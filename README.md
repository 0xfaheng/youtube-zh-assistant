# 译幕开发工作区

正式项目源码：`outputs/youtube-zh-assistant`；当前产品版本：0.4.7。

本地 Git 已管理源码、测试、开发记录、历史验证证据和精选发布工具。`main` 用于统一集成；任务通过独立分支和 worktree 开发。

- [Git 开发、并行聊天和回退指南](docs/Git开发与并行协作.md)
- [本次 Git 初始化记录](docs/Git初始化记录-2026-10-06.md)
- [项目开发规则](AGENTS.md)
- [产品使用说明](outputs/youtube-zh-assistant/README.md)
- [历史版本记录](outputs/youtube-zh-assistant/开发记录/README.md)

创建任务：`powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\new-task.ps1 -Name subtitle-layout -Type fix`。

备份 Git：`powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\backup-git.ps1`。

旧安装包和运行资料仍保留原处；未配置远程仓库。仓库备份不包含安装包、运行配置和未提交修改。
