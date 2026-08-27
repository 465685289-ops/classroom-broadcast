const assert = require('node:assert/strict');
const test = require('node:test');
const { createClassroomPointsQueue } = require('../public/classroom-points-queue');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test('pending score survives reload and keeps the same idempotency key', () => {
  const storage = memoryStorage();
  const first = createClassroomPointsQueue({
    storage,
    key: 'class-1',
    now: () => '2026-07-14T08:00:00.000Z',
    randomId: () => 'op-1'
  });
  const saved = first.enqueue({ student_ids: ['student-1'], rule_id: 'rule-1' });
  assert.equal(saved.client_operation_id, 'op-1');

  const restored = createClassroomPointsQueue({
    storage,
    key: 'class-1',
    now: () => '2026-07-14T08:01:00.000Z',
    randomId: () => 'op-2'
  });
  assert.equal(restored.pending()[0].client_operation_id, 'op-1');
  restored.markSynced('op-1');
  assert.equal(first.pending().length, 0);
});

test('queue preserves order, failure details and retry identity', () => {
  let nextId = 0;
  const storage = memoryStorage();
  const queue = createClassroomPointsQueue({
    storage,
    key: 'class-2',
    now: () => '2026-07-14T08:00:00.000Z',
    randomId: () => 'op-' + (++nextId)
  });
  queue.enqueue({ student_ids: ['student-1'], rule_id: 'rule-1' });
  queue.enqueue({ student_ids: ['student-2'], rule_id: 'rule-2' });
  assert.deepEqual(queue.pending().map(item => item.client_operation_id), ['op-1', 'op-2']);

  queue.markFailed('op-1', '会员已到期');
  assert.equal(queue.pending().length, 1);
  assert.equal(queue.failed()[0].error, '会员已到期');
  queue.clearFailure('op-1');
  assert.deepEqual(queue.pending().map(item => item.client_operation_id), ['op-1', 'op-2']);
});

test('queue recovers from malformed storage and returns defensive copies', () => {
  const storage = memoryStorage({ 'shixing_classroom_points_broken': '{bad json' });
  const queue = createClassroomPointsQueue({
    storage,
    key: 'broken',
    now: () => '2026-07-14T08:00:00.000Z',
    randomId: () => 'safe-op'
  });
  assert.deepEqual(queue.pending(), []);
  const saved = queue.enqueue({ student_ids: ['student-1'], rule_id: 'rule-1' });
  saved.student_ids.push('tampered');
  assert.deepEqual(queue.pending()[0].student_ids, ['student-1']);
});
