'use strict';

// 会话日志回归测试 / session-log regression tests
//
// 需求：每次运行一个日志文件（按启动时间命名）、退出补一行收尾、最多保留 50 份。
// 这个测试盯住四件事：
//   1. 文件名是本地时间戳，同一天多次启动不撞名（撞了就加后缀，不覆盖）
//   2. 启动写 session/start、退出写 session/end，且 finish 只生效一次
//   3. 超过上限只删最旧的，多余的一份不留、新的一个不删
//   4. 升级前遗留的 userdata/app.log 会被收进 logs/，不在根目录留孤儿
//
// Pins naming, start/end records, idempotent finish, oldest-first pruning and legacy adoption.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_SESSION_LOGS,
  sessionStamp,
  listSessionLogs,
  pruneSessionLogs,
  beginSessionLog,
} = require('../desktop/session-log');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-session-log-'));
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('sessionStamp 用本地时间且补零', () => {
  const stamp = sessionStamp(new Date(2026, 0, 5, 7, 8, 9));
  assert.equal(stamp, '2026-01-05_07-08-09');
});

test('启动建文件写 session/start，退出写 session/end 且只写一次', () => {
  const root = makeRoot();
  const session = beginSessionLog({ userDataDir: root, pid: 4242, meta: { version: '3.1.0' } });

  assert.equal(session.ok, true);
  assert.equal(path.dirname(session.filePath), path.join(root, 'logs'));
  assert.match(session.fileName, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);

  assert.equal(session.finish('quit'), true);
  assert.equal(session.finish('quit'), false, 'finish 只能生效一次');

  const lines = readLines(session.filePath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'session/start');
  assert.equal(lines[0].pid, 4242);
  assert.equal(lines[0].version, '3.1.0');
  assert.equal(lines[1].event, 'session/end');
  assert.equal(lines[1].status, 'quit');
  assert.ok(lines[1].uptimeMs >= 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('同一秒内两次启动不覆盖已有文件', () => {
  const root = makeRoot();
  const fixed = new Date(2026, 10, 21, 23, 54, 7);
  const first = beginSessionLog({ userDataDir: root, now: fixed });
  const second = beginSessionLog({ userDataDir: root, now: fixed });

  assert.notEqual(first.fileName, second.fileName);
  assert.equal(first.fileName, '2026-11-21_23-54-07.log');
  assert.equal(second.fileName, '2026-11-21_23-54-07-1.log');
  assert.equal(listSessionLogs(path.join(root, 'logs')).length, 2);

  fs.rmSync(root, { recursive: true, force: true });
});

test('超过上限只删最旧的，保留最近 MAX_SESSION_LOGS 份', () => {
  const root = makeRoot();
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const total = MAX_SESSION_LOGS + 7;
  for (let index = 0; index < total; index += 1) {
    const minute = String(index).padStart(2, '0');
    fs.writeFileSync(path.join(logDir, `2026-11-21_00-${minute}-00.log`), '{}\n', 'utf8');
  }

  const session = beginSessionLog({ userDataDir: root });

  const names = listSessionLogs(logDir);
  assert.equal(names.length, MAX_SESSION_LOGS, '总数必须被压到上限');
  assert.ok(!names.includes('2026-11-21_00-00-00.log'), '最旧的一份必须被删');
  // 原有 57 份 + 本次新建 1 份 = 58，压到 50 → 删掉最早的 8 份（00-00 ~ 00-07）。
  assert.ok(!names.includes('2026-11-21_00-07-00.log'), '前 8 份都被删');
  assert.ok(names.includes('2026-11-21_00-08-00.log'), '第 9 份要被保留');
  assert.ok(names.includes(session.fileName), '本次会话的文件必须在');

  fs.rmSync(root, { recursive: true, force: true });
});

test('别人放的文件不会被清理策略误删', () => {
  const root = makeRoot();
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'notes.txt'), 'keep me', 'utf8');
  fs.writeFileSync(path.join(logDir, 'app.log.1'), '{}\n', 'utf8');

  for (let index = 0; index < MAX_SESSION_LOGS + 3; index += 1) {
    const minute = String(index).padStart(2, '0');
    fs.writeFileSync(path.join(logDir, `2026-11-21_01-${minute}-00.log`), '{}\n', 'utf8');
  }

  pruneSessionLogs(logDir);

  assert.ok(fs.existsSync(path.join(logDir, 'notes.txt')));
  assert.ok(fs.existsSync(path.join(logDir, 'app.log.1')));

  fs.rmSync(root, { recursive: true, force: true });
});

test('升级前遗留的 userdata/app.log 会被收进 logs/', () => {
  const root = makeRoot();
  const legacy = path.join(root, 'app.log');
  fs.writeFileSync(legacy, '{"event":"legacy"}\n', 'utf8');

  const session = beginSessionLog({ userDataDir: root });

  assert.equal(fs.existsSync(legacy), false, '根目录不该再留着旧的 app.log');
  const adopted = listSessionLogs(path.join(root, 'logs')).filter((name) => name !== session.fileName);
  assert.equal(adopted.length, 1, '旧日志必须被收进 logs/');
  assert.match(adopted[0], /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);

  fs.rmSync(root, { recursive: true, force: true });
});
