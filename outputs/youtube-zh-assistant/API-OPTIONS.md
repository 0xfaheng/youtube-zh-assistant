# 语音 API 选择

查询日期：2026-10-05。以下只计算语音转文字，中文翻译另计；不包含税费、促销赠送额度及重试。成本按完整上传的单声道音频估算，跳过静音或丢弃片段会减少实际上传量。没有进行不同服务的真实音频质量或延迟对比。

| 服务 / 模型 | 每小时音频参考价格（美元） | 接入当前版本 |
|---|---:|---|
| Groq `whisper-large-v3-turbo` | $0.04 | 接口兼容 `/audio/transcriptions`，可配置后测试，未真实调用 |
| Groq `whisper-large-v3` | $0.111 | 同上；Groq 推荐错误敏感的多语种任务用此模型 |
| OpenAI `gpt-4o-mini-transcribe` | 约 $0.18 | 默认语音模型；已验证请求结构，未真实调用 |
| 阿里云 `qwen3-asr-flash` | 北京 $0.1152 / 新加坡 $0.126 | 需要新增专用适配，不能只更换模型名称 |
| Deepgram Nova-3 | 流式英文约 $0.288 / 多语言约 $0.348 | 需要新增流式适配；该流式价格是官网当前促销价 |

价格与能力依据：[Groq 语音文档](https://console.groq.com/docs/speech-to-text)、[OpenAI 价格](https://developers.openai.com/api/docs/pricing)、[阿里云模型信息](https://www.alibabacloud.com/help/zh/model-studio/qwen3-asr-flash)、[Deepgram 价格](https://deepgram.com/pricing)。OpenAI 的每分钟价格是估算，实际按计费规则结算。Deepgram 非流式模型另有价格，不能混用。

## 当前建议

**这台电脑已有 Qwen3-ASR-1.7B，优先使用 0.2.0 的本地识别。** 本地语音识别没有按分钟的 API 费用，也不上传音频；原文翻译仍可能使用账号额度或文字 API。上表适用于不使用本地模型时的云端备选。

选择云端时，可以先用 OpenAI `gpt-4o-mini-transcribe`，文字翻译用同一份 OpenAI 密钥和默认 `gpt-4.1-mini`。观看量大时，可以测试 Groq Turbo；语音基础地址填 `https://api.groq.com/openai/v1`，模型填 `whisper-large-v3-turbo`。

当前版本文字与语音共用一份 API 密钥。选择 Groq 语音后，不能同时用另一份 OpenAI 密钥做文字翻译；可让文字翻译走已登录的 Codex CLI，但账号路线较慢。若想兼顾低成本语音和快速 OpenAI 翻译，需要后续增加独立密钥配置，不能在现版本里混填。

Groq 每次请求最低按 10 秒计费，当前约 7 秒分片全部上传时，Turbo 实际约 $0.057/小时，Large V3 约 $0.159/小时。这些是按 10/7 换算的估算，不是实际账单。Turbo 本身不提供音频翻译，仍需另一步文字翻译。

有现成字幕的 YouTube 视频会优先走字幕翻译，无需调用语音识别 API，成本更低。无字幕识别是 beta，繁忙时可能漏掉内容；便宜的识别 API 也不能消除分片和翻译造成的延迟。
