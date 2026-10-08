# 译幕开发工作区

正式项目源码：`outputs/youtube-zh-assistant`；当前产品版本：0.4.7。

本地 Git 管理源码、测试、当前开发记录、验证证据和精选发布工具。`main` 用于统一集成；任务通过独立分支和 worktree 开发。

- [Git 开发、并行聊天和回退指南](docs/Git开发与并行协作.md)
- [本次 Git 初始化记录](docs/Git初始化记录-2026-10-06.md)
- [项目开发规则](AGENTS.md)
- [产品使用说明](outputs/youtube-zh-assistant/README.md)
- [当前版本记录](outputs/youtube-zh-assistant/开发记录/README.md)

创建任务：`powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\new-task.ps1 -Name subtitle-layout -Type fix`。

备份 Git：`powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\backup-git.ps1`。

2026-10-08 已按用户要求删除旧安装包及散落的旧版资料，保留 0.4.7 安装包、当前证据、运行资料和 Git 历史；未配置远程仓库。仓库备份不包含安装包、运行配置和未提交修改。

本次[运行检查与清理记录](docs/运行检查与旧版清理-2026-10-08.md)：自动测试通过，真实翻译因 Codex CLI 未登录而失败。
