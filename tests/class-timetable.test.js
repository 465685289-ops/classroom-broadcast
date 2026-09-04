const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TMP = path.join(os.tmpdir(), 'shixing-class-timetable-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');
const NOW = '2026-08-30T08:00:00.000Z';

fs.mkdirSync(TMP, { recursive: true });
process.env.SQLITE_FILE = DB_FILE;
process.env.LEGACY_JSON_FILE = path.join(TMP, 'missing-data.json');
process.env.BACKUP_DIR = path.join(TMP, 'backups');

const {
  TIMETABLE_DAYS,
  TIMETABLE_SLOTS,
  classTimetableHasEntries,
  emptyClassTimetable,
  normalizeClassTimetable
} = require('../class-timetable');
const dbStore = require('../db');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test.before(() => {
  dbStore.upsertClass({
    id: 'class-1',
    user_id: 'teacher-1',
    name: '八年级一班',
    grade: 'junior',
    bind_code: 'CLS123',
    member_ids: [],
    created_at: NOW
  });
});

test('class timetable normalizes fixed weekdays and twelve bounded slots', () => {
  const result = normalizeClassTimetable({
    entries: {
      mon: [' 语文 ', 'x'.repeat(35)],
      tue: 'not-an-array',
      sat: [' 周六竞赛 '],
      zhouba: ['不应保存']
    },
    updated_at: NOW
  });

  assert.deepEqual(TIMETABLE_DAYS, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.deepEqual(TIMETABLE_SLOTS, [
    '早读', '第1节', '第2节', '第3节', '第4节', '第5节',
    '第6节', '第7节', '第8节', '晚自习1', '晚自习2', '晚自习3'
  ]);
  assert.deepEqual(Object.keys(result.entries), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.equal(result.entries.mon.length, 12);
  assert.equal(result.entries.mon[0], '语文');
  assert.equal(result.entries.mon[1], 'x'.repeat(30));
  assert.equal(result.entries.tue.every(value => value === ''), true);
  assert.equal(result.entries.sat.length, 12);
  assert.equal(result.entries.sat[0], '周六竞赛');
  assert.equal(result.entries.zhouba, undefined);
  assert.equal(result.updated_at, NOW);
});

test('empty and populated timetables are distinguished by their real cells', () => {
  const empty = emptyClassTimetable();
  assert.equal(classTimetableHasEntries(empty), false);
  assert.equal(classTimetableHasEntries({ entries: { fri: ['', '班会'] } }), true);
});

test('class timetable persists through the classes extra_json field', () => {
  const saved = dbStore.saveClassTimetable('class-1', {
    entries: { mon: ['语文'], fri: ['', '班会'] },
    updated_at: NOW
  });
  assert.equal(saved.entries.mon[0], '语文');

  const cls = dbStore.loadClasses().find(item => item.id === 'class-1');
  assert.equal(cls.timetable.entries.mon[0], '语文');
  assert.equal(cls.timetable.entries.fri[1], '班会');
  assert.equal(cls.timetable.entries.fri.length, 12);
  assert.equal(cls.timetable.updated_at, NOW);
});
