'use strict';

// CSS 拆分后测试按页面加载顺序拼接所有分片。
// readAllCss() 按页面加载顺序拼接所有分片，测试只关心选择器是否存在，
// 不关心它落在哪个物理文件里，避免每次搬代码都要改二十多个断言。
const fs = require('node:fs');
const path = require('node:path');

const CSS_DIR = ['public', 'css'];
const ORDER = ['core.css', 'background.css', 'startup.css', 'search.css', 'home.css', 'topbar.css', 'mini-cover.css', 'player.css', 'control-bar.css', 'modal.css', ...["loading-toast.css","console.css","playlist.css","lyrics.css","gesture.css","responsive.css","home-dashboard.css","desktop.css"]];
const LAST = 'desktop.css';

function readAllCss(root) {
  const appRoot = path.resolve(root || path.join(__dirname, '..', '..'));
  const dir = path.join(appRoot, ...CSS_DIR);
  if (!fs.existsSync(dir)) return '';
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.css'));
  const middle = names
    .filter((name) => !ORDER.includes(name) && name !== LAST)
    .sort((a, b) => a.localeCompare(b));
  const ordered = [...ORDER.filter((name) => names.includes(name)), ...middle, LAST]
    .filter((name, index, list) => names.includes(name) && list.indexOf(name) === index);
  return ordered
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

module.exports = { readAllCss };
