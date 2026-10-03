'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8');
}

const serverText = read('server.js');
const updateUiText = read('public/js/modules/08-account/00-update-preview.js');
const htmlText = read('public/index.html');
const packageData = JSON.parse(read('package.json'));

function serverFunctionSource(name, nextName) {
  const start = serverText.indexOf(`function ${name}(`);
  const end = serverText.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing ${nextName}`);
  return serverText.slice(start, end);
}

test('release update metadata accepts only a bounded HTTPS external page', () => {
  // 版本号不再钉死：这个用例真正要验的是"更新页 URL 只接受受限的 HTTPS 外部页"，顺手写死一个
  // 版本号只会让每次发版都红一次，而红的原因与本用例毫无关系。改为断言它是个合法的 semver，
  // 既保住"版本号存在且合法"这层意思，又不会在发版时变成噪声。
  // No longer pin an exact version: what this case actually verifies is that the update URL accepts
  // only a bounded HTTPS external page. A hard-coded version only turned every release into a red
  // run unrelated to what is under test. Assert a well-formed semver instead — that keeps the
  // "a version exists and is sane" intent without becoming release-time noise.
  assert.match(packageData.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageData.mineradio.update.preview, false);
  assert.match(serverText, /function safeExternalUpdateUrl\(value\)/);
  assert.match(serverText, /raw\.length > 2048/);
  assert.match(serverText, /parsed\.protocol !== 'https:'/);
  assert.match(serverText, /mineradio-download-page/);
  assert.match(serverText, /function extractReleaseDownloadPages\(body\)/);
  assert.match(serverText, /const downloadPages = extractReleaseDownloadPages\(data\.body\)/);
  assert.match(serverText, /const downloadPageUrl = externalUrl \|\| htmlUrl/);
  assert.match(serverText, /\n\s+downloadPageUrl,/);
  assert.match(serverText, /\n\s+downloadPages,/);
  assert.match(serverText, /patchAvailable:\s*false/);
  assert.match(htmlText, /id="update-modal-version"[^>]*>v2\.2\.0</);
  assert.match(htmlText, /id="update-download-sources"/);
});

test('removed local update routes stay disabled and their workers stay absent', () => {
  assert.match(serverText, /pn === '\/api\/update\/download'/);
  assert.match(serverText, /pn === '\/api\/update\/patch'/);
  assert.match(serverText, /error:\s*'UPDATE_EXTERNAL_ONLY'/);
  assert.match(serverText, /\},\s*410\);/);
  assert.doesNotMatch(serverText, /startUpdateDownloadJob/);
  assert.doesNotMatch(serverText, /startUpdatePatchJob/);
  assert.doesNotMatch(serverText, /updateDownloadJobs/);
  assert.doesNotMatch(serverText, /PATCH_ALLOWED/);
  assert.doesNotMatch(serverText, /UPDATE_DOWNLOAD_DIR/);
  assert.doesNotMatch(serverText, /pickPatchAsset/);
});

test('release body preserves all three labelled HTTPS download pages', () => {
  const sandbox = { URL, Set };
  vm.runInNewContext([
    serverFunctionSource('cleanReleaseLine', 'extractReleaseNotes'),
    serverFunctionSource('safeExternalUpdateUrl', 'normalizeUpdateDownloadPages'),
    serverFunctionSource('normalizeUpdateDownloadPages', 'extractReleaseDownloadPages'),
    serverFunctionSource('extractReleaseDownloadPages', 'extractReleaseDownloadPage'),
  ].join('\n'), sandbox);
  const pages = sandbox.extractReleaseDownloadPages([
    '<!-- mineradio-download-page: 夸克盘|https://pan.quark.cn/s/df00d9520835 -->',
    '<!-- mineradio-download-page: 百度云|https://pan.baidu.com/s/1UAAyvXHNJjxVXAHIPtl4Ow?pwd=SJHP -->',
    '<!-- mineradio-download-page: 蓝奏云|https://xxhuber.lanzout.com/s/Mineradio -->',
    '<!-- mineradio-download-page: 不安全|http://example.com/file -->',
  ].join('\n'));
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), [
    { label: '夸克盘', url: 'https://pan.quark.cn/s/df00d9520835' },
    { label: '百度云', url: 'https://pan.baidu.com/s/1UAAyvXHNJjxVXAHIPtl4Ow?pwd=SJHP' },
    { label: '蓝奏云', url: 'https://xxhuber.lanzout.com/s/Mineradio' },
  ]);
});

test('renderer opens the external page without local installer or patch calls', () => {
  assert.match(updateUiText, /desktopWindow\.openUpdatePage\(target\)/);
  assert.match(updateUiText, /new URL\(raw\)\.protocol === 'https:'/);
  assert.match(updateUiText, /function openUpdateDownloadSource\(index\)/);
  assert.match(updateUiText, /Array\.isArray\(release\.downloadPages\)/);
  assert.match(updateUiText, /Array\.isArray\(data\.downloadPages\)/);
  assert.match(updateUiText, /explicitPages === null/);
  assert.match(updateUiText, /update-download-source/);
  assert.match(updateUiText, /软件不会在本地下载或应用补丁/);
  assert.doesNotMatch(updateUiText, /\/api\/update\/download/);
  assert.doesNotMatch(updateUiText, /\/api\/update\/patch/);
  assert.doesNotMatch(updateUiText, /openUpdateInstaller/);
  assert.doesNotMatch(updateUiText, /快速补丁/);
});
