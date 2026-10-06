"""Offline, single-owner Qwen3-ASR JSONL worker. Audio stays in memory."""
import argparse
import base64
import gc
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import time
import wave

PROTOCOL = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
# All dependency prints, including imports/model loading, go to stderr.
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr
for key, value in {
    "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false",
}.items():
    os.environ[key] = value

MODEL_NAME = "Qwen3-ASR-1.7B"
MAX_BYTES = 4 * 1024 * 1024


def emit(value):
    PROTOCOL.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    PROTOCOL.flush()


def available(args):
    model_complete = False
    try:
        index = json.loads(Path(args.model, "model.safetensors.index.json").read_text(encoding="utf-8"))
        shards = set(index.get("weight_map", {}).values())
        model_complete = bool(shards) and Path(args.model, "config.json").is_file() and all(
            isinstance(name, str) and Path(args.model, name).is_file() for name in shards)
    except (OSError, ValueError, TypeError):
        pass
    checks = {
        "model": model_complete,
        "qwen_asr": importlib.util.find_spec("qwen_asr") is not None,
        "torch": importlib.util.find_spec("torch") is not None,
        "numpy": importlib.util.find_spec("numpy") is not None,
        "lock": Path(args.lock_root, "runtime_common.py").is_file(),
    }
    missing = [name for name, ok in checks.items() if not ok]
    result = {"available": not missing, "ready": False, "model": MODEL_NAME,
              "state": "idle" if not missing else "unavailable", "ffmpeg": bool(shutil.which("ffmpeg"))}
    if missing:
        result["error"] = "缺少本地依赖或模型文件：" + ", ".join(missing)
    return result


def decode_audio(encoded, mime):
    import numpy as np
    if not isinstance(encoded, str) or len(encoded) > (MAX_BYTES + 2) // 3 * 4:
        raise ValueError("音频分片不能超过 4MB")
    data = base64.b64decode(encoded, validate=True)
    if not data or len(data) > MAX_BYTES:
        raise ValueError("音频分片为空或超过 4MB")
    if mime == "audio/wav":
        with wave.open(io.BytesIO(data), "rb") as source:
            channels, rate, width = source.getnchannels(), source.getframerate(), source.getsampwidth()
            if not 1 <= channels <= 8 or not 8000 <= rate <= 192000 or source.getnframes() / rate > 30:
                raise ValueError("WAV 声道、采样率或时长超限（最多 30 秒）")
            raw = source.readframes(source.getnframes())
        if width == 1:
            audio = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128) / 128
        elif width == 2:
            audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
        elif width == 3:
            octets = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
            values = octets[:, 0] | (octets[:, 1] << 8) | (octets[:, 2] << 16)
            values = (values ^ 0x800000) - 0x800000
            audio = values.astype(np.float32) / 8388608
        elif width == 4:
            audio = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648
        else:
            raise ValueError("仅支持 PCM WAV")
        audio = audio.reshape(-1, channels).mean(axis=1, dtype=np.float32)
    elif mime == "audio/webm":
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise ValueError("本机未安装 ffmpeg；请使用 WAV 分片")
        process = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "pipe,fd",
             "-i", "pipe:0", "-t", "30", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
            input=data, capture_output=True, timeout=15, check=False)
        if process.returncode:
            raise ValueError("WebM 解码失败：" + process.stderr.decode("utf-8", "replace")[-500:])
        audio = np.frombuffer(process.stdout, dtype="<f4").copy()
        rate = 16000
    else:
        raise ValueError("音频 MIME 必须是 audio/wav 或 audio/webm")
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError("音频内容为空或无效")
    return np.ascontiguousarray(audio, dtype=np.float32), rate


class Worker:
    def __init__(self, args):
        self.args, self.model, self.lock, self.torch = args, None, None, None
        self.load_ms = 0

    def unload(self):
        # Release GPU resources before relinquishing the shared lock.
        self.model = None
        try:
            gc.collect()
            if self.torch is not None:
                self.torch.cuda.empty_cache()
                self.torch.cuda.synchronize()
        finally:
            if self.lock is not None:
                lock, self.lock = self.lock, None
                lock.__exit__(None, None, None)

    def warmup(self):
        if self.model is None:
            check = available(self.args)
            if not check["available"]:
                raise RuntimeError(check["error"])
            started = time.monotonic()
            spec = importlib.util.spec_from_file_location("ytzh_runtime_common", Path(self.args.lock_root, "runtime_common.py"))
            common = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(common)
            common.ROOT = Path(self.args.lock_root)
            # Keep the established cross-Windows/WSL lock for the whole residency.
            lock = common.gpu_lock("youtube-zh-assistant Qwen3-ASR resident")
            lock.__enter__()
            self.lock = lock
            try:
                import torch
                from qwen_asr import Qwen3ASRModel
                self.torch = torch
                if not torch.cuda.is_available():
                    raise RuntimeError("WSL 中 CUDA 不可用")
                self.model = Qwen3ASRModel.from_pretrained(
                    self.args.model, dtype=torch.bfloat16, device_map="cuda:0", local_files_only=True,
                    max_inference_batch_size=1, max_new_tokens=256)
                self.load_ms = round((time.monotonic() - started) * 1000)
            except BaseException:
                self.unload()
                raise
        return {"available": True, "ready": True, "model": MODEL_NAME, "state": "ready",
                "loadMs": self.load_ms, "pid": os.getpid()}

    def transcribe(self, request):
        language = request.get("language", "auto")
        if not isinstance(language, str) or len(language) > 40:
            raise ValueError("识别语言无效")
        context = request.get("context", "")
        if not isinstance(context, str) or len(context) > 4000:
            raise ValueError("识别上下文最多 4000 个字符")
        audio = decode_audio(request.get("audioBase64"), request.get("mime"))
        self.warmup()
        started = time.monotonic()
        result = self.model.transcribe(audio=audio, language=None if language.lower() == "auto" else language,
                                       context=context, return_time_stamps=False)
        first = result[0] if isinstance(result, (list, tuple)) and result else result
        text = getattr(first, "text", None)
        if not isinstance(text, str):
            raise RuntimeError("本地 ASR 未返回有效文本")
        detected = getattr(first, "language", None) or language
        return {"text": text.strip(), "language": str(detected),
                "inferenceMs": round((time.monotonic() - started) * 1000), "loadMs": self.load_ms,
                "model": MODEL_NAME}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--lock-root", required=True)
    parser.add_argument("--idle-seconds", type=float, default=120)
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    if args.inspect:
        emit(available(args))
        return
    worker = Worker(args)
    def terminate(_signal, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    emit({"type": "hello", "protocol": 1, "pid": os.getpid(), "model": MODEL_NAME})
    reason = "eof"
    try:
        while True:
            # Node sends one operation at a time. Avoid reader threads retaining audio.
            readable, _, _ = select.select([sys.stdin], [], [], max(1, args.idle_seconds))
            if not readable:
                reason = "idle"
                break
            line = sys.stdin.buffer.readline(6 * 1024 * 1024)
            if not line:
                break
            request = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict) or not isinstance(request.get("id"), str):
                    raise ValueError("请求必须包含字符串 id")
                command = request.get("type")
                if command == "stop":
                    worker.unload()
                    emit({"id": request["id"], "ok": True, "result": {"stopped": True}})
                    reason = "requested"
                    break
                if command == "warmup":
                    result = worker.warmup()
                elif command == "transcribe":
                    result = worker.transcribe(request)
                else:
                    raise ValueError("不支持的 worker 命令")
                emit({"id": request["id"], "ok": True, "result": result})
            except Exception as error:
                emit({"id": request.get("id") if isinstance(request, dict) else None,
                      "ok": False, "error": {"code": "LOCAL_ASR_ERROR", "message": str(error)[:1500]}})
    finally:
        worker.unload()
        emit({"type": "stopped", "reason": reason, "pid": os.getpid()})


if __name__ == "__main__":
    main()
