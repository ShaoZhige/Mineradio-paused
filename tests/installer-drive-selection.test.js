'use strict';

// 安装器盘符选择回归测试（#265 / #275 / #86 / #102）
//
// 背景：安装器曾用 `IfFileExists "X:\*.*"` 枚举"可安装分区"。该判据只回答「该盘根目录下有没有
// 文件」，与驱动器类型无关，于是：
//   - 真正为空的本地 D 盘被判成"不存在"，明明有空间却只能装到 C 盘；
//   - 映射的网络盘 / 光驱 / 读卡器只要根目录有内容就被当成本地分区；
//   - 只有 C 盘、但插了 U 盘的电脑被判成"还有别的分区"，C 盘安装被拒 → 无盘可装。
// 现在改为向内核查询真实驱动器类型（kernel32!GetDriveTypeW），只接受 DRIVE_FIXED(3)。
//
// Background: the installer enumerated candidate partitions with `IfFileExists "X:\*.*"`, which
// only reports whether the drive root has entries — not what kind of drive it is. The fix asks
// the kernel for the real drive type (kernel32!GetDriveTypeW) and accepts DRIVE_FIXED (3) only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const installerText = fs
  .readFileSync(path.join(appRoot, 'build', 'installer.nsh'), 'utf8')
  .replace(/\r\n/g, '\n');
// 说明性注释里会引用被替换掉的旧写法，因此"不得出现"类断言只看真代码行。
// Explanatory comments quote the removed idiom, so "must not appear" assertions ignore
// full-line comments.
const installerCode = installerText
  .split('\n')
  .filter((line) => !/^\s*;/.test(line))
  .join('\n');

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8');
}

function functionSource(name) {
  const start = installerText.indexOf(`Function ${name}\n`);
  assert.notEqual(start, -1, `missing installer function ${name}`);
  const end = installerText.indexOf('FunctionEnd', start);
  assert.notEqual(end, -1, `missing FunctionEnd for ${name}`);
  // 函数内的说明性注释同样要排除，否则"只允许 $R 寄存器"之类的断言会被注释文本干扰。
  // Strip in-function comment lines as well, otherwise assertions such as "only $R registers
  // may be used" would be tripped by the prose itself.
  return installerText
    .slice(start, end)
    .split('\n')
    .filter((line) => !/^\s*;/.test(line))
    .join('\n');
}

test('installer never picks an install drive from "<letter>:\\*.*" existence', () => {
  // 只禁止"硬编码盘符 + 通配符"的驱动探测写法；扫描已安装目录的 `IfFileExists "$2\*.*"` 不在此列。
  // Only the hard-coded "<letter>:\*.*" drive probe is forbidden here; the existing-installation
  // scan `IfFileExists "$2\*.*"` is a different concern and must keep working.
  assert.doesNotMatch(installerCode, /IfFileExists\s+"[A-Z]:\\\*\.\*"/);
  assert.doesNotMatch(installerCode, /IfFileExists\s+"\$[A-Z0-9]+:\\\*\.\*"/);
  assert.match(installerCode, /System::Call 'kernel32::GetDriveTypeW\(/);
  // 已安装目录探测保留（防止误删导致重复安装无法识别）。
  assert.match(installerCode, /IfFileExists\s+"\$2\\\*\.\*"\s+0\s+done/);
});

test('installer asks the kernel for the real drive type and accepts DRIVE_FIXED only', () => {
  assert.match(installerText, /!define MINERADIO_DRIVE_FIXED 3/);
  const probe = functionSource('MineradioDriveLetterIsFixed');
  assert.match(probe, /System::Call\s+'kernel32::GetDriveTypeW\(w "\$0:\\\\"\) i \.r1'/);
  assert.match(probe, /\$\{If\}\s+\$1 == \$\{MINERADIO_DRIVE_FIXED\}/);
  // 返回值必须是字符串 "1"/"0"，调用方用字符串比较。
  assert.match(probe, /StrCpy \$1 "1"/);
  assert.match(probe, /StrCpy \$1 "0"/);
});

test('fixed-drive enumeration walks D..Z and survives register clobbering', () => {
  const scan = functionSource('MineradioFirstFixedDriveLetter');
  // 从 D 开始：C 盘由调用方决定是否允许。
  assert.match(scan, /StrCpy \$R0 "DEFGHIJKLMNOPQRSTUVWXYZ"/);
  assert.match(scan, /StrCmp \$R0 "" driveLoopEnd/);
  assert.match(scan, /StrCpy \$R1 "\$R0" 1 0/);
  // 循环状态必须存在 $R 寄存器里：被调用的 MineradioDriveLetterIsFixed 会写 $0 / $1。
  // Loop state must live in $R registers because MineradioDriveLetterIsFixed writes $0 / $1.
  assert.doesNotMatch(scan, /\$[0-9](?![0-9A-Za-z])/);
  // 无可用固定盘时返回空串，调用方据此落回 C 盘。
  assert.match(scan, /driveLoopEnd:\s*\n\s*Push ""/);
});

test('install dir falls back to C: when the machine only has the system drive', () => {
  const useFirst = functionSource('MineradioUseFirstAvailableInstallDir');
  assert.match(useFirst, /Call MineradioFirstFixedDriveLetter/);
  assert.match(useFirst, /StrCpy \$INSTDIR "C:\\\$\{MINERADIO_INSTALL_DIR_NAME\}"/);
  assert.match(useFirst, /StrCpy \$INSTDIR "\$0:\\\$\{MINERADIO_INSTALL_DIR_NAME\}"/);

  const hasPreferred = functionSource('MineradioHasPreferredInstallDrive');
  assert.match(hasPreferred, /Call MineradioFirstFixedDriveLetter/);
  assert.match(hasPreferred, /Push "0"/);
  assert.match(hasPreferred, /Push "1"/);
});

test('the C: install rejection still routes through the fixed-drive probe', () => {
  // 只有 C 盘的机器必须放行 C 盘安装；真有多分区时仍拒绝装 C 盘。
  const marker = 'Call MineradioHasPreferredInstallDrive';
  const index = installerText.indexOf(marker);
  assert.notEqual(index, -1);
  const callSite = installerText.slice(index, index + 600);
  assert.match(callSite, /Pop \$2/);
  assert.match(callSite, /\$\{If\} \$2 == "1"/);
  assert.match(callSite, /Abort/);
  // "0"（只有 C 盘）不进拒绝分支。
  assert.doesNotMatch(callSite, /\$\{If\} \$2 == "0"/);
});

test('both installers share one definition of the drive helpers', () => {
  const betaText = read('build/installer-internal-beta.nsh');
  assert.match(betaText, /!include "\$\{BUILD_RESOURCES_DIR\}\\installer\.nsh"/);
  assert.doesNotMatch(
    betaText,
    /Function Mineradio(DriveLetterIsFixed|FirstFixedDriveLetter|UseFirstAvailableInstallDir|HasPreferredInstallDrive)/
  );
  // LogicLib 提供 ${If}/${Else}，缺了它整个补丁在编译期就会失败。
  assert.match(installerText, /!include LogicLib\.nsh/);
  assert.match(installerText, /!include FileFunc\.nsh/);
});
