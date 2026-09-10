'use strict';

const TEACHERS_DAY_2026 = Object.freeze({
  key: 'teachers-day-2026',
  date: '2026-09-10',
  membershipDays: 7,
  message: Object.freeze({
    title: '教师节快乐｜师行为您增加了 7 天会员时长',
    body: `亲爱的老师：

教师节快乐！

谢谢您选择并使用师行。

师行的许多功能，都来自一线老师真实的工作场景：课表与待办、学生管理、家校沟通、作文批改、课堂广播……我们想做的，不是再给老师增加一个需要学习的系统，而是尽量帮您少跑几趟、少翻几个群、少处理一些重复工作。

值此教师节，师行也为您的账号增加了 7 天会员时长。望能在新学期开始时，为您省下一点时间和精力。

祝您教师节快乐，工作顺利，生活从容。

一位一线老师`,
  }),
});

function shanghaiDayKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isTeachersDay2026(value = new Date()) {
  return shanghaiDayKey(value) === TEACHERS_DAY_2026.date;
}

function addMembershipDays(user, days, now) {
  const current = user.plan === 'yearly' && user.plan_expires ? Date.parse(user.plan_expires) : 0;
  const base = current && current > now.getTime() ? current : now.getTime();
  return new Date(base + days * 86400000).toISOString();
}

function ensureTeacherDayCampaignTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_runs (
      campaign_key TEXT PRIMARY KEY,
      audience_cutoff_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_grants (
      campaign_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      plan_expires_before TEXT,
      plan_expires_after TEXT NOT NULL,
      popup_shown_at TEXT,
      PRIMARY KEY (campaign_key, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_campaign_grants_popup
      ON campaign_grants (campaign_key, popup_shown_at);
  `);
}

function previewTeacherDayMemberships(db, { now = new Date() } = {}) {
  const table = db.prepare('SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', 'campaign_runs');
  const run = table
    ? db.prepare('SELECT audience_cutoff_at FROM campaign_runs WHERE campaign_key = ?').get(TEACHERS_DAY_2026.key)
    : null;
  const cutoff = run?.audience_cutoff_at || now.toISOString();
  const audience = Number(db.prepare(`
    SELECT COUNT(*) AS total
    FROM users
    WHERE created_at IS NULL OR created_at = '' OR created_at <= ?
  `).get(cutoff).total) || 0;
  const grantsTable = db.prepare('SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', 'campaign_grants');
  const existing = grantsTable ? Number(db.prepare(`
    SELECT COUNT(*) AS total
    FROM campaign_grants AS grant_row
    INNER JOIN users ON users.id = grant_row.user_id
    WHERE grant_row.campaign_key = ?
      AND (users.created_at IS NULL OR users.created_at = '' OR users.created_at <= ?)
  `).get(TEACHERS_DAY_2026.key, cutoff).total) || 0 : 0;
  return { campaignKey: TEACHERS_DAY_2026.key, granted: 0, existing, audience };
}

function grantTeacherDayMemberships(db, { now = new Date() } = {}) {
  ensureTeacherDayCampaignTables(db);
  const nowIso = now.toISOString();
  return db.transaction(() => {
    const run = db.prepare('SELECT audience_cutoff_at FROM campaign_runs WHERE campaign_key = ?')
      .get(TEACHERS_DAY_2026.key);
    const cutoff = run?.audience_cutoff_at || nowIso;
    if (!run) {
      db.prepare('INSERT INTO campaign_runs (campaign_key, audience_cutoff_at, created_at) VALUES (?, ?, ?)')
        .run(TEACHERS_DAY_2026.key, cutoff, nowIso);
    }
    const users = db.prepare(`
      SELECT id, plan, plan_expires
      FROM users
      WHERE created_at IS NULL OR created_at = '' OR created_at <= ?
      ORDER BY id
    `).all(cutoff);
    const insertGrant = db.prepare(`
      INSERT INTO campaign_grants (
        campaign_key, user_id, granted_at, plan_expires_before, plan_expires_after, popup_shown_at
      ) VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(campaign_key, user_id) DO NOTHING
    `);
    const updateUser = db.prepare('UPDATE users SET plan = ?, plan_expires = ? WHERE id = ?');
    let granted = 0;
    let existing = 0;
    for (const user of users) {
      const nextExpiry = addMembershipDays(user, TEACHERS_DAY_2026.membershipDays, now);
      const result = insertGrant.run(
        TEACHERS_DAY_2026.key, user.id, nowIso, user.plan_expires || null, nextExpiry,
      );
      if (result.changes) {
        updateUser.run('yearly', nextExpiry, user.id);
        granted += 1;
      } else {
        existing += 1;
      }
    }
    return { campaignKey: TEACHERS_DAY_2026.key, granted, existing, audience: users.length };
  })();
}

function claimTeacherDayPopup(db, userId, { now = new Date() } = {}) {
  if (!isTeachersDay2026(now)) return null;
  ensureTeacherDayCampaignTables(db);
  return db.transaction(() => {
    const result = db.prepare(`
      UPDATE campaign_grants
      SET popup_shown_at = ?
      WHERE campaign_key = ? AND user_id = ? AND popup_shown_at IS NULL
    `).run(now.toISOString(), TEACHERS_DAY_2026.key, userId);
    return result.changes ? TEACHERS_DAY_2026.message : null;
  })();
}

module.exports = {
  TEACHERS_DAY_2026,
  addMembershipDays,
  claimTeacherDayPopup,
  ensureTeacherDayCampaignTables,
  grantTeacherDayMemberships,
  isTeachersDay2026,
  previewTeacherDayMemberships,
  shanghaiDayKey,
};
