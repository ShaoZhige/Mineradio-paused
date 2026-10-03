'use strict';

// 把本程序登记为 Windows「游戏」。
//
// 这是一次有意为之的整活：Windows 的游戏模式（Game Mode）在识别到前台窗口属于游戏时，会把电源计划
// 切到卓越性能、给该进程更高的调度优先级，并压制 Windows 更新之类的后台活动。官方并没有"应用自报
// 为游戏"的公开 API —— 唯一路径是 Game Bar 里的「记住这是游戏」，而它是往下面这棵注册表子树写条目：
//
//   HKCU\System\GameConfigStore\Children\{GUID}   条目本体，MatchedExeFullPath 指向本程序 exe
//   HKCU\System\GameConfigStore\Parents\{hash}   反向索引，Children 是一个多字符串 GUID 列表
//
// 字段含义与取值来自实机观察一台已装多款游戏的机器（Type=1、Flags=17、Revision、TitleId 等）。
// 这不是公开契约，Windows 升级后完全可能改名或改结构，所以：
//
//   1. 整活性质，不承诺长期有效；
//   2. **先整棵备份、再改、关闭时原样写回**。用户可能手改、系统可能重构，冲突时以备份为准；
//   3. 只写 HKCU，不需要管理员权限，出错也只是少一个游戏模式加成，绝不阻塞启动；
//   4. 非 Windows 平台返回 supported:false，由界面把开关置灰。
//
// Registering this app as a Windows "game" is deliberate fun. Windows Game Mode gives a foreground
// window recognised as a game a better power plan, higher scheduling priority, and suppresses
// background work such as Windows Update. There is no public API for self-declaring as a game — the
// only route is Game Bar's "Remember this is a game", which writes entries into the registry subtree
// below. Field names and values were read off a real machine with several games installed. This is
// not a public contract, so: it is a joke feature with no long-term guarantee; we back up the whole
// subtree before touching it and write it back verbatim on disable (user edits and system rewrites
// included, the backup wins); only HKCU is touched so no elevation is needed; and any failure merely
// forgoes the Game Mode benefit instead of blocking startup. Non-Windows platforms report
// supported:false so the UI can grey the switch out.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const POWER_SHELL = 'powershell.exe';
const GAME_STORE_KEY = 'HKCU\\System\\GameConfigStore';
const CHILDREN_KEY = 'System\\GameConfigStore\\Children';
const PARENTS_KEY = 'System\\GameConfigStore\\Parents';

// Parents 的键名是 exe 路径的某种规范化哈希。实机比对表明它不是路径的 SHA1（utf-16le / utf-8 /
// 大小写变体全部不匹配），算法未公开。我们用一个自己算的稳定值代替：功能上等价（作用只是把
// Children 条目挂到某个父键下），且因为值是本程序自己算的，关闭时能精确算回同一个键并整棵删掉。
// The Parents key name is some canonicalised hash of the exe path; it is not a plain SHA-1 of it
// (no encoding or case variant matches). The algorithm is undocumented, so we substitute our own
// stable value — functionally equivalent, since it only groups child entries under a parent — and
// because we compute it ourselves we can recompute the exact same key on disable and remove it.
const PARENT_KEY_PREFIX = 'mineradio-';

function isSupported() {
  return process.platform === 'win32';
}

function quoteRegValue(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parentKeyName() {
  return PARENT_KEY_PREFIX + require('crypto').createHash('sha1')
    .update(String(process.execPath || '').toLowerCase())
    .digest('hex')
    .slice(0, 24);
}

function parentKeyPath() {
  return PARENTS_KEY + '\\' + parentKeyName();
}

// 统一的 PowerShell 执行入口。**spawn 阶段失败是同步抛出的**（EPERM / EACCES / ENOENT），
// 不会走进回调，所以必须 try/catch 包住；这一点在壁纸库扫描那边也踩过一次。
// Single PowerShell entry point. Failures at spawn time (EPERM / EACCES / ENOENT) are thrown
// *synchronously* and never reach the callback, so the call must be wrapped in try/catch — the same
// trap the Wallpaper Engine library scan hit.
function runPowerShell(script) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        POWER_SHELL,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), code: error && error.code || 0 });
        }
      );
    } catch (_) {
      resolve({ ok: false, stdout: '', stderr: 'spawn failed', code: -1 });
      return;
    }
    if (child && typeof child.on === 'function') child.on('error', () => resolve({ ok: false, stdout: '', stderr: 'spawn error', code: -1 }));
  });
}

function backupPath(userDataPath) {
  return path.join(String(userDataPath || '.'), 'windows-game-registration-backup.json');
}

async function readSubtree() {
  // 导出整棵子树（含 Parents 与 Children 两层）成一个 JSON 文本，再用 ConvertFrom-Json 取回。
  // 一次性导出比逐键读稳：中途 Windows 若重构结构，我们拿到的仍是同一时刻的一致快照。
  // Export the whole subtree in one shot rather than reading key by key: if Windows restructures
  // mid-way we still hold one consistent snapshot.
  const script = `
$ErrorActionPreference = 'Stop'
$root = "${GAME_STORE_KEY}"
if (-not (Test-Path $root)) { Write-Output '{"rootMissing":true}'; exit 0 }
$payload = @{ rootMissing = $false; children = @{}; parents = @{} }
$childrenKey = Join-Path $root 'Children'
if (Test-Path $childrenKey) {
  foreach ($child in (Get-ChildItem $childrenKey -ErrorAction SilentlyContinue)) {
    $props = @{}
    foreach ($name in $child.GetValueNames()) { $props[$name] = [string]$child.GetValue($name) }
    $payload.children[$child.PSChildName] = $props
  }
}
$parentsKey = Join-Path $root 'Parents'
if (Test-Path $parentsKey) {
  foreach ($parent in (Get-ChildItem $parentsKey -ErrorAction SilentlyContinue)) {
    $names = @($parent.GetValueNames())
    $props = @{}
    foreach ($name in $names) { $props[$name] = @($parent.GetValue($name)) }
    $payload.parents[$parent.PSChildName] = $props
  }
}
$payload | ConvertTo-Json -Depth 6 -Compress
`;
  const result = await runPowerShell(script);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout.trim() || '{}');
  } catch (_) {
    return null;
  }
}

// 生成 PowerShell 用的注册表路径。集中一处，避免"模板字符串里 \\ 会被解成单反斜杠"这个坑
// 在各个字面量里重复踩：注册表路径一旦多一个或少一个反斜杠，New-Item 就会作用到错误的键上，
// 而备份还原写错的后果是污染用户的注册表。
// Builds the PowerShell-side registry path in one place, so the "a template literal turns \\ into
// one backslash" trap is not repeated across literals: one extra or missing backslash sends
// New-Item to the wrong key, and a wrong path while restoring pollutes the user's registry.
function regKeyPath(subKey, name) {
  const tail = name ? `\\${name}` : '';
  return `HKCU:\\System\\GameConfigStore\\${subKey}${tail}`;
}

function childGuid() {
  return require('crypto').randomUUID();
}

// 开启：备份 → 写 Children 条目 + Parents 索引
async function enable(userDataPath, exePath) {
  if (!isSupported()) return { ok: false, supported: false, reason: 'UNSUPPORTED_PLATFORM' };
  const target = String(exePath || process.execPath || '');
  if (!target) return { ok: false, supported: true, reason: 'NO_EXE_PATH' };

  const backup = await readSubtree();
  if (!backup) return { ok: false, supported: true, reason: 'BACKUP_FAILED' };
  try {
    fs.mkdirSync(path.dirname(backupPath(userDataPath)), { recursive: true });
    fs.writeFileSync(backupPath(userDataPath), JSON.stringify(backup, null, 1), 'utf8');
  } catch (_) {
    return { ok: false, supported: true, reason: 'BACKUP_WRITE_FAILED' };
  }

  const guid = childGuid();
  const parentName = parentKeyName();
  // Flags=17 / Type=1 / Revision 取自实机观察到的游戏条目形态。TitleId 与 LastAccessed 不写 ——
  // 那是 Steam 侧的游戏 ID 与时间戳，本程序没有，也不需要。
  // Flags=17 / Type=1 / Revision mirror entries observed on a real machine. TitleId and LastAccessed
  // are deliberately left unset: those are the Steam-side game id and an access timestamp, and this
  // app has neither.
  const script = `
$ErrorActionPreference = 'Stop'
$child = "${regKeyPath('Children', guid)}"
New-Item -Path $child -Force | Out-Null
New-ItemProperty -Path $child -Name 'Type' -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $child -Name 'Flags' -Value 17 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $child -Name 'Revision' -Value 2639 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $child -Name 'GameDVR_GameGUID' -Value '${guid}' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $child -Name 'MatchedExeFullPath' -Value '${quoteRegValue(target)}' -PropertyType String -Force | Out-Null
$parent = "${regKeyPath('Parents', parentName)}"
New-Item -Path $parent -Force | Out-Null
New-ItemProperty -Path $parent -Name 'Children' -Value @('${guid}') -PropertyType MultiString -Force | Out-Null
Write-Output 'MR_GAME_WRITTEN'
`;
  const result = await runPowerShell(script);
  if (!result.ok || !/MR_GAME_WRITTEN/.test(result.stdout)) {
    return { ok: false, supported: true, reason: 'REGISTRY_WRITE_FAILED', detail: result.stderr.slice(0, 300) };
  }
  return { ok: true, supported: true, guid, parentName, exePath: target };
}

// 关闭：按备份原样写回（含删除我们新增的那两个键）
async function disable(userDataPath) {
  if (!isSupported()) return { ok: false, supported: false, reason: 'UNSUPPORTED_PLATFORM' };
  let backup = null;
  try {
    backup = JSON.parse(fs.readFileSync(backupPath(userDataPath), 'utf8'));
  } catch (_) {
    // 没有备份可比对：仍然做一次尽力而为的清理，把我们自己的两个键删掉。
    // No snapshot to compare against: still attempt a best-effort cleanup of our own two keys.
    backup = null;
  }

  // 删掉本次可能写入的键：Parents 下我们算得出的那个固定键，以及 Children 里指向本程序 exe 的条目。
  // Remove whatever this run may have written: the fixed Parents key we compute, plus any Children
  // entry whose MatchedExeFullPath points at this app.
  const selfClean = `
$ErrorActionPreference = 'Continue'
$exe = '${quoteRegValue(process.execPath || '')}'
$childrenKey = "${regKeyPath('Children')}"
if (Test-Path $childrenKey) {
  foreach ($child in (Get-ChildItem $childrenKey -ErrorAction SilentlyContinue)) {
    $v = $child.GetValue('MatchedExeFullPath')
    if ($v -and ($v -ieq $exe)) { Remove-Item -LiteralPath $child.PSPath -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
$parent = "${regKeyPath('Parents', parentKeyName())}"
if (Test-Path $parent) { Remove-Item -LiteralPath $parent -Recurse -Force -ErrorAction SilentlyContinue }
Write-Output 'CLEANED'
`;
  await runPowerShell(selfClean);

  if (!backup || backup.rootMissing) return { ok: true, supported: true, restored: false };

  // 原样写回备份里记录的整棵子树。
  // Write the recorded subtree back verbatim.
  const children = Object.entries(backup.children || {});
  const parents = Object.entries(backup.parents || {});
  const lines = ['$ErrorActionPreference = \'Continue\''];
  for (const [name, props] of children) {
    // 模板字符串里 `\\` 会输出单个 `\`，这正是 PowerShell 需要的形式；写成 `\\\\` 会输出两个
    // 反斜杠，New-Item 会建到错误的键上。备份里既然可能有用户自己的条目，这里写错就等于在
    // 还原时污染注册表，所以路径一律走 regKeyPath() 统一生成，不在字面量里手写转义。
    // In a template literal `\\` emits a single `\`, which is what PowerShell wants; `\\\\` would emit
    // two and make New-Item target the wrong key. Since the backup may hold the user's own entries,
    // getting this wrong would pollute the registry while restoring — so every path goes through
    // regKeyPath() instead of hand-written escaping.
    lines.push(`$p = "${regKeyPath('Children', name)}"`);
    lines.push('New-Item -Path $p -Force | Out-Null');
    for (const [k, v] of Object.entries(props || {})) {
      lines.push(`New-ItemProperty -Path $p -Name '${String(k).replace(/'/g, "''")}' -Value '${quoteRegValue(v)}' -PropertyType String -Force | Out-Null`);
    }
  }
  for (const [name, props] of parents) {
    lines.push(`$p = "${regKeyPath('Parents', name)}"`);
    lines.push('New-Item -Path $p -Force | Out-Null');
    for (const [k, v] of Object.entries(props || {})) {
      const arr = Array.isArray(v) ? v : [v];
      const joined = arr.map((x) => `'${quoteRegValue(x)}'`).join(',');
      lines.push(`New-ItemProperty -Path $p -Name '${String(k).replace(/'/g, "''")}' -Value @(${joined}) -PropertyType MultiString -Force | Out-Null`);
    }
  }
  lines.push("Write-Output 'RESTORED'");
  const result = await runPowerShell(lines.join('\n'));
  return {
    ok: true,
    supported: true,
    restored: /RESTORED/.test(result.stdout),
    detail: result.stderr.slice(0, 300),
  };
}

// 只读当前状态：注册表里是否已有指向本程序 exe 的条目
async function status() {
  if (!isSupported()) return { supported: false, registered: false };
  const script = `
$ErrorActionPreference = 'Continue'
$exe = '${quoteRegValue(process.execPath || '')}'
$found = $false
$childrenKey = "${regKeyPath('Children')}"
if (Test-Path $childrenKey) {
  foreach ($child in (Get-ChildItem $childrenKey -ErrorAction SilentlyContinue)) {
    $v = $child.GetValue('MatchedExeFullPath')
    if ($v -and ($v -ieq $exe)) { $found = $true; break }
  }
}
if ($found) { Write-Output 'MR_GAME_REGISTERED' } else { Write-Output 'MR_GAME_ABSENT' }
`;
  const result = await runPowerShell(script);
  // 必须精确匹配：/REGISTERED/ 也会命中 "NOT_REGISTERED"，那会让"从未注册"被读成"已注册"，
  // 关闭后无法确认是否真的还原。状态脚本输出互为反义词，用独占标记最省心。
  // Match exactly: /REGISTERED/ also matches "NOT_REGISTERED", which would read "never registered"
  // as "registered" and hide a failed restore. The two outputs are negations, so use distinct tokens.
  return {
    supported: true,
    registered: /MR_GAME_REGISTERED/.test(result.stdout),
    exePath: process.execPath || '',
  };
}

module.exports = { isSupported, enable, disable, status, backupPath, parentKeyName };
