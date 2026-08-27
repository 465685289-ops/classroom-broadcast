const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const test = require('node:test');

const { createShixingPoints } = require('../shixing-points');
const { createUnifiedReferrals, REFERRAL_REWARDS } = require('../unified-referrals');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      teacher_code TEXT,
      plan TEXT,
      plan_expires TEXT,
      created_at TEXT
    );
    CREATE TABLE payments (out_trade_no TEXT, user_id TEXT, plan TEXT, status TEXT, paid_at TEXT, created_at TEXT);
    CREATE TABLE edulab_payments (out_trade_no TEXT, user_id TEXT, package TEXT, status TEXT, paid_at TEXT, created_at TEXT);
    CREATE TABLE comment_credit_ledger (user_id TEXT, delta INTEGER, reason TEXT);
    CREATE TABLE essay_credit_ledger (user_id TEXT, delta INTEGER, reason TEXT);
    CREATE TABLE roundtable_credit_ledger (user_id TEXT, delta INTEGER, reason TEXT);
    CREATE TABLE edulab_credit_ledger (user_id TEXT, credits INTEGER, reason TEXT);
    CREATE TABLE essay_referrals (
      invitee_user_id TEXT PRIMARY KEY,
      inviter_user_id TEXT NOT NULL,
      invitee_username TEXT,
      created_at TEXT NOT NULL,
      grading_rewarded_at TEXT,
      purchase_rewarded_at TEXT
    );
    CREATE TABLE app_referrals (
      product TEXT NOT NULL,
      invitee_user_id TEXT NOT NULL,
      inviter_user_id TEXT NOT NULL,
      invitee_username TEXT,
      created_at TEXT NOT NULL,
      usage_rewarded_at TEXT,
      purchase_rewarded_at TEXT,
      PRIMARY KEY (product, invitee_user_id)
    );
  `);
  return db;
}

function addUser(db, id, code, createdAt = '2026-07-01T00:00:00.000Z') {
  db.prepare('INSERT INTO users (id, username, display_name, teacher_code, plan, plan_expires, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, id + '@example.com', id, code || id.toUpperCase(), 'trial', null, createdAt);
}

function setup() {
  const db = createDb();
  const points = createShixingPoints(db);
  const referrals = createUnifiedReferrals(db, points);
  return { db, points, referrals };
}

test('binds one global inviter per invitee and is idempotent for the same inviter', () => {
  const { db, referrals } = setup();
  addUser(db, 'inviter-a', 'AAA111');
  addUser(db, 'inviter-b', 'BBB222');
  addUser(db, 'friend', 'FRI333');

  const first = referrals.bindReferral({
    invitee_user_id: 'friend', inviter_user_id: 'inviter-a', invite_code: 'AAA111', source_product: 'comment'
  });
  assert.equal(first.created, true);

  const repeated = referrals.bindReferral({
    invitee_user_id: 'friend', inviter_user_id: 'inviter-a', invite_code: 'AAA111', source_product: 'essay'
  });
  assert.equal(repeated.created, false);
  assert.equal(repeated.reason, 'already_bound');

  assert.throws(() => referrals.bindReferral({
    invitee_user_id: 'friend', inviter_user_id: 'inviter-b', invite_code: 'BBB222', source_product: 'broadcast'
  }), err => err && err.code === 'REFERRAL_ALREADY_BOUND');
});

test('first valid use rewards inviter and invitee 500 points exactly once across products', () => {
  const { db, points, referrals } = setup();
  addUser(db, 'inviter', 'INV111');
  addUser(db, 'friend', 'FRI111');
  referrals.bindReferral({ invitee_user_id: 'friend', inviter_user_id: 'inviter', invite_code: 'INV111', source_product: 'comment' });
  assert.equal(points.getBalance('inviter'), 1625);
  assert.equal(points.getBalance('friend'), 1625);

  const activated = referrals.activateReferral({
    invitee_user_id: 'friend', product: 'comment', source_record_id: 'comment:1', device_hash: 'device-a', created_at: '2026-07-13T01:00:00.000Z'
  });
  assert.equal(activated.status, 'approved');
  assert.equal(activated.inviter_reward_points, 500);
  assert.equal(activated.invitee_reward_points, 500);
  assert.equal(points.getBalance('inviter'), 2125);
  assert.equal(points.getBalance('friend'), 2125);

  const duplicate = referrals.activateReferral({
    invitee_user_id: 'friend', product: 'essay', source_record_id: 'essay:2', device_hash: 'device-a', created_at: '2026-07-13T02:00:00.000Z'
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(points.getBalance('inviter'), 2125);
  assert.equal(points.getBalance('friend'), 2125);
});

test('first paid order rewards either 1500 points or 30 broadcast days only once', () => {
  const { db, points, referrals } = setup();
  addUser(db, 'inviter', 'INV111');
  addUser(db, 'friend', 'FRI111');
  referrals.bindReferral({ invitee_user_id: 'friend', inviter_user_id: 'inviter', invite_code: 'INV111', source_product: 'roundtable' });

  const paid = referrals.rewardFirstPurchase({
    invitee_user_id: 'friend', purchase_type: 'points', source_product: 'edulab', source_record_id: 'PAY-1', created_at: '2026-07-13T03:00:00.000Z'
  });
  assert.equal(paid.status, 'approved');
  assert.equal(paid.inviter_reward_points, 1500);
  assert.equal(points.getBalance('inviter'), 3125);

  const duplicate = referrals.rewardFirstPurchase({
    invitee_user_id: 'friend', purchase_type: 'broadcast', source_product: 'broadcast', source_record_id: 'PAY-2', created_at: '2026-07-13T04:00:00.000Z'
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(points.getBalance('inviter'), 3125);

  addUser(db, 'inviter-2', 'INV222');
  addUser(db, 'friend-2', 'FRI222');
  referrals.bindReferral({ invitee_user_id: 'friend-2', inviter_user_id: 'inviter-2', invite_code: 'INV222', source_product: 'broadcast' });
  const broadcast = referrals.rewardFirstPurchase({
    invitee_user_id: 'friend-2', purchase_type: 'broadcast', source_product: 'broadcast', source_record_id: 'PAY-3', created_at: '2026-07-13T05:00:00.000Z'
  });
  assert.equal(broadcast.inviter_reward_days, 30);
  assert.ok(Date.parse(broadcast.broadcast_expires_at) > Date.parse('2026-08-11T05:00:00.000Z'));
});

test('refund reverses the first-purchase reward once with an auditable negative ledger entry', () => {
  const { db, points, referrals } = setup();
  addUser(db, 'inviter', 'INV111');
  addUser(db, 'friend', 'FRI111');
  referrals.bindReferral({ invitee_user_id: 'friend', inviter_user_id: 'inviter', invite_code: 'INV111', source_product: 'comment' });
  referrals.rewardFirstPurchase({
    invitee_user_id: 'friend', purchase_type: 'points', source_product: 'roundtable', source_record_id: 'PAY-REFUND', created_at: '2026-07-13T03:00:00.000Z'
  });
  assert.equal(points.getBalance('inviter'), 3125);

  const reversed = referrals.reverseFirstPurchaseReward({ source_record_id: 'PAY-REFUND', created_at: '2026-07-14T03:00:00.000Z' });
  assert.equal(reversed.status, 'reversed');
  assert.equal(points.getBalance('inviter'), 1625);
  const ledger = db.prepare("SELECT delta, reason FROM shixing_point_ledger WHERE user_id = ? AND reason = 'referral_first_purchase_reversal'").get('inviter');
  assert.deepEqual(ledger, { delta: -1500, reason: 'referral_first_purchase_reversal' });

  const duplicate = referrals.reverseFirstPurchaseReward({ source_record_id: 'PAY-REFUND', created_at: '2026-07-15T03:00:00.000Z' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(points.getBalance('inviter'), 1625);
});

test('broadcast reward reversal removes only the awarded 30 days', () => {
  const { db, referrals } = setup();
  addUser(db, 'inviter', 'INV111');
  addUser(db, 'friend', 'FRI111');
  referrals.bindReferral({ invitee_user_id: 'friend', inviter_user_id: 'inviter', invite_code: 'INV111', source_product: 'broadcast' });
  const paid = referrals.rewardFirstPurchase({
    invitee_user_id: 'friend', purchase_type: 'broadcast', source_product: 'broadcast', source_record_id: 'BROADCAST-REFUND', created_at: '2026-07-13T03:00:00.000Z'
  });
  const before = Date.parse(paid.broadcast_expires_at);
  const reversed = referrals.reverseFirstPurchaseReward({ source_record_id: 'BROADCAST-REFUND', created_at: '2026-07-14T03:00:00.000Z' });
  const after = Date.parse(reversed.broadcast_expires_at);
  assert.equal(before - after, 30 * 86400000);
  assert.equal(reversed.status, 'reversed');
});

test('holds suspicious device bursts and monthly activation overflow for review', () => {
  const { db, points, referrals } = setup();
  addUser(db, 'inviter', 'INV111');
  for (let i = 0; i < 13; i++) {
    const friend = 'friend-' + i;
    addUser(db, friend, 'F' + String(i).padStart(5, '0'));
    referrals.bindReferral({ invitee_user_id: friend, inviter_user_id: 'inviter', invite_code: 'INV111', source_product: 'comment' });
    const result = referrals.activateReferral({
      invitee_user_id: friend,
      product: 'comment',
      source_record_id: 'comment:' + i,
      device_hash: i < 3 ? 'same-device' : 'device-' + i,
      created_at: `2026-07-${String(1 + i).padStart(2, '0')}T01:00:00.000Z`
    });
    if (i < 2) assert.equal(result.status, 'approved');
    if (i === 2) {
      assert.equal(result.status, 'pending');
      assert.match(result.risk_reason, /device/);
    }
  }

  const approved = referrals.getAdminStats().events.activation.approved;
  const pending = referrals.getAdminStats().events.activation.pending;
  assert.equal(approved, 10);
  assert.equal(pending, 3);
  assert.equal(points.getBalance('inviter'), 1625 + 10 * REFERRAL_REWARDS.activation_inviter_points);
});

test('migrates earliest legacy relationship, records conflicts, and preserves awarded milestones', () => {
  const { db, referrals } = setup();
  addUser(db, 'inviter-old', 'OLD111');
  addUser(db, 'inviter-new', 'NEW222');
  addUser(db, 'friend', 'FRI111');
  db.prepare('INSERT INTO app_referrals (product, invitee_user_id, inviter_user_id, invitee_username, created_at, usage_rewarded_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('comment', 'friend', 'inviter-old', 'friend@example.com', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z');
  db.prepare('INSERT INTO essay_referrals (invitee_user_id, inviter_user_id, invitee_username, created_at, purchase_rewarded_at) VALUES (?, ?, ?, ?, ?)')
    .run('friend', 'inviter-new', 'friend@example.com', '2026-06-03T00:00:00.000Z', '2026-06-04T00:00:00.000Z');

  const preview = referrals.migrateLegacyReferrals({ dry_run: true });
  assert.deepEqual({ relationships: preview.relationships, conflicts: preview.conflicts, activated: preview.activated, paid: preview.paid }, {
    relationships: 1, conflicts: 1, activated: 1, paid: 1
  });
  assert.equal(referrals.getReferralByInvitee('friend'), null);

  const migrated = referrals.migrateLegacyReferrals({ dry_run: false });
  assert.equal(migrated.inserted, 1);
  const relation = referrals.getReferralByInvitee('friend');
  assert.equal(relation.inviter_user_id, 'inviter-old');
  assert.match(relation.legacy_conflict_json, /inviter-new/);
  const center = referrals.getReferralCenter('inviter-old');
  assert.equal(center.invitees[0].activation_status, 'approved');
  assert.equal(center.invitees[0].purchase_status, 'approved');
});

test('records invite clicks and lets an administrator approve or reject pending activations exactly once', () => {
  const { db, points, referrals } = setup();
  addUser(db, 'inviter', 'INV111');
  for (let i = 0; i < 4; i++) {
    const friend = 'friend-' + i;
    addUser(db, friend, 'FRI' + i);
    referrals.bindReferral({ invitee_user_id: friend, inviter_user_id: 'inviter', invite_code: 'INV111', source_product: 'comment' });
    referrals.activateReferral({
      invitee_user_id: friend, product: 'comment', source_record_id: 'comment:' + i,
      device_hash: 'shared-device', created_at: `2026-07-0${i + 1}T01:00:00.000Z`
    });
  }
  referrals.recordClick({
    click_token: 'click-1', inviter_user_id: 'inviter', invite_code: 'INV111',
    source_product: 'essay', device_hash: 'shared-device', ip_hash: 'ip-hash',
    clicked_at: '2026-07-01T00:00:00.000Z', expires_at: '2026-07-08T00:00:00.000Z'
  });
  assert.equal(referrals.getAdminStats().clicks, 1);

  const pending = db.prepare("SELECT id FROM referral_events WHERE status = 'pending' ORDER BY id").all();
  assert.equal(pending.length, 2);
  const beforeInviter = points.getBalance('inviter');
  const approved = referrals.reviewEvent({ event_id: pending[0].id, decision: 'approve', reviewer: 'admin', note: '人工核验通过' });
  assert.equal(approved.status, 'approved');
  assert.equal(points.getBalance('inviter'), beforeInviter + 500);
  assert.equal(points.getBalance('friend-2'), 2125);
  const duplicate = referrals.reviewEvent({ event_id: pending[0].id, decision: 'approve', reviewer: 'admin' });
  assert.equal(duplicate.duplicate, true);

  const rejected = referrals.reviewEvent({ event_id: pending[1].id, decision: 'reject', reviewer: 'admin', note: '同设备异常' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(points.getBalance('friend-3'), 1625);
  assert.equal(referrals.listPendingEvents().length, 0);
});
