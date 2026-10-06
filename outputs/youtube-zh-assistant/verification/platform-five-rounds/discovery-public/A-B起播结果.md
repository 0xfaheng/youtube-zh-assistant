# 原生全新 Profile A/B 起播对照

四个样本各观察约 39 秒，不循环重试。共同配置：headed Edge、viewport 1365×900、Playwright launchPersistentContext、独立新 Profile、无扩展、继承 User HTTPS_PROXY/HTTP_PROXY，proxy bypass localhost/127.0.0.1/[::1]。A 无额外参数，B 只添加 `--autoplay-policy=no-user-gesture-required`。没有调用 `video.play()`，没有读取 token，所有媒体仅浏览器正常播放。

| 平台 | A/B | 39秒时 ready/time/decoded | DOM 英语字幕 | HTTP >=400 响应 |
|---|---|---|---|---|
| Dailymotion xaazv0o | A | 4 / 33.036963 / 996 | 默认未开，空 | 无 |
| Dailymotion xaazv0o | B | 0 / 0 / 0 | 空 | cdndirector.dailymotion.com xhr 403 |
| Khan Uiqro5TUyLA iframe | A | 4 / 20.163720 / 1213 | `.ytp-caption-segment` 持续改变 | 无 |
| Khan Uiqro5TUyLA iframe | B | 4 / 19.770006 / 1192 | `.ytp-caption-segment` 持续改变 | 无 |

所有样本 video.error 均为 null。DM B 的失败发生在无扩展环境，说明扩展不是这一失败的必要条件。单次 A/B 仅证明观察到的配置关联，不能据此断言 autoplay 参数导致 403；未越界扩大诊断或反复重试。

精确等待/正常点击：
- Dailymotion：普通 HTTPS 页 `goto waitUntil=domcontentloaded`，再等 15 秒，自动起播。A 到 elapsed 16.771 秒时已 ready4/time10.757/decoded327，没有任何播放点击。默认字幕未启用；之前软字幕正例的正常 `字幕` 开关已另行验证。
- Khan：DOM loaded 后等 15 秒，依次正常点击父页面 `Strictly Necessary Only` → `close`（捐赠横幅）→ `Close Sign Up Banner` → `Dismiss banner.` → `Play video`。每项在可见时才点，exact=true；不是 iframe 的初始 Play video。A 最后 Play 点击 elapsed17.642秒，B elapsed18.189秒；此后5秒均 ready4、time约3.8–4.0秒且英语字幕出现。默认字幕无需额外开启。

证据：
- `ab-dm-A-2026-10-05T03-06-11-430Z.json`
- `ab-dm-B-2026-10-05T03-07-04-633Z.json`
- `ab-khan-A-2026-10-05T03-07-46-603Z.json`
- `ab-khan-B-2026-10-05T03-08-27-603Z.json`

脚本：`ab-native.cjs`。各样本正常关闭浏览器，未改生产源码或主代理测试配置。
