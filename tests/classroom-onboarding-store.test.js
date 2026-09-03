const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TMP = path.join(os.tmpdir(), 'shixing-classroom-onboarding-store-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');

fs.mkdirSync(TMP, { recursive: true });
process.env.SQLITE_FILE = DB_FILE;
process.env.LEGACY_JSON_FILE = path.join(TMP, 'missing-data.json');
process.env.BACKUP_DIR = path.join(TMP, 'backups');

const dbStore = require('../db');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('classroom onboarding keeps the first class, screen connection, and successful notice across reloads', () => {
  assert.equal(dbStore.getClassroomOnboarding('teacher-1'), null);

  dbStore.rememberOnboardingClass('teacher-1', 'class-1', '2026-08-31T01:00:00.000Z');
  dbStore.markOnboardingScreenConnected('teacher-1', 'class-1', '2026-08-31T01:05:00.000Z');
  dbStore.markOnboardingFirstNotification('teacher-1', 'class-1', 42, '2026-08-31T01:10:00.000Z');

  const saved = dbStore.getClassroomOnboarding('teacher-1');
  assert.deepEqual(saved, {
    user_id: 'teacher-1',
    version: 1,
    first_class_id: 'class-1',
    screen_connected_at: '2026-08-31T01:05:00.000Z',
    first_notification_id: 42,
    first_notification_at: '2026-08-31T01:10:00.000Z',
    updated_at: '2026-08-31T01:10:00.000Z'
  });
});

test('classroom onboarding never advances from a different class or overwrites first-success times', () => {
  dbStore.rememberOnboardingClass('teacher-2', 'class-first', '2026-08-31T02:00:00.000Z');
  dbStore.markOnboardingScreenConnected('teacher-2', 'class-other', '2026-08-31T02:01:00.000Z');
  dbStore.markOnboardingFirstNotification('teacher-2', 'class-other', 99, '2026-08-31T02:02:00.000Z');
  dbStore.markOnboardingScreenConnected('teacher-2', 'class-first', '2026-08-31T02:03:00.000Z');
  dbStore.markOnboardingScreenConnected('teacher-2', 'class-first', '2026-08-31T02:04:00.000Z');
  dbStore.markOnboardingFirstNotification('teacher-2', 'class-first', 7, '2026-08-31T02:05:00.000Z');
  dbStore.markOnboardingFirstNotification('teacher-2', 'class-first', 8, '2026-08-31T02:06:00.000Z');

  const saved = dbStore.getClassroomOnboarding('teacher-2');
  assert.equal(saved.first_class_id, 'class-first');
  assert.equal(saved.screen_connected_at, '2026-08-31T02:03:00.000Z');
  assert.equal(saved.first_notification_id, 7);
  assert.equal(saved.first_notification_at, '2026-08-31T02:05:00.000Z');
});

test('deleting the target class clears its onboarding record so a new class can start fresh', () => {
  dbStore.rememberOnboardingClass('teacher-3', 'deleted-class', '2026-08-31T03:00:00.000Z');
  dbStore.markOnboardingScreenConnected('teacher-3', 'deleted-class', '2026-08-31T03:01:00.000Z');

  dbStore.clearClassroomOnboardingForClass('teacher-3', 'another-class');
  assert.equal(dbStore.getClassroomOnboarding('teacher-3').first_class_id, 'deleted-class');

  dbStore.clearClassroomOnboardingForClass('teacher-3', 'deleted-class');
  assert.equal(dbStore.getClassroomOnboarding('teacher-3'), null);
});
