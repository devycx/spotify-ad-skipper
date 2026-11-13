// ==UserScript==
// @name         Spotify Ad Skipper - Auto-Skip Ads & Resume on Web Player
// @name:en      Spotify Ad Skipper - Auto-Skip Ads & Resume on Web Player
// @name:zh-CN   Spotify 网页版广告跳过（自动恢复播放）
// @namespace    https://github.com/devycx/spotify-ad-skipper
// @version      3.5.0
// @description  Lightweight Spotify audio ad blocker for the web player: skips ads automatically and resumes your music. Detects ads without relying on duration, caps retries so playback never gets stuck, and recovers a frozen player after backgrounding or network changes.
// @description:en  Lightweight Spotify audio ad blocker for the web player: skips ads automatically and resumes your music. Detects ads without relying on duration, caps retries so playback never gets stuck, and recovers a frozen player after backgrounding or network changes.
// @description:zh-CN  轻量级 Spotify 网页版音频广告拦截：自动跳过广告并恢复播放；不依赖时长判定，限制重试次数避免卡死，并在后台/切网导致播放器假死时自动恢复。
// @author       simonwep (original) / devycx (hardened)
// @license      MIT
// @homepageURL  https://github.com/devycx/spotify-ad-skipper
// @supportURL   https://github.com/devycx/spotify-ad-skipper/issues
// @updateURL    https://raw.githubusercontent.com/devycx/spotify-ad-skipper/main/spotify-ad-skipper.user.js
// @downloadURL  https://raw.githubusercontent.com/devycx/spotify-ad-skipper/main/spotify-ad-skipper.user.js
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
        watchdogIntervalMs: 1000,      // 1s watchdog for bar re-renders and zombie nodes
        maxSkipTicks: 60,              // hard cap per skip cycle: ~18s
        maxSkipDurationMs: 35000,
        adEndConfirmTicks: 2,          // require 2 consecutive confirmations that the ad ended
        emptyHrefGraceTicks: 5,        // after clearing src, allow a short window where the link is empty (~1.5s)
        resumeDelayMs: 800,            // wait for Spotify's state machine to settle before resuming
        playFallbackDelayMs: 500,      // 500ms gives slow devices a safety buffer for activeEl.play()
        maxClearsPerAd: 3,             // at most 3 src clears per ad session (persists across skip cycles)
        maxTrackedElements: 6,         // max off-screen media elements to keep

        // ---- Connection guard: Spotify connect WebSocket stalls after backgrounding / network switches ----
        connGuard: true,
        stallMs: 10000,                // media is playing but currentTime has not moved for 10s
        brokenConfirmMs: 5000,         // act only after a suspected stall lasts 5s
        backgroundCheckMs: 15000,      // only check after being backgrounded for 15s+
        resumeCheckDelayMs: 5000,      // wait 5s after returning to foreground / reconnecting
        recoverProbeMs: 7000,          // wait 7s to verify a lightweight recovery
        autoReload: true,              // still stalled but network is reachable -> auto reload
        reloadCooldownMs: 180000,      // at least 3 minutes between auto reloads

        // UI language: 'auto' follows the browser, or force 'en' / 'zh-CN'
        locale: 'auto',
        debug: false,
    };

    const MESSAGES = {
        en: {
            recovering: 'Playback connection stalled. Trying to recover…',
            restored: 'Connection restored',
            offline: 'Network offline. Will retry when the connection returns…',
            networkPending: 'Network still unavailable. Will retry shortly…',
            reloadSuppressed: 'Connection still down. You can reload the page manually.',
            reloading: 'Player connection is stuck. Reloading automatically…',
            reloadedResuming: 'Page reloaded. Resuming playback…',
            reloadedManual: 'Page reloaded. Press play to continue.',
        },
        'zh-CN': {
            recovering: '播放连接卡住了，正在尝试恢复…',
            restored: '连接已恢复',
            offline: '网络已断开，等待联网后自动恢复…',
            networkPending: '网络似乎还没恢复，稍后自动重试…',
            reloadSuppressed: '连接仍未恢复，可手动刷新页面',
            reloading: '连接卡死，正在自动刷新…',
            reloadedResuming: '已自动刷新，正在恢复播放…',
            reloadedManual: '已刷新，点一下播放继续',
        },
    };

    function detectLocale() {
        if (CONFIG.locale && CONFIG.locale !== 'auto') return CONFIG.locale;
        const languages = Array.isArray(navigator.languages) && navigator.languages.length
            ? navigator.languages
            : [navigator.language || 'en'];
        for (const language of languages) {
            const normalized = String(language).toLowerCase();
            if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
            if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
        }
        return 'en';
    }

    const UI_LOCALE = detectLocale();
    const t = (key) => (MESSAGES[UI_LOCALE] && MESSAGES[UI_LOCALE][key]) || MESSAGES.en[key] || key;

    const BAR_SELECTORS = [
        '[data-testid="now-playing-bar"]',
        '.now-playing-bar',
        '.Root__now-playing-bar',
    ].join(',');

    const AD_HREF_RE = /^\/(ad|ads|sponsored)\b/i;
    // Common normal-content routes so returning to real content reliably resets the ad session
    const NORMAL_CONTENT_HREF_RE = /^\/(track|episode|album|playlist|artist|show|mix|radio|search|collection|user|concert)\b/i;
    // Chinese labels are kept because Spotify localizes its UI
    const AD_TEXT_RE = /^(advertisement|sponsored|spotify\s*ad|广告|廣告)$/i;

    // \b keeps English from matching playlist/player; Chinese has no trailing anchor so compounds like 播放音乐/暂停播放 still match
    const PLAY_LABEL_RE = /^(?:(play|resume)\b|播放)/i;
    const PAUSE_LABEL_RE = /^(?:pause\b|暂停|暫停)/i;

    // Strictly validate play/pause buttons; never hit Shuffle / Previous / Next / Repeat
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

    // ==================== State ====================
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

    // connection guard state
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

    // ad session state persisted across skip cycles
    let adSessionClears = 0;
    let adSessionGaveUp = false;

    // ==================== Media element lifecycle & hooks ====================
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

    // Hook WebSocket before the page opens its connection so Spotify connect closes are observable
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
            lastAdvanceAt = Date.now(); // reset stall timer when playback starts again
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

    // ==================== Play button & state detection ====================
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

    // ==================== Ad detection ====================
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

    // ==================== Ad skipping ====================
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
                    // even if slow loading leaves paused=true when play() resolves, clean up the timer and rely on the fallback
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

    // ==================== Connection guard (mobile background / network stall) ====================
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
                // give Spotify's own reconnect logic 5s before stepping in
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
            // do not reset lastAdvanceAt while paused; otherwise a stalled player
            // woken by play() would look recovered just because currentTime moved (see recoverySucceeded)
            lastMediaTime = el.currentTime;
        }
    }

    function computeBroken(now = Date.now()) {
        if (!CONFIG.connGuard || skipActive || adSessionGaveUp) return false;

        const btn = getPlayButton();
        const uiPlaying = btn ? buttonShowsPause(btn) : false;
        const el = getActiveMediaElement();
        const mediaPlaying = Boolean(el && !el.paused && !el.ended);

        // UI and media both say "not playing": treat it as a user pause
        if (!uiPlaying && !mediaPlaying) return false;
        if (!el || el.ended) return false;

        // UI says playing but media stopped: the most common stall after returning to foreground
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
        toast(t('recovering'), 4000);
        recoveryTimer = setTimeout(() => {
            recoveryTimer = null;
            runRecovery(reason);
        }, 300);
    }

    function runRecovery(reason) {
        if (skipActive || adSessionGaveUp) return;
        log('recovering:', reason);

        // dispatch an online event so Spotify's own network listener reconnects
        try { pageWindow.dispatchEvent(new pageWindow.Event('online')); } catch (e) { /* ignore */ }

        // nudge the media layer too (not during ads)
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
                toast(t('restored'), 2500);
                resetConnGuard();
                return;
            }
            if (navigator.onLine === false) {
                toast(t('offline'), 5000);
                pendingRecoveryReason = reason;
                lastRecoveryAt = Date.now() + 40000; // avoid a toast every 15s while offline
                return;
            }
            probeServer().then((reachable) => {
                if (recoverySucceeded(reason)) {
                    toast(t('restored'), 2500);
                    resetConnGuard();
                    return;
                }
                if (!reachable) {
                    toast(t('networkPending'), 5000);
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

        // recovery triggered by a play click that did nothing: only success once playback actually starts
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
                resolve(true); // if Image is unavailable, do not block auto reload
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
            toast(t('reloadSuppressed'), 4000);
            lastRecoveryAt = Date.now() + 40000;
            resetConnGuard();
            return;
        }

        writeSession('__adSkipperReloadAt', String(Date.now()));
        writeSession('__adSkipperWasPlaying', '1');
        log('auto reload:', reason);
        toast(t('reloading'), 0);

        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
            reloadTimer = null;
            try { location.reload(); } catch (e) { /* ignore */ }
        }, 800);
    }

    // after an auto reload, wait for the player to initialize then click play (audibility depends on autoplay policy)
    function maybeResumeAfterReload() {
        if (readSession('__adSkipperWasPlaying') !== '1') return;
        try { sessionStorage.removeItem('__adSkipperWasPlaying'); } catch (e) { /* ignore */ }

        toast(t('reloadedResuming'), 5000);
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
                    el.play().catch(() => toast(t('reloadedManual'), 5000));
                } catch (e) {
                    toast(t('reloadedManual'), 5000);
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

        // 7s after a Play click with no playback -> the player is probably stalled
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

    // ==================== Main flow & SPA guard ====================
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
                    // fixed: removed the adSessionGaveUp shortcut; reset only when the route is normal content and the strong ad signal is gone
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
                // an empty href is just a transient bar re-render, not "ad ended"; otherwise counters reset too early
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

    // ==================== Cleanup ====================
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

    // ==================== Start ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main, { once: true });
    } else {
        main();
    }

})();