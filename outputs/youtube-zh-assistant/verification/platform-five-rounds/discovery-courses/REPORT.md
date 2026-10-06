# edX、Udemy、Coursera 公开样本发现结果

时间：2026-10-05；环境：隔离 Edge Profile、Playwright、用户 HTTPS_PROXY，未登录。只浏览正常 HTTPS 页面并点击公开课程内容/注册入口。没有调用模型、读取 token、下载媒体、绕过验证或修改生产文件。

结论：本次没有获得这三个平台可直接用于真实字幕播放测试的公开原生视频。下列页面可作为真实访问限制/空播放器负向样本，不能记为字幕通过。所有实际渲染 frame 的 video 数量均为 0，因此 currentTime、readyState、textTracks 均应记 `null / not available`，不能虚写为 0、readyState 4 或已播放。

| 平台/样本 | 实际访问与行为 | 分类与证据 |
| --- | --- | --- |
| edX CS50 | https://www.edx.org/learn/computer-science/harvard-university-cs50-s-introduction-to-computer-science ，HTTP 200；显示课程介绍、Audit course，无实际 video、视频 iframe 或 Play Video 控件 | `public-page-no-player`。`edx-initial.json`、`edx-initial.png`、`edx-network.json`。没有点击 Audit course。 |
| edX 原生 DemoX | [官方 Videos on edX 深链](https://learning.edx.org/course/course-v1:edX%2BDemoX.1%2B2T2019/block-v1:edX%2BDemoX.1%2B2T2019%2Btype@sequential%2Bblock@ec3364075f2845baa625bfecd5970410/block-v1:edX%2BDemoX.1%2B2T2019%2Btype@vertical%2Bblock@4ebaf48ef09c410a95404165c7f1e52c) ，HTTP 200 壳页；显示 Working with Videos iframe、注册/登录、意外错误与“再试一次” | `unauthenticated-api-401-no-player`。courses.edx.org 的 xhr 4 次 401，edx-exams.edx.org 的 xhr 1 次 401；所有 frame 无 video。`edx-native-demo-initial.json`、`edx-native-demo-initial.png`、`edx-native-demo-network.json`。 |
| Udemy Web Development Bootcamp | https://www.udemy.com/course/100-days-of-code-web-development-bootcamp/ ，HTTP 403，Cloudflare“正在进行安全验证” | `security-challenge`。`udemy-initial.json`、`udemy-initial.png`、`udemy-network.json`。未点击验证、未重试解题。 |
| Coursera Learning How to Learn | https://www.coursera.org/learn/learning-how-to-learn ，HTTP 200；正常展开第一单元及内容列表，共列出 15 个视频标题，没有 video/播放器或讲座链接；点击“马上注册” | `login-gate`。真实弹出“登录或创建账户”，邮箱为空，没有提交。`coursera-initial.json` 中 before/module/content/gate 记录各阶段；`coursera-initial.png` 是登录模态截图；`coursera-network.json`。 |
| Coursera Machine Learning | https://www.coursera.org/learn/machine-learning ，HTTP 200，中文“有监督的机器学习：回归与分类”课程页，没有 video、iframe、播放入口 | `public-page-no-player`。`coursera2-initial.json`、`coursera2-initial.png`、`coursera2-network.json`。 |

## 可重复正常操作

Coursera 第一课程当前渲染语言为简体中文：

```js
await page.goto('https://www.coursera.org/learn/learning-how-to-learn');
await page.getByRole('button', { name: /什么是学习？/ }).first().click();
await page.getByRole('button', { name: '显示有关单元内容的信息', exact: true }).click();
await page.getByRole('button', { name: '马上注册', exact: true }).first().click();
// 可见“登录或创建账户”，以及以下已观察到的模态控件；不要输入或提交。
page.getByRole('button', { name: '关闭模式', exact: true });
page.getByRole('button', { name: '继续', exact: true });
```

英文页面应按实际文本定位 Module details/Show info about module content/Enroll now；本次仅验证中文定位器。edX DemoX 正常导航即可重现错误，iframe 定位器为 `page.frameLocator('iframe[title="Working with Videos"]')`。不存在已验证的 Play/CC 定位器。

## 有限替代检查

- https://teach.udemy.com/publishing/promo-video/ 是官方 promo-video 指南，实际 HTTP 200，但渲染页面没有 video 或视频 iframe，只有文章和辅助 iframe；证据 `udemy-demo-*`。不能把文章里“Watch the video”当作已播放。
- https://business-support.edx.org/hc/en-us/articles/14112926380311-Video-the-edX-Learning-Experience 实际 HTTP 403 Cloudflare 验证；证据 `edx-demo-*`。未绕过。

## 权威来源与适用边界

- [edX 官方播放器帮助](https://support.edx.org/hc/en-us/articles/360000222027-Watching-videos-on-the-edX-video-player)直接链接上述 DemoX 单元，并说明 CC、transcript 和语言菜单；这是入口合法性的依据，不是本次视频成功的证明。
- [edX 官方 DemoX 帮助](https://support.edx.org/hc/en-us/articles/207205937-Is-there-a-walk-through-of-a-sample-course)说明 DemoX 为演示课程且引导报名。
- [Udemy 官方预览说明](https://support.udemy.com/hc/en-us/articles/229231027-How-to-preview-and-compare-courses)说明正常入口为 Preview This Course；本次课程页先遭 403，无法达到该入口。
- [Coursera 官方新预览说明](https://blog.coursera.org/introducing-courseras-new-course-preview-experience/)说明多数课程首模块免费预览；本次未登录访问依然触发登录模态，因此“免费”不能推定为匿名可播。

脚本 `discover.cjs` 可重新运行，只使用隔离 `profile-*` 目录。所有 network JSON 只保留域名/type/status，无 URL query。DOM 快照中的 URL 去除了 query/hash，没有输出媒体源或授权参数。Profile 仅为临时浏览器隔离产物，不是字幕通过或模型调用证明。

验收限制：这里只负责发现/实际访问样本；没有加载扩展、执行五轮或测试翻译。主代理应将这些平台的本轮字幕播放结果记为受访问限制、未覆盖，不能记为成功。
