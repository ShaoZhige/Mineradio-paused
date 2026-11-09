'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMiddleClickPoller } = require('../desktop/global-middle-click-poller');

function makeSpawn() {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    return child;
  };
  return { spawn, calls, child };
}

test('middle click poller starts once and forwards MMB lines', () => {
  const fake = makeSpawn();
  const hits = [];
  const poller = createMiddleClickPoller({
    spawn: fake.spawn,
    platform: 'win32',
    onMiddleClick: () => hits.push('click'),
  });
  poller.start();
  poller.start();
  assert.equal(fake.calls.length, 1);
  fake.child.stdout.emit('data', Buffer.from('noise\nMMB\nMM'));
  fake.child.stdout.emit('data', Buffer.from('B\n'));
  assert.deepEqual(hits, ['click', 'click']);
});

test('middle click poller stops the child and can restart', () => {
  const fake = makeSpawn();
  const poller = createMiddleClickPoller({ spawn: fake.spawn, platform: 'win32' });
  poller.start();
  poller.stop();
  assert.equal(fake.child.killed, true);
  assert.equal(poller.isRunning(), false);
  poller.start();
  assert.equal(fake.calls.length, 2);
});

test('middle click poller is a no-op off Windows', () => {
  const fake = makeSpawn();
  const poller = createMiddleClickPoller({ spawn: fake.spawn, platform: 'linux' });
  poller.start();
  assert.equal(fake.calls.length, 0);
  assert.equal(poller.isRunning(), false);
});
