# 0.4.7 当前运行检查 · 2026-10-08

结论：代码自动测试通过，本机服务在线；翻译当前不可用，不能宣称插件完整工作正常。

- `npm test`：213 项通过，0 失败、0 跳过。
- 本机服务版本 0.4.7，鉴权状态接口和设置页静态资源可访问；未停止或重启服务。
- 插件实际调用的 Codex CLI 执行 `login status` 返回 `Not logged in`、退出码 1；本机服务显示 `configured=false`。
- 一次真实 `/test` 翻译请求返回 HTTP 502、`CODEX_FAILED`，没有获得译文。
- 本机 Qwen3-ASR-1.7B 部署和 ffmpeg 检测可用，模型空闲未预热；本次没有重新执行 GPU 识别。
- Chrome 注册路径指向正式 extension 目录；源码、独立插件目录的 21 个文件哈希一致，均为 0.4.7。
- 设置页在已运行的 Chrome 中打开；自动化未取得新的配对成功确认，不将此结果当作浏览器全链路通过。本次未验证真实 YouTube 播放、字幕显示或 tabCapture。
- 0.4.7 ZIP/RAR SHA-256 与原发布哈希清单一致；清理前后继续核验源码、当前安装包和运行配对文件。

恢复步骤：在本机终端执行 `codex login` 完成登录；随后执行 `codex login status`，再在本机设置页点“翻译一句，测试连接”。翻译成功后，刷新视频页、点击“启用译幕”进行实际播放验证。登录操作参见 [OpenAI 官方身份验证说明](https://learn.chatgpt.com/docs/auth)。

本次日志与清理清单位于仓库 `docs/verification/health-cleanup-20261008/`。0.4.7 原发布证据仍在 [verification/releases/0.4.7](verification/releases/0.4.7)，属于历史发布验证。
