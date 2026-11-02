# Spotify 网页版广告跳过（Hardened）

一个跑在 Spotify Web Player 上的油猴脚本。识别到广告后清空广告音源，广告结束自动恢复播放；单轮有硬上限、整个广告会话有收敛，不会无限重试把播放器拖死。

- 安装（Greasy Fork）：https://greasyfork.org/zh-CN/scripts/603454
- 直接装（GitHub）：https://raw.githubusercontent.com/devycx/spotify-ad-skipper/main/spotify-ad-skipper.user.js
- 适用范围：`https://open.spotify.com/*`（桌面浏览器 + 支持油猴的移动浏览器）
- 版本：3.3.0

## 它做什么

1. 用 `document.createElement` 钩子登记所有 `<audio>` / `<video>`，再用 `HTMLMediaElement.prototype.play` 钩子记录"当前真正在播的那个"——Spotify 换曲、换广告都会新建或复用媒体节点。
2. 通过底栏的 `data-testid`、`aria-label`、链接 `href`（`/ad`、`/ads`、`/sponsored`）判断广告，**不靠时长**，所以不会把短歌误判成广告。
3. 命中广告就 `pause()` + `removeAttribute('src')` + `load()`，让广告流直接断掉。
4. 广告结束后等 800ms，优先点播放按钮恢复；点不动就调 `activeEl.play()`；还不行再兜底点一次"非暂停态"的按钮。三步都失败就停下，不循环点。
5. `MutationObserver` 盯底栏重绘，1 秒一次的 watchdog 兜底：底栏被 SPA 换掉会重新绑定，僵尸媒体节点会清理。

## 为什么是"清 src"而不是拖进度条

另一种写法是把广告 `currentTime` 拖到 `duration`，等于让它瞬间播完。问题是这要求媒体已经拿到 metadata——`readyState` 太低时给 `currentTime` 赋值会抛 `InvalidStateError`；而且拖完之后播放器仍停在广告上下文里，要等它自己切下一首。

这一版改成 `removeAttribute('src')` + `load()`：媒体元素直接失去数据源，播放器只能走"广告结束"分支。代价是页面状态会短暂错乱（按钮变灰、进度条归零），所以广告结束后有 800ms 的稳定等待和三级恢复兜底。

## 收敛（v3 的重点）

早期版本最危险的不是"跳不过广告"，是**跳不过还一直试**：每次轮询都清一次 src，播放器被反复打断，最后整页卡死。现在有三层限制：

| 限制 | 值 | 作用 |
| --- | --- | --- |
| `maxSkipTicks` / `maxSkipDurationMs` | 60 次 / 35s | 单轮跳过到点就收手 |
| `maxClearsPerAd` | 3 | 同一个广告会话最多清 3 次 src |
| `adSessionGaveUp` | — | 超限后只静音，不再动媒体节点 |

`adSessionGaveUp` 置位后不会再自动重试，直到确认切到正常内容路由（`/track`、`/album`、`/playlist`、`/search` 等）才重置会话。

## 已知边界

- **UI 改版会失效**：广告判定依赖 `data-testid` 和 `aria-label`，Spotify 换标记就要跟着改。
- **广告类型**：只处理媒体元素里的音频广告。页面级插屏、视频广告、以及服务端直接切流（不换 `src`）的情况不覆盖。
- **不是去广告会员**：跳过的是"这次播放"，不是"以后不再投放"。
- **可能误伤**：如果某首正片异常短、且底栏链接是 `/ad` 开头，会被当成广告。实际没见过，但逻辑上存在。
- **违反 Spotify 服务条款**：这只是本地 DOM/媒体 API 操作，不修改服务端数据，但用不用自己判断。

## 原始版本与许可

初版来自 [simonwep 的 gist](https://gist.github.com/simonwep/24f8cdcd6d32d86e929004013bd660ae)，这一版在它基础上重写了检测、恢复与收敛逻辑。MIT License，见 [LICENSE](LICENSE)。
