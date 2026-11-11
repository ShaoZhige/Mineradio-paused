'use strict';

// Builds the Windows WebView2 host that backs the Apple Music provider.
// The companion is an x64 .NET Framework 4.8 WinForms executable; it must be
// present before electron-builder copies it through `build.extraResources`.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const project = path.join(root, 'build', 'apple-music-native', 'windows', 'MineradioAppleMusicCompanion.csproj');
const output = path.join(root, 'build', 'apple-music-native', 'windows', 'bin', 'Release', 'net48');

const REQUIRED_FILES = [
    'MineradioAppleMusicCompanion.exe',
    'MineradioAppleMusicCompanion.exe.config',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
];

function resolveDotnet() {
    if (process.env.DOTNET_EXE) return process.env.DOTNET_EXE;
    const local = path.join(root, 'build', '.dotnet', 'dotnet.exe');
    if (process.platform === 'win32' && fs.existsSync(local)) return local;
    return 'dotnet';
}

function fail(message) {
    console.error(`[apple-music] ${message}`);
    process.exit(1);
}

if (process.platform !== 'win32') {
    fail('the Apple Music companion can only be built on Windows x64');
}
if (!fs.existsSync(project)) fail(`companion project not found: ${project}`);

const dotnet = resolveDotnet();
console.log(`[apple-music] dotnet: ${dotnet}`);
const result = spawnSync(dotnet, ['build', project, '-c', 'Release', '-v:minimal'], {
    cwd: root,
    stdio: 'inherit',
});
if (result.error) fail(`failed to run ${dotnet}: ${result.error.message}`);
if (result.status !== 0) fail(`dotnet build exited with code ${result.status}`);

const missing = REQUIRED_FILES.filter(name => !fs.existsSync(path.join(output, name)));
if (missing.length) fail(`companion build is incomplete; missing: ${missing.join(', ')}`);

console.log(`[apple-music] companion ready: ${output}`);
