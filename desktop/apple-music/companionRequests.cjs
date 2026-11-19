'use strict';

const { controlQueue } = require('./companionQueue.cjs');
const { updateFavorite } = require('./companionFavorites.cjs');
const { addPlaylistTracks } = require('./companionPlaylist.cjs');
const { readPersonalStation } = require('./companionRadio.cjs');
const { alignStorefront } = require('./companionStorefront.cjs');

// Define the only data requests the parent may send to the isolated Apple Music page.
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const RESOURCE_ID = /^[a-zA-Z0-9._-]{1,200}$/;
// Folia chooses the order; the companion may prepare a bounded tail but cannot invent next tracks.
const PLAYBACK_COMMANDS = new Set(['playStation', 'playSong', 'pause', 'resume', 'seek', 'setVolume', 'prepareNext']);
const OPERATIONS = new Set(['songOriginal', 'catalogSong', 'catalogAlbum', 'catalogAlbumTracks', 'catalogArtist', 'catalogArtistSongs', 'catalogArtistAlbums', 'libraryAlbums', 'librarySongs', 'libraryAlbumTracks', 'stations', 'station', 'personalFm', 'showWindow', 'hideWindow', 'logout', 'accountStatus', 'search', 'playlists', 'playlistTracks', 'playlistTrackCount', 'lyrics', 'playbackStatus', 'likeSong', 'addPlaylistTracks', ...PLAYBACK_COMMANDS]);

function validateRequest(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const { id, operation, params = {} } = message;
    if (typeof id !== 'string' || !REQUEST_ID.test(id) || !OPERATIONS.has(operation)) return null;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    if (['showWindow', 'hideWindow', 'logout', 'accountStatus'].includes(operation)) return { id, operation, params: {} };
    if (operation === 'stations') return { id, operation, params: { limit: 20, offset: 0 } };
    if (operation === 'station' || operation === 'playStation') {
        if (typeof params.stationId !== 'string' || !/^ra\.[a-zA-Z0-9._-]{1,196}$/.test(params.stationId)) return null;
        return { id, operation, params: { stationId: params.stationId, limit: 1, offset: 0 } };
    }
    if (operation === 'personalFm') return { id, operation, params: { limit: 2, offset: 0 } };
    if (operation === 'playbackStatus' || ['pause', 'resume'].includes(operation)) return { id, operation, params: {} };
    if (operation === 'seek') {
        if (typeof params.seconds !== 'number' || !Number.isFinite(params.seconds) || params.seconds < 0 || params.seconds > 604800) return null;
        return { id, operation, params: { seconds: params.seconds } };
    }
    if (operation === 'setVolume') {
        if (typeof params.volume !== 'number' || !Number.isFinite(params.volume) || params.volume < 0 || params.volume > 1) return null;
        return { id, operation, params: { volume: params.volume } };
    }
    if (operation === 'addPlaylistTracks') {
        if (typeof params.playlistId !== 'string' || !/^p\.[a-zA-Z0-9._-]{1,198}$/.test(params.playlistId)
            || !Array.isArray(params.catalogIds) || params.catalogIds.length < 1 || params.catalogIds.length > 100
            || params.catalogIds.some(id => typeof id !== 'string' || !/^\d{1,40}$/.test(id))) return null;
        return { id, operation, params: { playlistId: params.playlistId, catalogIds: [...new Set(params.catalogIds)] } };
    }
    if (operation === 'likeSong') {
        if (typeof params.catalogId !== 'string' || !/^\d{1,40}$/.test(params.catalogId) || typeof params.liked !== 'boolean') return null;
        return { id, operation, params: { catalogId: params.catalogId, liked: params.liked } };
    }
    if (operation === 'prepareNext') {
        if (typeof params.catalogId !== 'string' || !/^\d{1,40}$/.test(params.catalogId)
            || !Array.isArray(params.nextIds) || params.nextIds.length > 2
            || params.nextIds.some(id => typeof id !== 'string' || !/^\d{1,40}$/.test(id))
            || new Set([params.catalogId, ...params.nextIds]).size !== params.nextIds.length + 1) return null;
        return { id, operation, params: { catalogId: params.catalogId, nextIds: params.nextIds.slice() } };
    }
    if (operation === 'playSong') {
        const { catalogId, startSec = 0, requestKey, adoptCurrent = false } = params;
        if (typeof catalogId !== 'string' || !/^\d{1,40}$/.test(catalogId)) return null;
        if (typeof startSec !== 'number' || !Number.isFinite(startSec) || startSec < 0 || startSec > 604800) return null;
        if (requestKey !== undefined && (typeof requestKey !== 'string' || !REQUEST_ID.test(requestKey))) return null;
        if (typeof adoptCurrent !== 'boolean') return null;
        return { id, operation, params: { catalogId, startSec,
            ...(requestKey !== undefined ? { requestKey } : {}), ...(adoptCurrent ? { adoptCurrent } : {}) } };
    }
    if (operation === 'lyrics') {
        if (typeof params.songId !== 'string' || !RESOURCE_ID.test(params.songId)) return null;
        return { id, operation, params: { songId: params.songId } };
    }
    const { offset = 0, limit = 25 } = params;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
    if (operation === 'search') {
        if (typeof params.query !== 'string' || !params.query.trim() || params.query.length > 200) return null;
        return { id, operation, params: { query: params.query.trim(), offset, limit } };
    }
    if (['songOriginal', 'catalogSong', 'catalogAlbum', 'catalogAlbumTracks', 'catalogArtist', 'catalogArtistSongs', 'catalogArtistAlbums'].includes(operation)) {
        if (typeof params.catalogId !== 'string' || !/^\d{1,40}$/.test(params.catalogId)) return null;
        return { id, operation, params: { catalogId: params.catalogId, offset, limit } };
    }
    if (operation === 'libraryAlbumTracks') {
        if (typeof params.albumId !== 'string' || !/^l\.[a-zA-Z0-9._-]{1,198}$/.test(params.albumId)) return null;
        return { id, operation, params: { albumId: params.albumId, offset, limit } };
    }
    if (operation === 'playlistTracks' || operation === 'playlistTrackCount') {
        if (typeof params.playlistId !== 'string' || !RESOURCE_ID.test(params.playlistId)) return null;
        return { id, operation, params: { playlistId: params.playlistId, offset, limit } };
    }
    return { id, operation, params: { offset, limit } };
}

// This function runs inside the Apple page; return only fields required by the provider.
async function readFromPage(request, controlQueue, updateFavorite, addPlaylistTracks, readPersonalStation, alignStorefront) {
    try {
        const mk = window.MusicKit?.getInstance();
        const modern = mk?.api?.v3;
        const legacy = mk?.api;
        // The webpage wrapper takes flat RequestInit, while SDK v3 takes { fetchOptions }.
        // Normalize here so writes cannot silently become GET requests on the webpage's API.
        const call = typeof modern?.music === 'function' ? modern.music.bind(modern)
            : typeof legacy?.music === 'function' ? (path, query, options) => options
                ? legacy.music(path, query, options.fetchOptions) : legacy.music(path, query)
                : null;
        if (!call) return { ok: false, error: 'not-ready' };
        // Starts and prepared queues play in the account's region, whatever region the page is in.
        if (['playSong', 'playStation', 'prepareNext'].includes(request.operation)) {
            try { await alignStorefront(mk); } catch { /* The start goes on in the page's own region. */ }
        }
        if (request.operation === 'addPlaylistTracks') return await addPlaylistTracks(call, request.params);
        if (request.operation === 'likeSong') return await updateFavorite(call, request.params);
        if (request.operation === 'prepareNext') return await controlQueue(mk, request.operation, request.params);
        if (request.operation === 'playbackStatus') {
            const pendingStart = window.__foliaStart;
            // The player can already be sounding while its play/seek promise is still unresolved.
            if (pendingStart?.pending && mk.isPlaying === true) pendingStart.pending = false;
            // A hung media promise must not keep every later resume in the deduplication path.
            if (pendingStart?.pending && !pendingStart.cancelled && Date.now() - pendingStart.startedAt >= 60000) {
                pendingStart.pending = false;
                pendingStart.cancelled = true;
                pendingStart.failed = true;
            }
            if (window.__foliaStart?.failed) return { ok: false, error: 'playback-failed', playbackStage: 'play' };
            const item = mk.nowPlayingItem;
            const params = item?.attributes?.playParams || {};
            const liveStation = typeof window.__foliaLiveStation === 'string' ? window.__foliaLiveStation : '';
            const position = liveStation ? 0 : Number(mk.currentPlaybackTime);
            const duration = Number(item?.attributes?.durationInMillis);
            const state = Number(mk.playbackState);
            // A queue that was set but not started has no now-playing item; the length tells the two apart.
            const queue = mk.queue;
            const queueLength = Number.isInteger(queue?.length)
                ? queue.length
                : Array.isArray(queue?.items) ? queue.items.length : null;
            return { ok: true, data: {
                itemId: liveStation || (typeof item?.id === 'string' ? item.id : ''),
                ...(liveStation ? { live: true } : {}),
                catalogId: liveStation || (typeof params.catalogId === 'string' ? params.catalogId : ''),
                isPlaying: mk.isPlaying === true,
                ...(window.__foliaStart?.pending && !window.__foliaStart.cancelled ? { starting: true } : {}),
                // MusicKit's own state tells "stopped" and "ended" apart from a pause.
                state: Number.isInteger(state) ? state : null,
                queueLength,
                queueKeys: queue ? Object.keys(queue).slice(0, 12) : null,
                positionMs: Number.isFinite(position) && position >= 0 ? Math.round(position * 1000) : 0,
                durationMs: !liveStation && Number.isFinite(duration) && duration >= 0 ? duration : 0,
            } };
        }
        if (request.operation === 'playStation') {
            window.__foliaStart = null;
            if (typeof mk.setQueue !== 'function' || typeof mk.play !== 'function') return { ok: false, error: 'unsupported' };
            try {
                // Programme metadata changes do not replace the queue; an explicit page queue selection does.
                if (mk.setQueue !== window.__foliaStationQueueHook) {
                    const originalSetQueue = mk.setQueue;
                    const clearStationOnQueueChange = function (...args) {
                        window.__foliaLiveStation = '';
                        return originalSetQueue.apply(this, args);
                    };
                    mk.setQueue = clearStationOnQueueChange;
                    window.__foliaStationQueueHook = clearStationOnQueueChange;
                }
                await mk.setQueue({ station: request.params.stationId, startPlaying: false });
                window.__foliaLiveStation = request.params.stationId;
                window.__foliaPreparedQueue = [];
                await mk.play();
                return { ok: true, data: {} };
            } catch { return { ok: false, error: 'playback-failed' }; }
        }
        if (request.operation === 'setVolume') {
            // Apple's audio plays here, outside Folia's gain: the page's player owns the level.
            if (typeof mk.volume !== 'number') return { ok: false, error: 'unsupported' };
            mk.volume = request.params.volume;
            return { ok: true, data: {} };
        }
        const methods = { pause: 'pause', resume: 'play', seek: 'seekToTime' };
        if (request.operation === 'playSong') {
            if (typeof mk.setQueue !== 'function' || typeof mk.play !== 'function') return { ok: false, error: 'unsupported' };
            window.__foliaStart = null;
            let playbackStage = 'prepared-queue';
            try {
                const reused = await controlQueue(mk, request.operation, request.params);
                if (reused) return reused;
                // Folia supplies the prepared tail separately and remains responsible for order.
                playbackStage = 'configure';
                if (typeof mk.setShuffleMode === 'function') mk.setShuffleMode(0);
                if (typeof mk.setRepeatMode === 'function') mk.setRepeatMode(0);
                // Set the queue without auto-start so queue resolution and DRM playback are distinct stages.
                playbackStage = 'queue';
                console.info('[AppleMusic] Playback stage: queue');
                window.__foliaLiveStation = '';
                await mk.setQueue({ song: request.params.catalogId, startPlaying: false, startTime: request.params.startSec });
                playbackStage = 'play';
                console.info('[AppleMusic] Playback stage: play');
                const attempt = { failed: false, cancelled: false, sought: false, pending: true, startedAt: Date.now() };
                window.__foliaStart = attempt;
                // Buffering may take longer than the IPC budget. Observe completion without holding the control queue.
                Promise.resolve(mk.play()).then(async () => {
                    if (window.__foliaStart !== attempt) return;
                    if (attempt.cancelled) { await mk.pause(); return; }
                    if (!attempt.sought && request.params.startSec > 0 && typeof mk.seekToTime === 'function'
                        && !(Number(mk.currentPlaybackTime) >= request.params.startSec - 1)) await mk.seekToTime(request.params.startSec);
                }).catch(() => {
                    if (window.__foliaStart === attempt && !attempt.cancelled) attempt.failed = true;
                }).finally(() => { attempt.pending = false; });
            } catch {
                console.warn('[AppleMusic] Playback command rejected', { operation: request.operation });
                return { ok: false, error: 'playback-failed', playbackStage };
            }
            window.__foliaLastPlay = { requestKey: request.params.requestKey, catalogId: request.params.catalogId };
            // What the player says right after the start; the caller logs it once (ids, no words).
            return { ok: true, data: {
                state: Number.isInteger(mk.playbackState) ? mk.playbackState : null,
                isPlaying: mk.isPlaying === true,
                itemId: typeof mk.nowPlayingItem?.id === 'string' ? mk.nowPlayingItem.id : '',
                queueKeys: mk.queue ? Object.keys(mk.queue).slice(0, 12) : null,
                // A start that will only sound a preview says so here, with the region it plays in and,
                // where the page is in another region, what Apple said of the subscription (null: nothing yet).
                previewOnly: mk.previewOnly === true,
                storefront: typeof mk.storefrontId === 'string' ? mk.storefrontId.slice(0, 8) : '',
                subscribed: typeof window.__foliaSubscribed === 'boolean' ? window.__foliaSubscribed : null,
            } };
        }
        if (Object.prototype.hasOwnProperty.call(methods, request.operation)) {
            const method = mk[methods[request.operation]];
            if (typeof method !== 'function') return { ok: false, error: 'unsupported' };
            if (request.operation === 'seek' && window.__foliaStart) window.__foliaStart.sought = true;
            if (request.operation === 'pause' && window.__foliaStart) window.__foliaStart.cancelled = true;
            if (request.operation === 'resume') {
                // Buffering is asynchronous; duplicate resumes must not restart it or hold the command queue.
                const previous = window.__foliaStart;
                if (previous?.pending && !previous.cancelled && Date.now() - previous.startedAt < 60000) return { ok: true, data: {} };
                if (previous) previous.cancelled = true;
                const attempt = { failed: false, cancelled: false, pending: true, startedAt: Date.now() };
                window.__foliaStart = attempt;
                try {
                    Promise.resolve(method.call(mk)).then(async () => {
                        if (window.__foliaStart === attempt && attempt.cancelled) await mk.pause();
                    }).catch(() => {
                        if (window.__foliaStart === attempt && !attempt.cancelled) attempt.failed = true;
                    }).finally(() => { attempt.pending = false; });
                } catch {
                    attempt.pending = false;
                    attempt.failed = true;
                    return { ok: false, error: 'playback-failed' };
                }
                return { ok: true, data: {} };
            }
            try {
                await method.call(mk, ...(request.operation === 'seek' ? [request.params.seconds] : []));
            } catch {
                console.warn('[AppleMusic] Playback command rejected', { operation: request.operation });
                return { ok: false, error: 'playback-failed' };
            }
            return { ok: true, data: {} };
        }
        let account = window.__foliaStorefront;
        if (!account || request.operation === 'accountStatus') {
            account = await call('v1/me/storefront');
            const id = account?.data?.data?.[0]?.id;
            window.__foliaStorefront = typeof id === 'string' && /^[a-z]{2}$/.test(id) ? account : null;
        }
        const store = account?.data?.data?.[0]?.id;
        if (typeof store !== 'string' || !/^[a-z]{2}$/.test(store)) {
            const status = Number(account?.status);
            // Apple answers 401 or 403 for a session it no longer accepts.
            return { ok: false, error: status === 401 || status === 403 ? 'auth-required' : 'storefront-unavailable' };
        }
        if (request.operation === 'accountStatus') {
            // 名字的唯一权威来源就是社交档案：Apple 自己的账号菜单也只用
            // `userSocialProfile.userSocialProfileDescriptor.name`，没有档案时它同样什么都不显示。
            // 头像则来自账号资源的 `avatarArtwork`；拿不到时退回页面里那个真实渲染出来的头像 img
            // （`[data-testid="account-menu-avatar"]`，登录后才有）。
            // The only authoritative name is the social profile — Apple's own account menu renders
            // `userSocialProfile.userSocialProfileDescriptor.name` and shows nothing without one.
            // The avatar comes from the account resource's `avatarArtwork`, with the rendered
            // account-menu avatar in the page as the fallback.
            const debug = { sources: {} };
            const cleanUrl = value => {
                if (typeof value !== 'string' || !value || value.length > 2048) return '';
                const sized = value.replace(/\{w\}x\{h\}/g, '256x256').replace(/\{w\}/g, '256').replace(/\{h\}/g, '256');
                try {
                    const url = new URL(sized);
                    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
                } catch { return ''; }
            };
            const text = value => (typeof value === 'string' ? value.trim().slice(0, 256) : '');

            const profile = await call('v1/me/social-profile');
            const item = profile?.data?.data?.[0];
            debug.sources.socialProfile = Number(profile?.status) || 0;
            let identity = typeof item?.id === 'string' && item.id && item.id.length <= 512 ? item.id : '';
            let nickname = text(item?.attributes?.name) || text(item?.attributes?.displayName);
            let avatarUrl = cleanUrl(item?.attributes?.artwork?.url);
            let source = nickname || avatarUrl ? 'social-profile' : '';

            if (!avatarUrl) {
                // `/v1/me/account` 是"资源映射"形态：data[0].id 指向 resources.accounts 里的那条。
                // 这个端点只用来补头像，出错绝不能让整次 accountStatus 失败（那会让 UI 判成未登录）。
                // The account endpoint answers with a resource map: data[0].id indexes
                // resources.accounts. It only fills in the avatar, so a failure here must never fail
                // the whole accountStatus — the UI would read that as "not signed in".
                try {
                    const account = await call('v1/me/account');
                    const body = (account && account.data) || {};
                    debug.sources.account = Number(account && account.status) || 0;
                    const first = body && body.data && body.data[0];
                    const resolved = first && first.id && body.resources && body.resources.accounts
                        ? body.resources.accounts[first.id] : null;
                    const attrs = (resolved && resolved.attributes) || (first && first.attributes) || {};
                    debug.accountKeys = Object.keys(attrs).slice(0, 24);
                    const art = cleanUrl(attrs.avatarArtwork && attrs.avatarArtwork.url)
                        || cleanUrl(attrs.artwork && attrs.artwork.url) || cleanUrl(attrs.imageUrl);
                    if (art) { avatarUrl = art; source = source || 'account'; }
                } catch { debug.sources.account = -1; }
            }

            if (!avatarUrl || !nickname) {
                // 页面里真实渲染出来的账号头像：登录后是 <img>（未登录整块不渲染）。
                // The avatar the page itself renders: an <img> once signed in, absent otherwise.
                const img = document.querySelector('[data-testid="account-menu-avatar"]');
                const src = cleanUrl(img && (img.getAttribute('src') || img.src));
                debug.sources.pageAvatar = src ? 1 : 0;
                if (!avatarUrl && src) { avatarUrl = src; source = source || 'page'; }
                if (!nickname) {
                    // 可读名常常是"账号菜单"这类界面文字，只在不像界面文字时才当成名字。
                    // The trigger's accessible name is usually a UI label; only use it when it is not.
                    const trigger = document.querySelector('[data-testid="account-menu-trigger"]');
                    const label = text(trigger && trigger.getAttribute('aria-label'));
                    const looksLikeLabel = !label || label.length > 40 || /(菜单|账户|帐号|资料|menu|account|profile)/i.test(label);
                    if (!looksLikeLabel) { nickname = label; source = source || 'page'; }
                }
            }

            if (!identity) {
                // An account may have no social profile. The music user token identifies it just as
                // well: it stays in this page, and only its SHA-256 leaves, as the profile id's does.
                const token = typeof mk.musicUserToken === 'string' ? mk.musicUserToken : '';
                if (token) identity = 'music-user-token:' + token;
            }
            if (!identity) return { ok: false, error: 'identity-unavailable' };
            const bytes = new TextEncoder().encode('folia-apple-music:' + identity);
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            return { ok: true, data: { id, nickname, storefront: store, avatarUrl, profileSource: source, debug } };
        }
        const p = request.params;
        // Cross-storefront metadata is an optional cn-only lookup; never change the playback storefront.
        if (request.operation === 'songOriginal') {
            if (store !== 'cn') return { ok: true, data: null };
            // A page-scoped cache follows logout/navigation; transient network errors are not cached.
            const cache = window.__foliaOriginalCache ||= new Map();
            if (cache.has(p.catalogId)) return { ok: true, data: await cache.get(p.catalogId) };
            const pending = (async () => {
                const original = await call('v1/catalog/jp/songs/' + encodeURIComponent(p.catalogId), { l: 'ja' });
                const status = Number(original?.status) || 0;
                if (status === 404) return null;
                if (status >= 400 || original?.data?.errors?.length) throw new Error('catalog unavailable');
                const a = original?.data?.data?.[0]?.attributes;
                if (!a || typeof a.name !== 'string' || typeof a.artistName !== 'string') return null;
                return { name: a.name.slice(0, 1024), artistName: a.artistName.slice(0, 1024), albumName: typeof a.albumName === 'string' ? a.albumName.slice(0, 1024) : '' };
            })();
            cache.set(p.catalogId, pending);
            try { return { ok: true, data: await pending }; }
            catch { if (cache.get(p.catalogId) === pending) cache.delete(p.catalogId); return { ok: false, error: 'request-failed' }; }
        }
        const base = 'v1/catalog/' + encodeURIComponent(store);
        let path;
        let options;
        if (request.operation === 'stations') {
            path = base + '/stations';
            options = { 'filter[featured]': 'apple-music-live-radio', limit: p.limit };
        } else if (request.operation === 'station') {
            path = base + '/stations/' + encodeURIComponent(p.stationId);
            options = {};
        } else if (request.operation === 'search') {
            path = base + '/search';
            options = { term: p.query, types: 'songs', limit: p.limit, offset: p.offset };
        } else if (['catalogSong', 'catalogAlbum', 'catalogAlbumTracks', 'catalogArtist', 'catalogArtistSongs', 'catalogArtistAlbums'].includes(request.operation)) {
            const paths = { catalogSong: '/songs/', catalogAlbum: '/albums/', catalogAlbumTracks: '/albums/',
                catalogArtist: '/artists/', catalogArtistSongs: '/artists/', catalogArtistAlbums: '/artists/' };
            const suffixes = { catalogAlbumTracks: '/tracks', catalogArtistSongs: '/view/top-songs', catalogArtistAlbums: '/albums' };
            path = base + paths[request.operation] + encodeURIComponent(p.catalogId) + (suffixes[request.operation] || '');
            options = ['catalogSong', 'catalogAlbum', 'catalogArtist'].includes(request.operation)
                ? {} : { limit: p.limit, offset: p.offset };
        } else if (request.operation === 'libraryAlbums') {
            path = 'v1/me/library/albums';
            options = { limit: p.limit, offset: p.offset };
        } else if (request.operation === 'librarySongs') {
            path = 'v1/me/library/songs';
            options = { limit: p.limit, offset: p.offset, include: 'catalog' };
        } else if (request.operation === 'libraryAlbumTracks') {
            path = 'v1/me/library/albums/' + encodeURIComponent(p.albumId) + '/tracks';
            options = { limit: p.limit, offset: p.offset, include: 'catalog' };
        } else if (request.operation === 'playlists') {
            path = 'v1/me/library/playlists';
            options = { limit: p.limit, offset: p.offset, extend: 'tags' };
        } else if (request.operation === 'playlistTracks' || request.operation === 'playlistTrackCount') {
            path = 'v1/me/library/playlists/' + encodeURIComponent(p.playlistId) + '/tracks';
            // 曲目是库内资源，catalog 关系里才有可播放的数字 catalog id（playSong 只收数字）。
            // Library songs only expose a playable numeric catalog id through this relationship;
            // playSong rejects anything else.
            options = request.operation === 'playlistTrackCount'
                ? { limit: 1 }
                : { limit: p.limit, offset: p.offset, include: 'catalog' };
        } else {
            path = base + '/songs/' + encodeURIComponent(p.songId) + '/syllable-lyrics';
        }
        const result = request.operation === 'personalFm' ? await readPersonalStation(call, store) : await call(path, options);
        const status = Number(result?.status) || 0;
        if (status >= 400 || result?.data?.errors?.length) {
            if (request.operation === 'lyrics' && status === 404) return { ok: false, error: 'lyrics-unavailable', httpStatus: 404 };
            // A signed-in account refused with 403 is a restriction of that request (region,
            // entitlement, the song), not a session that ran out: only 401 means sign in again.
            // The storefront read above is the one place where either means nobody is signed in.
            return { ok: false, error: status === 401 ? 'auth-required' : 'upstream-error', httpStatus: status || null };
        }
        if (request.operation === 'playlistTrackCount') {
            const total = result?.data?.meta?.total;
            return { ok: true, data: { total: Number.isSafeInteger(total) && total >= 0 ? total : null } };
        }
        if (request.operation === 'lyrics') {
            const ttml = result?.data?.data?.[0]?.attributes?.ttml;
            if (typeof ttml !== 'string') return { ok: false, error: 'lyrics-unavailable' };
            if (ttml.length > 2 * 1024 * 1024) return { ok: false, error: 'invalid-response' };
            return { ok: true, data: { ttml } };
        }
        const results = result?.data?.results;
        // A valid search response can omit the songs group when nothing matched.
        const page = request.operation === 'search'
            ? (results && typeof results === 'object' && !Array.isArray(results) && results.songs === undefined ? { data: [] } : results?.songs)
            : result?.data;
        if (!Array.isArray(page?.data) || page.data.length > request.params.limit) return { ok: false, error: 'invalid-response' };
        // Do not expose private tokens, arbitrary API fields, or full upstream responses.
        const string = value => typeof value === 'string' ? value.slice(0, 4096) : '';
        const items = page.data.map(item => {
            const a = item?.attributes || {};
            const p = a.playParams || {};
            return {
                id: string(item?.id), type: string(item?.type),
                attributes: {
                    playbackAvailable: typeof a.playParams?.id === 'string' && a.playParams.id.length > 0,
                    ...(typeof a.canEdit === 'boolean' ? { canEdit: a.canEdit } : {}),
                    isLive: a.isLive === true,
                    isFavoritePlaylist: Array.isArray(a.tags) && a.tags.includes('favorited'),
                    name: string(a.name), artistName: string(a.artistName), albumName: string(a.albumName),
                    durationInMillis: Number.isFinite(a.durationInMillis) ? a.durationInMillis : 0,
                    trackCount: Number.isSafeInteger(a.trackCount) && a.trackCount >= 0 ? a.trackCount : null,
                    artwork: { url: string(a.artwork?.url) }, isrc: string(a.isrc),
                    catalogAlbums: (Array.isArray(item?.relationships?.albums?.data) ? item.relationships.albums.data : []).slice(0, 10).map(x => ({ id: string(x?.id), name: string(x?.attributes?.name) })),
                    catalogArtists: (Array.isArray(item?.relationships?.artists?.data) ? item.relationships.artists.data : []).slice(0, 10).map(x => ({ id: string(x?.id), name: string(x?.attributes?.name) })),
                    playParams: { id: string(p.id), kind: string(p.kind), catalogId: string(p.catalogId || item?.relationships?.catalog?.data?.[0]?.id), isLibrary: p.isLibrary === true },
                },
            };
        });
        const hasMore = typeof page.next === 'string' && page.next.length > 0;
        if (hasMore && items.length === 0) return { ok: false, error: 'invalid-response' };
        let nextOffset = request.params.offset + items.length;
        if (hasMore) {
            const next = new URL(page.next, 'https://api.music.apple.com');
            const offsetText = next.searchParams.get('offset');
            const suppliedOffset = offsetText && /^\d+$/.test(offsetText) ? Number(offsetText) : NaN;
            if (!Number.isSafeInteger(suppliedOffset) || suppliedOffset < request.params.offset + items.length
                || suppliedOffset <= request.params.offset || suppliedOffset > 100000) {
                return { ok: false, error: 'invalid-response' };
            }
            nextOffset = suppliedOffset;
        }
        return { ok: true, data: { items, hasMore, nextOffset } };
    } catch {
        return { ok: false, error: 'request-failed' };
    }
}

// Embed validated JSON only; the parent cannot supply executable JavaScript.
function requestExpression(request) {
    return `(${readFromPage.toString()})(${JSON.stringify(request)}, (${controlQueue.toString()}), (${updateFavorite.toString()}), (${addPlaylistTracks.toString()}), (${readPersonalStation.toString()}), (${alignStorefront.toString()}))`;
}

// A timed-out playback can still produce sound later. Recover the document before accepting more work.
// 只读请求超时不能立刻换文档：用户正在 Apple Music 窗口里填 Apple ID，重载会把表单连同已填内容一起
// 冲掉 —— 表现就是"登录到一半窗口跳回首页，永远登不上"。连续超时到第 3 次才认定页面真的卡死。
// Read-only timeouts must not replace the document right away: reloading wipes the Apple ID form the
// user is filling in, which looks like "the window jumps back to the home page mid sign-in". Only a
// third consecutive timeout means the page is actually wedged.
// 窗口可见时用户就在页面里打字，连"三次"也不该赌：那时只报超时，不换文档。
// While the window is visible the user is typing in that page, so even the third strike must not bet
// on a reload: report the timeout and leave the document alone.
const READ_TIMEOUT_STRIKES = 3;
function createRequestDispatcher(getContents, timeoutMs = 20000, getGeneration = () => 0, recoverPlayback = async () => false, canRecoverReads = () => true) {
    let scope;
    let recovery = null;
    return async message => {
        const request = validateRequest(message);
        if (!request) return { ok: false, error: 'invalid-request' };
        if (recovery) return { ok: false, error: 'not-ready' };
        const contents = getContents();
        if (!contents || contents.isDestroyed()) return { ok: false, error: 'not-ready' };
        try {
            const url = new URL(contents.getURL());
            if (url.protocol !== 'https:' || url.hostname !== 'music.apple.com') return { ok: false, error: 'not-ready' };
        } catch {
            return { ok: false, error: 'not-ready' };
        }
        const generation = getGeneration();
        if (!scope || scope.contents !== contents || scope.generation !== generation) {
            scope = { contents, generation, running: 0, chain: Promise.resolve(), invalid: false, preparing: false, pausing: false, playRevision: 0, readTimeouts: 0 };
        }
        const current = scope;
        if (current.invalid) return { ok: false, error: 'not-ready' };
        const urgentPause = request.operation === 'pause' && current.preparing && !current.pausing;
        // Leave room for the current transport and clock while background reads prepare the tail.
        const foreground = request.operation === 'playbackStatus'
            || (PLAYBACK_COMMANDS.has(request.operation) && request.operation !== 'prepareNext');
        if (current.running >= (foreground ? 4 : 2) && !urgentPause) return { ok: false, error: 'busy' };
        current.running++;
        if (request.operation === 'playSong' || request.operation === 'playStation') current.playRevision++;
        const playRevision = current.playRevision;
        if (urgentPause) current.pausing = true;
        let expired = false;
        const playback = PLAYBACK_COMMANDS.has(request.operation);
        const run = () => {
            // An old queued tail must not delay or alter a newer explicit song selection.
            if (request.operation === 'prepareNext' && current.playRevision !== playRevision) {
                return { ok: false, error: 'stale-request' };
            }
            // Queued work must not execute after its caller timed out or its document was replaced.
            if (expired || current.invalid || getGeneration() !== generation || getContents() !== contents || contents.isDestroyed()) {
                return { ok: false, error: 'not-ready' };
            }
            // Folia initiates the operation; preserve its user gesture for media playback.
            const preparing = request.operation === 'prepareNext';
            if (preparing) current.preparing = true;
            return Promise.resolve().then(() => contents.executeJavaScript(requestExpression(request), true))
                .catch(() => ({ ok: false, error: 'request-failed' }))
                .finally(() => { if (preparing) current.preparing = false; });
        };
        const work = playback && !urgentPause ? current.chain.then(run, run) : Promise.resolve().then(run);
        if (playback && !urgentPause) current.chain = work.then(() => {}, () => {});
        const settled = work.finally(() => { current.running--; if (urgentPause) current.pausing = false; });
        let timer;
        const result = await Promise.race([
            settled,
            new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs); }),
        ]);
        clearTimeout(timer);
        if (result.error === 'timeout') {
            expired = true;
            // 只读命令不会"稍后出声"，也不该为它换掉用户正在填写的文档：先记一次，连续到第 3 次才恢复。
            // A read cannot sound later, and must not cost the user the document they are typing into.
            if (!playback) current.readTimeouts += 1;
            if ((playback || (current.readTimeouts >= READ_TIMEOUT_STRIKES && canRecoverReads()))
                && !current.invalid && getGeneration() === generation && getContents() === contents && !contents.isDestroyed()) {
                current.invalid = true;
                console.warn('[AppleMusic] Page request timed out; replacing its document', { operation: request.operation, readTimeouts: current.readTimeouts });
                // Never release the old queue merely on timeout: navigation must first stop its player.
                recovery = Promise.resolve().then(() => {
                    // Logout may have taken ownership of the document before this microtask runs.
                    if (getGeneration() !== generation || getContents() !== contents || contents.isDestroyed()) return true;
                    return recoverPlayback(contents);
                }).then(recovered => {
                    if (recovered === true) recovery = null;
                }).catch(error => {
                    console.warn('[AppleMusic] Playback recovery failed', error);
                });
            }
            return result;
        }
        if (!playback) current.readTimeouts = 0;
        // An append might have reached Apple before navigation: do not invite the client's startup retry.
        if (current.invalid || getGeneration() !== generation || getContents() !== contents || contents.isDestroyed()) {
            return { ok: false, error: request.operation === 'addPlaylistTracks' ? 'request-failed' : 'not-ready' };
        }
        return result;
    };
}

module.exports = { validateRequest, requestExpression, createRequestDispatcher };
