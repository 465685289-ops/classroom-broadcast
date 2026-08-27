const assert = require('node:assert/strict');
const test = require('node:test');
const { addMembershipDays, getMembershipStatus, isLearningHost } = require('../learning-membership');

const now = new Date('2026-07-01T00:00:00.000Z');

test('extends an active membership from its current expiry', () => {
  assert.equal(
    addMembershipDays('2026-08-01T00:00:00.000Z', 180, now),
    '2027-01-28T00:00:00.000Z'
  );
});

test('starts an expired membership from the renewal time', () => {
  assert.equal(
    addMembershipDays('2026-01-01T00:00:00.000Z', 180, now),
    '2026-12-28T00:00:00.000Z'
  );
});

test('reports an inactive membership when no future expiry exists', () => {
  assert.deepEqual(getMembershipStatus(null, now), { active: false, expiresAt: null });
});

test('recognizes only the student assistant host', () => {
  assert.equal(isLearningHost('xiezuo.yingyuzuowen.asia'), true);
  assert.equal(isLearningHost('zuowen.yingyuzuowen.asia'), false);
});
