# 译幕 0.4.0 代码审校报告（只读）

只读了附件 `source-snapshot.txt`。没有编辑文件，没有运行程序或测试，也没有访问网络、凭据或运行目录。下文行号是各源文件的原始行号，不是快照文件的行号。

**结论：有 8 项已确认缺陷，另有 3 项需要实测的风险。** 其中 1 项 P1，3 项 P2，4 项 P3。现有测试覆盖不到这几处，所以 157 项全部通过和这些缺陷并不矛盾。

---

## 一、已确认缺陷

### 1. 【P1】DOM 滚动字幕在每次整理后重复送译，中文重复显示

- **位置**：`extension/semantic.js:95-111`（`live.add`）、`:113-115`（`flush` 的 `records.splice`）、`:132-134`（`tick` 的 6 秒强制整理）
- **触发条件**：
  - 默认开启“完整语句显示”，YouTube 走 DOM 兜底（README:37 说明匿名字幕接口常返回空，这条路径很常见）。
  - 原生字幕是自动字幕的滚动窗口（两行，逐词增长、上行滚出）。
  - 说话连续时，`aged`（6 秒）会触发 `flush()`，把当前记录整体移出 `records`。
- **实际影响**：
  - 移出后 `records` 为空。下一次 DOM 文本只要多一个词，`previous` 就是 `undefined`，代码进入 `else` 分支（`:107-110`），把整个窗口文本当作新记录推入。
  - 窗口里已经整理过的 10–20 个词会再次送译，中文按队列依次显示，内容明显重复。
  - 每 6 秒左右重复一次，还会多消耗模型额度。
  - `last` 只拦截完全相同的文本，`joinRolling` 只和 `records` 里还在的上一条比较，都挡不住这种情况。
- **建议最小修复**：
  - 在 `live` 闭包里保存上次整理的尾文本 `flushedTail`（例如最后一条记录的文本）。
  - 当 `records` 为空且 `end===null` 时：如果文本以 `flushedTail` 开头，就截掉这段前缀；否则按 `joinRolling` 的词重叠规则截掉重叠部分。剩余为空就直接返回。
  - `cancel()` 时清空 `flushedTail`。
- **回归验证**：
  1. 依次 `add('a b c d',0)`，推进 6 秒后 `tick` 触发第一次整理。
  2. 再 `add('c d e f',7)`，再整理一次。
  3. 断言第二批 `items[0].text` 为 `e f`，不包含 `c d`。
  4. 另测：截掉后为空时不产生请求。

### 2. 【P2】翻译出错后的“自动翻译已暂停”对实时整理不生效，429 退避在完整语句模式下也会被绕过

- **位置**：
  - `extension/content.js:73`（`render` 每次都调用 `liveSpeech.tick`）、`:236-238`（`AUDIO_RESULT` 无条件 `liveSpeech.add`）、`:29`（`invalidate` 把 `translationBlocked` 复位为 false）、`:138`（语义预取不检查 `retryAt`）
  - `extension/generic.js:116`、`:156`
  - `extension/semantic.js:131-134`
- **触发条件**：完整语句模式下，任意一次 `TRANSLATE_SEGMENTS` 失败（429、超时、模型格式错误），`translationError` 或 `error` 把翻译标记为已暂停。
- **实际影响**：
  - 失败的那一批在途期间新加入的记录还留在 `records` 里，250 ms 内 `render → tick → flush()` 会再发一次付费请求。`tick` 本身完全不看暂停标志。
  - 采音仍在运行时，每个约 7 秒的 `AUDIO_RESULT` 都会 `add → tick → flush`，持续发请求。在 429 下等于每 7 秒撞一次限流，提示文字却写着“已暂停”。
  - YouTube 侧：语义预取（`content.js:138`）只看 `translationBlocked`，不看 `retryAt`。而任何一次跳转都会经 `invalidate()` 把 `translationBlocked` 复位，所以 60 秒的 429 退避被直接绕过。
- **建议最小修复**：
  - 在 `translationError`（content）和 `error`（generic）里调用 `liveSpeech.cancel()`。
  - `AUDIO_RESULT` 和 `render` 中的 `tick` 加上 `!translationBlocked` / `!blocked` 判断。
  - 语义预取分支补上 `Date.now() >= retryAt`。
- **回归验证**：
  1. 用 fixture 让 `send` 第一次返回 429。
  2. 在途期间再 `add` 两条，失败后连续触发 `render` 和 `AUDIO_RESULT`。
  3. 断言 `send` 只被调用 1 次。
  4. 跳转后 60 秒内语义预取不发请求。

### 3. 【P2】跳转后旧翻译请求不取消，占住后台并发槽和服务端串行队列，新位置的请求可能超时并让翻译暂停

- **位置**：
  - `extension/background.js:270-281`：`TRANSLATE` 和 `TRANSLATE_SEGMENTS` 调用 `api()` 时没有传 `externalSignal`；只有 `/transcribe` 有取消信号。
  - `background.js:124-135`：同时最多 2 个请求。
  - `background.js:90`：150 秒计时从后台开始发送时算起，包含服务端排队时间。
  - `server/app.mjs:57-71`、`:91-105`：排队中的任务开始执行前，不检查客户端是否已断开。
  - `server/core.mjs:211-219`：`SerialQueue` 一次只执行一个任务。
  - `server/providers.mjs:158`：codex 单次最长 120 秒。
- **触发条件**：
  - 默认 codex 路线（RESEARCH:9 实测单次 47–119 秒）。
  - 用户在在途批次期间远距离跳转一次或多次。
  - 近距离跳转会因为请求体相同而被 `enqueue` 去重，不受影响。
- **实际影响**：
  - 内容脚本只丢弃旧结果，后台和服务端仍把旧请求完整跑完。
  - 新批次要排在旧请求后面：服务端排队时间加上自身耗时很容易超过 150 秒，报“请求超时”，随后 `translationError` 暂停整个视频的翻译。
  - 旧请求同时计入 `maxRequestsPerHour`，并消耗付费额度。
  - 现有文档只对音频说明“已提交的调用可能继续完成”，没有说明翻译也是这样。
- **建议最小修复**：
  - 服务端：在 `queue.run` 回调开头检查 `req.destroyed || res.destroyed`。如果没有其他调用方共享该任务，就不调用模型，直接抛出 `AppError(..., 499)`。共享调用方用引用计数判断。
  - 扩展：`enqueue` 按 key 维护引用计数和 `AbortController`；内容脚本在 `invalidate` 时发送 `CANCEL_TRANSLATION`（带视频和代次），引用数归零时中止 fetch。
- **回归验证**：
  1. 服务端测试：慢任务 A 执行中，任务 B 排队，B 的客户端断开；断言 provider 只被调用 1 次。
  2. 后台测试：发送 `TRANSLATE_SEGMENTS` 后再发取消消息，断言 fetch 的 signal 已中止，并发槽被释放。

### 4. 【P2】显示时把所有 Unicode 标点替换为空格，改变数字和专名的意思

- **位置**：`extension/core.js:141-150`（`subtitleText` 使用 `/\p{P}+/gu`）。显示、换行和预览都调用它。
- **触发条件**：译文或原文里出现 `%`、`％`、`-`、`/`、`:`、`#`、`&`、`@` 等。这些在 Unicode 里都属于 P 类标点。
- **实际影响**（只影响显示，原始数据不变）：

  | 原文 | 显示为 |
  |---|---|
  | 增长50% | 增长50 |
  | -5°C | 5°C |
  | 24/7 | 24 7 |
  | 3:30 | 3 30 |
  | C# | C |
  | AT&T | AT T |
  | COVID-19 | COVID 19 |

  README:11 只承诺替换“逗号、句号、问号、引号、括号、省略号等停顿标点”，实现超出了文档范围。`core.test.cjs:60-62` 只测了停顿标点。
- **建议最小修复**：改为白名单，只替换停顿和引用类标点，例如 `，。、；：！？…—「」『』“”‘’（）()[]【】《》,;!?"` 和英文句点（小数点除外）。保留 `% ％ / # & @ - _`，以及数字之间的冒号。
- **回归验证**：
  - `subtitleText('增长50%，达到3:30')` 应为 `增长50% 达到3:30`。
  - `subtitleText('-5°C C# AT&T 24/7')` 应保持原样。
  - 原有三条断言继续通过。

### 5. 【P3】客户端拒收服务端已接受的“纯标点译文”，导致整批失败并暂停翻译

- **位置**：`extension/semantic.js:36`（`!core.subtitleText(s.text)` 时抛错）；服务端 `server/core.mjs:171` 只要求 `text.trim()` 非空。
- **触发条件**：某一组的源文是 `...`、`?`、`—` 这类纯标点，模型返回 `……`、`？`。服务端校验通过，并写入 `semanticCache`。
- **实际影响**：
  - 客户端 `groups()` 抛出“完整语句返回格式无效”，整批丢弃并暂停翻译。
  - 结果已在服务端缓存，相同请求会再次命中同一份结果，重试也无法恢复。
  - `sentenceParts` 本身会把 `"... Hello"` 拆出单独的 `...` 片段（`semantic.js:13`），所以这个输入可以由代码自己产生。
- **建议最小修复**：客户端改为和服务端一致，只检查 `core.cleanText(s.text)` 非空；显示时为空就不显示。
- **回归验证**：`groups([{id:'a',text:'...',start:0,end:1}],[{sourceIds:['a'],text:'……'}])` 不抛错，`write` 结果为空。

### 6. 【P3】网页字幕 cue 的 id 依赖数组下标，中间插入 cue 会作废后面全部译文并重新付费

- **位置**：`extension/core.js:82`（id 为 `` `web:${i}:${startTime}` ``，`i` 是过滤后的下标）；`extension/generic.js:69-73`（id 或文本变化即判为过期）。
- **触发条件**：分段加载的 WebVTT 播放器（如 hls.js），先向后跳转、再跳回未加载的区间。新 cue 按开始时间插到列表中部，后面所有 cue 的下标都会移位。从头部移除旧 cue（直播）也会触发。
- **实际影响**：
  - 插入点之后已翻译的 cue 全部被判为过期：代次加一、`translated` 被删除、语义组因签名不符被过滤，然后整体重新请求。
  - 浪费额度，字幕出现闪断。
- **代码逻辑已确认；具体站点是否触发需要实测。**
- **建议最小修复**：id 改为 `` `web:${startTime}:${endTime}:${n}` ``，其中 `n` 是同一起止时间下相同文本的出现序号；或者用文本短哈希代替序号。
- **回归验证**：先给出 cue `[10,20]`，翻译完成后插入 cue `5`。断言 10 和 20 的 id 不变、`translated` 保留、没有新增对应的请求。

### 7. 【P3】音频结果的时间按 1 倍速估算，非 1 倍速播放时制造假停顿，模型一旦合并就整批失败

- **位置**：
  - `extension/background.js:316`：`start = currentTime - 7`，`end = currentTime`。
  - `extension/audio-processor.js:2`：7 秒是墙钟时间的采样长度。
- **触发条件**：`playbackRate` 不等于 1。例如 2 倍速时，7 秒采样实际覆盖约 14 秒视频，相邻两段之间会出现约 7 秒的“空隙”。
- **实际影响**：
  - 跨片段的句子无法合法合并，完整语句效果失效。
  - 如果模型仍然合并，服务端 `parseSegments` 返回 502“不能跨越明显停顿”（`server/core.mjs:179-180`），客户端随即暂停翻译。
- **建议最小修复**：`GET_PAGE_STATE` 带上 `video.playbackRate`，后台用 `7 * rate` 计算 `start`；或者由内容脚本记录上一段的结束时间，直接作为下一段的开始时间。
- **回归验证**：后台测试中 `pageState` 设 `{currentTime:28, playbackRate:2}`，断言 `AUDIO_RESULT.start === 14`。

### 8. 【P3】启动器复用任何响应 `/health` 的旧服务，升级文档引用了不存在的 `stop.cmd`

- **位置**：`start.ps1:31` 只看 `/health` 的 `ok`，不比对版本和运行目录；`README.md:51`（另有旧说明 `使用与升级说明-v0.3.10.md:9`）要求“先运行旧目录的 stop.cmd”。
- **触发条件**：
  - 快照中只有 `start.cmd`、`start.ps1`、`stop.ps1`，没有 `stop.cmd`。用户照文档找不到停止入口。
  - 如果旧版（例如 0.3.x）服务仍在 17865 端口运行，新版 `start.ps1` 会判定“已在运行”并直接复用。
- **实际影响**：
  - 0.4.0 扩展默认调用 `/translate-segments`。根据 CHANGELOG:3，这是 0.4.0 新增的接口，旧服务没有这个路由，会返回 404，随后暂停翻译。
  - 如果旧服务属于另一个运行目录，设置页打开时带的是新目录的配对码，与正在运行的服务不匹配，配对失败。
- **建议最小修复**：
  - `start.ps1` 带当前配对码调用 `/pairing`（返回中有 `version`），版本不是 `0.4.0` 或返回 401 时，明确报错并提示先执行 `stop.ps1`。
  - README:51 改为 `stop.ps1` 的实际执行方式，或补一个 `stop.cmd`。
- **回归验证**：`process.test.mjs` 模拟一个 `/pairing` 返回 0.3.14 的服务，断言启动器报错，并且不打开设置页。

**附带的文档偏差（不计入以上 8 项）**：README:21 和 :79 仍写“128 项自动测试”，与 VALIDATION 和 CHANGELOG 中的 157 项不一致。

---

## 二、需要实测的风险

- **R1：数值约束完全依赖模型自觉遵守。** 1.2 秒停顿和 12 秒上限只写在提示词里（`server/core.mjs:193`、`semantic-instructions.md:4`），Schema 无法表达。模型偶尔越界，就会触发 502，并暂停整个视频的翻译，而这次调用已经计费。建议实测越界率。可以在发送前按停顿超过 1.2 秒的边界把 items 切成独立子批次，或给每项附加 `breakBefore` 标记，减少模型出错的机会。
- **R2：完整语句模式会把中文字幕轨也送去模型。** 关闭该模式时，中文轨直接显示、零成本（`content.js:124,204`、`generic.js:74`）；开启后（默认），中文轨也走 `/translate-segments`。加上排序时中文轨优先（`content.js:214`），有中英双轨的视频会选中文轨做“中译中”。需要产品确认这是否有意为之；如果不是，建议中文轨只合并、不送模型，或改为优先选原语言轨。
- **R3：`/transcribe` 的等待接近 MV3 单次请求上限。** 客户端超时为 300 秒，再加上服务端串行队列（与翻译、预热共用），离 MV3 service worker 单个事件约 5 分钟的上限很近。建议在冷启动本地模型加上并发翻译的场景下实测，看后台是否被提前终止。

---

## 三、已核对、确认无需报告的防护

- 本机服务的 Host 和 Origin 校验、`timingSafeEqual` 鉴权。
- `storage.local` 设为 `TRUSTED_CONTEXTS`，内容脚本读不到配对码。
- 配对前先向服务验证。
- 付费 POST 不自动重试；进度模式下 HTTP 200 包裹的错误仍会被识别。
- 音频旧代次的取消与二次校验。
- 可选站点权限、内嵌播放器授权，以及撤销权限后的清理。
- 模型输出的 id 覆盖、顺序和数量校验（服务端 `parseSegments`、`parseTranslation`）。
- 本地 ASR 子进程的停止确认和 PID 归属校验。

这些路径都有对应实现，部分还有测试，本报告没有重复列出。