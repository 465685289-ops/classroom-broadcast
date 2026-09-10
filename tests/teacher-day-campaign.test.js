const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  TEACHERS_DAY_2026,
  claimTeacherDayPopup,
  ensureTeacherDayCampaignTables,
  grantTeacherDayMemberships,
  previewTeacherDayMemberships,
} = require('../teacher-day-campaign');

function createDatabase() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-day-campaign-')), 'broadcast.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      plan TEXT,
      plan_expires TEXT
    );
  `);
  ensureTeacherDayCampaignTables(db);
  return { db, file };
}

test('教师节赠礼只给活动启动前的既有账号各增加一次七天会员时长', () => {
  const { db, file } = createDatabase();
  try {
    db.prepare('INSERT INTO users (id, created_at, plan, plan_expires) VALUES (?, ?, ?, ?)').run(
      'active', '2026-09-01T00:00:00.000Z', 'yearly', '2026-10-01T00:00:00.000Z');
    db.prepare('INSERT INTO users (id, created_at, plan, plan_expires) VALUES (?, ?, ?, ?)').run(
      'expired', '2026-09-01T00:00:00.000Z', 'trial', null);

    const launchedAt = new Date('2026-09-10T02:00:00.000Z');
    assert.deepEqual(previewTeacherDayMemberships(db, { now: launchedAt }), {
      campaignKey: TEACHERS_DAY_2026.key, granted: 0, existing: 0, audience: 2,
    });
    const first = grantTeacherDayMemberships(db, { now: launchedAt });
    assert.deepEqual(first, { campaignKey: TEACHERS_DAY_2026.key, granted: 2, existing: 0, audience: 2 });
    assert.equal(db.prepare('SELECT plan_expires FROM users WHERE id = ?').get('active').plan_expires, '2026-10-08T00:00:00.000Z');
    assert.equal(db.prepare('SELECT plan_expires FROM users WHERE id = ?').get('expired').plan_expires, '2026-09-17T02:00:00.000Z');

    db.prepare('INSERT INTO users (id, created_at, plan, plan_expires) VALUES (?, ?, ?, ?)').run(
      'tomorrow-register', '2026-09-10T02:00:01.000Z', 'trial', null);
    const repeated = grantTeacherDayMemberships(db, { now: new Date('2026-09-11T02:00:00.000Z') });
    assert.deepEqual(repeated, { campaignKey: TEACHERS_DAY_2026.key, granted: 0, existing: 2, audience: 2 });
    assert.equal(db.prepare('SELECT plan_expires FROM users WHERE id = ?').get('tomorrow-register').plan_expires, null);
  } finally {
    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('教师节弹窗仅可在上海时间九月十日向获赠账号展示一次', () => {
  const { db, file } = createDatabase();
  try {
    db.prepare('INSERT INTO users (id, created_at, plan, plan_expires) VALUES (?, ?, ?, ?)').run(
      'teacher', '2026-09-01T00:00:00.000Z', 'trial', null);
    grantTeacherDayMemberships(db, { now: new Date('2026-09-10T02:00:00.000Z') });

    const popup = claimTeacherDayPopup(db, 'teacher', { now: new Date('2026-09-10T08:00:00.000Z') });
    assert.deepEqual(popup, TEACHERS_DAY_2026.message);
    assert.equal(claimTeacherDayPopup(db, 'teacher', { now: new Date('2026-09-10T08:01:00.000Z') }), null);

    db.prepare('UPDATE campaign_grants SET popup_shown_at = NULL WHERE campaign_key = ? AND user_id = ?')
      .run(TEACHERS_DAY_2026.key, 'teacher');
    assert.equal(claimTeacherDayPopup(db, 'teacher', { now: new Date('2026-09-11T00:01:00.000Z') }), null);
    assert.equal(claimTeacherDayPopup(db, 'unknown', { now: new Date('2026-09-10T08:00:00.000Z') }), null);
  } finally {
    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
