'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Keep release resource paths separate from development outputs and explicit developer overrides.
// The dotnet CLI puts the exe under bin/Release/net48; a packaged build copies the whole folder to
// resources/apple-music/windows. Check both dev locations so `dotnet build` output needs no manual
// copy, and only fall through to the release path when packaged.
function resolveNativeExecutable({ platform, isPackaged, resourcesPath, projectRoot, override = '' }) {
    if (platform !== 'win32') return '';
    if (!isPackaged && override) return path.isAbsolute(override) ? override : '';
    const windows = isPackaged
        ? path.join(resourcesPath, 'apple-music', 'windows')
        : path.join(projectRoot, 'build', 'apple-music-native', 'windows');
    const candidates = [
        path.join(windows, 'MineradioAppleMusicCompanion.exe'),
        path.join(windows, 'bin', 'Release', 'net48', 'MineradioAppleMusicCompanion.exe'),
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

module.exports = { resolveNativeExecutable };
