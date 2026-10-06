# Vimeo 原生起播诊断

目标：`https://player.vimeo.com/video/76979871`。2026-10-05，独立新 Profile、安装版 Edge / Chrome，继承 User 级 HTTP_PROXY / HTTPS_PROXY，并为 localhost 配置 bypass。没有加载插件，没有读取用户日常浏览器 Profile / Cookie，没有媒体下载或 DRM 绕过。生产文件未修改。

## 已验证结论

- Edge 和 Chrome 均成功点击 Vimeo 的实际播放按钮；随后持续观测 60 秒，均为 `readyState=0`、`currentTime=0`、解码帧数 `0`、`paused=false`，`duration=61.853437`。原生播放器也不能起播。
- Edge 原生截图明确显示：**权利问题 / 我们在授权回放此视频时遇到问题。** 此处是 Vimeo 自身的回放授权提示。
- 两种浏览器均记录到 `vod-adaptive-ak.vimeocdn.com` 的 5 次 `xhr` 返回 `200`。HTTP 成功没有产生实际播放。
- 后续 Edge 原生设置尝试中：`com.widevine.alpha` 访问被拒绝，`NotSupportedError: Unsupported keySystem or supportedConfigurations.`；`com.microsoft.playready` 访问成功。`pr.service.expressplay.com` 的 `xhr` 返回 `200`，但仍为 0 秒 / 0 帧。此证据把排查方向收窄到 DRM 支持或授权后处理；尚不能判定许可证被成功应用，也不能确定最终根因。
- 字幕元信息包含 `de` / `es` / `en` / `fr`；观测到的 captions `cues=0`。没有实际播放、字幕 cue 消费或翻译成功证据。

## 针对性尝试与边界

- 打开原生设置和画质列表；最终截图显示 `360p` 选中，仍不能起播。此次操作没有证明 `240p` 已测试，因此不能排除更低码率差异。
- 另一个视频 `148751763` 显示“此视频不存在”，没有创建 `video` 元素，也没有播放按钮。该样本无效，不能作为成功对照。
- 原生基线未包装 EME API；后续诊断只观察 `requestMediaKeySystemAccess` 的原始 Promise 结果，透传原函数调用，不读取 initData、许可证、密钥或响应体。
- 媒体网络日志只保存域名、资源类型、状态和错误类别，不保存路径、query、签名或媒体内容。

## 已落盘证据

| 类型 | 目录 | 关键文件 |
|---|---|---|
| Edge 原生基线 | `edge-2026-10-05T02-13-59-464Z` | `evidence.json`、`final.png` |
| Chrome 原生基线 | `chrome-2026-10-05T02-14-21-436Z` | `evidence.json`、`final.png` |
| Edge 原生设置 / 授权观测 | `edge-low-quality-2026-10-05T02-16-16-963Z` | `evidence.json`、`final.png` |
| 无效公开视频对照 | `chrome-alternate-2026-10-05T02-16-32-936Z` | `evidence.json`、`final.png` |

下一步可验证条件：先取得在相同独立浏览器环境中能持续推进 `currentTime` 且产生解码帧的合法 Vimeo 样本，再验证插件字幕与翻译。当前目标应标记为“播放器授权问题；未验证翻译”。若后续必须定位该目标的授权根因，需要原生播放器 DRM / 许可证应用失败类别；本次已结束额外尝试。
