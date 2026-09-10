'use strict';

const crypto = require('crypto');
const { TEACHERS_DAY_2026, isTeachersDay2026 } = require('./teacher-day-campaign');

const TEACHERS_DAY_EMAIL_2026 = Object.freeze({
  key: 'teachers-day-2026',
  workbenchUrl: 'https://notice.yingyuzuowen.asia/student-growth/',
  subject: TEACHERS_DAY_2026.message.title,
  text: `${TEACHERS_DAY_2026.message.body}\n\n师行教师工作台：\nhttps://notice.yingyuzuowen.asia/student-growth/`,
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function emailHash(email) {
  return crypto.createHash('sha256').update(email).digest('hex');
}

function ensureTeacherDayEmailCampaignTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_email_runs (
      campaign_key TEXT PRIMARY KEY,
      audience_cutoff_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_email_deliveries (
      campaign_key TEXT NOT NULL,
      email_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT,
      message_id TEXT,
      failure_code TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (campaign_key, email_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_campaign_email_deliveries_status
      ON campaign_email_deliveries (campaign_key, status);
  `);
}

function existingRun(db) {
  const hasTable = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'campaign_email_runs'").get();
  if (!hasTable) return null;
  return db.prepare('SELECT audience_cutoff_at FROM campaign_email_runs WHERE campaign_key = ?').get(TEACHERS_DAY_EMAIL_2026.key) || null;
}

function getAudienceCutoff(db, { now = new Date(), persist = false } = {}) {
  const run = existingRun(db);
  if (run) return run.audience_cutoff_at;
  const cutoff = now.toISOString();
  if (!persist) return cutoff;
  ensureTeacherDayEmailCampaignTables(db);
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO campaign_email_runs (campaign_key, audience_cutoff_at, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(campaign_key) DO NOTHING
    `).run(TEACHERS_DAY_EMAIL_2026.key, cutoff, cutoff);
    return db.prepare('SELECT audience_cutoff_at FROM campaign_email_runs WHERE campaign_key = ?')
      .get(TEACHERS_DAY_EMAIL_2026.key).audience_cutoff_at;
  })();
}

function collectTeacherDayEmailAudience(db, cutoff) {
  const rows = db.prepare(`
    SELECT contact_type, contact_value, registration_email
    FROM users
    WHERE created_at IS NULL OR created_at = '' OR created_at <= ?
  `).all(cutoff);
  const recipients = new Set();
  for (const row of rows) {
    const registered = normalizeEmail(row.registration_email);
    const contact = normalizeEmail(row.contact_value);
    if (isEmail(registered)) {
      recipients.add(registered);
      continue;
    }
    if ((String(row.contact_type || '').toLowerCase() === 'email' || isEmail(contact)) && isEmail(contact)) {
      recipients.add(contact);
    }
  }
  return [...recipients].sort();
}

function deliveryStats(db) {
  const hasTable = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'campaign_email_deliveries'").get();
  if (!hasTable) return { sent: 0, failed: 0, sending: 0 };
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS total
    FROM campaign_email_deliveries
    WHERE campaign_key = ?
    GROUP BY status
  `).all(TEACHERS_DAY_EMAIL_2026.key);
  return rows.reduce((stats, row) => ({ ...stats, [row.status]: Number(row.total) || 0 }), { sent: 0, failed: 0, sending: 0 });
}

function previewTeacherDayEmails(db, { now = new Date() } = {}) {
  const cutoff = getAudienceCutoff(db, { now });
  const audience = collectTeacherDayEmailAudience(db, cutoff);
  return {
    campaignKey: TEACHERS_DAY_EMAIL_2026.key,
    audience: audience.length,
    cutoff,
    ...deliveryStats(db),
  };
}

function beginDelivery(db, email, now, retryFailed) {
  const hash = emailHash(email);
  return db.transaction(() => {
    const current = db.prepare(`
      SELECT status FROM campaign_email_deliveries
      WHERE campaign_key = ? AND email_hash = ?
    `).get(TEACHERS_DAY_EMAIL_2026.key, hash);
    if (current?.status === 'sent' || current?.status === 'sending') return false;
    if (current?.status === 'failed' && !retryFailed) return false;
    if (current) {
      db.prepare(`
        UPDATE campaign_email_deliveries
        SET status = 'sending', attempts = attempts + 1, failure_code = NULL, updated_at = ?
        WHERE campaign_key = ? AND email_hash = ?
      `).run(now, TEACHERS_DAY_EMAIL_2026.key, hash);
    } else {
      db.prepare(`
        INSERT INTO campaign_email_deliveries (campaign_key, email_hash, status, attempts, updated_at)
        VALUES (?, ?, 'sending', 1, ?)
      `).run(TEACHERS_DAY_EMAIL_2026.key, hash, now);
    }
    return true;
  })();
}

function markDelivery(db, email, result) {
  const hash = emailHash(email);
  db.prepare(`
    UPDATE campaign_email_deliveries
    SET status = ?, sent_at = ?, message_id = ?, failure_code = ?, updated_at = ?
    WHERE campaign_key = ? AND email_hash = ?
  `).run(
    result.status,
    result.sentAt || null,
    result.messageId || null,
    result.failureCode || null,
    result.updatedAt,
    TEACHERS_DAY_EMAIL_2026.key,
    hash,
  );
}

function failureCode(error) {
  return String(error?.code || 'send_failed').slice(0, 80);
}

async function sendTeacherDayEmails(db, {
  now = new Date(),
  from,
  mailer,
  retryFailed = false,
} = {}) {
  if (!from || !mailer || typeof mailer.sendMail !== 'function') throw new Error('需要已配置的邮件发送器');
  ensureTeacherDayEmailCampaignTables(db);
  const cutoff = getAudienceCutoff(db, { now, persist: true });
  const audience = collectTeacherDayEmailAudience(db, cutoff);
  let sentThisRun = 0;
  let failedThisRun = 0;
  let skipped = 0;
  for (const email of audience) {
    const sentAt = now.toISOString();
    if (!beginDelivery(db, email, sentAt, retryFailed)) {
      skipped += 1;
      continue;
    }
    try {
      const info = await mailer.sendMail({
        from,
        to: email,
        subject: TEACHERS_DAY_EMAIL_2026.subject,
        text: TEACHERS_DAY_EMAIL_2026.text,
      });
      markDelivery(db, email, {
        status: 'sent', sentAt, messageId: String(info?.messageId || '').slice(0, 255), updatedAt: new Date().toISOString(),
      });
      sentThisRun += 1;
    } catch (error) {
      markDelivery(db, email, {
        status: 'failed', failureCode: failureCode(error), updatedAt: new Date().toISOString(),
      });
      failedThisRun += 1;
    }
  }
  return {
    campaignKey: TEACHERS_DAY_EMAIL_2026.key,
    audience: audience.length,
    cutoff,
    sentThisRun,
    failedThisRun,
    skipped,
    ...deliveryStats(db),
  };
}

module.exports = {
  TEACHERS_DAY_EMAIL_2026,
  collectTeacherDayEmailAudience,
  deliveryStats,
  ensureTeacherDayEmailCampaignTables,
  isTeachersDay2026,
  previewTeacherDayEmails,
  sendTeacherDayEmails,
};
