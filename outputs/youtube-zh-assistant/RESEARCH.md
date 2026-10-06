# 实现依据与方案研究

## 本机 Codex CLI

项目用本机 `codex exec` 复用 CLI 的 ChatGPT 登录，不用网页 Cookie。本机检查：版本 `0.160.0`，状态 `Logged in using ChatGPT`。非交互模式支持 stdin、`--ephemeral`、`--output-schema`；请求消耗 ChatGPT/Codex 用量。参考：[非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[认证](https://learn.chatgpt.com/docs/auth)。登录不保证调用成功。

ChatGPT/Codex 用量与 API 计费分开。参考：[定价与用量](https://learn.chatgpt.com/docs/pricing)。默认请求 `gpt-6-luna`、`high`、Fast（`service_tier=fast`、`features.fast_mode=true`）；明确不可用时提示切回标准，不静默换模型。Fast 增加用量，并不保证所有调用的墙钟耗时，参考：[速度模式](https://learn.chatgpt.com/docs/agent-configuration/speed)。

本机两句字幕的两次成功调用耗时 119.486 秒、47.568 秒。后者用专用翻译指令替换编码默认指令，并限制项目文档上下文；已经保留该优化。更激进地禁用额外能力的另一次试验在约 120 秒超时，相关额外配置已撤回。成功返回“今天我们要构建一个简单的 AI 助手。”及对应的第二句中文字幕；CLI 未返回实际模型和速度档位标识，因此只记录请求配置。账号路线可作备用，连续字幕建议优先测试 API。

## API 翻译与语音转写

Structured Outputs 可约束翻译 JSON。API 翻译默认 `gpt-4.1-mini`；语音转写默认 `gpt-4o-mini-transcribe`。参考：[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)、[Speech-to-text](https://developers.openai.com/api/docs/guides/speech-to-text)。

语音指南列出 WAV、WebM 等格式及 25 MB 文件上限。项目将音频拆成约 6–8 秒 WAV 片段，单片最多 4 MB。分段上传、识别和翻译仍会带来延迟。

## 浏览器采音与数据流

Chrome `tabCapture` 需用户手势启动，捕获后应恢复播放输出；service worker 可用 Chrome 116+ offscreen document。参考：[tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)。音频链路标为 beta，分段、静音跳过后转写翻译。

服务仅绑定 `127.0.0.1`；token 留在本机，密钥可由 Windows DPAPI 加密。字幕发送给所选翻译服务；只有选择云端识别并启用捕获时才向云端发送音频片段，不发送完整视频。本地识别不上传音频，原文翻译仍可能使用云端服务。费用及数据处理取决于所选服务。

## 后续方向

Sign in with ChatGPT 可让符合条件的应用按授权流程使用适用计划能力，不是复用网页 Cookie。本项目未实现独立 OAuth，接入资格未验证。参考：[Sign in with ChatGPT](https://developers.openai.com/siwc)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。该授权与 Realtime API 可后续评估，尚未实现。

## 已部署本地 ASR 的接入

0.2.0 复用本机 `D:\AIModels\Qwen3-ASR-1.7B`，运行于 WSL `Dayuanzong` 和既有 Qwen Python 环境。离线加载，音频通过标准输入的 JSONL 送入常驻进程，在内存解码；仅识别文本交给翻译服务。实时短片段无需强制对齐器，避免额外加载开销。

worker 持有既有视频工具的公共 GPU 锁；遇占用报错，不结束其他任务。连续分片复用模型，空闲后卸载；本地识别失败不会自动切换云端。本机已存在部署回执，但本次调用结果与原先部署验收分别记录，见 `VALIDATION.md`。
