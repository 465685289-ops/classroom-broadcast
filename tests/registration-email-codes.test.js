const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TMP_DB = path.join(os.tmpdir(), 'shixing-registration-email-codes-' + Date.now() + '.db');
process.env.SQLITE_FILE = TMP_DB;
process.env.LEGACY_JSON_FILE = path.join(os.tmpdir(), 'shixing-registration-email-codes-missing-data.json');
process.env.BACKUP_DIR = path.join(os.tmpdir(), 'shixing-registration-email-codes-backups-' + Date.now());
const dbStore = require('../db.js');

test.after(() => {
  for (const file of [TMP_DB, TMP_DB + '-shm', TMP_DB + '-wal']) {
    try { fs.unlinkSync(file); } catch (e) {}
  }
  try { fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true }); } catch (e) {}
});

test('stores a registration code by email and counts sends by IP', () => {
  const now = new Date('2026-06-24T00:00:00.000Z');
  const row = dbStore.insertRegistrationEmailCode({
    email: 'new-user@example.com',
    request_ip: '203.0.113.8',
    code_hash: 'hash',
    code_salt: 'salt',
    attempts: 0,
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    created_at: now.toISOString()
  });

  assert.ok(row.id);
  assert.equal(dbStore.getRecentRegistrationEmailCode('new-user@example.com', now.toISOString()).id, row.id);
  assert.equal(dbStore.getLatestRegistrationEmailCode('new-user@example.com').request_ip, '203.0.113.8');
  assert.equal(dbStore.countRegistrationEmailCodesByIp('203.0.113.8', now.toISOString()), 1);
});

test('consumes a registration code so it cannot be retrieved again', () => {
  const row = dbStore.insertRegistrationEmailCode({
    email: 'single-use@example.com',
    request_ip: '203.0.113.9',
    code_hash: 'hash',
    code_salt: 'salt',
    attempts: 0,
    expires_at: '2026-06-24T00:10:00.000Z',
    created_at: '2026-06-24T00:00:00.000Z'
  });

  dbStore.markRegistrationEmailCodeUsed(row.id, '2026-06-24T00:01:00.000Z');
  assert.equal(dbStore.getLatestRegistrationEmailCode('single-use@example.com'), null);
});
