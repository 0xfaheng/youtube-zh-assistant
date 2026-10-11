# 0.4.8 GitHub 发布记录

日期：2026-10-11（Asia/Shanghai）。本次将已交付的 0.4.8 发布到 GitHub，产品版本不变。

## 发布范围

- 账号通过 GitHub API 实时核验为 `0xfaheng`，用户明确选择公开仓库 `0xfaheng/youtube-zh-assistant`。
- 起点提交：`d0f42610c19cac3cec404277d995d0ce2d869f6b`；任务分支：`docs/github-publish`，通过独立 worktree 准备。
- 增加公开首页、安装与下载入口、品牌联系信息、发布记录；保留产品源码、原安装包、作者提交历史及既有 `v0.4.8` 附注标签。
- GitHub 发布 `main` 和既有版本标签 `v0.4.8`，不额外发布旧版 Release，不上传本机运行配置或安装包备份。
- 产品完整包的打包源码提交仍是 `52ccf68756207f27f6eaa1d3bb54e247e7ad2601`。本次未重打包，不更改已发布版本的字节或标签。

## 发布前验证

- 在隔离任务目录运行 `npm test`：224 项通过，0 失败、0 跳过；日志见 [测试日志](verification/github-publish-20261011/tests.log)。未启动正式服务、调用真实翻译账号或占用 GPU。
- 对起点 main / v0.4.8 可达历史的 415 个文本 blob 扫描常见 API / GitHub 密钥、私钥、JWT、Cookie、Bearer、配对码及敏感运行文件名；命中项经核对均为单元测试夹具假值，没有发现真实凭证。
- 95 个二进制 blob 均为 PNG，其中 5 个为图标；对其余 90 张历史截图制作缩略总览并逐页查看，未发现可见密钥或配对码。规则扫描与缩略检查不等同于第三方安全认证。
- ZIP CRC 检查通过，77 个条目全部与正式目录中的对应文件逐字节一致，路径无越界。完整目录枚举检查初次报告差异，原因是打包后新增的 4 份发布证据不在包内；没有缺失或被更改的包内文件。
- RAR 自检通过，两个原安装包 SHA-256 与既有发布证据一致。RAR 公开下载名改为 ASCII，文件内容保持一致。
- 本次只有仓库级文档变更，产品 README、版本号和包内源码保持原发布状态。第三方真实服务商账号测试不在本次验证范围内。

## 下载文件与哈希

| GitHub Release 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `youtube-zh-assistant-v0.4.8.zip` | 504300 | `1527a0d42413c045f60858483c6b3d45e2323231c4983a3c8cdd7550c550720e` |
| `youtube-zh-assistant-extension-v0.4.8.rar` | 132252 | `5356ba4ce4eb5661e1956c1b107c7e54570bb7ce80c2f6fd83b810ed00a1c93e` |

另提供 `SHA256SUMS.txt`。公开 RAR 对应本机原文件 `Chrome插件-YouTube中文字幕-v0.4.8.rar`。本机原 ZIP/RAR、哈希清单与历史标签均保留。

## 地址与验收

- 仓库：https://github.com/0xfaheng/youtube-zh-assistant
- Release：https://github.com/0xfaheng/youtube-zh-assistant/releases/tag/v0.4.8
- 远端提交、Release 附件、匿名下载哈希及 Git 备份的最终验收在发布后单独保存。

## 回退与模型分工

仓库文档变更可通过 `git revert` 撤回；产品回退按原版本开发记录执行。不要覆盖既有标签或同版安装包。公开仓库的历史不能通过删除当前文件保证不再可见。

当前主代理独立完成账号核验、文档准备、历史与安装包检查、回归测试及 GitHub 发布；没有调用子代理，没有升级 Astra。没有独立工具确认主模型的具体型号，不将默认配置当作实际调用证明。
