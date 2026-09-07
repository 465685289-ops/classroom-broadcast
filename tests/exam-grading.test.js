const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-exam-grading-' + Date.now());
process.env.SQLITE_FILE = path.join(TMP, 'test.db');
process.env.LEGACY_JSON_FILE = path.join(TMP, 'missing.json');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
fs.mkdirSync(TMP, { recursive: true });
const dbStore = require('../db');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('exam test creation normalizes questions and totals', () => {
  const t = dbStore.createExamTest({
    user_id: 'exam-user', name: '  第三周周测  ', class_name: '初三(2)班', exam_date: '2026-09-07',
    questions: [
      { no: '1', label: '古诗文默写', score: 10, answer: '海日生残夜', rubric: '每空1分，错字该空不得分' },
      { no: '2', score: 4.5, answer: '拟人' },
      { no: '', score: 3, answer: '无题号的应被丢弃' },
      { score: 200, answer: '无题号自动补，分数越界夹紧' }
    ]
  });
  assert.equal(t.name, '第三周周测');
  assert.equal(t.questions.length, 4);
  assert.equal(t.questions[2].no, '3', '空题号自动按序号补齐');
  assert.equal(t.questions[3].score, 100, '越界满分夹紧到 100');
  assert.equal(t.total_score, 117.5);
  // 读取时不再泄漏原始 JSON 字段
  assert.equal(t.questions_json, undefined);
  const loaded = dbStore.getExamTest('exam-user', t.id);
  assert.equal(loaded.total_score, 117.5);
  // 越权读取为空
  assert.equal(dbStore.getExamTest('other-user', t.id), null);
});

test('exam roster import dedupes and results upsert by student', () => {
  const t = dbStore.createExamTest({ user_id: 'exam-user', name: '名单卷', questions: [{ no: '1', score: 10, answer: 'a' }] });
  const out = dbStore.addExamStudents('exam-user', t.id, ['张三', '李四', '张三', '  ', '王五']);
  assert.equal(out.added, 3);
  assert.equal(out.skipped, 2);
  const students = dbStore.listExamStudents('exam-user', t.id);
  assert.equal(students.length, 3);
  // 重复导入整批，全部跳过
  const again = dbStore.addExamStudents('exam-user', t.id, ['张三', '李四']);
  assert.equal(again.added, 0);

  const first = dbStore.saveExamResult({
    user_id: 'exam-user', test_id: t.id, student_id: students[0].id, status: 'graded',
    scores: [{ no: '1', label: '默写', full: 10, score: 6, comment: '错字' }], total: 6, ocr_text: '【题1】…', model: 'test'
  });
  const second = dbStore.saveExamResult({
    user_id: 'exam-user', test_id: t.id, student_id: students[0].id,
    scores: [{ no: '1', full: 10, score: 8 }], total: 8
  });
  assert.equal(second.id, first.id, '同一学生应更新同一条结果');
  const results = dbStore.listExamResults('exam-user', t.id);
  assert.equal(results.length, 1);
  assert.equal(results[0].total, 8);
  assert.equal(results[0].scores[0].score, 8);
});

test('exam score application clamps AI scores to question bounds', () => {
  const { examApplyScores, examTotalOf } = require('../exam-routes');
  const questions = [
    { no: '1', label: '默写', score: 10 },
    { no: '2', label: '鉴赏', score: 4 },
    { no: '3(1)', label: '翻译', score: 3 }
  ];
  const scores = examApplyScores(questions, [
    { no: '1', score: 99, comment: '超出满分应夹紧' },
    { no: '2', score: -2, comment: '负分应夹到0' },
    { no: '4', score: 5, comment: '不存在的题应忽略' }
  ]);
  assert.equal(scores[0].score, 10);
  assert.equal(scores[1].score, 0);
  assert.equal(scores[2].score, 0, 'AI 漏评的题按 0 分落库');
  assert.equal(scores[2].comment, '');
  assert.equal(examTotalOf(scores), 10);
  // 0.5 步长取整
  const half = examApplyScores([{ no: '1', score: 10 }], [{ no: '1', score: 7.4 }]);
  assert.equal(half[0].score, 7.5);
});

test('exam result review patch updates scores and status', () => {
  const t = dbStore.createExamTest({ user_id: 'exam-user', name: '复核卷', questions: [{ no: '1', score: 10, answer: 'a' }, { no: '2', score: 5, answer: 'b' }] });
  dbStore.addExamStudents('exam-user', t.id, ['张三']);
  const s = dbStore.listExamStudents('exam-user', t.id)[0];
  const r = dbStore.saveExamResult({
    user_id: 'exam-user', test_id: t.id, student_id: s.id,
    scores: [{ no: '1', full: 10, score: 5 }, { no: '2', full: 5, score: 5 }], total: 10
  });
  const { examApplyScores, examTotalOf } = require('../exam-routes');
  const merged = examApplyScores(t.questions, [{ no: '1', score: 7.5 }, { no: '2', score: 99 }]);
  const updated = dbStore.updateExamResult('exam-user', r.id, {
    scores: merged, total: examTotalOf(merged), status: 'reviewed'
  });
  assert.equal(updated.status, 'reviewed');
  assert.equal(updated.total, 12.5, '总分应为改后分之和');
  // 不传 status 时保持原状态（reviewed 语义由路由层决定）
  const untouched = dbStore.updateExamResult('exam-user', r.id, { scores: [{ no: '1', score: 8 }], total: 13 });
  assert.equal(untouched.status, 'reviewed');
});

test('exam test deletion cascades students and results', () => {
  const t = dbStore.createExamTest({ user_id: 'exam-user', name: '待删卷', questions: [{ no: '1', score: 10, answer: 'a' }] });
  dbStore.addExamStudents('exam-user', t.id, ['张三', '李四']);
  const s = dbStore.listExamStudents('exam-user', t.id)[0];
  dbStore.saveExamResult({ user_id: 'exam-user', test_id: t.id, student_id: s.id, scores: [{ no: '1', full: 10, score: 9 }], total: 9 });
  assert.equal(dbStore.deleteExamTest('exam-user', t.id), true);
  assert.equal(dbStore.listExamStudents('exam-user', t.id).length, 0);
  assert.equal(dbStore.listExamResults('exam-user', t.id).length, 0);
  assert.equal(dbStore.deleteExamTest('exam-user', t.id), false);
});

test('yuejuan page and route wiring exist', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(serverSrc, /require\('\.\/exam-routes\.js'\)/);
  assert.match(serverSrc, /installExamRoutes\(app\)/);

  const routesSrc = fs.readFileSync(path.join(ROOT, 'exam-routes.js'), 'utf8');
  assert.match(routesSrc, /module\.exports = \{\s*installExamRoutes,/);
  for (const endpoint of ['/api/exam/tests', '/api/exam/ocr', '/api/exam/grade', '/api/exam/parse-questions', '/api/exam/results/']) {
    assert.ok(routesSrc.includes(endpoint), 'exam-routes 缺少端点 ' + endpoint);
  }

  const enginesSrc = fs.readFileSync(path.join(ROOT, 'ai-engines.js'), 'utf8');
  for (const fn of ['qwenOcrExamImage', 'buildExamParsePrompt', 'buildExamGradePrompt', 'gradeExamAI']) {
    assert.ok(enginesSrc.includes('function ' + fn), 'ai-engines 缺少 ' + fn);
  }

  const pageSrc = fs.readFileSync(path.join(ROOT, 'public', 'yuejuan.html'), 'utf8');
  assert.match(pageSrc, /周测 AI 阅卷/);
  assert.match(pageSrc, /\/vendor\/vue\.global\.prod\.min\.js/);
  assert.match(pageSrc, /\/api\/exam\/grade/);
  assert.match(pageSrc, /导出 Excel 成绩表/);
});
