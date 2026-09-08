const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TMP = path.join(os.tmpdir(), 'shixing-classroom-points-store-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');
const NOW = '2026-07-14T08:00:00.000Z';

fs.mkdirSync(TMP, { recursive: true });
process.env.SQLITE_FILE = DB_FILE;
process.env.LEGACY_JSON_FILE = path.join(TMP, 'missing-data.json');
process.env.BACKUP_DIR = path.join(TMP, 'backups');

const points = require('../classroom-points');
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
    bind_code: 'ABC123',
    member_ids: [],
    created_at: NOW
  });
});

test('normalizes students and score rules with bounded values', () => {
  assert.deepEqual(points.normalizeStudentInput({
    name: '  李明  ',
    student_no: ' 080101 ',
    seat_row: '2',
    seat_col: 3
  }), {
    name: '李明',
    student_no: '080101',
    seat_row: 2,
    seat_col: 3
  });

  assert.deepEqual(points.normalizeRuleInput({ name: ' 课堂发言 ', delta: '2' }), {
    name: '课堂发言',
    delta: 2,
    active: 1
  });
  assert.throws(() => points.normalizeRuleInput({ name: '无效', delta: 0 }), /非零整数/);

  assert.deepEqual(points.normalizeSeatLayout({}), { seat_rows: 8, seat_cols: 6 });
  assert.deepEqual(points.normalizeSeatLayout({ seat_rows: '9', seat_cols: 7 }), { seat_rows: 9, seat_cols: 7 });
  assert.throws(() => points.normalizeSeatLayout({ seat_rows: 0, seat_cols: 7 }), /座位行数/);
  assert.throws(() => points.normalizeSeatLayout({ seat_rows: null, seat_cols: 7 }), /座位行数/);
  assert.throws(() => points.normalizeSeatLayout({ seat_rows: 8, seat_cols: '' }), /座位列数/);
  assert.throws(() => points.normalizeStudentInput({ name: '不完整座位', seat_row: 2 }), /行号和列号/);
});

test('custom seat dimensions survive a service restart', () => {
  const restartDb = path.join(TMP, 'restart.db');
  const env = {
    ...process.env,
    SQLITE_FILE: restartDb,
    LEGACY_JSON_FILE: path.join(TMP, 'restart-missing-data.json'),
    BACKUP_DIR: path.join(TMP, 'restart-backups')
  };
  execFileSync(process.execPath, ['-e', `
    const store = require('./db');
    store.upsertClass({
      id: 'restart-class', user_id: 'teacher-1', name: '小班', grade: 'junior',
      bind_code: 'RST123', member_ids: [], created_at: '${NOW}'
    });
    store.setClassManagement('restart-class', { seat_rows: 4, seat_cols: 5 });
  `], { cwd: path.join(__dirname, '..'), env });
  const output = execFileSync(process.execPath, ['-e', `
    const store = require('./db');
    process.stdout.write(JSON.stringify(store.getClassManagement('restart-class')));
  `], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), {
    class_id: 'restart-class', enabled: false, sound_enabled: false,
    seat_rows: 4, seat_cols: 5, archived_at: null
  });
});

test('class management is opt-in and stores stable students, rules and a current period', () => {
  assert.deepEqual(dbStore.getClassManagement('class-1'), {
    class_id: 'class-1',
    enabled: false,
    sound_enabled: false,
    seat_rows: 8,
    seat_cols: 6,
    archived_at: null
  });

  const management = dbStore.setClassManagement('class-1', {
    enabled: true,
    sound_enabled: false,
    seat_rows: 9,
    seat_cols: 7,
    updated_at: NOW
  });
  assert.equal(management.enabled, true);
  assert.equal(management.seat_rows, 9);
  assert.equal(management.seat_cols, 7);

  const student = dbStore.createClassStudent({
    id: 'student-1',
    class_id: 'class-1',
    name: '李明',
    student_no: '080101',
    seat_row: 2,
    seat_col: 3,
    created_at: NOW,
    updated_at: NOW
  });
  assert.equal(student.id, 'student-1');
  assert.equal(dbStore.listClassStudents('class-1').length, 1);

  const rule = dbStore.saveClassScoreRule({
    id: 'rule-1',
    class_id: 'class-1',
    name: '课堂发言',
    delta: 2,
    active: 1,
    sort_order: 10,
    created_at: NOW,
    updated_at: NOW
  });
  assert.equal(rule.delta, 2);
  assert.equal(dbStore.listClassScoreRules('class-1').length, 1);

  const period = dbStore.ensureCurrentClassScorePeriod('class-1', NOW);
  assert.equal(period.class_id, 'class-1');
  assert.equal(period.status, 'current');
  assert.equal(dbStore.ensureCurrentClassScorePeriod('class-1', NOW).id, period.id);
});

test('seat dimensions cannot strand students outside the configured grid', () => {
  const edge = dbStore.createClassStudent({
    id: 'student-edge', class_id: 'class-1', name: '边界学生', student_no: '080199',
    seat_row: 9, seat_col: 7, created_at: NOW, updated_at: NOW
  });
  assert.equal(edge.seat_row, 9);
  assert.throws(() => dbStore.setClassManagement('class-1', { seat_rows: 8, seat_cols: 6 }), /边界学生/);
  assert.throws(() => dbStore.createClassStudent({
    id: 'student-outside', class_id: 'class-1', name: '超界学生',
    seat_row: 10, seat_col: 1, created_at: NOW, updated_at: NOW
  }), /超出当前 9 行 × 7 列/);
  dbStore.updateClassStudent('class-1', 'student-edge', { archived: true, updated_at: NOW });
});

test('batch seat synchronization swaps students without creating duplicate seats', () => {
  const second = dbStore.createClassStudent({
    id: 'student-2', class_id: 'class-1', name: '王华', student_no: '080102',
    seat_row: 2, seat_col: 4, created_at: NOW, updated_at: NOW
  });
  assert.equal(second.seat_col, 4);
  const swapped = dbStore.syncClassStudents('class-1', {
    students: [],
    seats: [
      { id: 'student-1', seat_row: 2, seat_col: 4 },
      { id: 'student-2', seat_row: 2, seat_col: 3 }
    ]
  });
  assert.equal(swapped.updated, 2);
  assert.equal(dbStore.getClassStudent('class-1', 'student-1').seat_col, 4);
  assert.equal(dbStore.getClassStudent('class-1', 'student-2').seat_col, 3);
  assert.throws(() => dbStore.syncClassStudents('class-1', {
    students: [],
    seats: [
      { id: 'student-1', seat_row: 2, seat_col: 3 },
      { id: 'student-2', seat_row: 2, seat_col: 3 }
    ]
  }), /座位重复/);
});

test('score entries are idempotent and reversal keeps an auditable pair', () => {
  const period = dbStore.ensureCurrentClassScorePeriod('class-1', NOW);
  const entryInput = {
    id: 'entry-1',
    client_operation_id: 'screen-op-1:student-1',
    class_id: 'class-1',
    student_id: 'student-1',
    period_id: period.id,
    rule_id: 'rule-1',
    rule_name_snapshot: '课堂发言',
    delta: 2,
    source: 'screen',
    actor_user_id: null,
    batch_id: 'screen-op-1',
    reversal_of_id: null,
    client_created_at: NOW,
    created_at: NOW
  };

  const first = dbStore.appendClassScoreEntries([entryInput]);
  const duplicate = dbStore.appendClassScoreEntries([{ ...entryInput, id: 'entry-duplicate' }]);
  assert.equal(first[0].id, 'entry-1');
  assert.equal(duplicate[0].id, 'entry-1');

  const reversed = dbStore.reverseClassScoreEntry({
    id: 'reversal-1',
    class_id: 'class-1',
    entry_id: first[0].id,
    client_operation_id: 'teacher-reverse-1',
    source: 'teacher',
    actor_user_id: 'teacher-1',
    client_created_at: NOW,
    created_at: NOW
  });
  assert.equal(reversed.delta, -2);
  assert.equal(reversed.reversal_of_id, first[0].id);

  assert.throws(() => dbStore.reverseClassScoreEntry({
    id: 'reversal-2',
    class_id: 'class-1',
    entry_id: first[0].id,
    client_operation_id: 'teacher-reverse-2',
    source: 'teacher',
    actor_user_id: 'teacher-1',
    client_created_at: NOW,
    created_at: NOW
  }), /已经撤销/);

  const ledger = dbStore.listClassScoreLedger({ class_id: 'class-1', limit: 20 });
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].id, 'reversal-1');
  const ranking = dbStore.getClassScoreLeaderboard({ class_id: 'class-1', period_id: period.id });
  assert.equal(ranking[0].student_id, 'student-1');
  assert.equal(ranking[0].score, 0);
});

test('date scopes use local calendar boundaries and current period bounds', () => {
  const now = new Date('2026-07-14T08:30:00+08:00');
  const today = points.scoreScopeBounds('today', now, null, 8 * 60);
  assert.equal(today.from, '2026-07-13T16:00:00.000Z');
  assert.equal(today.to, '2026-07-14T16:00:00.000Z');

  const period = points.scoreScopeBounds('term', now, {
    starts_at: '2026-02-20T00:00:00.000Z',
    ends_at: null
  }, 8 * 60);
  assert.equal(period.from, '2026-02-20T00:00:00.000Z');
  assert.equal(period.to, null);
});

test('starting a new period closes the previous period without deleting its ledger', () => {
  const previous = dbStore.ensureCurrentClassScorePeriod('class-1', NOW);
  const next = dbStore.startClassScorePeriod('class-1', {
    name: '2026年秋季学期',
    starts_at: '2026-09-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z'
  });
  assert.equal(next.name, '2026年秋季学期');
  assert.equal(next.status, 'current');
  assert.notEqual(next.id, previous.id);
  const periods = dbStore.listClassScorePeriods('class-1');
  const closed = periods.find(item => item.id === previous.id);
  assert.equal(closed.status, 'ended');
  assert.equal(closed.ends_at, '2026-09-01T00:00:00.000Z');
  assert.equal(dbStore.listClassScoreLedger({ class_id: 'class-1', period_id: previous.id }).length, 2);
});

test('a class with points history is archived instead of losing its ledger', () => {
  const archived = dbStore.archiveClass('class-1', '2026-09-02T00:00:00.000Z');
  assert.equal(archived.archived_at, '2026-09-02T00:00:00.000Z');
  assert.equal(dbStore.loadClasses().some(item => item.id === 'class-1'), false);
  assert.equal(dbStore.listClassScoreLedger({ class_id: 'class-1', limit: 20 }).length, 2);
});
