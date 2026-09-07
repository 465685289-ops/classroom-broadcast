'use strict';

// AI 常把题号写成"题1"，统一剥掉前缀，保证与题目清单对位
function examCleanNo(no) {
  return String(no === undefined || no === null ? '' : no).trim().replace(/^题/, '').trim();
}

// AI 给分按题号对位、夹紧到 [0, 满分]、0.5 步长；answeredNos 传入时，未识别到作答的题强制 0 分
function examApplyScores(questions, aiScores, answeredNos) {
  const byNo = new Map();
  (Array.isArray(aiScores) ? aiScores : []).forEach(s => {
    if (s && s.no !== undefined && s.no !== null) byNo.set(examCleanNo(s.no), s);
  });
  return (questions || []).map(q => {
    const hit = byNo.get(examCleanNo(q.no));
    let score = 0;
    let comment = '';
    if (answeredNos && answeredNos.size && !answeredNos.has(examCleanNo(q.no))) {
      comment = '未识别到该题作答，按0分计；学生如有作答请拍照补录或手动改分';
    } else if (hit) {
      const n = Number(hit.score);
      if (Number.isFinite(n)) score = Math.round(Math.max(0, Math.min(Number(q.score) || 0, n)) * 2) / 2;
      comment = String(hit.comment || '').slice(0, 300);
    }
    return {
      no: q.no, label: q.label || '', full: Number(q.score) || 0, score, comment
    };
  });
}

function examTotalOf(scores) {
  return Math.round((scores || []).reduce((sum, s) => sum + (Number(s.score) || 0), 0) * 10) / 10;
}

// bbox 校验：0-1000 整数四元组，x2>x1、y2>y1，非法返回 null
function examNormalizeBbox(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const nums = raw.map(Number);
  if (!nums.every(n => Number.isFinite(n))) return null;
  const [x1, y1, x2, y2] = nums.map(n => Math.round(Math.max(0, Math.min(1000, n))));
  if (x2 - x1 < 4 || y2 - y1 < 4) return null;
  return [x1, y1, x2, y2];
}

// 从 OCR 锚点文本提取有实际作答内容的题号（防止 AI 给没拍到的题凭空判分）
function examAnsweredNos(ocrText) {
  const set = new Set();
  String(ocrText || '').split(/\r?\n/).forEach(line => {
    const m = line.match(/^【题(.+?)】/);
    const content = m ? line.slice(m[0].length).trim() : '';
    if (m && content && !/^[（(]?空白[)）]?$/.test(content)) set.add(examCleanNo(m[1]));
  });
  return set;
}

// 结构化 OCR 结果归一化：题号/文本/合法 bbox；并拼出【题N】锚点文本供评分与人工校对
function examNormalizeOcrAnswers(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const answers = (Array.isArray(data.answers) ? data.answers : []).slice(0, 40).map((a, i) => {
    const no = examCleanNo(a && a.no !== undefined && a.no !== null ? a.no : i + 1).slice(0, 20);
    const text = String(a && a.text || '').trim().slice(0, 2000);
    return { no, text, bbox: examNormalizeBbox(a && a.bbox) };
  }).filter(a => a.no);
  const name = String(data.name || '').trim().replace(/^姓名[:：]?/, '').slice(0, 20);
  const ocrText = answers.filter(a => a.text).map(a => '【题' + a.no + '】' + a.text).join('\n');
  return { name, answers, ocrText };
}

// 周测阅卷路由：周测(题目/参考答案) / 名单 / 拍照OCR / AI逐题评分 / 复核改分 / 成绩报表。
// 样板参照 essay-routes.js；AI 调用与提示词在 ai-engines.js。
function installExamRoutes(app) {
// @WIRE
const dbStore = require('./db');
const {
  buildExamGradePrompt, buildExamParsePaperPrompt, buildExamParsePrompt, examAIConfigured, examGradeAllowed, examOcrAllowed,
  examVisionStructured, extractExamJson, glmVisionReady, gradeExamAI
} = require('./ai-engines');
const { userAuth } = require('./middleware');
const { QWEN_API_KEY } = require('./platform-config');

function examOwnedTest(userId, testId) {
  return dbStore.getExamTest(userId, String(testId || ''));
}

// ---------- 周测管理 ----------
app.get('/api/exam/config', userAuth, (req, res) => {
  res.json({
    ok: true,
    ocr_enabled: !!QWEN_API_KEY || glmVisionReady(),
    ai_enabled: examAIConfigured(),
    ocr_engine: glmVisionReady() ? 'glm' : (QWEN_API_KEY ? 'qwen' : 'none')
  });
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

// docx 上传前的文本拆卷：试卷原文 + 答案原文 → 按内容对齐的题目列表
app.post('/api/exam/parse-paper', userAuth, async (req, res) => {
  if (!examAIConfigured()) return res.status(503).json({ error: 'AI 服务暂未配置，请联系管理员' });
  const paperText = String(req.body.paper_text || '').trim();
  const answerText = String(req.body.answer_text || '').trim();
  if (paperText.length < 20) return res.status(400).json({ error: '试卷内容为空或过短' });
  try {
    const graded = await gradeExamAI(buildExamParsePaperPrompt(paperText, answerText));
    const data = extractExamJson(graded.result);
    if (!data || !Array.isArray(data.questions) || !data.questions.length) {
      return res.status(502).json({ error: 'AI 未能从文档中拆出题目，请手动添加或调整文档' });
    }
    res.json({ ok: true, questions: data.questions, model: graded.model });
  } catch (e) {
    console.log('[EXAM] parse-paper failed:', e.message);
    res.status(502).json({ error: '拆卷失败：' + e.message });
  }
});

// 拍照结构化识别：姓名 + 逐题手写内容 + 批阅框（GLM 优先，Qwen 兜底）；可带题目清单做题号锚定
app.post('/api/exam/ocr', userAuth, async (req, res) => {
  const image = String(req.body.image || '');
  if (!image.startsWith('data:image/')) return res.status(400).json({ error: '图片格式不正确' });
  if (image.length > 8 * 1024 * 1024) return res.status(413).json({ error: '图片过大，请重拍或裁剪后重试' });
  if (!QWEN_API_KEY && !glmVisionReady()) return res.status(503).json({ error: 'OCR 服务暂未配置，请联系管理员' });
  if (!examOcrAllowed(req.user.id)) return res.status(429).json({ error: '今日识别次数已达上限（400张），请明天再试' });
  const questions = (Array.isArray(req.body.questions) ? req.body.questions : [])
    .map(q => ({ no: examCleanNo(q && q.no), label: String(q && q.label || '').slice(0, 30), score: Number(q && q.score) || 0 }))
    .filter(q => q.no);
  try {
    const vision = await examVisionStructured(image, questions);
    const data = extractExamJson(vision.raw);
    if (!data || !Array.isArray(data.answers)) {
      return res.status(502).json({ error: '识别结果格式异常，请重试一次' });
    }
    const norm = examNormalizeOcrAnswers(data);
    res.json({ ok: true, engine: vision.engine, model: vision.model, name: norm.name, answers: norm.answers, ocr_text: norm.ocrText });
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
    const scores = examApplyScores(test.questions, data.scores, examAnsweredNos(ocrText));
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
    const patchByNo = new Map(req.body.scores.map(s => [examCleanNo(s && s.no), s]));
    scores = (current.scores || []).map(s => {
      const patch = patchByNo.get(examCleanNo(s.no));
      if (!patch || patch.score === undefined || patch.score === null || patch.score === '') return s;
      const n = Number(patch.score);
      if (!Number.isFinite(n)) return s;
      const next = { ...s, score: Math.round(Math.max(0, Math.min(s.full, n)) * 2) / 2, comment: patch.comment === undefined ? s.comment : String(patch.comment).slice(0, 300) };
      if (patch.bbox !== undefined) {
        const bbox = examNormalizeBbox(patch.bbox);
        if (bbox) next.bbox = bbox; else delete next.bbox;
      }
      return next;
    });
    // 复核页允许增补 AI 漏掉的题（如 OCR 缺题时老师手动补分）
    req.body.scores.forEach(ps => {
      const no = examCleanNo(ps && ps.no);
      if (no && !scores.some(s => examCleanNo(s.no) === no)) {
        const q = test.questions.find(q => examCleanNo(q.no) === no);
        const n = Number(ps.score);
        if (q && Number.isFinite(n)) {
          scores.push({ no: q.no, label: q.label || '', full: Number(q.score) || 0, score: Math.round(Math.max(0, Math.min(q.score, n)) * 2) / 2, comment: String(ps.comment || '老师手动补分').slice(0, 300), bbox: examNormalizeBbox(ps.bbox) || undefined });
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
  examCleanNo,
  examAnsweredNos,
  examNormalizeBbox,
  examNormalizeOcrAnswers,
};
