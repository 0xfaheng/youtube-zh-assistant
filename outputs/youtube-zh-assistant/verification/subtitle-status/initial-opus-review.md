## 只读审校结论

**运行时代码：需求已实现，没有发现运行时缺陷。** **验收：不通过。** 原因是测试没有随这次修改同步更新，下面列出的 9 处断言必然失败。

本次审校由我（Opus 5.5）独立完成，没有派发子代理，只读取了附件 `snapshot.txt`，没有运行任何程序。所以测试失败是静态推断：`assert.match('', /非空正则/)` 必定抛错，结论确定。

### 需求核对（已通过）

- **提示已消除**：`extension/core.js:159-163` 中的 `captionStatus()` 固定返回空串。两个播放器的状态行只从这里写入：`content.js:113` 和 `generic.js:132`。空串经过 `writeCaption` 后，`textContent` 为空，命中 `p:empty{display:none}`（`core.js:10`），状态行不再显示。
- **没有残留提示路径**：
  - `semantic.js:73/79/126/132` 的“正在整理完整语句…”“正在等待并整理完整语句…”“完整语句 · 延迟显示”只通过 `changed()` 写入 `status` 变量，最终都经过 `captionStatus`。
  - `zh` 和 `original` 两行的内容只来自 cue、`semantic`/`live` 结果、DOM 结果或音频结果，状态文字进不去。
  - 其他代码没有引用 `captionStatus`。
- **以下行为都不受影响**：
  - 字幕内容和时间：`chinese`、`source`、`activeSemantic`、`groupStart`/`groupEnd` 的计算没有改动。
  - 原生 CC 的隐藏与还原：`replaceNative`、`maskNative` 的判断不依赖状态行。
  - 暂停、退避重试：`retryAt`、`translationBlocked`/`blocked` 没有改动。
  - 语音模式：`AUDIO_*` 消息处理只改了显示用的字符串。
- 状态行隐藏后不占位，也不会拦截拖动。拖动只在 `P` 元素上触发，而 `display:none` 的元素不会接收指针事件。

### 缺陷

**P1：测试仍断言状态行有文字，测试套件会失败，部分回归验证实际没有执行**

- 位置：
  - `extension/tests/content.test.cjs:70`（`/语义服务暂不可用/`）
  - `content.test.cjs:91`（`/翻译连接失败/`）
  - `content.test.cjs:96`（`/本机服务未启动/`）
  - `content.test.cjs:103`（`/0:01.*延迟译文/`）
  - `content.test.cjs:128`（`/视频播放异常/`）
  - `content.test.cjs:129`（`/视频暂未就绪/`）
  - `content.test.cjs:160`（`/跳过 2/`）
  - `extension/tests/generic.test.cjs:77`（`/0:01.*延迟译文/`）
  - `generic.test.cjs:81`（`/模型错误/`）
- 影响：
  - 共有 7 个测试用例失败。
  - `assert` 抛错后，同一用例里后面的有效断言不会执行，所以这些场景的验证都缺失了：
    - 失败时保留原生 CC（`content:91`）
    - 重新开启后的重试次数（`content:92-94`）
    - DOM 缓存不重复请求、`data-delayed` 标记（`content:105-107`）
    - 媒体错误恢复后重新显示译文（`content:129-130`）
    - 跳转后拒绝旧音频结果（`content:161-166`）
    - 迟到译文不隐藏原生 CC（`generic:77`）
  - 这部分正是需要证明“原生 CC、暂停重试、语音模式不受影响”的回归证据。
- 最小修复：
  - 把上面每处 `assert.match(text()[2], /…/)` 改成 `assert.equal(text()[2], '')`，用例里其余断言保持不变。
  - `content:160-166` 的旧音频用例里，`before` 会变成空串，断言仍然能通过。拒绝旧消息的效果改由 `text()[0] === ''` 证明，这条断言已经在用例里。
- 验证：运行 `node --test extension/tests/`，全部通过；并确认上面列出的后续断言都实际执行到了（不再提前抛错）。

**P2：没有直接覆盖本次需求的回归测试**

- 位置：`content.test.cjs:61-67` 和 `generic.test.cjs:44-48`。这两个完整语句用例的翻译请求都是立即完成的，没有在“正在整理完整语句…”的等待期间检查状态行。
- 影响：如果以后有人恢复了某条状态写入路径，现有测试发现不了。
- 最小修复（任选，至少一条）：
  - 在两个测试文件里各加一个用例：让 `segmentTranslate` 返回一个不立即完成的 Promise，在请求等待期间断言 `text()[2] === ''`，同时断言 `text()[0] === ''`、原生 CC 的 `visibility` 不是 `hidden`。
  - 实时整理路径也加一个同类用例：`tracks([])` 加 DOM 文本、`advance(1300)` 后 `tick`，检查同样的条件。
- 验证：先把 `captionStatus` 临时改成返回参数本身，新用例应该失败；恢复后应该通过。

### 不算缺陷，供参考

- 翻译失败、视频异常、浏览器原生全屏无法叠加等提示，现在页面上都看不到了。这是需求要求的结果。popup 也不显示页面里的翻译错误，所以用户遇到问题时只能看到“没有中文”。
- 字幕浮层上的鼠标悬停提示 `host.title`（“按住字幕拖动…”，`core.js:58`）不属于字幕行，不在本次范围内。