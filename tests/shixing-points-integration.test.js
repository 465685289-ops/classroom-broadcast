const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shixing-points-db-'));
process.env.SQLITE_FILE = path.join(TMP, 'test.db');
process.env.LEGACY_JSON_FILE = path.join(TMP, 'missing-data.json');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
const dbStore = require('../db');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function addUser(id) {
  dbStore.upsertUser({
    id,
    username: id + '@example.com',
    display_name: '老师',
    password_hash: 'hash',
    password_salt: 'salt',
    created_at: '2026-07-10T00:00:00.000Z'
  });
}

test('comment, essay and roundtable debit the same migrated point balance', () => {
  addUser('u1');
  assert.equal(dbStore.getShixingPointBalance('u1'), 1625);

  const comment = dbStore.insertCommentGenerationAndDebit({
    user_id: 'u1', username: 'u1@example.com', student_name: '小师',
    comment: '继续保持认真踏实的学习态度。', model: 'deepseek-v4-flash'
  });
  assert.equal(comment.balance, 1600);

  const essay = dbStore.insertEssayGradingAndDebit({
    user_id: 'u1', username: 'u1@example.com', student_name: '小师',
    genre: '记叙文', grade_level: '初二', score_type: '满分100分',
    essay_text: '这是一段用于积分回归测试的作文内容。'.repeat(4),
    result: '教师评语：继续努力。', model: 'deepseek-v4-flash'
  });
  assert.equal(essay.balance, 1550);

  const roundtable = dbStore.startRoundtableGeneration({
    user_id: 'u1', username: 'u1@example.com', topic: '教育中什么不能交给 AI？',
    model: 'deepseek-v4-flash'
  });
  assert.equal(roundtable.balance, 1500);
  assert.equal(dbStore.getCommentCreditBalance('u1'), 1500);
  assert.equal(dbStore.getRoundtableCreditBalance('u1'), 1500);
});

test('an active legacy essay membership grading does not debit shared points', () => {
  addUser('legacy-member');
  const before = dbStore.getShixingPointBalance('legacy-member');
  const essay = dbStore.insertEssayGradingAndDebit({
    user_id: 'legacy-member', username: 'legacy-member@example.com', student_name: '小师',
    genre: '记叙文', grade_level: '初二', score_type: '满分100分',
    essay_text: '这是一段用于旧会员兼容测试的作文内容。'.repeat(4),
    result: '教师评语：继续努力。', model: 'deepseek-v4-flash', skip_debit: true
  });
  assert.equal(essay.balance, before);
  assert.equal(dbStore.getShixingPointBalance('legacy-member'), before);
});

test('the first successful AI product activates one global referral and later products do not repeat it', () => {
  addUser('global-inviter');
  addUser('global-friend');
  const inviter = dbStore.loadStore().users.find(user => user.id === 'global-inviter');
  dbStore.bindUnifiedReferral({
    invitee_user_id: 'global-friend',
    inviter_user_id: 'global-inviter',
    invite_code: inviter.teacher_code,
    source_product: 'shixing',
    device_hash: 'integration-device'
  });
  assert.equal(dbStore.getShixingPointBalance('global-inviter'), 1625);
  assert.equal(dbStore.getShixingPointBalance('global-friend'), 1625);

  const comment = dbStore.insertCommentGenerationAndDebit({
    user_id: 'global-friend', username: 'global-friend@example.com', student_name: '小师',
    comment: '继续保持认真踏实的学习态度。', model: 'deepseek-v4-flash'
  });
  assert.equal(comment.balance, 2100);
  assert.equal(comment.referral_reward.status, 'approved');
  assert.equal(dbStore.getShixingPointBalance('global-inviter'), 2125);

  const essay = dbStore.insertEssayGradingAndDebit({
    user_id: 'global-friend', username: 'global-friend@example.com', student_name: '小师',
    genre: '记叙文', grade_level: '初二', score_type: '满分100分',
    essay_text: '这是一段用于统一邀请回归测试的作文内容。'.repeat(4),
    result: '教师评语：继续努力。', model: 'deepseek-v4-flash'
  });
  assert.equal(essay.balance, 2050);
  assert.equal(essay.referral_reward.duplicate, true);

  const roundtable = dbStore.startRoundtableGeneration({
    user_id: 'global-friend', username: 'global-friend@example.com', topic: '教育中什么不能交给 AI？',
    model: 'deepseek-v4-flash'
  });
  assert.equal(roundtable.balance, 2000);
  assert.equal(roundtable.referral_reward.duplicate, true);
  assert.equal(dbStore.getShixingPointBalance('global-inviter'), 2125);
});

test('db payment wrapper grants a first-top-up bonus only once', () => {
  addUser('u2');
  const first = dbStore.addShixingPointsForPayment({
    user_id: 'u2', username: 'u2@example.com', package_key: 'points_5000',
    out_trade_no: 'NEW1', product: 'comment'
  });
  assert.equal(first.awarded_points, 10000);
  assert.equal(first.balance, 11625);

  const duplicate = dbStore.addShixingPointsForPayment({
    user_id: 'u2', username: 'u2@example.com', package_key: 'points_5000',
    out_trade_no: 'NEW1', product: 'comment'
  });
  assert.equal(duplicate.balance, 11625);
});

test('payment source survives a database reload for delayed callbacks', () => {
  addUser('u3');
  dbStore.upsertPayment({
    out_trade_no: 'PERSIST1', user_id: 'u3', username: 'u3@example.com',
    plan: 'points_5000', credits: 5000, amount: '9.90', status: 'pending',
    source_product: 'roundtable', created_at: '2026-07-10T00:00:00.000Z'
  });
  const payment = dbStore.loadStore().payments.find(row => row.out_trade_no === 'PERSIST1');
  assert.equal(payment.source_product, 'roundtable');
});
