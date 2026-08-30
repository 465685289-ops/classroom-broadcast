const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TMP = path.join(os.tmpdir(), 'shixing-broadcast-notification-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');

fs.mkdirSync(TMP, { recursive: true });
process.env.SQLITE_FILE = DB_FILE;
process.env.LEGACY_JSON_FILE = path.join(TMP, 'missing-data.json');
process.env.BACKUP_DIR = path.join(TMP, 'backups');

const { normalizeBroadcastMode } = require('../broadcast-notification');
const dbStore = require('../db');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('broadcast mode accepts text and defaults every legacy or invalid value to voice', () => {
  assert.equal(normalizeBroadcastMode('text'), 'text');
  assert.equal(normalizeBroadcastMode('voice'), 'voice');
  assert.equal(normalizeBroadcastMode(undefined), 'voice');
  assert.equal(normalizeBroadcastMode('silent'), 'voice');
  assert.equal(normalizeBroadcastMode('TEXT'), 'voice');
});

test('text-only and legacy notification modes survive SQLite reloads', () => {
  const base = {
    class_id: 'class-1',
    user_id: 'teacher-1',
    content: '请安静自习',
    signature: '',
    sender_name: '班主任',
    student_name: '',
    repeat_count: 2,
    created_at: '2026-08-30T08:00:00.000Z'
  };
  dbStore.upsertNotification({ id: 1, ...base, broadcast_mode: 'text' });
  dbStore.upsertNotification({ id: 2, ...base, content: '旧通知没有模式字段' });
  dbStore.upsertNotification({ id: 3, ...base, content: '无效模式', broadcast_mode: 'silent' });

  const rows = dbStore.loadStore().notifications;
  assert.equal(rows.find(row => row.id === 1).broadcast_mode, 'text');
  assert.equal(rows.find(row => row.id === 2).broadcast_mode, 'voice');
  assert.equal(rows.find(row => row.id === 3).broadcast_mode, 'voice');
});
