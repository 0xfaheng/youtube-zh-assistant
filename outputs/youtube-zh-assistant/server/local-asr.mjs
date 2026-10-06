import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MODEL = 'Qwen3-ASR-1.7B';
const OFFLINE = Object.freeze({
  HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1',
  HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false', PYTHONUNBUFFERED: '1'
});
export function toWslPath(value) {
  if (/^[A-Za-z]:[\\/]/.test(value)) return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\', '/')}`;
  if (value.startsWith('/')) return value;
  throw new Error('本地 ASR 路径必须是绝对 Windows 路径或 WSL 路径');
}
export class LocalASRError extends Error {
  constructor(message, code = 'LOCAL_ASR_ERROR') { super(message); this.name = 'LocalASRError'; this.code = code; this.status = 503; }
}
function waitFor(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new LocalASRError(message, 'LOCAL_ASR_TIMEOUT')), ms); })]).finally(() => clearTimeout(timer));
}

export class LocalASR {
  constructor(options = {}) {
    const env = options.env || process.env;
    this.spawnImpl = options.spawnImpl || spawn;
    this.env = { ...env, ...OFFLINE };
    this.distro = env.YTZH_ASR_DISTRO || 'Dayuanzong';
    this.python = env.YTZH_ASR_PYTHON || '/opt/dayuanzong/venvs/qwen/bin/python';
    this.modelPath = toWslPath(env.YTZH_ASR_MODEL || 'D:\\AIModels\\Qwen3-ASR-1.7B');
    this.lockRoot = toWslPath(env.YTZH_ASR_LOCK_ROOT || 'D:\\AIRuntime\\video-intelligence');
    this.workerPath = toWslPath(options.workerPath || fileURLToPath(new URL('./local-asr-worker.py', import.meta.url)));
    this.idleSeconds = Math.max(1, Number(env.YTZH_ASR_IDLE_SECONDS) || 120);
    this.warmupTimeout = options.warmupTimeout ?? 120000;
    this.transcribeTimeout = options.transcribeTimeout ?? 45000;
    this.stopTimeout = options.stopTimeout ?? 8000;
    this.signalTimeout = options.signalTimeout ?? 10000;
    this.inspectTimeout = options.inspectTimeout ?? 15000;
    this.inspectCacheMs = options.inspectCacheMs ?? 60000;
    this.inspectedAt = 0; this.inspection = null; this.inspecting = null;
    this.child = null; this.pending = new Map(); this.warming = null; this.stopping = null;
    this.busy = false; this.detectedAvailable = false; this.state = 'unknown'; this.error = null; this.pid = null; this.loadMs = 0;
  }
  status() {
    return { available: this.detectedAvailable, ready: !!this.child && ['ready', 'transcribing'].includes(this.state),
      model: MODEL, state: this.state, ...(this.error ? { error: this.error } : {}) };
  }
  _args(extra = []) {
    return ['-d', this.distro, '--exec', '/usr/bin/env', ...Object.entries(OFFLINE).map(([k, v]) => `${k}=${v}`),
      this.python, '-u', this.workerPath, '--model', this.modelPath, '--lock-root', this.lockRoot,
      '--idle-seconds', String(this.idleSeconds), ...extra];
  }
  _spawn(args) { return this.spawnImpl('wsl.exe', args, { env: this.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
  async inspect() {
    if (this.child) return this.status();
    if (this.inspection && Date.now() - this.inspectedAt < this.inspectCacheMs) return {...this.inspection, ...this.status()};
    if (this.inspecting) return this.inspecting;
    this.inspecting = this._inspectOnce().then(result => {
      this.inspection=result; this.inspectedAt=Date.now(); return result;
    }).finally(()=>{this.inspecting=null;});
    return this.inspecting;
  }
  async _inspectOnce() {
    let child;
    try {
      child = this._spawn(this._args(['--inspect']));
      let output = '', errorText = '';
      const result = await waitFor(new Promise((resolve, reject) => {
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => { output += data; if (output.length > 65536) reject(new LocalASRError('ASR 检测输出过大')); });
        child.stderr.on('data', data => {errorText = (errorText + data).slice(-1500);});
        child.once('error', reject);
        child.once('close', code => {
          try {
            if (code !== 0) throw new Error(errorText || `WSL 检测退出码 ${code}`);
            const lines = output.trim().split(/\r?\n/);
            if (lines.length !== 1) throw new Error('ASR 检测 stdout 协议错误');
            const value = JSON.parse(lines[0]);
            if (typeof value.available !== 'boolean' || value.model !== MODEL) throw new Error('ASR 检测结果无效');
            resolve(value);
          } catch (error) {reject(error);}
        });
        child.stdin.end();
      }), this.inspectTimeout, '本地 ASR 检测超时');
      this.detectedAvailable = result.available;
      if (!result.available || !this.error) {this.state = result.state; this.error = result.error || null;}
      return { ...result, ...this.status(), ready: false };
    } catch (error) {
      // --inspect never loads a model or acquires the GPU lock.
      child?.kill(); this.detectedAvailable = false; this.state = 'unavailable'; this.error = error.message;
      return this.status();
    }
  }
  _start() {
    if (this.child) return;
    const child = this._spawn(this._args()); this.child = child; this.pid = null; this.state = 'starting'; this.error = null;
    let buffer = '', stderr = '';
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    child.stdout.on('data', data => {
      buffer += data;
      if (buffer.length > 65536) {this._protocolFailure('ASR worker stdout 超出协议限制'); return;}
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'hello') {
            if (value.protocol !== 1 || value.model !== MODEL || !Number.isInteger(value.pid) || value.pid < 1) throw new Error('worker 握手无效');
            this.pid = value.pid; continue;
          }
          if (value.type === 'stopped') continue;
          if (typeof value.id !== 'string' || typeof value.ok !== 'boolean') throw new Error('worker 响应格式无效');
          const pending = this.pending.get(value.id);
          if (!pending) continue;
          this.pending.delete(value.id); clearTimeout(pending.timer);
          if (value.ok) pending.resolve(value.result);
          else pending.reject(new LocalASRError(value.error?.message || '本地语音识别失败', value.error?.code));
        } catch (error) {this._protocolFailure('ASR worker stdout 协议错误：' + error.message); return;}
      }
    });
    child.once('error', error => { this.error = error.message; this.state = 'error'; this._rejectAll(new LocalASRError(error.message)); });
    child.once('close', (code, signal) => {
      const previousState = this.state;
      if (this.child === child) {
        this.child = null; this.pid = null;
        if (code === 0 && !['error', 'unavailable'].includes(previousState)) this.state = 'idle';
        else if (previousState !== 'error') {this.state = 'error'; this.error = stderr || `ASR worker 已退出 (${code ?? signal})`;}
        this._rejectAll(new LocalASRError(this.error || '本地 ASR worker 已退出', 'LOCAL_ASR_EXITED'));
      }
      this.resolveExit?.({ code, signal });
    });
  }
  _rejectAll(error) { for (const p of this.pending.values()) {clearTimeout(p.timer); p.reject(error);} this.pending.clear(); }
  _protocolFailure(message) { this.error = message; this.state = 'error'; this._rejectAll(new LocalASRError(message, 'LOCAL_ASR_PROTOCOL')); this.stop().catch(() => {}); }
  _request(type, values, timeout) {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new LocalASRError('本地 ASR worker 未运行'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(new LocalASRError(`本地 ASR ${type} 超时`, 'LOCAL_ASR_TIMEOUT'));}, timeout);
      this.pending.set(id, {resolve, reject, timer});
      child.stdin.write(JSON.stringify({id, type, ...values}) + '\n', error => {
        if (error) {const p = this.pending.get(id); if(p) {this.pending.delete(id); clearTimeout(timer); reject(new LocalASRError(error.message));}}
      });
    });
  }
  async warmup() {
    if (this.stopping) await this.stopping;
    if (this.child && ['ready', 'transcribing'].includes(this.state)) return {...this.status(), loadMs:this.loadMs};
    if (this.warming) return this.warming;
    this.warming = (async () => {
      try {
        this._start(); this.state = 'loading';
        const result = await this._request('warmup', {}, this.warmupTimeout);
        if (!result?.ready || result.model !== MODEL) throw new LocalASRError('本地 ASR 预热结果无效');
        this.detectedAvailable = true; this.state = 'ready'; this.error = null; this.loadMs = Number(result.loadMs) || 0;
        return {...this.status(), loadMs:this.loadMs};
      } catch (error) {this.error=error.message; await this.stop().catch(()=>{}); this.state='error'; throw error;}
    })().finally(() => {this.warming=null;});
    return this.warming;
  }
  async transcribe({buffer, mime, context = ''}, language = 'auto') {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 4 * 1024 * 1024) throw new LocalASRError('音频分片必须是 1 字节至 4MB 的 Buffer', 'INVALID_AUDIO');
    if (!['audio/wav', 'audio/webm'].includes(mime)) throw new LocalASRError('不支持的音频 MIME', 'INVALID_AUDIO');
    if (typeof context !== 'string' || context.length > 4000 || typeof language !== 'string' || !/^[A-Za-z][A-Za-z -]{0,39}$/.test(language)) throw new LocalASRError('识别上下文或语言无效', 'INVALID_AUDIO');
    if (this.busy) throw new LocalASRError('本地 ASR 正在识别上一片音频，请稍后重试', 'LOCAL_ASR_BUSY');
    this.busy = true;
    try {
      await this.warmup(); this.state = 'transcribing';
      const result = await this._request('transcribe', {audioBase64:buffer.toString('base64'), mime, context, language}, this.transcribeTimeout);
      if (typeof result?.text !== 'string' || typeof result.language !== 'string' || result.model !== MODEL || !Number.isFinite(result.inferenceMs)) throw new LocalASRError('本地 ASR 返回格式无效', 'LOCAL_ASR_PROTOCOL');
      this.state='ready'; this.error=null;
      return {text:result.text, language:result.language, inferenceMs:result.inferenceMs, loadMs:Number(result.loadMs)||this.loadMs, model:MODEL};
    } catch (error) {this.error=error.message; await this.stop().catch(()=>{}); this.state='error'; throw error;}
    finally {this.busy=false;}
  }
  async _signalWorker(pid) {
    // Signal the Linux child, checking its cmdline to avoid terminating a reused PID.
    const code = "import os,sys,signal; p=int(sys.argv[1]); expected=sys.argv[2].encode(); parts=open('/proc/%d/cmdline'%p,'rb').read().split(b'\\0'); assert expected in parts, 'worker PID ownership mismatch'; os.kill(p,signal.SIGTERM)";
    const child = this._spawn(['-d',this.distro,'--exec',this.python,'-c',code,String(pid),this.workerPath]);
    let stderr=''; child.stderr.setEncoding('utf8'); child.stderr.on('data',s=>{stderr=(stderr+s).slice(-1000);}); child.stdout.resume(); child.stdin.end();
    await waitFor(new Promise((resolve,reject) => {child.once('error',reject); child.once('close',code => code===0 ? resolve() : reject(new LocalASRError(stderr || '无法向 Linux worker 发送 SIGTERM')));}),this.signalTimeout,'Linux worker 停止命令超时');
  }
  async stop() {
    if (this.stopping) return this.stopping;
    if (!this.child) {if (this.state !== 'error') this.state='idle'; return this.status();}
    const child=this.child, exit=this.exited;
    this.stopping=(async () => {
      const savedError=this.error; this.state='stopping';
      if(child.stdin.writable) child.stdin.write(JSON.stringify({id:randomUUID(),type:'stop'})+'\n');
      try {await waitFor(exit,this.stopTimeout,'本地 ASR 未响应停止命令');}
      catch {
        const pid=this.pid;
        if(!pid) throw new LocalASRError('尚未收到 Linux worker PID，无法确认停止；worker 将按空闲超时退出', 'LOCAL_ASR_STOP_UNCONFIRMED');
        await this._signalWorker(pid);
        await waitFor(exit,this.signalTimeout,'Linux worker 尚未确认退出，请检查本机 GPU 锁', 'LOCAL_ASR_STOP_UNCONFIRMED');
      }
      this.error=savedError;
      this.state=savedError?'error':'idle';
      return this.status();
    })().catch(error => {this.error=error.message; this.state='error'; throw error;}).finally(()=>{this.stopping=null;});
    return this.stopping;
  }
}
export default LocalASR;
