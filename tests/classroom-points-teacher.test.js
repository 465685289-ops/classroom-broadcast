const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'teacher.html'), 'utf8');

test('teacher page loads the classroom points workspace as a first-class tab', () => {
  assert.match(html, /classroom-points-teacher\.css/);
  assert.match(html, /classroom-points-teacher\.js/);
  assert.match(html, /data-tab="points"[^>]*>积分管理</);
  assert.match(html, /id="tab-points"/);
  assert.match(html, /id="pointsTeacherClassSelect"/);
  assert.match(html, /id="pointsTeacherEnablePanel"/);
  assert.match(html, /开启班级管理/);
  assert.match(html, /包含在班级广播订阅中/);
  assert.match(html, /不消耗师行积分/);
});

test('teacher workspace contains real scoring, roster, rules, period, ranking and ledger regions', () => {
  [
    'pointsTeacherQuickScore',
    'pointsTeacherStudents',
    'pointsTeacherRules',
    'pointsTeacherPeriods',
    'pointsTeacherRanking',
    'pointsTeacherLedger'
  ].forEach((id) => assert.match(html, new RegExp(`id="${id}"`)));

  const source = fs.readFileSync(path.join(ROOT, 'public', 'classroom-points-teacher.js'), 'utf8');
  assert.match(source, /openClass/);
  assert.match(source, /refreshClass/);
  assert.match(source, /handleSocketEvent/);
  assert.match(source, /api\/classes\/.*management/);
  assert.match(source, /score-rules/);
  assert.match(source, /points\/leaderboard/);
  assert.match(source, /points\/ledger/);
  assert.match(source, /is_owner/);
  new Function(source);
});

test('existing tabs delegate the points tab lifecycle without changing broadcast billing', () => {
  assert.match(html, /ClassroomPointsTeacher\.boot/);
  assert.match(html, /ClassroomPointsTeacher\.setClasses/);
  assert.match(html, /ClassroomPointsTeacher\.openClass/);
  assert.doesNotMatch(html, /shixing-points.*classroom|points\/consume.*classroom/i);
});
