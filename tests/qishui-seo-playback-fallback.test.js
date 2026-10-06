'use strict';

// 签名校验升级后，未签名的 track_v2 会返回 HTTP 200 + 空 body，播放整体失效。
// 本文件覆盖两件事：
//   1) 「SEO 回退」这条与账号态无关的通路：免费曲拿全曲、会员曲拿服务端裁剪的试听片段。
//   2) 签名桥接的边界：未授权绝不签名，签名只能来自官方客户端的原生模块，
//      仓库里不存在任何硬编码的签名材料。
// 桥接刻意保持默认启用，用独立的临时缓存目录隔离，避免测试读写用户主目录下的真实授权。

const assert = require('assert');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-qishui-bridge-'));
const CACHE_DIR = path.join(SANDBOX, 'cache');
// 客户端根目录必须与缓存目录分开，并且保持为空：这样探测结果与开发机是否装了官方客户端无关。
const EMPTY_CLIENT_DIR = path.join(SANDBOX, 'empty-client');
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(EMPTY_CLIENT_DIR, { recursive: true });
// 本文件需要走「桥接已启用」的代码路径，因此显式打开它（测试运行器默认会关掉）。
process.env.QISHUI_CLIENT_BRIDGE = '';
process.env.QISHUI_NATIVE_CACHE_DIR = CACHE_DIR;
process.env.QISHUI_CLIENT_DIR = EMPTY_CLIENT_DIR;
// 把平台默认安装目录也指进沙箱：否则在真的装了官方客户端的开发机上，测试会去加载专有二进制。
['LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'USERPROFILE', 'HOME'].forEach(name => {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) process.env[name] = SANDBOX;
});
process.env.HOMEDRIVE = SANDBOX.slice(0, 2);
process.env.HOMEPATH = SANDBOX.slice(2);

const qishui = require('../server/qishui-api');
const bridge = require('../server/qishui-client-bridge');

function withHttpsMock(handler, task) {
  const original = https.request;
  https.request = function mockedRequest(targetUrl, options, callback) {
    const request = new EventEmitter();
    const chunks = [];
    request.write = chunk => chunks.push(Buffer.from(String(chunk)));
    request.setTimeout = () => request;
    request.destroy = error => request.emit('error', error || new Error('destroyed'));
    request.end = () => {
      Promise.resolve(handler({
        url: String(targetUrl),
        options: options || {},
        body: Buffer.concat(chunks).toString('utf8'),
      })).then(result => {
        result = result || {};
        const response = new EventEmitter();
        response.statusCode = Number(result.statusCode || 200);
        response.headers = result.headers || {};
        callback(response);
        process.nextTick(() => {
          response.emit('data', Buffer.from(typeof result.body === 'string' ? result.body : JSON.stringify(result.body || {})));
          response.emit('end');
        });
      }).catch(error => request.emit('error', error));
    };
    return request;
  };
  return Promise.resolve().then(task).finally(() => { https.request = original; });
}

const sessionCookie = 'sessionid=seo-fallback-session; sid_tt=seo-fallback-sid; uid_tt=seo-fallback-user';

function stripComments(source) {
  return String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * SEO 接口的真实返回形状（字段名与线上一致，仅数量缩减）。
 * label_info.quality_map 里刻意带上 lossless/hi_res 的 need_vip=true：
 * 免费曲同样会出现这些标记，它们描述的是音质档位而不是整曲权益。
 */
function seoTrackPayload(options) {
  const opts = options || {};
  const trackId = opts.trackId || 'seo-fixture';
  const fullDurationMs = Number(opts.fullDurationMs) || 261188;
  const vipOnly = !!opts.vipOnly;
  return {
    status_info: { now: 1, now_ts_ms: 1 },
    seo_track: {
      track: {
        id: trackId,
        name: opts.name || 'SEO 回退测试曲目',
        duration: fullDurationMs,
        media_type: 'track',
        artists: [{ id: 'artist-fixture', name: '测试歌手' }],
        bit_rates: [
          { br: 68199, size: 2226600, quality: 'medium' },
          { br: 132194, size: 4315956, quality: 'higher' },
        ],
        label_info: Object.assign({
          only_vip_download: true,
          quality_map: {
            medium: { play_detail: { need_vip: false } },
            lossless: { play_detail: { need_vip: true } },
            hi_res: { play_detail: { need_vip: true } },
          },
        }, vipOnly ? { only_vip_playable: true } : {}),
        limited_free_info: vipOnly
          ? { queue_types: [], expire_time: 0, sign_version: '', intercept_type: '' }
          : null,
      },
    },
    track_player: {
      media_id: 'media-fixture',
      url_player_info: 'https://media.example/seo-player-info',
    },
    lyric: { content: '' },
  };
}

function playerInfoPayload(streams) {
  return {
    Result: {
      Data: {
        PlayInfoList: streams.map(item => ({
          MainPlayUrl: item.url,
          Duration: item.duration,
          Bitrate: item.bitrate,
          Format: item.format || 'm4a',
          Quality: item.quality,
          Size: item.size,
        })),
      },
    },
  };
}

function testSeoVipSignalIgnoresQualityTierFlags() {
  // 免费曲：quality_map 里 lossless/hi_res 都是 need_vip=true，但整曲本身不收费。
  const free = qishui._test.qishuiSeoVipOnlySignal(seoTrackPayload({ vipOnly: false }));
  assert.strictEqual(free.vipOnly, false, 'quality-tier need_vip flags must not mark a free track as VIP-only');
  assert.strictEqual(free.onlyVipPlayable, false);
  assert.strictEqual(free.limitedFreeActive, false);

  const vip = qishui._test.qishuiSeoVipOnlySignal(seoTrackPayload({ vipOnly: true }));
  assert.strictEqual(vip.vipOnly, true, 'only_vip_playable must mark the track as VIP-only');
  assert.strictEqual(vip.onlyVipPlayable, true);
  assert.strictEqual(vip.limitedFreeActive, true, 'limited_free_info must be read as a VIP/limited marker');
}

function testHeaderPayloadRoundTrip() {
  const t = bridge._test;
  assert.strictEqual(t.buildHeaderLinePayload({ A: '1', B: '2' }), 'A\r\n1\nB\r\n2');
  assert.deepStrictEqual(t.parseHeaderLinePayload('X-Helios: abc\nX-Medusa: def'), {
    'X-Helios': 'abc',
    'X-Medusa': 'def',
  });
  assert.deepStrictEqual(t.parseHeaderLinePayload('X-Helios\r\nabc\r\nX-Medusa\r\ndef'), {
    'X-Helios': 'abc',
    'X-Medusa': 'def',
  });
  assert.strictEqual(t.normalizeBinding({}), null, '不含签名能力的导出必须被拒绝');
  assert.ok(t.normalizeBinding({ generateHttpSignatureHeaders() { return 'X-Helios: z'; } }));
  assert.strictEqual(t.isUsableDeviceId('1234567890123456'), true);
  assert.strictEqual(t.isUsableDeviceId(''), false);
}

function testUnsignedRequestsKeepTheShippedShape() {
  const request = qishui._test.buildQishuiTrackV2Request({
    cookie: sessionCookie,
    params: { track_id: 'unsigned-shape' },
  });
  assert.strictEqual(request.signed, false, '未授权时不得声称已签名');
  // 未签名时保持原有参数与 UA，避免影响其它已工作的链路。
  assert(/version_code=30030000/.test(request.url), 'unsigned track_v2 must keep the shipped version_code');
  assert(/LunaPC\/3\.3\.0/.test(String(request.headers['User-Agent'])), 'unsigned track_v2 must keep the shipped UA');
  assert.strictEqual(request.signed, false);
}

function testNoAuthorizationMeansNoSignature() {
  // 前置条件：本机没有任何授权记录。
  assert.strictEqual(bridge._test.readAuthorization(), null);
  const before = bridge.getQishuiClientBridgeStatus();
  assert.strictEqual(before.authorized, false, '未授权时 authorized 必须为 false');
  assert.strictEqual(before.signing, false, '未授权时不得进入可签名状态');

  const denied = bridge.signQishuiClientRequest('https://api.qishui.com/luna/pc/track_v2?aid=386088', {
    'Accept': 'application/json,text/plain,*/*',
  });
  assert.strictEqual(denied.ok, false, '未授权时绝不能返回签名头');
  assert.deepStrictEqual(denied.headers, {});
  assert.strictEqual(denied.deviceId, '');
  assert.strictEqual(denied.reason, 'client_not_authorized', '未授权必须区别于「装了但模块坏」的失败原因');

  // 即使伪造一条本地授权记录，没有原生模块也拿不到签名：签名只能来自官方客户端。
  const fakeNativeDir = path.join(CACHE_DIR, 'fake-native');
  fs.mkdirSync(fakeNativeDir, { recursive: true });
  fs.writeFileSync(path.join(fakeNativeDir, 'bdms.node'), '', 'utf8');
  assert.strictEqual(bridge._test.writeAuthorization({
    at: Date.now(),
    deviceId: '1234567890123456',
    clientDir: EMPTY_CLIENT_DIR,
    nativeDir: fakeNativeDir,
    launched: false,
  }), true);
  bridge.resetQishuiClientBridge();
  assert.strictEqual(bridge.getQishuiClientBridgeStatus().authorized, true, '记录存在时应报告已授权');
  const stillDenied = bridge.signQishuiClientRequest('https://api.qishui.com/luna/pc/track_v2?aid=386088', {});
  assert.strictEqual(stillDenied.ok, false, '没有可用的原生模块时，本地记录不得凭空产生签名');
  assert.deepStrictEqual(stillDenied.headers, {});
}

function testAuthorizationRecordHoldsNoCredentials() {
  const record = bridge._test.readAuthorization();
  assert.ok(record, '上一步写入的授权记录应仍然存在');
  assert.deepStrictEqual(
    Object.keys(record).sort(),
    ['at', 'clientDir', 'deviceId', 'launched', 'nativeDir'],
    '授权记录只允许保存设备身份与本地路径，不得出现凭据字段'
  );
  assert.strictEqual(JSON.stringify(record).includes('X-Helios'), false);
  assert.strictEqual(JSON.stringify(record).includes('X-Medusa'), false);
}

function testRevokeDropsTheLocalAuthorization() {
  assert.strictEqual(bridge.revokeQishuiClientAuthorization(), true);
  assert.strictEqual(bridge._test.readAuthorization(), null, '撤销后本地授权记录必须消失');
  bridge.resetQishuiClientBridge();
  assert.strictEqual(bridge.getQishuiClientBridgeStatus().signing, false);
}

function testSignaturesAreNeverHardcoded() {
  // 签名头由官方 SDK 生成，模块自身不得出现签名头名或高熵字面量：任何硬编码的签名值都会在这里露馅。
  const bridgeSource = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'qishui-client-bridge.js'), 'utf8'));
  assert.strictEqual(/X-Helios|X-Medusa/.test(bridgeSource), false, '签名头只能来自 SDK 返回值，不能在代码里写死');
  const apiSource = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'qishui-api.js'), 'utf8'));
  assert.strictEqual(/X-Helios|X-Medusa/.test(apiSource), false, 'qishui-api 不得自行拼装签名头');
  const entitlementLiterals = (bridgeSource.match(/['"][A-Za-z0-9+/=_-]{40,}['"]/g) || []);
  assert.deepStrictEqual(entitlementLiterals, [], '桥接模块不得内嵌任何长签名/密钥字面量');
  // 官方二进制也不允许随仓库分发。
  const trackedNative = ['bdms.node', 'metasecml.dll', 'metasecml.dylib', 'libmetasecml.so']
    .filter(name => fs.existsSync(path.join(ROOT, name)));
  assert.deepStrictEqual(trackedNative, [], '仓库根目录不得出现官方客户端二进制');
}

function seoResolution(options) {
  const opts = options || {};
  const fullDuration = Number(opts.fullDuration) || 187025;
  const clipDuration = Number(opts.clipDuration) || 60;
  return {
    best: {
      url: opts.url || 'https://media.example/seo-clip.m4a',
      duration: clipDuration,
      bitrate: 129649,
      quality: 'higher',
      format: 'm4a',
      size: 972391,
    },
    fullDuration,
    vipOnlySignal: {
      vipOnly: opts.vipOnly !== false,
      onlyVipPlayable: opts.vipOnly !== false,
      limitedFreeActive: opts.vipOnly !== false,
    },
  };
}

/**
 * 提示分支必须与「开发机装了没装官方客户端」解耦，因此直接喂合成状态给结果构造函数。
 * 三个分支对应三种完全不同的下一步，混成一句就等于没提示。
 */
function testVipClientHintBranches() {
  const notInstalled = qishui._test.qishuiSeoPlaybackResult(seoResolution(), {
    bridgeStatus: { installed: false, ready: false, authorized: false, signing: false },
  });
  assert.strictEqual(notInstalled.trial, true);
  assert.strictEqual(notInstalled.vipClientHint.reason, 'client_missing');
  assert.strictEqual(notInstalled.vipClientHint.clientInstalled, false);
  assert.strictEqual(notInstalled.vipClientHint.canAuthorize, false, '没装客户端时给授权按钮只会让人白点');
  assert(/安装官方客户端/.test(notInstalled.vipClientHint.message));

  const installedNotAuthorized = qishui._test.qishuiSeoPlaybackResult(seoResolution(), {
    bridgeStatus: { installed: true, ready: true, authorized: false, signing: false },
  });
  assert.strictEqual(installedNotAuthorized.vipClientHint.reason, 'client_not_authorized');
  assert.strictEqual(installedNotAuthorized.vipClientHint.clientInstalled, true);
  assert.strictEqual(installedNotAuthorized.vipClientHint.authorized, false);
  assert.strictEqual(installedNotAuthorized.vipClientHint.canAuthorize, true, '已装但未授权时必须提供授权入口');

  const authorizedButLimited = qishui._test.qishuiSeoPlaybackResult(seoResolution(), {
    bridgeStatus: { installed: true, ready: true, authorized: true, signing: true },
  });
  assert.strictEqual(authorizedButLimited.vipClientHint.reason, 'entitlement_limited');
  assert.strictEqual(authorizedButLimited.vipClientHint.canAuthorize, false, '签名已可用时不应再引导装/开客户端');

  // 免费曲拿到全曲时不得出现任何提示。
  const free = qishui._test.qishuiSeoPlaybackResult(seoResolution({
    vipOnly: false,
    fullDuration: 261188,
    clipDuration: 261,
  }), { bridgeStatus: { installed: false, ready: false, authorized: false, signing: false } });
  assert.strictEqual(free.trial, false);
  assert.strictEqual(free.vipRequired, false);
  assert.strictEqual(free.vipClientHint, null);
}

async function testFreeTrackRecoversThroughSeoWhenTrackV2IsRejected() {
  const fullUrl = 'https://media.example/seo-free-full.m4a';
  let seoRequests = 0;
  await withHttpsMock(({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/luna/pc/track_v2') {
      // 签名校验升级后的真实表现：HTTP 200 + 空 body。
      return { body: '' };
    }
    if (parsed.hostname === 'beta-luna.douyin.com' && parsed.pathname === '/luna/h5/seo_track') {
      seoRequests += 1;
      assert.strictEqual(parsed.searchParams.get('track_id'), 'seo-free-track');
      assert.strictEqual(parsed.searchParams.get('device_platform'), 'web');
      return { body: seoTrackPayload({ trackId: 'seo-free-track', fullDurationMs: 261188 }) };
    }
    if (parsed.pathname === '/seo-player-info') {
      return { body: playerInfoPayload([
        { url: fullUrl, duration: 261.188, bitrate: 129433, quality: 'higher', size: 4225815 },
      ]) };
    }
    if (parsed.pathname === '/luna/pc/me') {
      return { body: { data: { my_info: { id: 'seo-user', nickname: 'Fixture' }, is_vip: false } } };
    }
    throw new Error('Unexpected request: ' + parsed.hostname + parsed.pathname);
  }, async () => {
    const result = await qishui.handleQishuiSongUrl({ id: 'seo-free-track' }, sessionCookie);
    assert.strictEqual(result.playable, true, '未签名的 track_v2 失败后必须能通过 SEO 回退播放');
    assert.strictEqual(result.url, fullUrl);
    assert.strictEqual(result.trial, false, '免费曲在 SEO 通路上应当拿到全曲');
    assert.strictEqual(result.source, 'qishui-beta-seo-track');
    assert.strictEqual(result.duration, 261);
    assert.strictEqual(result.vipRequired, false);
    assert.strictEqual(result.vipClientHint, null, '全曲可播时不应出现安装客户端提示');
  });
  assert.strictEqual(seoRequests, 1, 'SEO 回退每个请求只发起一次');
}

async function testVipTrackFallsBackToTrialAndPromptsForTheOfficialClient() {
  const trialUrl = 'https://media.example/seo-vip-trial.m4a';
  await withHttpsMock(({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/luna/pc/track_v2') return { body: '' };
    if (parsed.pathname === '/luna/h5/seo_track') {
      return { body: seoTrackPayload({ trackId: 'seo-vip-track', fullDurationMs: 187025, vipOnly: true }) };
    }
    if (parsed.pathname === '/seo-player-info') {
      // 会员曲由服务端硬切成试听片段：时长明显短于整曲。
      return { body: playerInfoPayload([
        { url: trialUrl, duration: 60.001, bitrate: 129649, quality: 'higher', size: 972391 },
      ]) };
    }
    if (parsed.pathname === '/luna/pc/me') {
      return { body: { data: { my_info: { id: 'seo-user', nickname: 'Fixture' }, is_vip: false } } };
    }
    throw new Error('Unexpected request: ' + parsed.hostname + parsed.pathname);
  }, async () => {
    const result = await qishui.handleQishuiSongUrl({ id: 'seo-vip-track' }, sessionCookie);
    assert.strictEqual(result.playable, true, '会员曲仍应播放服务端给出的试听片段');
    assert.strictEqual(result.url, trialUrl);
    assert.strictEqual(result.trial, true, '片段短于整曲时必须标记为试听');
    assert.strictEqual(result.requiredTier, 'vip');
    assert.strictEqual(result.duration, 60);
    assert.ok(result.vipClientHint, '会员曲 + 本机无授权签名时必须给出提示');
    assert.strictEqual(result.vipClientHint.required, true);
    assert.strictEqual(result.vipClientHint.clientInstalled, false);
    assert.strictEqual(result.vipClientHint.reason, 'client_missing');
    assert(/安装官方客户端/.test(result.vipClientHint.message));
    // 提示只描述状态：后端不负责文案本地化，前端按 reason 取词典。
    assert.strictEqual(JSON.stringify(result).includes('X-Helios'), false);
  });
}

async function testFreeTrackPlaysWithoutAnySavedLogin() {
  const fullUrl = 'https://media.example/seo-anonymous-full.m4a';
  let pcRequests = 0;
  await withHttpsMock(({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/luna/pc/')) {
      pcRequests += 1;
      throw new Error('未登录时不应请求需要账号态的 PC 接口');
    }
    if (parsed.pathname === '/luna/h5/seo_track') {
      return { body: seoTrackPayload({ trackId: 'seo-anonymous', fullDurationMs: 200000 }) };
    }
    if (parsed.pathname === '/seo-player-info') {
      return { body: playerInfoPayload([
        { url: fullUrl, duration: 200, bitrate: 129433, quality: 'higher', size: 3200000 },
      ]) };
    }
    throw new Error('Unexpected request: ' + parsed.hostname + parsed.pathname);
  }, async () => {
    const result = await qishui.handleQishuiSongUrl({ id: 'seo-anonymous' }, '');
    assert.strictEqual(result.playable, true, '免签名通路不依赖登录态，免费曲必须可播');
    assert.strictEqual(result.url, fullUrl);
    assert.strictEqual(result.loggedIn, false);
    assert.strictEqual(result.trial, false);
  });
  assert.strictEqual(pcRequests, 0, '未登录时不应浪费时间在需要账号态的 PC 接口上');
}

async function testUnavailableSeoStillReportsLoginRequired() {
  await withHttpsMock(({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/luna/h5/seo_track') {
      return { body: { status_code: 1000091, status_info: { status_msg: 'SEO页面歌曲未知' } } };
    }
    if (parsed.pathname.startsWith('/luna/pc/')) throw new Error('unexpected PC request');
    throw new Error('Unexpected request: ' + parsed.hostname + parsed.pathname);
  }, async () => {
    const result = await qishui.handleQishuiSongUrl({ id: 'seo-unknown' }, '');
    assert.strictEqual(result.playable, false);
    assert.strictEqual(result.reason, 'login_required', 'SEO 也拿不到内容时仍需引导用户登录');
    assert.strictEqual(result.url, '');
  });
}

async function main() {
  testSeoVipSignalIgnoresQualityTierFlags();
  testHeaderPayloadRoundTrip();
  testVipClientHintBranches();
  testUnsignedRequestsKeepTheShippedShape();
  testNoAuthorizationMeansNoSignature();
  testAuthorizationRecordHoldsNoCredentials();
  testRevokeDropsTheLocalAuthorization();
  testSignaturesAreNeverHardcoded();
  await testFreeTrackRecoversThroughSeoWhenTrackV2IsRejected();
  await testVipTrackFallsBackToTrialAndPromptsForTheOfficialClient();
  await testFreeTrackPlaysWithoutAnySavedLogin();
  await testUnavailableSeoStillReportsLoginRequired();
  console.log('[OK] Qishui SEO fallback restores free playback; signatures stay runtime-only.');
}

main()
  .then(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); })
  .catch(error => {
    console.error(error && error.stack || error);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    process.exitCode = 1;
  });
