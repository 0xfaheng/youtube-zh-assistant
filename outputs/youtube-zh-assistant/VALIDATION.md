# 0.4.8 验证 · 2026-10-10

- 合并后全量自动测试：**224 项通过、0 失败、0 跳过**，见 [tests.log](verification/releases/0.4.8/tests.log)。首轮 223 通过、1 项 Windows 本机连接资源错误 `ENOBUFS`；停止并行浏览器验证后，同一套完整测试重跑通过，没有修改断言或产品实现。
- 独立临时资料的无头 Microsoft Edge：**9 项交互与布局检查通过**，见 [ui-report.json](verification/releases/0.4.8/ui-report.json)。已核对桌面、窄屏、错误反馈和显示 0.4.8 的弹窗截图。
- HTTP 模拟上游覆盖 Chat Completions / Responses、自定义路径、鉴权和模型、普通与语义翻译、密钥失效、404/429/500、缓存隔离；不使用真实第三方账号。
- 正式服务通过原有 `start.ps1 -NoBrowser` 启动，`/status` 与 `/pairing` 返回 0.4.8；待处理为 0，配对文件校验一致。设置页显示新 API 板块。详见 [runtime-report.json](verification/releases/0.4.8/runtime-report.json)。
- 当前账号模式显示未登录（`configured=false`）；需要完成账号登录，或在新 API 板块填写有效配置。模型部署检测可用且空闲；本次没有调用真实 GPU 或付费模型。
- 未重启日常 Chrome，也没有自动重载已安装扩展。用户需在 `chrome://extensions` 重新加载译幕、确认 0.4.8，再刷新视频页面。
- 打包校验、sourceCommit 和 SHA-256 以本版最终发布报告为准。旧开发资料的物理删除被自动审批拒绝，采用可逆归拢，没有将归拢当作删除。
