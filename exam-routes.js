'use strict';

// AI 给分按题号对位、夹紧到 [0, 满分]、0.5 步长
function examApplyScores(questions, aiScores) {
  const byNo = new Map();
  (Array.isArray(aiScores) ? aiScores : []).forEach(s => {
    if (s && s.no !== undefined && s.no !== null) byNo.set(String(s.no).trim(), s);
  });
  return (questions || []).map(q => {
    const hit = byNo.get(String(q.no).trim());
    let score = 0;
    if (hit) {
      const n = Number(hit.score);
      if (Number.isFinite(n)) score = Math.round(Math.max(0, Math.min(Number(q.score) || 0, n)) * 2) / 2;
    }
    return {
      no: q.no, label: q.label || '', full: Number(q.score) || 0, score,
      comment: String(hit && hit.comment || '').slice(0, 300)
    };
  });
}

function examTotalOf(scores) {
  return Math.round((scores || []).reduce((sum, s) => sum + (Number(s.score) || 0), 0) * 10) / 10;
}

// 周测阅卷路由：周测(题目/参考答案) / 名单 / 拍照OCR / AI逐题评分 / 复核改分 / 成绩报表。
// 样板参照 essay-routes.js；AI 调用与提示词在 ai-engines.js。
function installExamRoutes(app) {
// @WIRE
const dbStore = require('./db');
const {
  buildExamGradePrompt, buildExamParsePrompt, examAIConfigured, examGradeAllowed, examOcrAllowed,
  extractExamJson, gradeExamAI, qwenOcrExamImage
} = require('./ai-engines');
const { userAuth } = require('./middleware');
const { QWEN_API_KEY } = require('./platform-config');

function examOwnedTest(userId, testId) {
  return dbStore.getExamTest(userId, String(testId || ''));
}

// ---------- 周测管理 ----------
app.get('/api/exam/config', userAuth, (req, res) => {
  res.json({ ok: true, ocr_enabled: !!QWEN_API_KEY, ai_enabled: examAIConfigured() });
});

app.get('/api/exam/tests', userAuth, (req, res) => {
  res.json({ ok: true, tests: dbStore.listExamTests(req.user.id) });
});

app.post('/api/exam/tests', userAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请输入周测名称' });
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  if (!questions.length) return res.status(400).json({ error: '请至少添加一道题目' });
  const test = dbStore.createExamTest({
    user_id: req.user.id, name,
    class_name: req.body.class_name, exam_date: req.body.exam_date, questions
  });
  res.json({ ok: true, test });
});

app.get('/api/exam/tests/:id', userAuth, (req, res) => {
  const test = examOwnedTest(req.user.id, req.params.id);
  if (!test) return res.status(404).json({ error: '周测不存在' });
  const students = dbStore.listExamStudents(req.user.id, test.id);
  const results = dbStore.listExamResults(req.user.id, test.id);
  const resultMap = new Map(results.map(r => [r.student_id, r]));
  res.json({
    ok: true, test,
    students: students.map(s => ({ ...s, result: resultMap.get(s.id) || null })),
    questions: test.questions
  });
});

app.patch('/api/exam/tests/:id', userAuth, (req, res) => {
  const test = dbStore.updateExamTest(req.user.id, String(req.params.id || ''), req.body || {});
  if (!test) return res.status(404).json({ error: '周测不存在' });
  res.json({ ok: true, test });
});

app.delete('/api/exam/tests/:id', userAuth, (req, res) => {
  if (!dbStore.deleteExamTest(req.user.id, String(req.params.id || ''))) return res.status(404).json({ error: '周测不存在' });
  res.json({ ok: true });
});

// 复制上周周测：带题目，可选带名单——周测结构每周基本固定的核心省力点
app.post('/api/exam/tests/:id/clone', userAuth, (req, res) => {
  const source = examOwnedTest(req.user.id, req.params.id);
  if (!source) return res.status(404).json({ error: '周测不存在' });
  const test = dbStore.createExamTest({
    user_id: req.user.id,
    name: String(req.body.name || source.name + '（副本）').trim().slice(0, 80),
    class_name: source.class_name, exam_date: req.body.exam_date || '', questions: source.questions
  });
  if (req.body.with_students) {
    dbStore.addExamStudents(req.user.id, test.id, dbStore.listExamStudents(req.user.id, source.id).map(s => ({ name: s.name, student_no: s.student_no })));
  }
  res.json({ ok: true, test });
});

// ---------- 名单 ----------
app.post('/api/exam/tests/:id/students', userAuth, (req, res) => {
  const test = examOwnedTest(req.user.id, req.params.id);
  if (!test) return res.status(404).json({ error: '周测不存在' });
  let rows = req.body.names;
  if (!Array.isArray(rows) && req.body.names_text !== undefined) {
    rows = String(req.body.names_text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  }
  const out = dbStore.addExamStudents(req.user.id, test.id, rows);
  if (!out) return res.status(404).json({ error: '周测不存在' });
  res.json({ ok: true, ...out, students: dbStore.listExamStudents(req.user.id, test.id) });
});

app.delete('/api/exam/tests/:id/students/:studentId', userAuth, (req, res) => {
  if (!dbStore.deleteExamStudent(req.user.id, String(req.params.id || ''), String(req.params.studentId || ''))) {
    return res.status(404).json({ error: '学生不存在' });
  }
  res.json({ ok: true });
});

// ---------- AI 拆题 / OCR / 评分 ----------
app.post('/api/exam/parse-questions', userAuth, async (req, res) => {
  if (!examAIConfigured()) return res.status(503).json({ error: 'AI 服务暂未配置，请联系管理员' });
  const text = String(req.body.text || '').trim();
  if (text.length < 10) return res.status(400).json({ error: '请粘贴参考答案文本（至少 10 字）' });
  try {
    const graded = await gradeExamAI(buildExamParsePrompt(text));
    const data = extractExamJson(graded.result);
    if (!data || !Array.isArray(data.questions) || !data.questions.length) {
      return res.status(502).json({ error: 'AI 未能从文本中识别出题目，请手动添加或调整文本格式' });
    }
    res.json({ ok: true, questions: data.questions, model: graded.model });
  } catch (e) {
    console.log('[EXAM] parse-questions failed:', e.message);
    res.status(502).json({ error: '拆题失败：' + e.message });
  }
});

app.post('/api/exam/ocr', userAuth, async (req, res) => {
  if (!QWEN_API_KEY) return res.status(503).json({ error: 'OCR 服务暂未配置，请联系管理员' });
  const image = String(req.body.image || '');
  if (!image.startsWith('data:image/')) return res.status(400).json({ error: '图片格式不正确' });
  if (image.length > 8 * 1024 * 1024) return res.status(413).json({ error: '图片过大，请重拍或裁剪后重试' });
  if (!examOcrAllowed(req.user.id)) return res.status(429).json({ error: '今日识别次数已达上限（400张），请明天再试' });
  try {
    const text = await qwenOcrExamImage(image);
    res.json({ ok: true, text });
  } catch (e) {
    console.log('[EXAM] ocr failed:', e.message);
    res.status(502).json({ error: '识别失败：' + e.message });
  }
});

app.post('/api/exam/grade', userAuth, async (req, res) => {
  const test = examOwnedTest(req.user.id, req.body.test_id);
  if (!test) return res.status(404).json({ error: '周测不存在' });
  if (!test.questions.length) return res.status(400).json({ error: '该周测还没有题目，请先完善题目与参考答案' });
  const student = dbStore.getExamStudent(req.user.id, test.id, String(req.body.student_id || ''));
  if (!student) return res.status(404).json({ error: '学生不存在' });
  if (!examAIConfigured()) return res.status(503).json({ error: 'AI 评分服务暂未配置，请联系管理员' });
  if (!examGradeAllowed(req.user.id)) return res.status(429).json({ error: '今日评分次数已达上限（150次），请明天再试' });
  const ocrText = String(req.body.ocr_text || '').trim().slice(0, 20000);
  if (ocrText.length < 2) return res.status(400).json({ error: '答题内容为空，请先上传照片识别' });
  try {
    const graded = await gradeExamAI(buildExamGradePrompt(test.questions, ocrText, { studentName: student.name }));
    const data = extractExamJson(graded.result);
    if (!data || !Array.isArray(data.scores)) {
      return res.status(502).json({ error: 'AI 返回格式异常，请重试一次' });
    }
    const scores = examApplyScores(test.questions, data.scores);
    const total = examTotalOf(scores);
    const result = dbStore.saveExamResult({
      user_id: req.user.id, test_id: test.id, student_id: student.id,
      status: 'graded', scores, total,
      ocr_text: ocrText, model: graded.model,
      ai_raw: String(data.ocr_issues || '').slice(0, 2000)
    });
    res.json({ ok: true, result, scores, total, unanswered: Array.isArray(data.unanswered) ? data.unanswered : [], ocr_issues: String(data.ocr_issues || '') });
  } catch (e) {
    console.log('[EXAM] grade failed:', e.message);
    res.status(502).json({ error: '评分失败：' + e.message });
  }
});

// 老师复核改分：重算总分并标记 reviewed
app.patch('/api/exam/results/:id', userAuth, (req, res) => {
  const current = dbStore.getExamResult(req.user.id, String(req.params.id || ''));
  if (!current) return res.status(404).json({ error: '批改记录不存在' });
  const test = examOwnedTest(req.user.id, current.test_id);
  if (!test) return res.status(404).json({ error: '周测不存在' });
  let scores = current.scores;
  let status = 'reviewed';
  if (Array.isArray(req.body.scores)) {
    const patchByNo = new Map(req.body.scores.map(s => [String(s && s.no).trim(), s]));
    scores = (current.scores || []).map(s => {
      const patch = patchByNo.get(String(s.no).trim());
      if (!patch || patch.score === undefined || patch.score === null || patch.score === '') return s;
      const n = Number(patch.score);
      if (!Number.isFinite(n)) return s;
      return { ...s, score: Math.round(Math.max(0, Math.min(s.full, n)) * 2) / 2, comment: patch.comment === undefined ? s.comment : String(patch.comment).slice(0, 300) };
    });
    // 复核页允许增补 AI 漏掉的题（如 OCR 缺题时老师手动补分）
    req.body.scores.forEach(ps => {
      const no = String(ps && ps.no).trim();
      if (no && !scores.some(s => String(s.no).trim() === no)) {
        const q = test.questions.find(q => String(q.no).trim() === no);
        const n = Number(ps.score);
        if (q && Number.isFinite(n)) {
          scores.push({ no: q.no, label: q.label || '', full: Number(q.score) || 0, score: Math.round(Math.max(0, Math.min(q.score, n)) * 2) / 2, comment: String(ps.comment || '老师手动补分').slice(0, 300) });
        }
      }
    });
  }
  if (req.body.status) status = String(req.body.status).slice(0, 20);
  const total = examTotalOf(scores);
  const result = dbStore.updateExamResult(req.user.id, current.id, { scores, total, status });
  res.json({ ok: true, result, scores, total });
});

}

module.exports = {
  installExamRoutes,
  examApplyScores,
  examTotalOf,
};
