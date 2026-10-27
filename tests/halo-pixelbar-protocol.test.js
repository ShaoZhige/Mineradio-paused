'use strict';

// 花再 Halo PixelBar 同步：协议字节与接线两件事一起钉。
// 这台音响没有仿真器，抓包记录是唯一的规格来源，所以每个包形态都写成字节向量 ——
// 有人重构拼包函数时会立刻看到偏移变了，而不是等用户发现屏幕乱码。
// The speaker has no simulator, so the captured packet layout is the only spec. Each frame
// is pinned as a byte vector; a refactor that shifts an offset fails here instead of on
// someone's desk.

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const halo = require('../desktop/halo-lyric-sync.js');

const hex = (buffer, length) => Buffer.from(buffer.slice(0, length)).toString('hex');

testTextPacket();
testV2Frames();
testTruncation();
testConfigRoundTrip();
testLazyHidInit();
testAsarUnpackResolution();
testWiring();

function testTextPacket() {
  // 2E AA EC E8 | 颜色 | 总长 LE | 文本长 | 文本 | 校验
  const packet = halo.buildTextPacket('Hi', 0, 32);
  assert.equal(packet.length, 64, '文字包必须补齐到 64 字节整包');
  assert.equal(hex(packet, 11), '2eaaece800040002486935');
  // 校验和只对文本字节求和，起点 128，每字节 +2
  assert.equal(halo.checksumV1(Buffer.from('Hi', 'utf8')), 0x35);
  assert.equal(halo.checksumV1(Buffer.from('', 'utf8')), 128);
}

function testV2Frames() {
  assert.equal(hex(halo.buildFrameV2(0x67, [5]), 8), '2eaaed6700010504');
  // 场景包固定 F0 B4 C8：改色会让固件复位，所以颜色字段不跟着配置走
  assert.equal(hex(halo.buildScenePacket(0, 0, 0, 0, 0), 18), '2eaaecef000902f0b4c8000100fffffb0000');
  assert.equal(hex(halo.buildSpectrumPacket(1), 17), '2eaaecef000901c0fff200010800ff4800');
  assert.equal(hex(halo.buildClockPacket(1), 17), '2eaaecef000901f0b4c800010000fffbff');
  // v2 校验和从 AA 字节起算，与 v1 的「仅文本」规则不同，混用会让设备整包丢弃
  const beforeChecksum = Buffer.from([0x2e, 0xaa, 0xed, 0x67, 0x00, 0x01, 0x05]);
  assert.equal(halo.checksumV2(beforeChecksum), 0x04);
  assert.equal(halo.displayWidth('晴天abc'), 7, 'CJK 按两格算宽度');
}

function testTruncation() {
  // 两条上限同时存在：显示宽度与 64 字节包容量，谁先到谁截断
  const long = halo.buildTextPacket('一二三四五六七八九十'.repeat(6), 0, 32);
  const textLength = long[7];
  const text = long.slice(8, 8 + textLength).toString('utf8');
  assert.ok(halo.displayWidth(text) <= 32, '显示宽度不能超过配置值');
  assert.ok(Buffer.byteLength(text, 'utf8') <= 54, '文本字节不能撑破 64 字节包');
  assert.ok(textLength > 0, '长文本不能被截成空串');
}

function testConfigRoundTrip() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'halo-cfg-'));
  const file = path.join(dir, 'halo-sync.json');
  const instance = new halo.HaloSync(file);
  // 默认不开自动重连标识 —— 没连过设备的机器不该在启动时派生子进程
  assert.equal(instance.config.lastDeviceSeen, false);
  instance.setConfig({ volumeSync: true, align: 'left' });
  const reloaded = halo.loadConfig(file);
  assert.equal(reloaded.volumeSync, true);
  assert.equal(reloaded.align, 'left');
  assert.equal(reloaded.enabled, true, '未写的字段回落默认值');
  fs.rmSync(dir, { recursive: true, force: true });
}

function testLazyHidInit() {
  // 构造 HaloSync 只是读配置文件。真派生子进程发生在第一次 connect()，
  // 否则每个没买这台音响的用户都会白挂一个常驻进程。
  const instance = new halo.HaloSync(null);
  assert.equal(instance._hidReady, false, '构造阶段不应初始化 HID');
  assert.equal(instance.remote, undefined, '构造阶段不应派生子进程');
  assert.equal(typeof instance.dispose, 'function');
}

function testAsarUnpackResolution() {
  // 打包后 desktop/ 在 app.asar 里，而 HID 子进程是纯 Node，读不到 asar 内部。
  // 解包那份存在时必须选它，否则装好的应用永远连不上音响，开发期又看不出来。
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-asar-'));
  const asarDesktop = path.join(root, 'resources', 'app.asar', 'desktop');
  const unpackedDesktop = path.join(root, 'resources', 'app.asar.unpacked', 'desktop');
  fs.mkdirSync(asarDesktop, { recursive: true });
  fs.mkdirSync(unpackedDesktop, { recursive: true });
  fs.copyFileSync(path.join(appRoot, 'desktop', 'halo-lyric-sync.js'), path.join(asarDesktop, 'halo-lyric-sync.js'));
  fs.writeFileSync(path.join(unpackedDesktop, 'halo-hid-server.js'), '// stub\n');
  const packed = require(path.join(asarDesktop, 'halo-lyric-sync.js'));
  assert.ok(
    packed.HID_SCRIPT_PATH.includes('app.asar.unpacked'),
    '打包环境下必须指向解包后的 HID 子进程脚本，实际是 ' + packed.HID_SCRIPT_PATH
  );
  assert.ok(fs.existsSync(packed.HID_SCRIPT_PATH));
  fs.rmSync(root, { recursive: true, force: true });
}

function testWiring() {
  const preload = read('desktop/preload.js');
  const main = read('desktop/main.js');
  const loader = read('public/js/index-loader.js');
  const indexHtml = read('public/index.html');
  const bridge = read('public/js/modules/06-lyrics/halo-sync-bridge.js');
  const css = read('public/css/index.css');
  const haloSource = read('desktop/halo-lyric-sync.js');

  // 枚举要按 VID/PID 过滤：不过滤的话本机 15 个键鼠接口全会被报成「找到设备」
  assert.match(haloSource, /\.filter\(\(d\) => d\.vendorId === VENDOR_ID && d\.productId === PRODUCT_ID\)/);

  // 渲染进程走 preload 桥，不直连 ipcRenderer
  assert.match(preload, /halo:\s*\{[\s\S]{0,2000}getConfig: \(\) => ipcRenderer\.invoke\('halo-sync-get-config'\)/);
  assert.match(preload, /listDevices: \(\) => ipcRenderer\.invoke\('halo-sync-list-devices'\)/);
  assert.doesNotMatch(bridge, /ipcRenderer/, '桥接模块不能直接碰 ipcRenderer');

  // 每个通道都先过可信发送方判据：音响能改的是硬件状态，不能由任意窗口驱动
  const channels = [
    'halo-sync-get-config', 'halo-sync-set-config', 'halo-sync-set-enabled',
    'halo-sync-list-devices', 'halo-sync-connect', 'halo-sync-lyric',
    'halo-sync-audio-frame', 'halo-sync-volume', 'halo-sync-play-state',
    'halo-sync-song', 'halo-sync-cover-color', 'halo-sync-scene',
    'halo-sync-spectrum', 'halo-sync-clock-style', 'halo-sync-manual-hold',
  ];
  for (const channel of channels) {
    const at = main.indexOf("'" + channel + "'");
    assert.ok(at > 0, '主进程缺少通道 ' + channel);
    const handler = main.slice(at, at + 220);
    assert.match(handler, /isTrustedMainWindowIpc\(event\)/, channel + ' 没有校验可信发送方');
  }
  // 启动恢复必须同时看开关与「连过设备」两个条件
  assert.match(main, /if \(!saved\.enabled \|\| !saved\.lastDeviceSeen\) return;/);
  assert.match(main, /restoreHaloSyncOnStartup\(\);/);

  // 模块目录里的每个 .js 都必须登记，未登记的模块永不加载且不报错
  assert.match(loader, /'js\/modules\/06-lyrics\/halo-sync-bridge\.js'/);
  assert.doesNotMatch(indexHtml, /halo-sync-bridge\.js/, '走加载器登记，不要往 index.html 塞 script');

  // 浮层的毛玻璃必须跟着画质档位走
  assert.match(css, /\.halo-sync-panel\s*\{[\s\S]{0,600}backdrop-filter:\s*blur\(calc\(10px \* var\(--glass-blur-scale, 1\)\)\)/);
  assert.match(css, /\.halo-sync-panel\.show\s*\{[\s\S]{0,40}display:\s*block/);

  // 面板文案全部走词典，不许写死中文
  const uiStrings = bridge.match(/'(halo_[a-z0-9_]+)'/g) || [];
  const dictLangs = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];
  const dicts = dictLangs.map((lang) => JSON.parse(read('public/locales/' + lang + '.json')));
  const keys = new Set(uiStrings.map((entry) => entry.slice(1, -1)));
  assert.ok(keys.size >= 40, '同步面板的取词点太少，可能漏接了文案');
  for (const key of keys) {
    for (let i = 0; i < dicts.length; i += 1) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(dicts[i], key),
        dictLangs[i] + ' 缺词条 ' + key
      );
    }
  }

  console.log('OK halo-pixelbar');
}
