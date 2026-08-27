const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const test = require('node:test');

const { createShixingPoints, POINT_COSTS, POINT_PACKAGES } = require('../shixing-points');

function testDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE payments (out_trade_no TEXT, user_id TEXT, plan TEXT, status TEXT, paid_at TEXT, created_at TEXT);
    CREATE TABLE edulab_payments (out_trade_no TEXT, user_id TEXT, package TEXT, status TEXT, paid_at TEXT, created_at TEXT);
    CREATE TABLE comment_credit_ledger (user_id TEXT, delta INTEGER, reason TEXT);
    CREATE TABLE essay_credit_ledger (user_id TEXT, delta INTEGER, reason TEXT);
    CREATE TABLE roundtable_credit_ledger (user_id TEXT, delta INTEGER, reason TEXT);
    CREATE TABLE edulab_credit_ledger (user_id TEXT, credits INTEGER, reason TEXT);
  `);
  return db;
}

test('migrates each legacy balance once using the 25/50/50/75 ratios', () => {
  const db = testDb();
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u1', 'teacher');
  db.prepare('INSERT INTO comment_credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)').run('u1', -2, 'generation');
  db.prepare('INSERT INTO essay_credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)').run('u1', -3, 'grading');
  db.prepare('INSERT INTO roundtable_credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)').run('u1', -1, 'topic');
  db.prepare('INSERT INTO edulab_credit_ledger (user_id, credits, reason) VALUES (?, ?, ?)').run('u1', 10, 'signup');
  db.prepare('INSERT INTO edulab_credit_ledger (user_id, credits, reason) VALUES (?, ?, ?)').run('u1', -2, 'generate');

  const points = createShixingPoints(db);
  assert.equal(points.getBalance('u1'), 1225);
  assert.equal(points.getBalance('u1'), 1225);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shixing_point_ledger WHERE user_id = ? AND reason = 'legacy_migration'").get('u1').n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shixing_point_ledger WHERE user_id = ? AND reason = 'essay_legacy_migration'").get('u1').n, 1);
});

test('preserves all unclaimed signup allowances for a new account', () => {
  const db = testDb();
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('new', 'newteacher');
  const points = createShixingPoints(db);
  assert.equal(points.getBalance('new'), 1625);
});

test('charges the five AI products from one shared balance', () => {
  const db = testDb();
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u1', 'teacher');
  const points = createShixingPoints(db);

  assert.deepEqual(POINT_COSTS, { comment: 25, essay: 50, english: 50, roundtable: 50, edulab: 75 });
  assert.equal(points.debit({ user_id: 'u1', product: 'comment', note: '评语' }).balance, 1600);
  assert.equal(points.debit({ user_id: 'u1', product: 'essay', note: '作文' }).balance, 1550);
  assert.equal(points.debit({ user_id: 'u1', product: 'english', note: '英语作文' }).balance, 1500);
  assert.equal(points.debit({ user_id: 'u1', product: 'roundtable', note: '圆桌' }).balance, 1450);
  assert.equal(points.debit({ user_id: 'u1', product: 'edulab', note: '数学' }).balance, 1375);
  assert.throws(
    () => points.debit({ user_id: 'u1', product: 'edulab', cost: 1500 }),
    err => err && err.code === 'SHIXING_POINTS_EXHAUSTED' && err.balance === 1375
  );
});

test('adds the essay migration once for accounts migrated before essay joined shared points', () => {
  const db = testDb();
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('older', 'olderteacher');
  const points = createShixingPoints(db);

  assert.equal(points.getBalance('older'), 1625);
  db.prepare("DELETE FROM shixing_point_ledger WHERE user_id = ? AND reason = 'essay_legacy_migration'").run('older');
  assert.equal(points.getBalance('older'), 1625);
  assert.equal(points.getBalance('older'), 1625);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shixing_point_ledger WHERE user_id = ? AND reason = 'essay_legacy_migration'").get('older').n, 1);
});

test('awards the first top-up bonus once across all products and is callback-idempotent', () => {
  const db = testDb();
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u1', 'teacher');
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u2', 'teacher2');
  const points = createShixingPoints(db);

  assert.deepEqual(POINT_PACKAGES.points_5000, {
    key: 'points_5000', label: '5000师行积分', points: 5000, amount: '9.90', first_bonus: 5000
  });
  assert.deepEqual(POINT_PACKAGES.points_10000, {
    key: 'points_10000', label: '10000师行积分', points: 10000, amount: '19.90', first_bonus: 12000
  });

  const first = points.addPayment({ user_id: 'u1', package_key: 'points_5000', out_trade_no: 'P1' });
  assert.deepEqual({ first: first.first_topup, bonus: first.bonus_points, awarded: first.awarded_points, balance: first.balance }, {
    first: true, bonus: 5000, awarded: 10000, balance: 11625
  });

  const duplicate = points.addPayment({ user_id: 'u1', package_key: 'points_5000', out_trade_no: 'P1' });
  assert.equal(duplicate.balance, 11625);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shixing_point_ledger WHERE out_trade_no = 'P1'").get().n, 1);

  const second = points.addPayment({ user_id: 'u1', package_key: 'points_10000', out_trade_no: 'P2' });
  assert.deepEqual({ first: second.first_topup, bonus: second.bonus_points, awarded: second.awarded_points, balance: second.balance }, {
    first: false, bonus: 0, awarded: 10000, balance: 21625
  });

  const otherFirst = points.addPayment({ user_id: 'u2', package_key: 'points_10000', out_trade_no: 'P3' });
  assert.deepEqual({ first: otherFirst.first_topup, bonus: otherFirst.bonus_points, awarded: otherFirst.awarded_points, balance: otherFirst.balance }, {
    first: true, bonus: 12000, awarded: 22000, balance: 23625
  });
  assert.equal(points.hasPaidTopup('u1'), true);
  assert.equal(points.hasPaidTopup('u2'), true);
});

test('treats earlier paid product orders as prior top-ups', () => {
  const db = testDb();
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u1', 'teacher');
  db.prepare('INSERT INTO payments VALUES (?, ?, ?, ?, ?, ?)')
    .run('OLD1', 'u1', 'comment_100', 'paid', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const points = createShixingPoints(db);

  assert.equal(points.hasPaidTopup('u1'), true);
  const purchase = points.addPayment({ user_id: 'u1', package_key: 'points_5000', out_trade_no: 'P1' });
  assert.equal(purchase.first_topup, false);
  assert.equal(purchase.bonus_points, 0);
  assert.equal(purchase.awarded_points, 5000);
});

test('converts a pending legacy package callback without granting a first-top-up bonus', () => {
  const db = testDb();
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u1', 'teacher');
  const points = createShixingPoints(db);

  const paid = points.addLegacyPayment({
    user_id: 'u1', product: 'roundtable', credits: 60,
    package_key: 'rt_60', out_trade_no: 'OLD-PENDING'
  });
  assert.equal(paid.awarded_points, 3000);
  assert.equal(paid.balance, 4625);
  assert.equal(paid.first_topup, true);
  assert.equal(paid.bonus_points, 0);
  assert.equal(points.addLegacyPayment({
    user_id: 'u1', product: 'roundtable', credits: 60,
    package_key: 'rt_60', out_trade_no: 'OLD-PENDING'
  }).balance, 4625);
});
