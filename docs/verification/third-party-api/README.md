# 第三方 API 板块验证

验证时间：2026-10-09（Asia/Shanghai）。基线：`590d3125c65b44f6b3d369e32c0370455c8a43e7`；任务分支：`feat/third-party-api`。

## 改动

- 插件弹窗首屏增加「第三方 API」卡片及设置页直达按钮。
- 设置页始终显示独立 API 板块，集中配置基础地址、协议、模型和密钥，展示是否启用及密钥保存状态。
- 支持保存并启用、保存并测试、移除密钥；API 操作不会提交其他未保存的音频或账号字段。
- 测试前先保存当前输入；重复点击不会重复提交；修改字段会清除旧的成功提示。API 操作使用板块内反馈，窄屏不会被全局提示遮挡按钮。
- `/test` 每次都请求当前保存的服务与密钥，不使用字幕缓存，也不自动重试。普通字幕和语义字幕原有缓存保留。
- 导航仅接受固定 `section=api`，配对码仍放 fragment，进入设置页后移除；不添加外部跳转地址或新的高权限消息类型。
- README 已同步操作步骤。版本维持 0.4.7；这是任务分支功能变更，未发布新版本。

## 证据

- `npm test --prefix outputs/youtube-zh-assistant`：**224 通过，0 失败，0 跳过**，见 [tests.log](tests.log)。
- 新增 HTTP 模拟集成测试覆盖 Chat Completions / Responses 两种协议、自定义基础路径、Authorization、模型 ID、逐条翻译、语义翻译、缓存保留、密钥留空保留及清除。
- 测试实际先填充与测试句相同的字幕缓存，再替换密钥；确认测试仍请求上游并返回鉴权失败。401、404、429、500 均清晰报错且只调用一次。
- 独立临时资料的无头 Microsoft Edge 完成 **9 项浏览器检查**，见 [ui-report.json](ui-report.json)：保存、协议切换、错误状态、刷新恢复、非法地址校验、导航、弹窗入口及窄屏布局。
- 已人工查看 [桌面 API 板块](api-desktop.png)、[窄屏 API 板块](api-mobile.png)、[鉴权失败反馈](api-error.png)、[插件弹窗](popup.png)，没有裁切或按钮遮挡。
- 浏览器复测最初因复用模拟服务的已保存 API 状态而未满足“初始账号模式”断言；验证工具增加仅针对随机端口测试服务的状态初始化后，重跑通过。该失败不涉及真实账号或正式配置。
- `git diff --check` 通过。已保留原文件未修改行的换行字节，避免无关格式改动。

## 重跑

在任务 worktree 中运行：

```powershell
npm test --prefix outputs/youtube-zh-assistant
# 以下模拟服务仅在随机端口启动，生成临时测试配对码。
node tools/api-test-fixture.mjs work/third-party-api/fixture.json
# 另一个终端：
python tools/verify-api-ui.py --fixture work/third-party-api/fixture.json --output work/third-party-api/ui --browser 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
# 验证结束后，在模拟服务终端按 Ctrl+C 停止并清理其临时运行目录。
```

模拟上游只接受虚构测试密钥，且测试应用阻止访问非模拟上游。浏览器脚本拒绝正式端口 17865。独立弹窗页面使用模拟 Chrome API，扩展消息权限另外由单元测试覆盖。

## 验证边界与待办

没有使用真实第三方账号，不能据此承诺某一家服务商的模型、额度或协议兼容性。没有在日常浏览器加载任务插件，没有运行真实 GPU 或 Codex 翻译，没有启动或停止正式服务，没有读取或修改正式配对配置。

目前保留独立分支，**未合并 main、未打包、未升级已安装插件**。真实服务测试通过后再由主聊天合并；合并回归、Git 备份及后续版本发布按项目规则执行。尚未集成时，回退只需继续使用原有正式安装，无需撤销主分支提交。

实际分工：当前主代理独立实现和验证；没有子代理调用，没有升级 Astra，未把默认配置声称为已确认的模型身份。
