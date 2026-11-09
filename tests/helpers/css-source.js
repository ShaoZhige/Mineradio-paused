'use strict';

// CSS 拆分后测试仍需要一个“逻辑上的 index.css”。
// readAllCss() 按页面加载顺序拼接所有分片，测试只关心选择器是否存在，
// 不关心它落在哪个物理文件里，避免每次搬代码都要改二十多个断言。
const fs = require('node:fs');
const path = require('node:path');

const CSS_DIR = ['public', 'css'];
const FIRST = 'core.css';
const LAST = 'index.css';

function readAllCss(root) {
  const appRoot = path.resolve(root || path.join(__dirname, '..', '..'));
  const dir = path.join(appRoot, ...CSS_DIR);
  if (!fs.existsSync(dir)) return '';
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.css'));
  const middle = names
    .filter((name) => name !== FIRST && name !== LAST)
    .sort((a, b) => a.localeCompare(b));
  const ordered = [FIRST, ...middle, LAST]
    .filter((name, index, list) => names.includes(name) && list.indexOf(name) === index);
  return ordered
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

module.exports = { readAllCss };
