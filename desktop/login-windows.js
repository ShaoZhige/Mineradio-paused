'use strict';

// Provider login windows (NetEase / QQ Music / Kugou), extracted from desktop/main.js.
// Pure cookie helpers are returned from the factory so tests can exercise them
// without spawning Electron or reading main.js source text.

function createLoginWindows(deps) {
  const {
    BrowserWindow,
    session,
    shell,
    desktopText,
    extractKugouAuth,
    appIcon,
    neteasePartition,
    neteaseLoginUrl,
    qqPartition,
    qqLoginUrl,
    qqFallbackUrl,
    kugouPartition,
    kugouLoginUrl,
    kugouWarmupUrl,
    qqCookiePriority,
    neteaseCookiePriority,
    kugouCookiePriority,
  } = deps || {};
  const setInterval = deps.setInterval || global.setInterval;
  const clearInterval = deps.clearInterval || global.clearInterval;
  const setTimeout = deps.setTimeout || global.setTimeout;
  const clearTimeout = deps.clearTimeout || global.clearTimeout;

function parseCookieHeader(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach((part) => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    out[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  });
  return out;
}

function qqCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  const isWechat = !!obj.wxopenid || Number(obj.login_type) === 2;
  const rawUin = isWechat
    ? (obj.wxuin || obj.uin || obj.p_uin || '')
    : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin || '');
  const uin = String(rawUin).replace(/\D/g, '');
  const musicKey = obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey ||
    obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || '';
  return !!(uin && musicKey);
}

function qqCookieHasPlaybackLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  const isWechat = !!obj.wxopenid || Number(obj.login_type) === 2;
  const rawUin = isWechat
    ? (obj.wxuin || obj.uin || obj.p_uin || '')
    : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin || '');
  const uin = String(rawUin).replace(/\D/g, '');
  const playbackKey = obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || '';
  return !!(uin && playbackKey);
}

function isTrustedQQLoginUrl(targetUrl) {
  try {
    const parsed = new URL(String(targetUrl || ''));
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return [
      'qq.com',
      'tencent.com',
      'qqmusic.com',
      'gtimg.com',
      'qpic.cn',
      'weixin.qq.com',
    ].some(domain => hostname === domain || hostname.endsWith('.' + domain));
  } catch (_) {
    return false;
  }
}

function qqLoginCompletionFromCookie(cookieText) {
  if (qqCookieHasPlaybackLogin(cookieText)) {
    return { ok: true, cookie: cookieText };
  }
  if (qqCookieHasLogin(cookieText)) {
    return {
      ok: false,
      partial: true,
      error: 'QQ_PLAYBACK_AUTH_INCOMPLETE',
      message: 'QQ 账号验证已完成，但 QQ 音乐播放授权尚未生成，请在官方登录窗口完成授权后再关闭',
    };
  }
  return { ok: false, cancelled: true, error: 'LOGIN_WINDOW_CLOSED_QQ', message: 'QQ 登录窗口已关闭' };
}

function neteaseCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  return !!obj.MUSIC_U;
}

function isQQCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === 'qq.com' || normalized.endsWith('.qq.com') || normalized.endsWith('qqmusic.qq.com');
}

function isNeteaseCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === '163.com' || normalized.endsWith('.163.com') ||
    normalized === 'music.163.com' || normalized.endsWith('.music.163.com') ||
    normalized === 'netease.com' || normalized.endsWith('.netease.com');
}

function isKugouCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === 'kugou.com' || normalized.endsWith('.kugou.com');
}

function kugouCookieHasLogin(cookieText) {
  return extractKugouAuth(cookieText).loggedIn;
}

function kugouCookieHasPlayback(cookieText) {
  return extractKugouAuth(cookieText).playbackReady;
}

function cookieIsExpired(cookie, nowSeconds) {
  const expires = Number(cookie && cookie.expirationDate);
  return Number.isFinite(expires) && expires > 0 && expires <= nowSeconds;
}

function qqLoginCookieCandidateScore(cookie) {
  const domain = String(cookie && cookie.domain || '').replace(/^\./, '').toLowerCase();
  const pathName = String(cookie && cookie.path || '/');
  let score = 0;
  if (domain === 'y.qq.com' || domain.endsWith('.y.qq.com')) score += 400;
  else if (domain === 'qqmusic.qq.com' || domain.endsWith('.qqmusic.qq.com')) score += 360;
  else if (domain === 'qq.com') score += 240;
  else if (domain.endsWith('.qq.com')) score += 160;
  if (pathName === '/') score += 40;
  if (cookie && cookie.secure) score += 10;
  if (cookie && cookie.hostOnly) score += 5;
  const expires = Number(cookie && cookie.expirationDate);
  if (Number.isFinite(expires) && expires > Date.now() / 1000) score += Math.min(20, Math.floor((expires - Date.now() / 1000) / 86400));
  return score;
}

function buildCookieHeaderFor(cookies, isAllowedDomain, priority, candidateScore) {
  const picked = new Map();
  const nowSeconds = Date.now() / 1000;
  (cookies || []).forEach((cookie) => {
    if (!cookie || !cookie.name || !isAllowedDomain(cookie.domain) || cookieIsExpired(cookie, nowSeconds)) return;
    const score = typeof candidateScore === 'function' ? Number(candidateScore(cookie)) || 0 : 0;
    const previous = picked.get(cookie.name);
    const expirationDate = Number(cookie.expirationDate) || 0;
    const tieKey = [cookie.domain || '', cookie.path || '', cookie.value || ''].join('\n');
    if (
      !previous ||
      score > previous.score ||
      (score === previous.score && expirationDate > previous.expirationDate) ||
      (score === previous.score && expirationDate === previous.expirationDate && tieKey > previous.tieKey)
    ) {
      picked.set(cookie.name, { value: cookie.value || '', score, expirationDate, tieKey });
    }
  });

  const ordered = [];
  (priority || []).forEach((name) => {
    if (picked.has(name)) {
      ordered.push([name, picked.get(name).value]);
      picked.delete(name);
    }
  });
  picked.forEach((entry, name) => ordered.push([name, entry.value]));

  return ordered
    .filter(([name, value]) => name && value != null && String(value) !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function buildCookieHeader(cookies) {
  return buildCookieHeaderFor(cookies, isQQCookieDomain, qqCookiePriority, qqLoginCookieCandidateScore);
}

async function readQQLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeader(cookies);
}

async function readNeteaseLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeaderFor(cookies, isNeteaseCookieDomain, neteaseCookiePriority);
}

async function readKugouLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeaderFor(cookies, isKugouCookieDomain, kugouCookiePriority);
}

async function openNeteaseMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(neteasePartition);
  const initialCookie = await readNeteaseLoginCookieHeader(cookieSession);
  if (neteaseCookieHasLogin(initialCookie)) return { ok: true, cookie: initialCookie, reused: true };

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;

    const loginWindow = new BrowserWindow({
      width: 940,
      height: 760,
      minWidth: 780,
      minHeight: 580,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: desktopText('desktop_netease_login', '网易云音乐登录'),
      backgroundColor: '#111111',
      icon: appIcon,
      webPreferences: {
        partition: neteasePartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
      resolve(result);
    };

    const checkCookies = async () => {
      try {
        const cookie = await readNeteaseLoginCookieHeader(cookieSession);
        if (neteaseCookieHasLogin(cookie)) {
          finish({ ok: true, cookie });
        }
      } catch (e) {
        console.warn('Netease login cookie check failed:', e.message);
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?(163|music\.163|netease)\.com/i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('Netease login popup navigation failed:', e.message));
      } else if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const docs = [document];
          document.querySelectorAll('iframe').forEach((frame) => {
            try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (_) {}
          });
          for (const doc of docs) {
            const nodes = Array.from(doc.querySelectorAll('a, button, span, div'));
            const loginNode = nodes.find((node) => {
              const text = (node.textContent || '').trim();
              if (!/登录|立即登录/.test(text)) return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            if (loginNode) { loginNode.click(); return true; }
          }
          return false;
        }, 900);
      `, true).catch(() => {});
    });

    loginWindow.__mineradioLoginWindow = true;
    loginWindow.__mineradioLoginTitleKey = 'desktop_netease_login';
    loginWindow.__mineradioLoginTitleFallback = '网易云音乐登录';
    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readNeteaseLoginCookieHeader(cookieSession);
        resolve(neteaseCookieHasLogin(cookie)
          ? { ok: true, cookie }
          : { ok: false, cancelled: true, error: 'LOGIN_WINDOW_CLOSED_NETEASE', message: '网易云登录窗口已关闭' });
      } catch (e) {
        resolve({ ok: false, error: e.message || '网易云登录窗口已关闭' });
      }
    });

    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(neteaseLoginUrl).catch((e) => finish({ ok: false, error: e.message }));
  });
}

async function openQQMusicLoginWindow(owner, options) {
  options = options || {};
  const cookieSession = session.fromPartition(qqPartition);
  const initialCookie = await readQQLoginCookieHeader(cookieSession);
  if (qqCookieHasPlaybackLogin(initialCookie)) {
    return { ok: true, cookie: initialCookie, reused: true, recovered: !!options.forceReauth };
  }
  if (options.forceReauth) {
    await cookieSession.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let warmupTimer = null;
    let warmupWindow = null;
    let playbackFinalizePending = false;
    let showWatchdog = null;
    const popupWindows = new Set();

    const loginWindow = new BrowserWindow({
      width: 900,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: desktopText('desktop_qq_login', 'QQ 音乐登录'),
      backgroundColor: '#111111',
      icon: appIcon,
      webPreferences: {
        partition: qqPartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const closeAuxiliaryWindows = () => {
      if (showWatchdog) {
        clearTimeout(showWatchdog);
        showWatchdog = null;
      }
      if (warmupTimer) {
        clearTimeout(warmupTimer);
        warmupTimer = null;
      }
      const windows = Array.from(popupWindows);
      popupWindows.clear();
      if (warmupWindow) windows.push(warmupWindow);
      warmupWindow = null;
      windows.forEach((win) => {
        try {
          if (win && !win.isDestroyed()) win.close();
        } catch (_) {}
      });
    };

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      closeAuxiliaryWindows();
      try { await cookieSession.flushStorageData(); } catch (_) {}
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
      resolve(result);
    };

    const showLoginWindow = () => {
      if (settled || !loginWindow || loginWindow.isDestroyed() || loginWindow.isVisible()) return;
      loginWindow.show();
      loginWindow.focus();
    };

    const loadQQOfficialLoginEntry = async () => {
      try {
        await loginWindow.loadURL(qqLoginUrl);
      } catch (firstError) {
        const message = String(firstError && firstError.message || firstError || '');
        if (/HTTP2|PROTOCOL_ERROR|ERR_FAILED/i.test(message)) {
          try { await cookieSession.clearCache(); } catch (_) {}
        }
        console.warn('QQ profile login entry failed, retrying official homepage:', message);
        await loginWindow.loadURL(qqFallbackUrl);
      }
    };

    const schedulePlaybackWarmup = () => {
      if (settled || warmupTimer || warmupWindow) return;
      // Give the official OAuth callback enough time to exchange the generic
      // QQ web session for qm_keyst/qqmusic_key. The fallback player page runs
      // in a separate hidden WebContents so it can never replace that callback.
      warmupTimer = setTimeout(() => {
        warmupTimer = null;
        if (settled || !loginWindow || loginWindow.isDestroyed()) return;
        warmupWindow = new BrowserWindow({
          width: 720,
          height: 520,
          parent: loginWindow,
          modal: false,
          show: false,
          autoHideMenuBar: true,
          backgroundColor: '#111111',
          icon: appIcon,
          webPreferences: {
            partition: qqPartition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        warmupWindow.on('closed', () => {
          warmupWindow = null;
        });
        warmupWindow.webContents.on('did-finish-load', checkCookies);
        warmupWindow.loadURL('https://y.qq.com/n/ryqq/player')
          .catch((e) => console.warn('QQ login warmup navigation failed:', e.message));
      }, 5000);
    };

    const checkCookies = async () => {
      try {
        const cookie = await readQQLoginCookieHeader(cookieSession);
        if (qqCookieHasPlaybackLogin(cookie)) {
          if (playbackFinalizePending) return;
          playbackFinalizePending = true;
          // QQ writes the playback ticket and profile/refresh cookies in a
          // short burst. Keep the official callback alive for one final read.
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 450));
          const finalizedCookie = await readQQLoginCookieHeader(cookieSession);
          await finish({
            ok: true,
            cookie: qqCookieHasPlaybackLogin(finalizedCookie) ? finalizedCookie : cookie,
          });
        } else if (qqCookieHasLogin(cookie)) {
          schedulePlaybackWarmup();
        }
      } catch (e) {
        if (!settled) playbackFinalizePending = false;
        console.warn('QQ login cookie check failed:', e.message);
      }
    };

    const installQQLoginWindowHandlers = (win, isRoot) => {
      if (!win || win.isDestroyed()) return;
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (isTrustedQQLoginUrl(url)) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 760,
              height: 640,
              parent: loginWindow,
              modal: false,
              show: true,
              autoHideMenuBar: true,
              backgroundColor: '#111111',
              icon: appIcon,
              webPreferences: {
                partition: qqPartition,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            },
          };
        }
        if (/^https?:\/\//i.test(String(url || ''))) {
          shell.openExternal(url).catch(() => {});
        }
        return { action: 'deny' };
      });
      win.webContents.on('did-create-window', (child) => {
        popupWindows.add(child);
        child.on('closed', () => popupWindows.delete(child));
        installQQLoginWindowHandlers(child, false);
      });
      if (!isRoot) win.webContents.on('did-finish-load', checkCookies);
    };
    installQQLoginWindowHandlers(loginWindow, true);

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      showLoginWindow();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
          const loginNode = nodes.find((node) => {
            const text = (node.textContent || '').trim();
            if (!/登录|登陆/.test(text)) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (loginNode) loginNode.click();
        }, 700);
      `, true).catch(() => {});
    });

    loginWindow.__mineradioLoginWindow = true;
    loginWindow.__mineradioLoginTitleKey = 'desktop_qq_login';
    loginWindow.__mineradioLoginTitleFallback = 'QQ 音乐登录';
    loginWindow.on('ready-to-show', showLoginWindow);
    loginWindow.on('closed', async () => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      closeAuxiliaryWindows();
      try {
        const cookie = await readQQLoginCookieHeader(cookieSession);
        try { await cookieSession.flushStorageData(); } catch (_) {}
        resolve(qqLoginCompletionFromCookie(cookie));
      } catch (e) {
        resolve({ ok: false, error: e.message || 'QQ 登录窗口已关闭' });
      }
    });

    pollTimer = setInterval(checkCookies, 1200);
    showWatchdog = setTimeout(showLoginWindow, 2500);
    loadQQOfficialLoginEntry().catch((e) => finish({ ok: false, error: e.message }));
  });
}

async function clearQQMusicLoginSession() {
  const cookieSession = session.fromPartition(qqPartition);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

async function openKugouMusicLoginWindow(owner, options) {
  options = options && typeof options === 'object' ? options : {};
  const cookieSession = session.fromPartition(kugouPartition);
  // Explicit re-login must discard the revoked session before considering reuse.
  // Cookie presence alone cannot establish whether the server still accepts it.
  if (options.forceReauth === true) {
    await cookieSession.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
    });
  }
  const initialCookie = await readKugouLoginCookieHeader(cookieSession);
  if (kugouCookieHasPlayback(initialCookie)) return { ok: true, cookie: initialCookie, reused: true };

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let warmupStarted = false;

    const loginWindow = new BrowserWindow({
      width: 900,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: desktopText('desktop_kugou_login', '酷狗音乐登录'),
      backgroundColor: '#111111',
      icon: appIcon,
      webPreferences: {
        partition: kugouPartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      resolve(result);
    };

    const checkCookies = async () => {
      try {
        const cookie = await readKugouLoginCookieHeader(cookieSession);
        if (kugouCookieHasPlayback(cookie)) {
          finish({ ok: true, cookie });
        } else if (kugouCookieHasLogin(cookie) && !warmupStarted) {
          warmupStarted = true;
          setTimeout(() => {
            if (!settled && loginWindow && !loginWindow.isDestroyed()) {
              loginWindow.loadURL(kugouWarmupUrl).catch((e) => console.warn('Kugou login warmup navigation failed:', e.message));
            }
          }, 900);
        }
      } catch (e) {
        console.warn('Kugou login cookie check failed:', e.message);
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('Kugou login popup navigation failed:', e.message));
      } else {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
          const loginNode = nodes.find((node) => {
            const text = (node.textContent || '').trim();
            if (!/登录|登陆/.test(text)) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (loginNode) loginNode.click();
        }, 700);
      `, true).catch(() => {});
    });

    loginWindow.__mineradioLoginWindow = true;
    loginWindow.__mineradioLoginTitleKey = 'desktop_kugou_login';
    loginWindow.__mineradioLoginTitleFallback = '酷狗音乐登录';
    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readKugouLoginCookieHeader(cookieSession);
        resolve(kugouCookieHasPlayback(cookie)
          ? { ok: true, cookie }
          : (kugouCookieHasLogin(cookie)
            ? { ok: true, cookie, partial: true, error: 'KUGOU_PLAYBACK_TOKEN_INCOMPLETE', message: '酷狗账号已登录，但播放 token 不完整，请稍后在播放器内重试登录' }
            : { ok: false, cancelled: true, error: 'LOGIN_WINDOW_CLOSED_KUGOU', message: '酷狗登录窗口已关闭' }));
      } catch (e) {
        resolve({ ok: false, error: e.message || '酷狗登录窗口已关闭' });
      }
    });

    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(kugouLoginUrl).catch((e) => finish({ ok: false, error: e.message }));
  });
}

async function clearKugouMusicLoginSession() {
  const cookieSession = session.fromPartition(kugouPartition);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

async function clearNeteaseMusicLoginSession() {
  const cookieSession = session.fromPartition(neteasePartition);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

  return {
    openNeteaseMusicLoginWindow,
    openQQMusicLoginWindow,
    openKugouMusicLoginWindow,
    clearNeteaseMusicLoginSession,
    clearQQMusicLoginSession,
    clearKugouMusicLoginSession,
    readNeteaseLoginCookieHeader,
    readQQLoginCookieHeader,
    readKugouLoginCookieHeader,
    parseCookieHeader,
    qqCookieHasLogin,
    qqCookieHasPlaybackLogin,
    qqLoginCompletionFromCookie,
    isTrustedQQLoginUrl,
    isQQCookieDomain,
    isNeteaseCookieDomain,
    isKugouCookieDomain,
    kugouCookieHasLogin,
    kugouCookieHasPlayback,
    buildCookieHeaderFor,
    buildCookieHeader,
    qqLoginCookieCandidateScore,
  };
}

module.exports = { createLoginWindows };
