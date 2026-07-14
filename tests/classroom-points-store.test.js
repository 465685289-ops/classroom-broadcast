const assert = require('node:assert/strict');
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
});

test('class management is opt-in and stores stable students, rules and a current period', () => {
  assert.deepEqual(dbStore.getClassManagement('class-1'), {
    class_id: 'class-1',
    enabled: false,
    sound_enabled: false,
    archived_at: null
  });

  const management = dbStore.setClassManagement('class-1', {
    enabled: true,
    sound_enabled: false,
    updated_at: NOW
  });
  assert.equal(management.enabled, true);

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
