'use strict';

function installEnglishRoutes(app) {
// 英语作文批改路由：班级 / 题目 / 批改 / 分享页。
// @WIRE
const dbStore = require('./db');
const {
  buildEnglishEssayPrompt, ENGLISH_RUBRIC_PRESETS, ENGLISH_TASK_TYPES, englishDataToText, essayAIConfigured, essayOcrAllowed, extractEssayJson, gradeEssayAI, normalizeEnglishEssayData, qwenOcrImage
} = require('./ai-engines');
const {
  deviceHashFromReq
} = require('./http-utils');
const {
  notifyUnifiedActivation
} = require('./messaging-referrals');
const {
  userAuth
} = require('./middleware');
const {
  createPaymentOrderNo, extractPayUrl, getBaseUrl, getPointPackage, moneyDisplay, publicPointPackages, yungouConfigured, yungouRequest, yungouSign
} = require('./payment-engine');
const {
  ENGLISH_BASE_URL, QWEN_API_KEY, YUNGOU_APP_ID, YUNGOU_MCH_ID, YUNGOU_PAY_KEY
} = require('./platform-config');
const {
  POINT_COSTS
} = require('./shixing-points');
const state = require('./state');

function englishShareUrl(token) {
  return (ENGLISH_BASE_URL || 'https://notice.yingyuzuowen.asia') + '/english/revise/' + encodeURIComponent(token);
}

function englishAssignment(req, id) {
  return dbStore.getEssayAssignment(req.user.id, String(id || ''), 'english');
}

app.get('/api/english/config', userAuth, (req, res) => {
  const pointBalance = dbStore.getShixingPointBalance(req.user.id);
  res.json({
    ok: true,
    enabled: essayAIConfigured(),
    ocr_enabled: !!QWEN_API_KEY,
    pay_enabled: yungouConfigured(),
    balance: pointBalance,
    point_balance: pointBalance,
    point_cost: POINT_COSTS.english,
    task_types: ENGLISH_TASK_TYPES,
    rubric_presets: ENGLISH_RUBRIC_PRESETS,
    score_types: ['满分15分', '满分20分', '满分25分', '满分30分', '满分40分'],
    packages: publicPointPackages(req.user.id),
    first_topup_available: !dbStore.hasShixingPointTopup(req.user.id)
  });
});

app.post('/api/english/payments/package', userAuth, async (req, res) => {
  if (!yungouConfigured()) {
    return res.status(503).json({ error: '微信支付暂未配置，请联系管理员' });
  }
  const pkg = getPointPackage(req.body.package_key);
  if (!pkg) return res.status(400).json({ error: '积分套餐不存在' });

  const outTradeNo = createPaymentOrderNo('EN');
  const amount = moneyDisplay(pkg.amount);
  const baseUrl = ENGLISH_BASE_URL || getBaseUrl(req);
  const payment = {
    out_trade_no: outTradeNo,
    user_id: req.user.id,
    username: req.user.username,
    plan: pkg.key,
    plan_days: null,
    credits: pkg.points,
    amount,
    status: 'created',
    created_at: new Date().toISOString(),
    source_product: 'english'
  };
  state.store.payments.push(payment);
  dbStore.upsertPayment(payment);

  const requiredParams = {
    out_trade_no: outTradeNo,
    total_fee: amount,
    mch_id: YUNGOU_MCH_ID,
    body: '师行积分' + pkg.points
  };
  const params = {
    ...requiredParams,
    sign: yungouSign(requiredParams, YUNGOU_PAY_KEY),
    attach: req.user.id,
    notify_url: baseUrl + '/api/payments/yungou/notify',
    return_url: baseUrl + '/english.html?pay_order=' + encodeURIComponent(outTradeNo),
    auto: '0'
  };
  if (YUNGOU_APP_ID) params.app_id = YUNGOU_APP_ID;

  try {
    const result = await yungouRequest('POST', '/api/pay/wxpay/cashierPay', params);
    payment.provider_response = result;
    if (!result || result.code !== 0) {
      payment.status = 'create_failed';
      payment.error = (result && (result.msg || result.message)) || '创建支付订单失败';
      dbStore.upsertPayment(payment);
      return res.status(502).json({ error: payment.error });
    }
    const payUrl = extractPayUrl(result.data);
    if (!payUrl) {
      payment.status = 'create_failed';
      payment.error = '支付链接为空';
      dbStore.upsertPayment(payment);
      return res.status(502).json({ error: payment.error });
    }
    payment.status = 'pending';
    dbStore.upsertPayment(payment);
    res.json({
      ok: true,
      out_trade_no: outTradeNo,
      amount,
      credits: pkg.points,
      points: pkg.points,
      pay_url: payUrl
    });
  } catch (e) {
    payment.status = 'create_failed';
    payment.error = e.message;
    dbStore.upsertPayment(payment);
    res.status(502).json({ error: '创建支付订单失败：' + e.message });
  }
});

app.get('/api/english/classes', userAuth, (req, res) => {
  res.json({ ok: true, classes: dbStore.listEssayClasses(req.user.id, req.query.archived === '1', 'english') });
});

app.post('/api/english/classes', userAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请输入班级名称' });
  const item = dbStore.createEssayClass({ user_id: req.user.id, subject: 'english', name, grade: req.body.grade, school_year: req.body.school_year });
  res.json({ ok: true, class: item });
});

app.patch('/api/english/classes/:id', userAuth, (req, res) => {
  if (!dbStore.listEssayClasses(req.user.id, true, 'english').some(item => item.id === req.params.id)) return res.status(404).json({ error: '英语班级不存在' });
  const item = dbStore.updateEssayClass(req.user.id, req.params.id, req.body || {});
  res.json({ ok: true, class: item });
});

app.get('/api/english/import-sources', userAuth, (req, res) => {
  const sources = dbStore.listEssayClasses(req.user.id, false, 'chinese').map(item => ({
    id: item.id,
    name: item.name,
    grade: item.grade,
    student_count: dbStore.listEssayStudents(req.user.id, item.id, false, 'chinese').length
  }));
  res.json({ ok: true, sources });
});

app.post('/api/english/classes/import', userAuth, (req, res) => {
  const copied = dbStore.copyEssayClassRoster(req.user.id, String(req.body.source_class_id || ''), req.body.name);
  if (!copied) return res.status(404).json({ error: '可复制的原班级不存在' });
  res.json({ ok: true, ...copied });
});

app.get('/api/english/classes/:id/students', userAuth, (req, res) => {
  if (!dbStore.listEssayClasses(req.user.id, true, 'english').some(item => item.id === req.params.id)) return res.status(404).json({ error: '英语班级不存在' });
  res.json({ ok: true, students: dbStore.listEssayStudents(req.user.id, req.params.id, req.query.archived === '1', 'english') });
});

app.post('/api/english/classes/:id/students', userAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请输入学生姓名' });
  const student = dbStore.createEssayStudent({ user_id: req.user.id, subject: 'english', class_id: req.params.id, name, student_no: req.body.student_no });
  if (!student) return res.status(404).json({ error: '英语班级不存在' });
  res.json({ ok: true, student });
});

app.patch('/api/english/students/:id', userAuth, (req, res) => {
  const current = dbStore.listEssayStudents(req.user.id, '', true, 'english').find(item => item.id === req.params.id);
  if (!current) return res.status(404).json({ error: '英语学生不存在' });
  res.json({ ok: true, student: dbStore.updateEssayStudent(req.user.id, req.params.id, req.body || {}) });
});

app.get('/api/english/rubrics', userAuth, (req, res) => {
  res.json({ ok: true, rubrics: dbStore.listEssayRubrics(req.user.id, 'english'), presets: ENGLISH_RUBRIC_PRESETS });
});

app.post('/api/english/rubrics', userAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const dimensions = Array.isArray(req.body.dimensions) ? req.body.dimensions : [];
  const sum = dimensions.reduce((total, item) => total + (Number(item && item.weight) || 0), 0);
  if (!name || dimensions.length < 2) return res.status(400).json({ error: '请填写模板名称和评分维度' });
  if (Math.abs(sum - 100) > 0.01) return res.status(400).json({ error: '评分权重合计必须为100%' });
  const rubric = dbStore.saveEssayRubric({ user_id: req.user.id, subject: 'english', name, dimensions });
  res.json({ ok: true, rubric });
});

app.get('/api/english/assignments', userAuth, (req, res) => {
  res.json({ ok: true, assignments: dbStore.listEssayAssignments(req.user.id, String(req.query.class_id || ''), req.query.archived === '1', 'english') });
});

app.post('/api/english/assignments', userAuth, (req, res) => {
  const title = String(req.body.title || '').trim();
  const taskType = ENGLISH_TASK_TYPES.includes(req.body.task_type || req.body.genre) ? (req.body.task_type || req.body.genre) : '中考作文';
  if (!title) return res.status(400).json({ error: '请输入英语作文题目' });
  const dimensions = Array.isArray(req.body.dimensions) && req.body.dimensions.length ? req.body.dimensions : ENGLISH_RUBRIC_PRESETS[taskType];
  const assignment = dbStore.createEssayAssignment({
    user_id: req.user.id,
    subject: 'english',
    ...req.body,
    title,
    genre: taskType,
    grade_level: String(req.body.grade_level || (taskType.indexOf('高中') === 0 || taskType === '读后续写' ? '高中' : '初中')),
    score_type: String(req.body.score_type || (taskType === '读后续写' ? '满分25分' : '满分20分')),
    dimensions
  });
  if (!assignment) return res.status(404).json({ error: '英语班级或量规模板不存在' });
  res.json({ ok: true, assignment });
});

app.patch('/api/english/assignments/:id', userAuth, (req, res) => {
  const current = englishAssignment(req, req.params.id);
  if (!current) return res.status(404).json({ error: '英语作业不存在' });
  const patch = { ...req.body };
  if (patch.task_type) patch.genre = patch.task_type;
  if (Array.isArray(patch.dimensions)) patch.rubric = { dimensions: patch.dimensions };
  const assignment = dbStore.updateEssayAssignment(req.user.id, req.params.id, patch);
  res.json({ ok: true, assignment });
});

app.post('/api/english/assignments/:id/copy', userAuth, (req, res) => {
  const source = englishAssignment(req, req.params.id);
  if (!source) return res.status(404).json({ error: '英语作业不存在' });
  const assignment = dbStore.createEssayAssignment({
    ...source,
    id: undefined,
    user_id: req.user.id,
    subject: 'english',
    title: String(req.body.title || source.title + '（副本）'),
    status: 'active',
    archived: false,
    dimensions: source.rubric.dimensions
  });
  res.json({ ok: true, assignment });
});

app.post('/api/english/submissions', userAuth, (req, res) => {
  if (!englishAssignment(req, req.body.assignment_id)) return res.status(400).json({ error: '英语作业不存在' });
  const submission = dbStore.createEssaySubmission({ user_id: req.user.id, assignment_id: req.body.assignment_id, student_id: req.body.student_id, student_name: req.body.student_name, essay_text: req.body.essay_text });
  if (!submission || submission.subject !== 'english') return res.status(400).json({ error: '作业、学生或作文内容无效' });
  res.json({ ok: true, submission: { ...submission, share_url: englishShareUrl(submission.share_token) } });
});

app.get('/api/english/submissions/:id', userAuth, (req, res) => {
  const detail = dbStore.getEssaySubmission(req.user.id, req.params.id);
  if (!detail || detail.submission.subject !== 'english') return res.status(404).json({ error: '英语作文记录不存在' });
  detail.submission.share_url = englishShareUrl(detail.submission.share_token);
  res.json({ ok: true, ...detail });
});

app.patch('/api/english/submissions/:id', userAuth, (req, res) => {
  const detail = dbStore.getEssaySubmission(req.user.id, req.params.id);
  if (!detail || detail.submission.subject !== 'english') return res.status(404).json({ error: '英语作文记录不存在' });
  res.json({ ok: true, ...dbStore.updateEssaySubmission(req.user.id, req.params.id, req.body || {}) });
});

app.delete('/api/english/submissions/:id', userAuth, (req, res) => {
  const detail = dbStore.getEssaySubmission(req.user.id, req.params.id);
  if (!detail || detail.submission.subject !== 'english') return res.status(404).json({ error: '英语作文记录不存在' });
  dbStore.deleteEssaySubmission(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.put('/api/english/submissions/:id/review', userAuth, (req, res) => {
  const current = dbStore.getEssaySubmission(req.user.id, req.params.id);
  if (!current || current.submission.subject !== 'english') return res.status(404).json({ error: '英语作文记录不存在' });
  const review = dbStore.saveEssayReview({ user_id: req.user.id, submission_id: req.params.id, grading_id: req.body.grading_id, status: req.body.status, score_override: req.body.score_override, summary_override: req.body.summary_override, annotations: req.body.annotations });
  const detail = dbStore.getEssaySubmission(req.user.id, req.params.id);
  res.json({ ok: true, review, submission: { ...detail.submission, share_url: englishShareUrl(detail.submission.share_token) } });
});

app.get('/api/english/workflow/history', userAuth, (req, res) => {
  res.json({ ok: true, ...dbStore.listEssayWorkflowHistory(req.user.id, { ...req.query, subject: 'english' }) });
});

app.get('/api/english/history', userAuth, (req, res) => {
  res.json({
    ok: true,
    balance: dbStore.getShixingPointBalance(req.user.id),
    gradings: dbStore.listEssayGradings(req.user.id, Math.min(100, Number(req.query.limit) || 50), 'english'),
    ledger: dbStore.listShixingPointLedger(req.user.id, 30).filter(item => item.product === 'english')
  });
});

app.get('/api/english/assignments/:id/report', userAuth, (req, res) => {
  if (!englishAssignment(req, req.params.id)) return res.status(404).json({ error: '英语作业不存在' });
  const report = dbStore.getEssayAssignmentReport(req.user.id, req.params.id);
  res.json({ ok: true, report });
});

app.get('/api/english/public/:token', (req, res) => {
  const detail = dbStore.getEssaySubmissionByShareToken(req.params.token);
  if (!detail || detail.submission.subject !== 'english') return res.status(404).json({ error: '链接无效或已失效' });
  res.json({ ok: true, assignment: detail.assignment, student: detail.student ? { name: detail.student.name } : { name: detail.submission.student_name }, submission: { status: detail.submission.status, current_version: detail.submission.current_version }, revisions: detail.revisions, review: detail.review && detail.review.status === 'finalized' ? detail.review : null });
});

app.post('/api/english/public/:token/revisions', (req, res) => {
  const detail = dbStore.getEssaySubmissionByShareToken(req.params.token);
  if (!detail || detail.submission.subject !== 'english') return res.status(404).json({ error: '链接无效或已失效' });
  const result = dbStore.addEssayRevisionByToken(req.params.token, req.body.essay_text);
  if (result && result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, revision: result });
});

app.post('/api/english/ocr', userAuth, async (req, res) => {
  if (!QWEN_API_KEY) return res.status(503).json({ error: 'OCR 服务暂未配置，请联系管理员' });
  const image = String(req.body.image || '');
  if (!image.startsWith('data:image/') || image.length > 8 * 1024 * 1024) return res.status(400).json({ error: '图片格式不正确或过大' });
  if (!essayOcrAllowed(req.user.id + ':english')) return res.status(429).json({ error: '今日 OCR 识别次数已达上限，请明天再试' });
  try {
    const text = await qwenOcrImage(image);
    res.json({ ok: true, text });
  } catch (e) {
    console.log('[ENGLISH] ocr failed:', e.message);
    res.status(502).json({ error: '识别失败：' + e.message });
  }
});

app.post('/api/english/grade', userAuth, async (req, res) => {
  if (!essayAIConfigured()) return res.status(503).json({ error: 'AI 批改服务暂未配置，请联系管理员' });
  const requestId = String(req.body.request_id || '').trim().slice(0, 100);
  if (!requestId) return res.status(400).json({ error: '缺少批改任务编号，请刷新页面后重试' });
  const existing = dbStore.getEssayGradingByRequest(req.user.id, 'english', requestId);
  if (existing) {
    if (req.body.submission_id) {
      const retrySubmission = dbStore.getEssaySubmission(req.user.id, String(req.body.submission_id));
      if (!retrySubmission || retrySubmission.submission.subject !== 'english') return res.status(404).json({ error: '学生英语作文记录不存在' });
      dbStore.attachEssayGradingToSubmission(req.user.id, retrySubmission.submission.id, existing.id, Number(req.body.revision_no) || retrySubmission.submission.current_version);
    }
    return res.json({ ok: true, duplicate: true, structured: existing.english || null, result: existing.result, grading_id: existing.id, balance: dbStore.getShixingPointBalance(req.user.id) });
  }
  const balance = dbStore.getShixingPointBalance(req.user.id);
  if (balance < POINT_COSTS.english) return res.status(402).json({ error: '师行积分不足，本次英语作文批改需要 ' + POINT_COSTS.english + ' 积分', balance });
  const essayText = String(req.body.essay_text || '').trim().slice(0, 8000);
  if (essayText.length < 30) return res.status(400).json({ error: '英语作文内容过短，无法批改' });
  const assignment = req.body.assignment_id ? englishAssignment(req, req.body.assignment_id) : null;
  if (req.body.assignment_id && !assignment) return res.status(404).json({ error: '英语作业不存在' });
  const submissionDetail = req.body.submission_id ? dbStore.getEssaySubmission(req.user.id, String(req.body.submission_id)) : null;
  if (req.body.submission_id && (!submissionDetail || submissionDetail.submission.subject !== 'english')) return res.status(404).json({ error: '学生英语作文记录不存在' });
  const taskType = ENGLISH_TASK_TYPES.includes(assignment && assignment.genre || req.body.task_type) ? (assignment && assignment.genre || req.body.task_type) : '中考作文';
  const gradeLevel = String(assignment && assignment.grade_level || req.body.grade_level || (taskType === '中考作文' || taskType === '初中日常作文' ? '初中' : '高中'));
  const scoreType = String(assignment && assignment.score_type || req.body.score_type || (taskType === '读后续写' ? '满分25分' : '满分20分'));
  const studentName = String(req.body.student_name || '').trim().slice(0, 40);
  try {
    const graded = await gradeEssayAI(buildEnglishEssayPrompt(essayText, taskType, gradeLevel, scoreType, assignment));
    const structured = normalizeEnglishEssayData(extractEssayJson(graded.result), taskType, scoreType, assignment, essayText);
    if (!structured || !structured.annotations || !structured.dimensions.length) throw new Error('AI 返回的评分结构不完整');
    const resultText = englishDataToText(structured);
    const saved = dbStore.insertEssayGradingAndDebit({
      user_id: req.user.id,
      username: req.user.username,
      subject: 'english',
      request_id: requestId,
      student_name: studentName,
      genre: taskType,
      grade_level: gradeLevel,
      score_type: scoreType,
      essay_text: essayText,
      result: resultText,
      model: graded.model,
      extra_json: { english: structured },
      device_hash: deviceHashFromReq(req),
      created_at: new Date().toISOString()
    });
    if (submissionDetail) dbStore.attachEssayGradingToSubmission(req.user.id, submissionDetail.submission.id, saved.grading.id, Number(req.body.revision_no) || submissionDetail.submission.current_version);
    notifyUnifiedActivation(saved.referral_reward, req.user, '英语作文批改');
    res.json({ ok: true, duplicate: !!saved.duplicate, result: resultText, structured, model: graded.model, balance: saved.balance, grading_id: saved.grading.id });
  } catch (e) {
    if (e.code === 'ESSAY_POINTS_EXHAUSTED' || e.code === 'SHIXING_POINTS_EXHAUSTED') return res.status(402).json({ error: '师行积分不足，本次英语作文批改需要 ' + POINT_COSTS.english + ' 积分', balance: dbStore.getShixingPointBalance(req.user.id) });
    console.log('[ENGLISH] grade failed:', e.message);
    res.status(502).json({ error: '批改失败，本次不扣积分：' + e.message });
  }
});
}

module.exports = {
  installEnglishRoutes,
};
