const assert = require('node:assert/strict');
const test = require('node:test');
const { routeIncomingNotification } = require('../public/classroom-notification-queue');

test('a new broadcast starts immediately when the classroom screen is idle', () => {
  const queue = [];
  const action = routeIncomingNotification(queue, false, { id: 1, content: '第一条' });
  assert.equal(action, 'start');
  assert.deepEqual(queue.map(item => item.id), [1]);
});

test('a new broadcast interrupts the current notice without waiting for acknowledgement', () => {
  const queue = [];
  const action = routeIncomingNotification(queue, true, { id: 2, content: '紧急通知' });
  assert.equal(action, 'interrupt');
  assert.deepEqual(queue.map(item => item.id), [2]);
});

test('rapid broadcasts retain first-in-first-out order', () => {
  const queue = [];
  routeIncomingNotification(queue, true, { id: 3 });
  routeIncomingNotification(queue, true, { id: 4 });
  assert.deepEqual(queue.map(item => item.id), [3, 4]);
});
