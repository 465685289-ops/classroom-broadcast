'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { routeIncomingNotification } = require('../public/classroom-notification-queue');

test('a new broadcast starts immediately when the classroom screen is idle', () => {
  const queue = [];
  const action = routeIncomingNotification(queue, false, { id: 1, content: '第一条' });
  assert.equal(action, 'start');
  assert.deepEqual(queue.map(item => item.id), [1]);
});

test('a showing notice is never interrupted by a normal follow-up broadcast（审查F07）', () => {
  const queue = [];
  const action = routeIncomingNotification(queue, true, { id: 2, content: '普通通知' });
  assert.equal(action, 'queued', '普通通知应排队顺序播完，不抢占');
  assert.deepEqual(queue.map(item => item.id), [2]);
});

test('an urgent broadcast explicitly preempts the showing notice（审查F07）', () => {
  const queue = [];
  const action = routeIncomingNotification(queue, true, { id: 3, content: '紧急通知', urgent: true });
  assert.equal(action, 'interrupt', '仅 urgent 通知显式抢占');
  assert.deepEqual(queue.map(item => item.id), [3]);
});

test('rapid broadcasts retain first-in-first-out order', () => {
  const queue = [];
  routeIncomingNotification(queue, true, { id: 3 });
  routeIncomingNotification(queue, true, { id: 4 });
  assert.deepEqual(queue.map(item => item.id), [3, 4]);
});
