// ==UserScript==
// @name         Spotify 网页版广告跳过（Hardened）
// @name:en      Spotify Ad Skipper (Hardened)
// @namespace    https://github.com/devycx/spotify-ad-skipper
// @version      3.3.1
// @description  跳过 Spotify 网页版广告：识别到广告后清空广告音源，广告结束自动恢复播放；单轮有硬上限、整个广告会话有收敛，不会无限重试把播放器打死
// @description:en  Skip ads on the Spotify web player: clears the ad media source, then resumes playback. Hard-capped per ad and converged per ad session, so it never retries forever.
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

    // ==================== 主流程与 SPA 守护 ====================
    async function main() {
        try {
            const bar = await queryAsync(BAR_SELECTORS, CONFIG.barTimeoutMs);
            await queryAsync(() => getPlayButton(), CONFIG.barTimeoutMs);
            startObserver(bar);
            startWatchdog();
            log('main ready');
        } catch (e) {
            log('main failed:', e.message);
            startWatchdog();
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
            pruneTrackedElements();

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