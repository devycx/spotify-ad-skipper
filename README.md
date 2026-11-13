# Spotify Ad Skipper

A lightweight **audio ad blocker for the Spotify Web Player**: it detects ads, cuts their media source, and resumes your music when the ad ends. Every ad and every ad session is capped, so it never retries forever and drags the player down.

**English** | [简体中文](README.zh-CN.md)

- Install (Greasy Fork): https://greasyfork.org/en/scripts/603454
- Direct install (GitHub): https://raw.githubusercontent.com/devycx/spotify-ad-skipper/main/spotify-ad-skipper.user.js
- Works on: `https://open.spotify.com/*` (desktop browsers and mobile browsers with userscript support)
- Version: 3.5.1

## What it does

1. Hooks `document.createElement` to register every `<audio>` / `<video>`, then hooks `HTMLMediaElement.prototype.play` to track the element that is actually playing. Spotify creates or reuses media elements whenever it switches tracks or ads.
2. Detects ads from the now-playing bar using `data-testid`, `aria-label`, and link `href` (`/ad`, `/ads`, `/sponsored`). It does **not** use duration, so a short song is not mistaken for an ad.
3. On a hit, it calls `pause()` + `removeAttribute('src')` + `load()`, which cuts the ad stream.
4. After the ad, it waits 800 ms and tries to resume in three steps: click the Play button, call `activeEl.play()`, then click the button once more if it is not in a paused state. It stops after all three fail instead of clicking in a loop.
5. A `MutationObserver` watches the bar, and a 1-second watchdog catches the rest: the observer is re-bound when the SPA replaces the bar, and zombie media elements are cleaned up.
6. A connection guard detects a frozen player after backgrounding or a network switch, then tries a lightweight recovery before falling back to a reload (see below).

## Why clear `src` instead of seeking

The other common approach is to set the ad's `currentTime` to its `duration`, which makes it finish instantly. That requires the media to have metadata: assigning `currentTime` while `readyState` is too low throws `InvalidStateError`. Even after seeking, the player stays in the ad context and waits for Spotify to switch tracks.

This version uses `removeAttribute('src')` + `load()` instead: the media element loses its source, so the player has to take the "ad ended" branch. The tradeoff is a brief inconsistent UI (greyed-out controls, progress reset), which is why there is an 800 ms settle delay and a three-stage resume fallback.

## Convergence (the point of v3)

The dangerous failure mode in early versions was not "the ad was not skipped" but **"the ad was not skipped and the script kept trying"**: every poll cleared `src` again, the player was interrupted repeatedly, and the whole page eventually froze. There are now three limits:

| Limit | Value | Purpose |
| --- | --- | --- |
| `maxSkipTicks` / `maxSkipDurationMs` | 60 ticks / 35s | Stop a single skip cycle at the cap |
| `maxClearsPerAd` | 3 | Clear `src` at most 3 times for the same ad |
| `adSessionGaveUp` | — | After the cap, only mute; never touch the media element again |

Once `adSessionGaveUp` is set, the script does not retry automatically. It resets only after it confirms a normal content route (`/track`, `/album`, `/playlist`, `/search`, etc.).

## Connection guard (v3.4)

After you background the tab, switch Wi-Fi/5G, or change proxy nodes on mobile, Spotify's connect WebSocket often stalls: the UI is still there, playback stops, and pressing Play does nothing. A full page reload used to be the only fix. v3.4 adds three checks to the watchdog:

1. `<audio>` is playing, but `currentTime` has not moved for 10 seconds.
2. The bar shows "Pause", but the media element has been `paused` for more than 5 seconds.
3. You click Play, and playback still has not started after 7 seconds.

If any check matches, the script first dispatches an `online` event and calls `activeEl.play()` once. If playback is still broken after 7 seconds and a same-origin favicon probe shows the network is reachable, it reloads the page automatically (at most once every 3 minutes), then tries to click Play after the reload. A toast at the top of the page explains what is happening; it never reloads silently.

The WebSocket hook records unclean closes of the Spotify connect socket as a secondary signal. It does not rebuild the connection; the real last resort is still the reload.

**What the script cannot handle:** if Quetta or Xiaomi freezes or kills the tab, the script never gets a chance to run. For reliable background playback you still need:

- Quetta: disable background tab freezing/auto-cleanup, lock the Spotify tab, and whitelist `spotify.com`, `scdn.co`, `spotifycdn.com`, `apresolve.spotify.com`, and `spclient.wg.spotify.com` in your ad blocker.
- Xiaomi: Settings → Apps → Manage apps → Quetta → Battery saver → **No restrictions**, allow background activity/autostart, lock Quetta in Recents, and disable system battery saver while testing.
- Proxy/VPN: do not switch nodes during playback; make sure Spotify's HTTPS and WSS traffic use the same route.
- Turn off "Pause cached apps" / "Don't keep activities" in Developer options.

To disable automatic reloads, set `CONFIG.autoReload` to `false` at the top of the file. The detection and lightweight recovery still work.

## FAQ: can the heart button appear on the lock-screen media card?

No. A web page can only control the Media Session API, whose actions are a fixed enum (`play`, `pause`, `previoustrack`, `nexttrack`, `seekto`, …). There is no `like` action and no way to add custom buttons; Android renders the media card from that enum, so a web page cannot add an icon to it. The most a userscript can do is add a floating heart button in the page, not on the lock screen.

To like a track from the lock screen, use the native client, or build a separate notification with Tasker/MacroDroid + the Spotify Web API (which needs OAuth and current-track sync, so it is considerably more work).

## Known limits

- **UI changes break detection**: ad detection depends on `data-testid` and `aria-label`; if Spotify changes those markers, the script needs an update.
- **Ad types**: it only handles audio ads inside media elements. Page-level interstitials, video ads, and server-side stream switches that do not change `src` are not covered.
- **Not an ad-free membership**: it skips *this playback*, not *future ad delivery*.
- **Possible false positive**: if a real track is unusually short and the bar link starts with `/ad`, it can be treated as an ad. This has not been observed in practice, but the logic allows it.
- **Spotify Terms of Service**: this is local DOM/media API manipulation and does not modify server data, but whether to use it is your call.

## UI language

The script follows the browser language. English is the default; Simplified Chinese is included. To force a language, set `CONFIG.locale` to `'en'` or `'zh-CN'` at the top of the file.

## Original version and license

The first version came from [simonwep's gist](https://gist.github.com/simonwep/24f8cdcd6d32d86e929004013bd660ae). This version rewrites the detection, recovery, and convergence logic on top of it. MIT License, see [LICENSE](LICENSE).
