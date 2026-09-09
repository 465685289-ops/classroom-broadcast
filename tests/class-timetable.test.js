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
  activeClassTimetableSlots,
  classTimetableHasEntries,
  emptyClassTimetable,
  normalizeClassTimetable,
  validateClassTimetableStructure
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

test('class timetable normalizes fixed weekdays and compatible fourteen storage slots', () => {
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
    '第6节', '第7节', '第8节', '晚自习1', '晚自习2', '晚自习3', '第9节', '晚自习4'
  ]);
  assert.deepEqual(Object.keys(result.entries), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.equal(result.entries.mon.length, 14);
  assert.equal(result.entries.mon[0], '语文');
  assert.equal(result.entries.mon[1], 'x'.repeat(30));
  assert.equal(result.entries.tue.every(value => value === ''), true);
  assert.equal(result.entries.sat.length, 14);
  assert.equal(result.entries.sat[0], '周六竞赛');
  assert.equal(result.entries.zhouba, undefined);
  assert.equal(result.updated_at, NOW);
  assert.deepEqual(result.structure, {
    configured: true,
    morning_reading: true,
    regular_count: 8,
    evening_study_count: 3
  }, '旧课表仍按原 12 个可见时段兼容，不因升级被隐藏');
});

test('empty and populated timetables are distinguished by their real cells', () => {
  const empty = emptyClassTimetable();
  assert.equal(classTimetableHasEntries(empty), false);
  assert.equal(empty.structure.configured, false, '新班级必须先由教师确认课程结构');
  assert.equal(classTimetableHasEntries({ entries: { fri: ['', '班会'] } }), true);
});

test('teacher-confirmed structure selects primary or secondary periods without deleting hidden cells', () => {
  const primary = normalizeClassTimetable({
    version: 2,
    structure: { configured: true, morning_reading: false, regular_count: 6, evening_study_count: 0 },
    entries: { mon: ['晨读', '语文', '数学', '英语', '科学', '体育', '美术', '隐藏第7节', '隐藏第8节', '隐藏晚1'] }
  });
  assert.deepEqual(activeClassTimetableSlots(primary.structure), [
    { index: 1, label: '第1节' }, { index: 2, label: '第2节' }, { index: 3, label: '第3节' },
    { index: 4, label: '第4节' }, { index: 5, label: '第5节' }, { index: 6, label: '第6节' }
  ]);
  assert.equal(primary.entries.mon[0], '晨读');
  assert.equal(primary.entries.mon[7], '隐藏第7节');
  assert.equal(primary.entries.mon[9], '隐藏晚1');

  const secondary = normalizeClassTimetable({
    ...primary,
    structure: { configured: true, morning_reading: true, regular_count: 8, evening_study_count: 2 }
  });
  assert.equal(activeClassTimetableSlots(secondary.structure).length, 11);
  assert.equal(secondary.entries.mon[7], '隐藏第7节', '中途扩回节次后原课程仍在');
  assert.equal(secondary.entries.mon[9], '隐藏晚1', '重新开启晚自习后原课程仍在');
});

test('nine regular periods and four evening studies use new storage cells without moving legacy evening courses', () => {
  const expanded = normalizeClassTimetable({
    structure: validateClassTimetableStructure({
      morning_reading: true,
      regular_count: 9,
      evening_study_count: 4
    }),
    entries: {
      mon: ['早读', '语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '原晚自习1', '原晚自习2', '原晚自习3', '第9节课程', '晚自习4']
    }
  });

  assert.deepEqual(activeClassTimetableSlots(expanded.structure), [
    { index: 0, label: '早读' },
    { index: 1, label: '第1节' }, { index: 2, label: '第2节' }, { index: 3, label: '第3节' },
    { index: 4, label: '第4节' }, { index: 5, label: '第5节' }, { index: 6, label: '第6节' },
    { index: 7, label: '第7节' }, { index: 8, label: '第8节' }, { index: 12, label: '第9节' },
    { index: 9, label: '晚自习1' }, { index: 10, label: '晚自习2' }, { index: 11, label: '晚自习3' }, { index: 13, label: '晚自习4' }
  ]);
  assert.equal(expanded.entries.mon[9], '原晚自习1', '已有晚自习1必须仍在原存储位');
  assert.equal(expanded.entries.mon[12], '第9节课程');
  assert.equal(expanded.entries.mon[13], '晚自习4');
});

test('course structure rejects invalid teacher input instead of silently coercing it', () => {
  assert.deepEqual(validateClassTimetableStructure({
    morning_reading: false,
    regular_count: 6,
    evening_study_count: 0
  }), {
    configured: true,
    morning_reading: false,
    regular_count: 6,
    evening_study_count: 0
  });
  assert.throws(() => validateClassTimetableStructure({ morning_reading: true, regular_count: 0, evening_study_count: 0 }), /正课节数/);
  assert.throws(() => validateClassTimetableStructure({ morning_reading: true, regular_count: 6.5, evening_study_count: 0 }), /正课节数/);
  assert.throws(() => validateClassTimetableStructure({ morning_reading: true, regular_count: 6, evening_study_count: 5 }), /晚自习节数/);
  assert.throws(() => validateClassTimetableStructure({ morning_reading: 'no', regular_count: 6, evening_study_count: 0 }), /早读设置/);
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
  assert.equal(cls.timetable.entries.fri.length, 14);
  assert.equal(cls.timetable.updated_at, NOW);
});

test('class timetable keeps a teacher-controlled visible flag defaulting to shown', () => {
  assert.equal(normalizeClassTimetable({ entries: { mon: ['语文'] } }).visible, true, '缺省视为对大屏显示');
  assert.equal(normalizeClassTimetable({ entries: {}, visible: false }).visible, false);
  assert.equal(normalizeClassTimetable({ visible: 'no' }).visible, true, '非布尔一律视为显示');

  const saved = dbStore.saveClassTimetable('class-1', {
    entries: { mon: ['语文'], fri: ['', '班会'] },
    visible: false,
    updated_at: NOW
  });
  assert.equal(saved.visible, false);
  const cls = dbStore.loadClasses().find(item => item.id === 'class-1');
  assert.equal(cls.timetable.visible, false);
  assert.equal(cls.timetable.entries.fri[1], '班会', '隐藏开关不影响课表内容');
});
