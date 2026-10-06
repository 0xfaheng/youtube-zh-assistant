# DM CC 窄诊断（2026-10-05）

仅测试 `https://www.dailymotion.com/video/xaazv0o`，两个全新原生 Edge Profile，headed、1365×900、无扩展、无 autoplay 参数、继承 User proxy。未调用模型、未读取 token、未 force click、未脚本改字幕状态。两次均未起播，停止重试。

第一尝试 `03-18-38-411Z`：DOMContentLoaded后15秒，ready0/time0/decoded0，字幕按钮不存在。video.hover超时；iframe bbox鼠标移动成功，但字幕click超时。之后对不存在按钮做boundingBox读取也超时，脚本退出；只有逐步PNG与命令输出，没有完整最终JSON。浏览器进程已检查清理。

第二尝试 `03-19-32-740Z`：完整逐步记录 `dm-cc-2026-10-05T03-19-32-740Z.json`，PNG同前缀。等待15秒后到31.453秒仍ready0/time0/decoded0，error=null；HTTP `cdndirector.dailymotion.com xhr403`。截图显示回放错误。字幕按钮不存在，无法记录aria-pressed/class/title（结果是button:null，不是空属性的可用按钮）。video.hover与正常click各超时2.5秒，普通鼠标移动成功。

字幕DOM：`.subtitles_placeholder` 空，display:none、visibility:visible、opacity:1、pointerEvents:none、rect0×0。共同 `.player.video_player` contains video/caption均true；video父级 `.video_view` contains caption=false。

本次不能证明主代理已正常起播状态下的CC步骤是否可靠；不能把这两次加载失败误判为扩展字幕实现失败或CC按钮点击缺陷。此前同URL成功记录已经确认正常字幕点击后有英语DOM（见 `dm3-2026-10-05T03-00-43-134Z-cc-menu.json/png`），但这不是本轮新Profile稳定复现。

此前成功的普通交互代码（需要先确认当前视频确实起播；本轮未重新验证成功）：

```js
await page.goto(url, {waitUntil: 'domcontentloaded'});
await page.waitForTimeout(15000);
const frame = page.frames().find(f => f.url().includes('geo.dailymotion.com/player/'));
const loaded = await frame.evaluate(() =>
  [...document.querySelectorAll('video')].some(v => v.readyState >= 2 && v.currentTime > 0));
if (!loaded) throw new Error('DM media not loaded; cannot verify CC');
const box = await (await frame.frameElement()).boundingBox();
await page.mouse.move(box.x + box.width / 2, Math.min(box.y + box.height - 40, 860));
await page.waitForTimeout(300);
await frame.locator('button[aria-label="字幕"]').click({timeout: 2500});
await page.waitForTimeout(5000);
const caption = await frame.locator('.subtitles_placeholder').innerText();
```

新Profile默认字幕未开时点击一次；已有字幕时再次点击会关闭。不要依赖 video.hover：视频可能被播放器覆盖层挡住，即使播放器本身可以正常交互。
