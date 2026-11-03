// ==UserScript==
// @name         Spotify 网页版广告跳过（Hardened）
// @name:en      Spotify Ad Skipper (Hardened)
// @namespace    https://github.com/devycx/spotify-ad-skipper
// @version      3.4.0
// @description  跳过 Spotify 网页版广告：识别到广告后清空广告音源，广告结束自动恢复播放；单轮有硬上限、整个广告会话有收敛；并带连接守护，后台/切网后播放器假死可自动恢复，必要时自动刷新
// @description:en  Skip ads on the Spotify web player: clears the ad media source, then resumes playback. Hard-capped per ad and converged per ad session, so it never retries forever. Also detects a dead player connection after backgrounding/network switch and recovers (reload as a last resort).
// @author       simonwep (original) / devycx (hardened)
// @license      MIT
// @homepageURL  https://github.com/devycx/spotify-ad-skipper
// @supportURL   https://github.com/devycx/spotify-ad-skipper/issues
// @icon         https://raw.githubusercontent.com/devycx/spotify-ad-skipper/main/icon.png
// @match        https://open.spotify.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        barTimeoutMs: 15000,
        skipCheckIntervalMs: 300,
        watchdogIntervalMs: 1000,      // 1s 巡检底栏重绘与僵尸节点
        maxSkipTicks: 60,              // 单轮硬上限：约 18 秒
        maxSkipDurationMs: 35000,
        adEndConfirmTicks: 2,          // 连续 2 次确认广告结束
        emptyHrefGraceTicks: 5,        // 清除 src 后允许链接短暂为空的过渡周期（约 1.5 秒）
        resumeDelayMs: 800,            // 恢复前等待 Spotify 状态机稳定
        playFallbackDelayMs: 500,      // 提升至 500ms，为慢加载设备的 activeEl.play() 提供安全缓冲
        maxClearsPerAd: 3,             // 整个广告会话周期最多清 src 3 次（跨轮次持久）
        maxTrackedElements: 6,         // 离屏媒体实例最大保留数

        // ---- 连接守护：移动端后台/切网后 connect WebSocket 假死 ----
        connGuard: true,
        stallMs: 10000,                // 媒体在播但进度 10 秒不动
        brokenConfirmMs: 5000,         // 疑似假死持续 5 秒才动手
        backgroundCheckMs: 15000,      // 后台超过 15 秒，回前台才做检查
        resumeCheckDelayMs: 5000,      // 回前台/重新联网后等 5 秒再看
        recoverProbeMs: 7000,          // 轻量恢复后等 7 秒验收
        autoReload: true,              // 仍假死且网络能通 → 自动刷新
        reloadCooldownMs: 180000,      // 两次自动刷新至少间隔 3 分钟
        debug: false,
    };

    const BAR_SELECTORS = [
        '[data-testid="now-playing-bar"]',
        '.now-playing-bar',
        '.Root__now-playing-bar',
    ].join(',');

    const AD_HREF_RE = /^\/(ad|ads|sponsored)\b/i;
    // 补全常见正常内容页路由，确保切回正片时能可靠触发会话重置
    const NORMAL_CONTENT_HREF_RE = /^\/(track|episode|album|playlist|artist|show|mix|radio|search|collection|user|concert)\b/i;
    const AD_TEXT_RE = /^(advertisement|sponsored|spotify\s*ad|广告|廣告)$/i;

    // 英文保留 \b 防止匹配 playlist/player；中文去尾锚以兼容“播放音乐”、“暂停播放”等组合词
    const PLAY_LABEL_RE = /^(?:(play|resume)\b|播放)/i;
    const PAUSE_LABEL_RE = /^(?:pause\b|暂停|暫停)/i;

    // 严格校验播放/暂停按钮，绝不误触 Shuffle / Previous / Next / Repeat
    const PLAY_BUTTON_FNS = [
        (root) => root.querySelector('[data-testid="control-button-playpause"]'),
        (root) => {
            const buttons = root.querySelectorAll(
                '.player-controls__buttons button, [data-testid="now-playing-bar"] button'
            );
            for (const btn of buttons) {
                const title = (btn.getAttribute('title') || '').trim();
                const aria = (btn.getAttribute('aria-label') || '').trim();
                if (
                    PLAY_LABEL_RE.test(title) || PAUSE_LABEL_RE.test(title) ||
                    PLAY_LABEL_RE.test(aria) || PAUSE_LABEL_RE.test(aria)
                ) {
                    return btn;
                }
            }
            return null;
        },
    ];

    const log = (...args) => { if (CONFIG.debug) console.log('[AdSkipper]', ...args); };
    const warn = (...args) => { console.warn('[AdSkipper]', ...args); };
    const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    function getBarRoot() {
        return (currentBar && currentBar.isConnected) ? currentBar : document;
    }

    function queryFirstFn(fns, root = document) {
        for (const fn of fns) {
            try {
                const el = fn(root);
                if (el && el.isConnected) return el;
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    function queryAsync(selectorOrFn, timeoutMs, pollMs = 100) {
        return new Promise((resolve, reject) => {
            const finder = typeof selectorOrFn === 'function'
                ? selectorOrFn
                : () => document.querySelector(selectorOrFn);
            let settled = false, interval = null, timer = null;
            const cleanup = () => {
                settled = true;
                if (interval) clearInterval(interval);
                if (timer) clearTimeout(timer);
            };
            const check = () => {
                if (settled) return;
                let el = null;
                try { el = finder(); } catch (e) { /* ignore */ }
                if (el) { cleanup(); resolve(el); }
            };
            check();
            if (settled) return;
            interval = setInterval(check, pollMs);
            timer = setTimeout(() => {
                if (settled) return;
                cleanup();
                reject(new Error('queryAsync timeout'));
            }, timeoutMs);
        });
    }

    // ==================== 状态 ====================
    const trackedElements = new Set();
    let mediaElement = null;
    let playButton = null;
    let currentBar = null;
    let barObserver = null;
    let watchdogInterval = null;
    let skipInterval = null;
    let skipDebounce = null;
    let bodyCheckTimer = null;
    let resumeTimer = null;

    // 连接守护状态
    let hiddenAt = 0;
    let lastAdvanceAt = Date.now();
    let lastMediaTime = -1;
    let brokenSince = 0;
    let lastRecoveryAt = 0;
    let pendingRecoveryReason = '';
    let connEventsBound = false;
    let recoveryTimer = null;
    let recoveryProbeTimer = null;
    let reloadTimer = null;
    let visualCheckTimer = null;
    let toastEl = null;
    let toastTimer = null;

    let skipActive = false;
    let skipStart = 0;
    let currentSkipTicks = 0;
    let adEndConfirmCount = 0;
    let wePausedIt = false;
    let lastClearedSrc = '';

    // 跨 skip 周期持久化的广告会话状态
    let adSessionClears = 0;
    let adSessionGaveUp = false;

    // ==================== 媒体节点生命周期与拦截 ====================
    (function injectMediaHooks() {
        try {
            const Doc = pageWindow.Document;
            if (Doc && Doc.prototype) {
                const origCreate = Doc.prototype.createElement;
                if (typeof origCreate === 'function' && !origCreate.__adSkipperPatchedV3) {
                    const patched = function (tagName, options) {
                        const el = origCreate.call(this, tagName, options);
                        try {
                            const tag = String(tagName).toLowerCase();
                            if (tag === 'video' || tag === 'audio') registerMediaElement(el);
                        } catch (e) { /* ignore */ }
                        return el;
                    };
                    patched.__adSkipperPatchedV3 = true;
                    Doc.prototype.createElement = patched;
                }
            }

            const MediaProto = pageWindow.HTMLMediaElement && pageWindow.HTMLMediaElement.prototype;
            if (MediaProto && typeof MediaProto.play === 'function' && !MediaProto.play.__adSkipperPatchedV3) {
                const origPlay = MediaProto.play;
                const patchedPlay = function (...args) {
                    try {
                        registerMediaElement(this);
                        this.__lastActiveAt = Date.now();
                        mediaElement = this;
                    } catch (e) { /* ignore */ }
                    return origPlay.apply(this, args);
                };
                patchedPlay.__adSkipperPatchedV3 = true;
                MediaProto.play = patchedPlay;
            }
            log('media hooks installed');
        } catch (e) {
            log('injectMediaHooks failed', e);
        }
    })();

    // WebSocket 要在页面主包建连之前挂上，才能记到 Spotify connect 连接的断开
    injectConnHooks();

    function hasMediaSource(el) {
        if (!el) return false;
        return Boolean(el.currentSrc || el.src || el.getAttribute('src') || el.srcObject);
    }

    function isMediaElementDead(el) {
        if (!el || !trackedElements.has(el)) return true;
        if (el.isConnected) {
            el.__everConnected = true;
            return false;
        }
        return Boolean(el.__everConnected);
    }

    function muteElementSafely(el) {
        if (!el) return;
        try {
            if (!el.muted) {
                el.muted = true;
                el.__adSkipperMuted = true;
            }
        } catch (e) { /* ignore */ }
    }

    function restoreMutedElements() {
        for (const el of trackedElements) {
            if (el.__adSkipperMuted) {
                try { el.muted = false; } catch (e) { /* ignore */ }
                el.__adSkipperMuted = false;
            }
        }
    }

    function resetAdSession() {
        if (adSessionClears > 0 || adSessionGaveUp) {
            log('ad session reset');
        }
        adSessionClears = 0;
        adSessionGaveUp = false;
        lastClearedSrc = '';
        restoreMutedElements();
    }

    function registerMediaElement(el) {
        if (!el || trackedElements.has(el)) return;
        const now = Date.now();
        el.__everConnected = Boolean(el.isConnected);
        el.__createdAt = now;
        el.__lastActiveAt = now;
        el.__adSkipperMuted = false;
        trackedElements.add(el);

        if (!mediaElement || isMediaElementDead(mediaElement) || (!hasMediaSource(mediaElement) && mediaElement.paused)) {
            mediaElement = el;
        }
        log('media element registered:', el.tagName);

        const onActivate = () => {
            if (el.isConnected) el.__everConnected = true;
            el.__lastActiveAt = Date.now();
            lastAdvanceAt = Date.now(); // 新一次播放从这里重新计时
            if (hasMediaSource(el) || !el.paused) {
                mediaElement = el;
            }
        };

        el.addEventListener('play', onActivate, { passive: true });
        el.addEventListener('loadedmetadata', onActivate, { passive: true });
        el.__adSkipperOnActivate = onActivate;

        try {
            const mo = new MutationObserver(() => {
                if (el.isConnected) el.__everConnected = true;
                el.__lastActiveAt = Date.now();
                if (hasMediaSource(el)) mediaElement = el;
                if (!skipActive && isAdPlayingStrong()) {
                    scheduleSkip();
                }
            });
            mo.observe(el, { attributes: true, attributeFilter: ['src'] });
            el.__adSkipperSrcObserverV3 = mo;
        } catch (e) { /* ignore */ }

        pruneTrackedElements();
    }

    function cleanupMediaElement(el) {
        if (!el) return;
        if (el.__adSkipperSrcObserverV3) {
            try { el.__adSkipperSrcObserverV3.disconnect(); } catch (e) { /* ignore */ }
            el.__adSkipperSrcObserverV3 = null;
        }
        if (el.__adSkipperOnActivate) {
            try {
                el.removeEventListener('play', el.__adSkipperOnActivate);
                el.removeEventListener('loadedmetadata', el.__adSkipperOnActivate);
            } catch (e) { /* ignore */ }
            el.__adSkipperOnActivate = null;
        }
        trackedElements.delete(el);
        if (mediaElement === el) mediaElement = null;
    }

    function pruneTrackedElements() {
        const now = Date.now();
        for (const el of Array.from(trackedElements)) {
            if (el.isConnected) el.__everConnected = true;

            if (el.__everConnected && !el.isConnected) {
                cleanupMediaElement(el);
                continue;
            }
            if (
                el !== mediaElement &&
                el.paused &&
                !hasMediaSource(el) &&
                now - (el.__createdAt || 0) > 10000
            ) {
                cleanupMediaElement(el);
            }
        }

        if (trackedElements.size > CONFIG.maxTrackedElements) {
            for (const el of Array.from(trackedElements)) {
                if (trackedElements.size <= CONFIG.maxTrackedElements) break;
                if (el !== mediaElement && el.paused) {
                    cleanupMediaElement(el);
                }
            }
        }
    }

    function getActiveMediaElement() {
        pruneTrackedElements();

        for (const el of trackedElements) {
            if (!el.paused) {
                mediaElement = el;
                return el;
            }
        }

        if (mediaElement && !isMediaElementDead(mediaElement) && hasMediaSource(mediaElement)) {
            return mediaElement;
        }

        let mostRecentWithSrc = null;
        let mostRecentAny = null;
        let maxSrcTime = -1;
        let maxAnyTime = -1;

        for (const el of trackedElements) {
            if (isMediaElementDead(el)) continue;
            const activeTime = el.__lastActiveAt || el.__createdAt || 0;
            if (activeTime >= maxAnyTime) {
                maxAnyTime = activeTime;
                mostRecentAny = el;
            }
            if (hasMediaSource(el) && activeTime >= maxSrcTime) {
                maxSrcTime = activeTime;
                mostRecentWithSrc = el;
            }
        }

        mediaElement = mostRecentWithSrc || mostRecentAny || null;
        return mediaElement;
    }

    // ==================== 播放按钮与状态判定 ====================
    function getPlayButton() {
        const root = getBarRoot();
        const btn = queryFirstFn(PLAY_BUTTON_FNS, root) || (root !== document ? queryFirstFn(PLAY_BUTTON_FNS, document) : null);
        if (btn) {
            playButton = btn;
            return btn;
        }
        if (playButton && playButton.isConnected) return playButton;
        playButton = null;
        return null;
    }

    function buttonShowsPause(btn = getPlayButton()) {
        if (!btn) return false;
        const title = (btn.getAttribute('title') || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        return PAUSE_LABEL_RE.test(title) || PAUSE_LABEL_RE.test(aria);
    }

    function buttonShowsPlay(btn = getPlayButton()) {
        if (!btn) return false;
        const title = (btn.getAttribute('title') || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        const isPlay = PLAY_LABEL_RE.test(title) || PLAY_LABEL_RE.test(aria);
        const isPause = PAUSE_LABEL_RE.test(title) || PAUSE_LABEL_RE.test(aria);
        return isPlay && !isPause;
    }

    // ==================== 广告检测 ====================
    function getNowPlayingLink() {
        const root = getBarRoot();
        return queryFirstFn([
            (r) => r.querySelector('[data-testid="now-playing-widget"] a[href]'),
            (r) => r.querySelector('[data-testid="context-item-info-title"] a'),
            (r) => r.querySelector('.now-playing-bar .now-playing a'),
            (r) => r.querySelector('.now-playing > a'),
        ], root);
    }

    function isAdPlayingStrong() {
        try {
            const root = getBarRoot();
            if (root.querySelector('[data-testid="context-item-info-ad-subtitle"]')) return true;
            if (root.querySelector('[data-testid="context-item-info-ad-title"]')) return true;
            if (root.querySelector('[data-testid="now-playing-widget"][aria-label*="Advertisement" i]')) return true;
            if (root.querySelector('[data-testid="now-playing-widget"][aria-label*="广告"]')) return true;

            const subEl = root.querySelector(
                '[data-testid="context-item-info-subtitles"], [data-testid="context-item-info-artist"]'
            );
            if (subEl && AD_TEXT_RE.test((subEl.textContent || '').trim())) return true;

            const link = getNowPlayingLink();
            if (link) {
                const href = link.getAttribute('href') || '';
                if (AD_HREF_RE.test(href)) return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function isAdPlaying() {
        if (isAdPlayingStrong()) return true;
        if (!skipActive) return false;

        try {
            const link = getNowPlayingLink();
            if (link) {
                const href = link.getAttribute('href') || '';
                if (AD_HREF_RE.test(href)) return true;
                if (!href && currentSkipTicks <= CONFIG.emptyHrefGraceTicks) return true;
            } else if (currentSkipTicks <= CONFIG.emptyHrefGraceTicks) {
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    // ==================== 跳过广告 ====================
    function scheduleSkip() {
        if (skipDebounce || skipActive) return;

        if (adSessionGaveUp) {
            const el = getActiveMediaElement();
            if (el) muteElementSafely(el);
            return;
        }

        skipDebounce = setTimeout(() => {
            skipDebounce = null;
            skipAd();
        }, 50);
    }

    function skipAd() {
        if (skipActive || adSessionGaveUp) return;
        const el = getActiveMediaElement();
        if (!el) { log('skipAd: no active media element'); return; }
        if (!isAdPlayingStrong()) { log('skipAd: strong signal gone'); return; }

        if (resumeTimer) {
            clearTimeout(resumeTimer);
            resumeTimer = null;
        }

        skipActive = true;
        skipStart = Date.now();
        currentSkipTicks = 0;
        adEndConfirmCount = 0;
        wePausedIt = false;

        log(`skipping ad (session clears so far: ${adSessionClears})`);
        clearAdMedia(el);
        startSkipInterval();
    }

    function clearAdMedia(el) {
        if (!el || isMediaElementDead(el)) return false;
        const currentSrc = el.currentSrc || el.src || el.getAttribute('src') || '';

        if (adSessionClears >= CONFIG.maxClearsPerAd) {
            muteElementSafely(el);
            return false;
        }

        if (adSessionClears > 0 && (currentSrc === '' || currentSrc === lastClearedSrc)) {
            try {
                if (!el.paused) { el.pause(); wePausedIt = true; }
            } catch (e) { /* ignore */ }
            return false;
        }

        try {
            if (!el.paused) el.pause();
            el.removeAttribute('src');
            el.load();
            wePausedIt = true;
            lastClearedSrc = currentSrc;
            adSessionClears++;
            log(`clearAdMedia #${adSessionClears}/${CONFIG.maxClearsPerAd}`);
            return true;
        } catch (e) {
            log('clearAdMedia failed', e);
            return false;
        }
    }

    function startSkipInterval() {
        if (skipInterval) return;

        skipInterval = setInterval(() => {
            currentSkipTicks++;
            const elapsed = Date.now() - skipStart;
            const hardCap = currentSkipTicks >= CONFIG.maxSkipTicks || elapsed >= CONFIG.maxSkipDurationMs;
            const ad = isAdPlaying();

            if (!ad) {
                adEndConfirmCount++;
                if (adEndConfirmCount >= CONFIG.adEndConfirmTicks || hardCap) {
                    finishSkip(false);
                }
                return;
            }

            adEndConfirmCount = 0;

            if (hardCap) {
                warn(`Ad still present after ${adSessionClears} clears / ${elapsed}ms; muting until ad finishes.`);
                adSessionGaveUp = true;
                finishSkip(true);
                return;
            }

            const el = getActiveMediaElement();
            if (el) {
                if (isAdPlayingStrong()) {
                    clearAdMedia(el);
                } else {
                    try {
                        if (!el.paused) {
                            el.pause();
                            wePausedIt = true;
                        }
                    } catch (e) { /* ignore */ }
                }
            }
        }, CONFIG.skipCheckIntervalMs);
    }

    function stopSkipInterval() {
        if (skipInterval) {
            clearInterval(skipInterval);
            skipInterval = null;
        }
    }

    function finishSkip(gaveUp = false) {
        stopSkipInterval();
        skipActive = false;
        const didPause = wePausedIt;
        wePausedIt = false;

        if (gaveUp) {
            const activeEl = getActiveMediaElement();
            if (activeEl) {
                muteElementSafely(activeEl);
                if (didPause && activeEl.paused) {
                    try { activeEl.play().catch(() => {}); } catch (e) { /* ignore */ }
                }
            }
            return;
        }

        restoreMutedElements();

        if (!didPause) {
            resetAdSession();
            log('ad ended, no resume needed');
            return;
        }
        log(`ad ended (session cleared ${adSessionClears}x), scheduling resume`);

        resumeTimer = setTimeout(() => {
            resumeTimer = null;
            if (skipActive || isAdPlayingStrong()) {
                log('resume aborted: ad active again');
                return;
            }

            resetAdSession();

            const activeEl = getActiveMediaElement();
            if (!activeEl || isMediaElementDead(activeEl)) {
                log('resume aborted: no alive mediaElement');
                return;
            }
            if (!activeEl.paused) {
                log('resume skipped: active media already playing');
                return;
            }

            const btn = getPlayButton();

            if (btn && buttonShowsPlay(btn)) {
                try {
                    btn.click();
                    log('resume click sent (Play button)');
                    return;
                } catch (e) { /* ignore */ }
            }

            const triggerButtonFallback = () => {
                if (skipActive || isAdPlayingStrong()) return;
                const currentEl = getActiveMediaElement();
                if (currentEl && !currentEl.paused) return;
                const currentBtn = getPlayButton();
                if (currentBtn && !buttonShowsPause(currentBtn)) {
                    try {
                        currentBtn.click();
                        log('resume fallback click sent (!Pause button)');
                    } catch (e) { /* ignore */ }
                }
            };

            let fallbackDone = false;
            const runFallbackOnce = () => {
                if (fallbackDone) return;
                fallbackDone = true;
                triggerButtonFallback();
            };

            const fallbackTimer = setTimeout(runFallbackOnce, CONFIG.playFallbackDelayMs);

            Promise.resolve()
                .then(() => activeEl.play())
                .then(() => {
                    // 即使流慢加载导致 resolve 时 paused 仍为 true，也安全清理定时器，依靠 fallback 兜底
                    clearTimeout(fallbackTimer);
                    fallbackDone = true;
                    if (!activeEl.paused) {
                        log('resume via activeEl.play() succeeded');
                    } else {
                        triggerButtonFallback();
                    }
                })
                .catch(() => {
                    clearTimeout(fallbackTimer);
                    runFallbackOnce();
                });
        }, CONFIG.resumeDelayMs);
    }

    // ==================== 连接守护（移动端后台/切网假死） ====================
    function injectConnHooks() {
        try {
            const WS = pageWindow.WebSocket;
            if (!WS || WS.__adSkipperWsHookedV34) return;
            const Wrapped = new Proxy(WS, {
                construct(target, args) {
                    const socket = Reflect.construct(target, args, target);
                    trackSocket(socket);
                    return socket;
                },
            });
            try { Object.defineProperty(WS, '__adSkipperWsHookedV34', { value: true }); } catch (e) { /* ignore */ }
            pageWindow.WebSocket = Wrapped;
            log('websocket hook installed');
        } catch (e) {
            log('websocket hook failed', e);
        }
    }

    function trackSocket(socket) {
        try {
            if (!socket || typeof socket.addEventListener !== 'function') return;
            const url = String(socket.url || '');
            if (!/^wss?:\/\//i.test(url)) return;
            if (!/spotify|scdn|dealer|spclient|guc/i.test(url)) return;

            socket.addEventListener('close', (ev) => {
                if (ev && ev.wasClean) return;
                log('spotify socket closed uncleanly:', url);
                // 先给 Spotify 自己的重连逻辑 5 秒；没缓过来再介入
                setTimeout(() => {
                    if (document.visibilityState !== 'visible') {
                        pendingRecoveryReason = 'ws-close';
                        return;
                    }
                    if (computeBroken(Date.now())) scheduleRecovery('ws-close');
                }, 5000);
            }, { passive: true });
        } catch (e) { /* ignore */ }
    }

    function readSession(key) {
        try { return sessionStorage.getItem(key); } catch (e) { return null; }
    }

    function writeSession(key, value) {
        try { sessionStorage.setItem(key, value); } catch (e) { /* ignore */ }
    }

    function toast(text, hold = 3500) {
        if (!document.body) return;
        if (!toastEl || !toastEl.isConnected) {
            toastEl = document.createElement('div');
            toastEl.style.cssText =
                'position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 12px);transform:translateX(-50%);' +
                'z-index:2147483647;max-width:86vw;padding:6px 12px;border-radius:999px;' +
                'background:rgba(0,0,0,.82);color:#fff;font:12px/1.5 system-ui,sans-serif;' +
                'text-align:center;pointer-events:none;transition:opacity .2s ease;opacity:1';
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = text;
        toastEl.style.opacity = '1';
        if (toastTimer) clearTimeout(toastTimer);
        if (hold) {
            toastTimer = setTimeout(() => {
                toastTimer = null;
                if (toastEl) toastEl.style.opacity = '0';
            }, hold);
        }
    }

    function trackPlaybackProgress(now) {
        const el = getActiveMediaElement();
        if (!el) {
            lastMediaTime = -1;
            lastAdvanceAt = now;
            return;
        }
        if (!el.paused && !el.ended) {
            if (el.currentTime !== lastMediaTime) {
                lastMediaTime = el.currentTime;
                lastAdvanceAt = now;
            }
        } else {
            // 暂停时不重置 lastAdvanceAt，否则"假死"被 play() 叫醒后
            // 会因为有进度而误判成功（见 recoverySucceeded）
            lastMediaTime = el.currentTime;
        }
    }

    function computeBroken(now = Date.now()) {
        if (!CONFIG.connGuard || skipActive || adSessionGaveUp) return false;

        const btn = getPlayButton();
        const uiPlaying = btn ? buttonShowsPause(btn) : false;
        const el = getActiveMediaElement();
        const mediaPlaying = Boolean(el && !el.paused && !el.ended);

        // UI 和媒体都说"没在播"，就当作是用户自己暂停的
        if (!uiPlaying && !mediaPlaying) return false;
        if (!el || el.ended) return false;

        // UI 认为在播、媒体却停了：移动端回前台后最常见的一种假死
        if (el.paused) return uiPlaying;

        return now - lastAdvanceAt >= CONFIG.stallMs;
    }

    function resetConnGuard() {
        brokenSince = 0;
        pendingRecoveryReason = '';
        lastAdvanceAt = Date.now();
    }

    function scheduleRecovery(reason) {
        if (!CONFIG.connGuard || recoveryTimer || recoveryProbeTimer || reloadTimer) return;
        if (skipActive || adSessionGaveUp) return;
        if (document.visibilityState !== 'visible') {
            pendingRecoveryReason = reason;
            return;
        }

        const now = Date.now();
        if (now - lastRecoveryAt < 15000) return;
        lastRecoveryAt = now;

        log('connection recovery scheduled:', reason);
        toast('播放连接卡住了，正在尝试恢复…', 4000);
        recoveryTimer = setTimeout(() => {
            recoveryTimer = null;
            runRecovery(reason);
        }, 300);
    }

    function runRecovery(reason) {
        if (skipActive || adSessionGaveUp) return;
        log('recovering:', reason);

        // 给页面补一个 online 事件，Spotify 自己的网络状态监听会借此重连
        try { pageWindow.dispatchEvent(new pageWindow.Event('online')); } catch (e) { /* ignore */ }

        // 媒体层再推一把（广告期间不动）
        const el = getActiveMediaElement();
        if (el && el.paused && !el.ended) {
            try { el.play().catch(() => {}); } catch (e) { /* ignore */ }
        }

        recoveryProbeTimer = setTimeout(() => {
            recoveryProbeTimer = null;
            if (document.visibilityState !== 'visible') {
                pendingRecoveryReason = reason;
                return;
            }
            if (recoverySucceeded(reason)) {
                toast('连接已恢复', 2500);
                resetConnGuard();
                return;
            }
            if (navigator.onLine === false) {
                toast('网络已断开，等待联网后自动恢复…', 5000);
                pendingRecoveryReason = reason;
                lastRecoveryAt = Date.now() + 40000; // 断网期间别每 15 秒弹一次
                return;
            }
            probeServer().then((reachable) => {
                if (recoverySucceeded(reason)) {
                    toast('连接已恢复', 2500);
                    resetConnGuard();
                    return;
                }
                if (!reachable) {
                    toast('网络似乎还没恢复，稍后自动重试…', 5000);
                    pendingRecoveryReason = reason;
                    lastRecoveryAt = Date.now() + 40000;
                    return;
                }
                maybeReload(reason);
            });
        }, CONFIG.recoverProbeMs);
    }

    function recoverySucceeded(reason) {
        const now = Date.now();
        const el = getActiveMediaElement();
        const mediaPlaying = Boolean(el && !el.paused && !el.ended);

        // 用户点播放没反应触发的恢复：必须真的开始播了才算成功
        if (reason === 'play-click-no-effect') {
            return mediaPlaying && now - lastAdvanceAt < CONFIG.stallMs;
        }
        return !computeBroken(now);
    }

    function probeServer(timeoutMs = 4000) {
        return new Promise((resolve) => {
            let img;
            try {
                img = new Image();
            } catch (e) {
                resolve(true); // 拿不到 Image 就不拦自动刷新
                return;
            }
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                img.onload = null;
                img.onerror = null;
                resolve(ok);
            };
            const timer = setTimeout(() => finish(false), timeoutMs);
            img.onload = () => finish(true);
            img.onerror = () => finish(false);
            img.src = '/favicon.ico?connect_probe=' + Date.now();
        });
    }

    function maybeReload(reason) {
        if (!CONFIG.autoReload) return;

        const last = Number(readSession('__adSkipperReloadAt')) || 0;
        if (last && Date.now() - last < CONFIG.reloadCooldownMs) {
            log('auto reload suppressed by cooldown');
            toast('连接仍未恢复，可手动刷新页面', 4000);
            lastRecoveryAt = Date.now() + 40000;
            resetConnGuard();
            return;
        }

        writeSession('__adSkipperReloadAt', String(Date.now()));
        writeSession('__adSkipperWasPlaying', '1');
        log('auto reload:', reason);
        toast('连接卡死，正在自动刷新…', 0);

        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
            reloadTimer = null;
            try { location.reload(); } catch (e) { /* ignore */ }
        }, 800);
    }

    // 自动刷新后，等播放器初始化完再点一次播放（能否出声取决于浏览器自动播放策略）
    function maybeResumeAfterReload() {
        if (readSession('__adSkipperWasPlaying') !== '1') return;
        try { sessionStorage.removeItem('__adSkipperWasPlaying'); } catch (e) { /* ignore */ }

        toast('已自动刷新，正在恢复播放…', 5000);
        setTimeout(() => {
            try {
                const btn = getPlayButton();
                if (btn && buttonShowsPlay(btn)) {
                    btn.click();
                    log('post-reload play click sent');
                }
            } catch (e) { /* ignore */ }

            setTimeout(() => {
                const el = getActiveMediaElement();
                if (!el || el.ended || !el.paused) return;
                try {
                    el.play().catch(() => toast('已刷新，点一下播放继续', 5000));
                } catch (e) {
                    toast('已刷新，点一下播放继续', 5000);
                }
            }, 1500);
        }, 2500);
    }

    function connWatchdogTick(now) {
        trackPlaybackProgress(now);

        const broken = computeBroken(now);
        if (!broken) {
            brokenSince = 0;
            return;
        }
        if (!brokenSince) brokenSince = now;

        if (document.visibilityState !== 'visible') {
            pendingRecoveryReason = 'broken-in-background';
            return;
        }
        if (now - brokenSince >= CONFIG.brokenConfirmMs) {
            scheduleRecovery('playback-broken');
        }
    }

    function initConnGuard() {
        if (connEventsBound || !CONFIG.connGuard) return;
        connEventsBound = true;

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                hiddenAt = Date.now();
                return;
            }
            const away = hiddenAt ? Date.now() - hiddenAt : 0;
            hiddenAt = 0;
            if (away < CONFIG.backgroundCheckMs) return;

            if (visualCheckTimer) clearTimeout(visualCheckTimer);
            visualCheckTimer = setTimeout(() => {
                visualCheckTimer = null;
                if (document.visibilityState !== 'visible' || skipActive) return;
                if (computeBroken(Date.now())) {
                    scheduleRecovery('resume-after-background');
                } else if (pendingRecoveryReason) {
                    const reason = pendingRecoveryReason;
                    pendingRecoveryReason = '';
                    scheduleRecovery(reason);
                } else {
                    resetConnGuard();
                }
            }, CONFIG.resumeCheckDelayMs);
        });

        window.addEventListener('online', () => {
            if (document.visibilityState !== 'visible') {
                pendingRecoveryReason = 'online';
                return;
            }
            setTimeout(() => {
                if (computeBroken(Date.now())) scheduleRecovery('online');
            }, CONFIG.resumeCheckDelayMs);
        }, { passive: true });

        // 点击"播放"后 7 秒还没开始播 → 播放器大概率已经假死
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!target || !target.closest) return;
            const btn = target.closest('[data-testid="control-button-playpause"]');
            if (!btn || !buttonShowsPlay(btn)) return;
            setTimeout(() => {
                if (document.visibilityState !== 'visible' || skipActive) return;
                const el = getActiveMediaElement();
                const currentBtn = getPlayButton();
                const stillNotPlaying = (!el || el.paused || el.ended) &&
                    (!currentBtn || buttonShowsPlay(currentBtn));
                if (stillNotPlaying) scheduleRecovery('play-click-no-effect');
            }, 7000);
        }, true);

        log('connection guard bound');
    }

    // ==================== 主流程与 SPA 守护 ====================
    async function main() {
        try {
            const bar = await queryAsync(BAR_SELECTORS, CONFIG.barTimeoutMs);
            await queryAsync(() => getPlayButton(), CONFIG.barTimeoutMs);
            startObserver(bar);
            startWatchdog();
            initConnGuard();
            maybeResumeAfterReload();
            log('main ready');
        } catch (e) {
            log('main failed:', e.message);
            startWatchdog();
            initConnGuard();
            maybeResumeAfterReload();
        }
    }

    function startObserver(bar) {
        if (!bar) return;
        if (barObserver) barObserver.disconnect();
        currentBar = bar;

        const scheduleBodyCheck = () => {
            if (bodyCheckTimer) return;
            bodyCheckTimer = setTimeout(() => {
                bodyCheckTimer = null;
                if (isAdPlayingStrong()) {
                    if (!skipActive) scheduleSkip();
                } else {
                    // 【已修正】：严格移除了 adSessionGaveUp 短路，只认准切到了正常内容路由且强信号彻底消失时才重置
                    const link = getNowPlayingLink();
                    const href = link ? (link.getAttribute('href') || '') : '';
                    if (!skipActive && NORMAL_CONTENT_HREF_RE.test(href)) {
                        resetAdSession();
                    }
                }
            }, 100);
        };

        barObserver = new MutationObserver(scheduleBodyCheck);
        barObserver.observe(bar, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['title', 'aria-label', 'href'],
        });

        if (!skipActive && isAdPlayingStrong()) scheduleSkip();
    }

    function startWatchdog() {
        if (watchdogInterval) return;
        watchdogInterval = setInterval(() => {
            const now = Date.now();
            pruneTrackedElements();
            if (CONFIG.connGuard) connWatchdogTick(now);

            if ((adSessionGaveUp || adSessionClears > 0) && !skipActive && !isAdPlayingStrong()) {
                const link = getNowPlayingLink();
                const href = link ? (link.getAttribute('href') || '') : '';
                // 空 href 只是底栏重绘的过渡态，不能当作"广告结束"，否则计数会被提前清零
                if (NORMAL_CONTENT_HREF_RE.test(href)) {
                    resetAdSession();
                }
            }

            if (!currentBar || !currentBar.isConnected) {
                const newBar = document.querySelector(BAR_SELECTORS);
                if (newBar && newBar.isConnected) {
                    log('re-binding barObserver to new bar DOM');
                    startObserver(newBar);
                }
            }
        }, CONFIG.watchdogIntervalMs);
    }

    // ==================== 清理 ====================
    window.addEventListener('beforeunload', () => {
        stopSkipInterval();
        if (watchdogInterval) clearInterval(watchdogInterval);
        if (barObserver) barObserver.disconnect();
        if (skipDebounce) clearTimeout(skipDebounce);
        if (bodyCheckTimer) clearTimeout(bodyCheckTimer);
        if (resumeTimer) clearTimeout(resumeTimer);
        if (recoveryTimer) clearTimeout(recoveryTimer);
        if (recoveryProbeTimer) clearTimeout(recoveryProbeTimer);
        if (reloadTimer) clearTimeout(reloadTimer);
        if (visualCheckTimer) clearTimeout(visualCheckTimer);
        if (toastTimer) clearTimeout(toastTimer);
        for (const el of Array.from(trackedElements)) {
            cleanupMediaElement(el);
        }
    });

    // ==================== 启动 ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main, { once: true });
    } else {
        main();
    }

})();