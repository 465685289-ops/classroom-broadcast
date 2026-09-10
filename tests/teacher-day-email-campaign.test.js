'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  TEACHERS_DAY_EMAIL_2026,
  previewTeacherDayEmails,
  sendTeacherDayEmails,
} = require('../teacher-day-email-campaign');

function createDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-day-email-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new Database(path.join(directory, 'campaign.db'));
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      contact_type TEXT,
      contact_value TEXT,
      registration_email TEXT,
      created_at TEXT
    );
  `);
  return db;
}

function insertUser(db, id, values) {
  db.prepare('INSERT INTO users (id, contact_type, contact_value, registration_email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, values.contactType || '', values.contactValue || '', values.registrationEmail || '', values.createdAt || '2026-09-10T00:00:00.000Z');
}

test('教师节邮件受众去重、优先使用注册邮箱，并冻结在活动开始前', (t) => {
  const db = createDb(t);
  insertUser(db, 'registered', { registrationEmail: 'Teacher@Example.com', contactType: 'email', contactValue: 'old@example.com' });
  insertUser(db, 'duplicate', { registrationEmail: 'teacher@example.com' });
  insertUser(db, 'legacy', { contactType: 'email', contactValue: 'legacy@example.com' });
  insertUser(db, 'invalid', { contactType: 'phone', contactValue: '13800000000' });
  insertUser(db, 'after-cutoff', { registrationEmail: 'later@example.com', createdAt: '2026-09-11T00:00:00.000Z' });

  const preview = previewTeacherDayEmails(db, { now: new Date('2026-09-10T06:00:00.000Z') });
  assert.equal(preview.audience, 2);
  assert.equal(preview.sent, 0);
  db.close();
});

test('教师节邮件每个地址只成功投递一次，并将失败留待显式重试', async (t) => {
  const db = createDb(t);
  insertUser(db, 'one', { registrationEmail: 'one@example.com' });
  insertUser(db, 'two', { contactType: 'email', contactValue: 'two@example.com' });
  const calls = [];
  const mailer = { sendMail: async (message) => { calls.push(message); return { messageId: 'message-' + calls.length }; } };

  const first = await sendTeacherDayEmails(db, {
    now: new Date('2026-09-10T06:00:00.000Z'), from: '师行 <no-reply@example.test>', mailer,
  });
  assert.equal(first.sentThisRun, 2);
  assert.equal(first.sent, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].subject, TEACHERS_DAY_EMAIL_2026.subject);
  assert.match(calls[0].text, /https:\/\/notice\.yingyuzuowen\.asia\/student-growth\//);

  const second = await sendTeacherDayEmails(db, {
    now: new Date('2026-09-10T06:05:00.000Z'), from: '师行 <no-reply@example.test>', mailer,
  });
  assert.equal(second.sentThisRun, 0);
  assert.equal(second.skipped, 2);
  assert.equal(calls.length, 2);
  db.close();
});

test('发送错误只记录失败，不会把地址误标记为已投递', async (t) => {
  const db = createDb(t);
  insertUser(db, 'failure', { registrationEmail: 'failure@example.com' });
  const failed = await sendTeacherDayEmails(db, {
    now: new Date('2026-09-10T06:00:00.000Z'),
    from: '师行 <no-reply@example.test>',
    mailer: { sendMail: async () => { const error = new Error('network'); error.code = 'ETIMEDOUT'; throw error; } },
  });
  assert.equal(failed.sent, 0);
  assert.equal(failed.failed, 1);

  const noRetry = await sendTeacherDayEmails(db, {
    now: new Date('2026-09-10T06:05:00.000Z'), from: '师行 <no-reply@example.test>',
    mailer: { sendMail: async () => ({ messageId: 'should-not-send' }) },
  });
  assert.equal(noRetry.sentThisRun, 0);
  assert.equal(noRetry.failed, 1);

  const retried = await sendTeacherDayEmails(db, {
    now: new Date('2026-09-10T06:10:00.000Z'), from: '师行 <no-reply@example.test>', retryFailed: true,
    mailer: { sendMail: async () => ({ messageId: 'retried' }) },
  });
  assert.equal(retried.sent, 1);
  assert.equal(retried.failed, 0);
  db.close();
});
