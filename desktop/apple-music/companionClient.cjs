'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { validateRequest, operationKind } = require('./companionRequests.cjs');

// Both hosts use a private parent-owned channel; neither opens a network listener.
// coldStartTimeoutMs：冷启动的那一次请求要等 WebView2 把 music.apple.com 页面加载完
// （实测十几到二十几秒，playSong 还要再叠上队列解析与 DRM），25s 的常规预算经常不够，
// 表现就是"启动后第一首 Apple Music 直接失败"。给第一次调用单独一条更宽的预算。
// The first request after a spawn also pays for loading music.apple.com, so it gets a wider budget.
// 冷启动时值得等更久的操作：播放启动要等页面加载完、队列解析和 DRM 缓冲。
// warm 也算：它就是『把页面加载起来』，冷启动同样要等十几秒。
const COLD_START_OPERATIONS = new Set(['playSong', 'playStation', 'resume', 'warm']);

function createCompanionClient({ nativeExecutablePath = '', profilePath, spawnProcess = spawn, createNativeChannel = require('./nativeSpawn.cjs').createNativeSpawn, timeoutMs = 25000, coldStartTimeoutMs = 70000, handshakeTimeoutMs = 5000, logger = null }) {
    // 落盘日志：请求结算、实例更替、宿主诊断都记一行，排查"播放加载失败"时能直接看时间线。
    const log = (entry) => {
        try { if (logger && typeof logger.write === 'function') logger.write(entry); } catch { /* 日志坏了不许影响播放 */ }
    };
    const spawnNative = createNativeChannel({ spawnProcess, onDiagnostic: (code) => log({ type: 'host', code }) });
    let child = null;
    let sequence = 0;
    const pending = new Map();

    // A lost child invalidates every outstanding request without exposing raw process errors.
    function failPending(error) {
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.resolve({ ok: false, error });
        }
        pending.clear();
    }

    function start() {
        if (child?.connected) return true;
        // 🔴 已经在连接中的那个实例必须复用，不能再 spawn 一个：冷启动时 request() 会连续
        // 调用 start()，以前这里没有"正在连"的判断，会一口气拉起好几个 WebView2 伴生进程，
        // 而且第一个请求还会在握手完成前就判定失败（启动后第一首 AM 歌放不出来）。
        // Reuse the instance that is still handshaking; spawning again here used to start
        // several companions and fail the very first request before the channel was up.
        //
        // ⚠️ 但复用必须带时限：如果这个实例一直握不上手（进程没退、通道没连），
        // 复用就成了"永远等下去"——每个请求都要熬到 25 秒超时才失败，界面表现就是加载奇慢。
        // 超过 handshakeTimeoutMs 还连不上就换掉它，重新 spawn 一次。
        // Reuse, but not forever: a child that never handshakes would make every request wait for
        // the full timeout. Replace it once the handshake budget is gone.
        if (child) {
            if (Date.now() - (child.__spawnedAt || 0) <= handshakeTimeoutMs) return true;
            log({ type: 'handshake-timeout', waitedMs: Date.now() - (child.__spawnedAt || 0), budgetMs: handshakeTimeoutMs });
            try { child.disconnect(); } catch { /* already gone */ }
            child = null;
        }
        if (!path.isAbsolute(nativeExecutablePath || '') || !path.isAbsolute(profilePath || '')) return false;
        const instance = spawnNative(nativeExecutablePath, [`--user-data-dir=${profilePath}`]);
        instance.__spawnedAt = Date.now();
        child = instance;
        log({ type: 'spawn' });
        instance.on('message', message => {
            if (instance !== child || !message || typeof message !== 'object' || typeof message.id !== 'string') return;
            const entry = pending.get(message.id);
            if (!entry || typeof message.ok !== 'boolean') return;
            clearTimeout(entry.timer);
            pending.delete(message.id);
            entry.resolve(message);
        });
        const onClosed = () => {
            if (child !== instance) return;
            child = null;
            failPending('disconnected');
        };
        instance.once('error', onClosed);
        instance.once('exit', onClosed);
        instance.once('disconnect', onClosed);
        return true;
    }

    // One attempt on the current child. A companion that is still starting, or whose page is
    // moving to the account's storefront, answers `not-ready`; that is not a failure of the call.
    const sendOnce = (request, deadline) => new Promise(resolve => {
        const instance = child;
        if (!instance?.connected) {
            resolve({ ok: false, error: 'runtime-unavailable' });
            return;
        }
        const budgetMs = Math.max(1, deadline - Date.now());
        const timer = setTimeout(() => {
            pending.delete(request.id);
            resolve({ ok: false, error: 'timeout' });
        }, budgetMs);
        pending.set(request.id, { resolve, timer });
        try {
            instance.send(request, error => {
                if (!error) return;
                const entry = pending.get(request.id);
                if (!entry) return;
                clearTimeout(entry.timer);
                pending.delete(request.id);
                resolve({ ok: false, error: 'disconnected' });
            });
        } catch {
            const entry = pending.get(request.id);
            if (entry) { clearTimeout(entry.timer); pending.delete(request.id); }
            resolve({ ok: false, error: 'runtime-unavailable' });
        }
    });

    return {
        async request(operation, params = {}) {
            const validated = validateRequest({ id: 'request_0', operation, params });
            if (!validated) return { ok: false, error: 'invalid-request' };
            // Login is the only visible surface; development follows the same background behavior.
            if (operation === 'hideWindow' && !child?.connected) return { ok: true, data: {} };
            if (pending.size >= 16) return { ok: false, error: 'busy' };
            // 宽预算只给「起播」：它必须等页面加载完 + 队列解析才算完成。数据类请求（歌单、
            // 曲目、搜索）必须**快速失败**——给它们 70 秒只会让界面一直转圈，而不是回退。
            // Only playback starts get the wide budget; data requests must fail fast so the UI can
            // fall back instead of spinning for a minute.
            const coldStart = (!child || !child.connected) && COLD_START_OPERATIONS.has(operation);
            const deadline = Date.now() + (coldStart ? Math.max(timeoutMs, coldStartTimeoutMs) : timeoutMs);
            let result = { ok: false, error: 'runtime-unavailable' };
            for (let attempt = 1; attempt <= 2000; attempt++) {
                if (Date.now() >= deadline) return result;
                if (!start()) {
                    return { ok: false, error: 'runtime-unavailable' };
                }
                if (!child?.connected) {
                    // 冷启动：伴生进程刚 spawn，父通道还没握手完。这里必须等它连上，
                    // 不能直接判失败 —— 否则"启动后第一首就是 Apple Music"必然放不出来。
                    // Cold start: the companion exists but the channel is not up yet. Wait for it
                    // instead of failing the request outright.
                    await new Promise(resolve => setTimeout(resolve, 60));
                    continue;
                }
                result = await sendOnce({ ...validated, id: `request_${++sequence}_${attempt}` }, deadline);
                // The first request of a run is always early, and a storefront move makes the page
                // not-ready for a moment: ask again until this call's own time is up.
                // `busy` is a rejection before execution, so retrying cannot duplicate a write.
                // Keep retries within this request's original deadline.
                if (!['not-ready', 'busy'].includes(result.error) || Date.now() >= deadline) {
                    const elapsedMs = Date.now() - (deadline - timeoutMs);
                    if (elapsedMs >= 1000) console.info('[AppleMusic] Companion request settled', { operation, elapsedMs, attempts: attempt, ok: result.ok });
                    log({
                        type: 'request',
                        operation,
                        // 分层来自 companionRequests 的操作表：read 可无脑重试，command 不能。
                        kind: operationKind(operation),
                        elapsedMs,
                        attempts: attempt,
                        ok: result.ok === true,
                        error: result.ok === true ? '' : String(result.error || ''),
                        stage: result && result.playbackStage ? result.playbackStage : '',
                        httpStatus: result && result.httpStatus ? result.httpStatus : null,
                    });
                    // 宿主被堵死/页面卡住时，通道还是"连着"的，后续请求只会在同一条队列后面等到超时
                    // —— 用户看到的就是"没有任何报错，但也永远不播"。这里主动断开，让下一次请求
                    // 重新 spawn 一个干净的宿主。只对"真的没回话"生效：明确的拒绝（播放失败）不该重建。
                    // A wedged host stays "connected" and every later request queues behind it until it
                    // times out. Drop the channel so the next request respawns a clean host. Explicit
                    // rejections are not restarted: only "nobody answered" counts.
                    if (result.ok !== true && ['timeout', 'playback-timeout'].includes(result.error)) {
                        log({ type: 'host-restart', reason: String(result.error), operation });
                        try { this.close(); } catch { /* 断开失败就留着，下次还会再判 */ }
                    }
                    return result;
                }
                await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
            }
            return result;
        },
        // Pauses the player when the companion runs; a companion that does not run sounds nothing,
        // and asking it would start one. False when there was nothing to pause or the pause failed.
        async pauseIfRunning() {
            if (!child?.connected) return false;
            const result = await this.request('pause');
            return result.ok === true;
        },
        // Disconnecting the parent channel makes the companion exit and clears pending work.
        close() {
            const instance = child;
            child = null;
            failPending('disconnected');
            if (instance?.connected) instance.disconnect();
        },
    };
}

module.exports = { createCompanionClient };
