'use strict';

// 花再 Halo PixelBar 硬件自检 / live check.
// 跑一次就知道三件事：node-hid 能不能加载、子进程通道能不能起、设备枚举能不能匹配到
// 控制接口。不接设备也能跑，只是最后一步会报「未找到」。
// One run answers three questions: does node-hid load, does the child-process channel come
// up, and does the enumeration find the control interface. It also runs with no device
// attached — the last step just reports not-found.
//
// 用法: node scripts/check-halo-pixelbar.js [--write]
//   --write  真的往设备写几帧（默认只枚举与连接，不打扰设备当前画面）

const { HaloSync, VENDOR_ID, PRODUCT_ID } = require('../desktop/halo-lyric-sync.js');

const WRITE = process.argv.includes('--write');

function line(label, value) {
  console.log('  ' + label.padEnd(18) + value);
}

(async () => {
  console.log('花再 Halo PixelBar 自检');
  console.log('  VID/PID          ' + '0x' + VENDOR_ID.toString(16) + ' / 0x' + PRODUCT_ID.toString(16));

  const halo = new HaloSync(null);
  const devices = await halo.listDevices();
  line('设备枚举', devices.length + ' 个匹配 VID/PID');

  for (const device of devices) {
    console.log('    - usagePage=0x' + (device.usagePage || 0).toString(16)
      + ' usage=' + device.usage + ' path=' + device.path);
  }

  const connected = await halo.connect();
  line('连接结果', connected ? '已连接' : '未连接');
  if (!connected) {
    console.log('  确认音响已用 USB 数据线接上，并且没有别的软件独占它；');
    console.log('  Windows 上如果枚举为空，多半是数据线只供电不传数据。');
    process.exit(devices.length ? 0 : 1);
  }

  if (!WRITE) {
    console.log('  只连接不写入（加 --write 才会真的改设备显示）。');
    halo.dispose();
    process.exit(0);
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  halo.onPlayState(true);
  halo.onSong('晴天', '周杰伦');
  await wait(1500);
  halo.onLyric('故事的小黄花');
  await wait(1500);
  halo.onLyric('从出生那年就飘着');
  await wait(1500);
  halo.onPlayState(false);
  console.log('  已写入 2 行歌词与切歌信息，看屏幕是否有反应。');
  halo.dispose();
  process.exit(0);
})();
