# 译幕开发工作区

正式项目源码：`outputs/youtube-zh-assistant`；当前产品版本：**0.4.8**。

本地 Git 管理源码、测试、当前开发记录、发布证据和可复用工具。`main` 用于统一集成；任务通过独立分支和 worktree 开发。

- [产品使用说明](outputs/youtube-zh-assistant/README.md)
- [当前版本记录](outputs/youtube-zh-assistant/开发记录/v0.4.8.md)
- [验证结果](outputs/youtube-zh-assistant/VALIDATION.md)
- [Git 开发与回退指南](docs/Git开发与并行协作.md)
- [项目开发规则](AGENTS.md)

创建任务：`powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\new-task.ps1 -Name subtitle-layout -Type fix`。
备份 Git：`powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\backup-git.ps1`。

2026-10-10 已合并第三方 API 功能并升级版本。旧资料从源码及交付目录移出，新版只保留当前记录和必要证据。批量物理删除被自动审批拦截，旧资料采用可逆归拢，放在 `work/旧资料待清理-20261010`；已完成任务目录放在相邻 worktrees 目录的「已完成待清理-20261010」内。这些文件尚未物理删除。Git 历史、备份和运行配置保留；仓库备份不包含安装包、运行配置和未提交修改。
