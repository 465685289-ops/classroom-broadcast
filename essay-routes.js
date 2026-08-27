'use strict';

function installEssayRoutes(app) {
// 英语作文批改路由：班级 / 题目 / 批改 / 分享页。
// @WIRE
const dbStore = require('./db');
const {
  buildEssayPrompt, ESSAY_GENRES, ESSAY_GRADE_LEVELS, ESSAY_SCORE_TYPES, essayAIConfigured, essayDataToLegacyText, essayOcrAllowed, extractEssayJson, gradeEssayAI, normalizeEssayData, qwenOcrImage
} = require('./ai-engines');
const {
  deviceHashFromReq
} = require('./http-utils');
const {
  createUserMessage, notifyUnifiedActivation
} = require('./messaging-referrals');
const {
  userAuth
} = require('./middleware');
const {
  createPaymentOrderNo, extractPayUrl, getEssayBaseUrl, getEssayPackage, getEssayTimePackage, getPointPackage, moneyDisplay, publicPointPackages, yungouConfigured, yungouRequest, yungouSign
} = require('./payment-engine');
const {
  ESSAY_CARD_ENABLED, ESSAY_PAY_MAX, ESSAY_REFERRAL_GRADING_REWARD, ESSAY_REFERRAL_GRADING_THRESHOLD, ESSAY_REFERRAL_PURCHASE_REWARD, FREE_ESSAY_CREDITS, QWEN_API_KEY, YUNGOU_APP_ID, YUNGOU_MCH_ID, YUNGOU_PAY_KEY
} = require('./platform-config');
const {
  POINT_COSTS
} = require('./shixing-points');
const state = require('./state');

// ---------- 作文批改 API ----------
function essayShareUrl(token) {
  return 'https://zuowen.yingyuzuowen.asia/essay/revise/' + encodeURIComponent(token);
}

app.get('/api/essay/classes', userAuth, (req, res) => {
  res.json({ ok: true, classes: dbStore.listEssayClasses(req.user.id, req.query.archived === '1') });
});

app.post('/api/essay/classes', userAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请输入班级名称' });
  const item = dbStore.createEssayClass({ user_id: req.user.id, name, grade: req.body.grade, school_year: req.body.school_year });
  res.json({ ok: true, class: item });
});

app.patch('/api/essay/classes/:id', userAuth, (req, res) => {
  const item = dbStore.updateEssayClass(req.user.id, req.params.id, req.body || {});
  if (!item) return res.status(404).json({ error: '班级不存在' });
  res.json({ ok: true, class: item });
});

app.get('/api/essay/classes/:id/students', userAuth, (req, res) => {
  if (!dbStore.listEssayClasses(req.user.id, true).some(x => x.id === req.params.id)) return res.status(404).json({ error: '班级不存在' });
  res.json({ ok: true, students: dbStore.listEssayStudents(req.user.id, req.params.id, req.query.archived === '1') });
});

app.post('/api/essay/classes/:id/students', userAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请输入学生姓名' });
  const student = dbStore.createEssayStudent({ user_id: req.user.id, class_id: req.params.id, name, student_no: req.body.student_no });
  if (!student) return res.status(404).json({ error: '班级不存在' });
  res.json({ ok: true, student });
});

app.patch('/api/essay/students/:id', userAuth, (req, res) => {
  const student = dbStore.updateEssayStudent(req.user.id, req.params.id, req.body || {});
  if (!student) return res.status(404).json({ error: '学生不存在' });
  res.json({ ok: true, student });
});

app.get('/api/essay/rubrics', userAuth, (req, res) => res.json({ ok: true, rubrics: dbStore.listEssayRubrics(req.user.id) }));

app.post('/api/essay/rubrics', userAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const dimensions = Array.isArray(req.body.dimensions) ? req.body.dimensions : [];
  const sum = dimensions.reduce((n, d) => n + (Number(d && d.weight) || 0), 0);
  if (!name || !dimensions.length) return res.status(400).json({ error: '请填写模板名称和评分维度' });
  if (Math.round(sum) !== 100) return res.status(400).json({ error: '评分权重合计必须为100%' });
  const rubric = dbStore.saveEssayRubric({ user_id: req.user.id, name, dimensions });
  res.json({ ok: true, rubric });
});

app.get('/api/essay/assignments', userAuth, (req, res) => {
  res.json({ ok: true, assignments: dbStore.listEssayAssignments(req.user.id, String(req.query.class_id || ''), req.query.archived === '1') });
});

app.post('/api/essay/assignments', userAuth, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: '请输入作文题目' });
  const assignment = dbStore.createEssayAssignment({ user_id: req.user.id, ...req.body, title });
  if (!assignment) return res.status(404).json({ error: '班级或量规模板不存在' });
  res.json({ ok: true, assignment });
});

app.patch('/api/essay/assignments/:id', userAuth, (req, res) => {
  const assignment = dbStore.updateEssayAssignment(req.user.id, req.params.id, req.body || {});
  if (!assignment) return res.status(404).json({ error: '作业不存在' });
  res.json({ ok: true, assignment });
});

app.post('/api/essay/assignments/:id/copy', userAuth, (req, res) => {
  const source = dbStore.getEssayAssignment(req.user.id, req.params.id);
  if (!source) return res.status(404).json({ error: '作业不存在' });
  const assignment = dbStore.createEssayAssignment({ ...source, id: undefined, user_id: req.user.id, title: String(req.body.title || source.title + '（副本）'), status: 'active', archived: false, dimensions: source.rubric.dimensions });
  res.json({ ok: true, assignment });
});

app.post('/api/essay/submissions', userAuth, (req, res) => {
  const submission = dbStore.createEssaySubmission({ user_id: req.user.id, assignment_id: req.body.assignment_id, student_id: req.body.student_id, student_name: req.body.student_name, essay_text: req.body.essay_text });
  if (!submission) return res.status(400).json({ error: '作业、学生或作文内容无效' });
  res.json({ ok: true, submission: { ...submission, share_url: essayShareUrl(submission.share_token) } });
});

app.get('/api/essay/submissions/:id', userAuth, (req, res) => {
  const detail = dbStore.getEssaySubmission(req.user.id, req.params.id);
  if (!detail) return res.status(404).json({ error: '作文记录不存在' });
  detail.submission.share_url = essayShareUrl(detail.submission.share_token);
  res.json({ ok: true, ...detail });
});

app.patch('/api/essay/submissions/:id', userAuth, (req, res) => {
  const detail = dbStore.updateEssaySubmission(req.user.id, req.params.id, req.body || {});
  if (!detail) return res.status(404).json({ error: '作文记录不存在' });
  res.json({ ok: true, ...detail });
});

app.delete('/api/essay/submissions/:id', userAuth, (req, res) => {
  if (!dbStore.deleteEssaySubmission(req.user.id, req.params.id)) return res.status(404).json({ error: '作文记录不存在' });
  res.json({ ok: true });
});

app.patch('/api/essay/gradings/:id', userAuth, (req, res) => {
  const grading = dbStore.updateEssayGradingRecord(req.user.id, Number(req.params.id), req.body || {});
  if (!grading) return res.status(404).json({ error: '历史批改不存在' });
  res.json({ ok: true, grading });
});

app.delete('/api/essay/gradings/:id', userAuth, (req, res) => {
  if (!dbStore.deleteEssayGradingRecord(req.user.id, Number(req.params.id))) return res.status(404).json({ error: '历史批改不存在' });
  res.json({ ok: true });
});

app.put('/api/essay/submissions/:id/review', userAuth, (req, res) => {
  const review = dbStore.saveEssayReview({ user_id: req.user.id, submission_id: req.params.id, grading_id: req.body.grading_id, status: req.body.status, score_override: req.body.score_override, summary_override: req.body.summary_override, annotations: req.body.annotations });
  if (!review) return res.status(404).json({ error: '作文记录不存在' });
  const detail = dbStore.getEssaySubmission(req.user.id, req.params.id);
  res.json({ ok: true, review, submission: { ...detail.submission, share_url: essayShareUrl(detail.submission.share_token) } });
});

app.get('/api/essay/workflow/history', userAuth, (req, res) => {
  res.json({ ok: true, ...dbStore.listEssayWorkflowHistory(req.user.id, req.query || {}) });
});

app.get('/api/essay/assignments/:id/report', userAuth, (req, res) => {
  const report = dbStore.getEssayAssignmentReport(req.user.id, req.params.id);
  if (!report) return res.status(404).json({ error: '作业不存在' });
  res.json({ ok: true, report });
});

app.get('/api/essay/public/:token', (req, res) => {
  const detail = dbStore.getEssaySubmissionByShareToken(req.params.token);
  if (!detail) return res.status(404).json({ error: '链接无效或已失效' });
  res.json({ ok: true, assignment: detail.assignment, student: detail.student ? { name: detail.student.name } : { name: detail.submission.student_name }, submission: { status: detail.submission.status, current_version: detail.submission.current_version }, revisions: detail.revisions, review: detail.review && detail.review.status === 'finalized' ? detail.review : null });
});

app.post('/api/essay/public/:token/revisions', (req, res) => {
  const result = dbStore.addEssayRevisionByToken(req.params.token, req.body.essay_text);
  if (!result) return res.status(404).json({ error: '链接无效或已失效' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, revision: result });
});

app.get('/api/essay/config', userAuth, (req, res) => {
  const plan = dbStore.getActiveEssayPlan(req.user.id);
  const pointBalance = dbStore.getShixingPointBalance(req.user.id);
  res.json({
    ok: true,
    enabled: essayAIConfigured(),
    ocr_enabled: !!QWEN_API_KEY,
    pay_enabled: yungouConfigured(),
    card_enabled: false,
    free_credits: 0,
    signup_bonus_points: FREE_ESSAY_CREDITS * POINT_COSTS.essay,
    balance: pointBalance,
    point_balance: pointBalance,
    point_cost: POINT_COSTS.essay,
    first_topup_available: !dbStore.hasShixingPointTopup(req.user.id),
    packages: publicPointPackages(req.user.id),
    time_packages: [],
    plan: plan ? {
      label: plan.plan_label,
      expires_at: plan.expires_at,
      daily_limit: plan.daily_limit,
      daily_used: dbStore.countEssayGradingsToday(req.user.id)
    } : null,
    referral: {
      code: req.user.teacher_code,
      grading_threshold: ESSAY_REFERRAL_GRADING_THRESHOLD,
      grading_reward: ESSAY_REFERRAL_GRADING_REWARD,
      purchase_reward: ESSAY_REFERRAL_PURCHASE_REWARD
    }
  });
});

app.get('/api/essay/referral', userAuth, (req, res) => {
  const invitees = dbStore.listEssayReferralsByInviter(req.user.id, 100);
  let earned = 0;
  invitees.forEach(i => {
    if (i.grading_rewarded) earned += ESSAY_REFERRAL_GRADING_REWARD;
    if (i.purchase_rewarded) earned += ESSAY_REFERRAL_PURCHASE_REWARD;
  });
  res.json({
    ok: true,
    code: req.user.teacher_code,
    link: getEssayBaseUrl(req) + '/?ref=' + encodeURIComponent(req.user.teacher_code),
    invitees,
    invited_count: invitees.length,
    earned_credits: earned,
    earned_points: earned * POINT_COSTS.essay,
    grading_threshold: ESSAY_REFERRAL_GRADING_THRESHOLD,
    grading_reward: ESSAY_REFERRAL_GRADING_REWARD,
    grading_reward_points: ESSAY_REFERRAL_GRADING_REWARD * POINT_COSTS.essay,
    purchase_reward: ESSAY_REFERRAL_PURCHASE_REWARD,
    purchase_reward_points: ESSAY_REFERRAL_PURCHASE_REWARD * POINT_COSTS.essay
  });
});

app.get('/api/essay/history', userAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  res.json({
    ok: true,
    balance: dbStore.getShixingPointBalance(req.user.id),
    gradings: dbStore.listEssayGradings(req.user.id, limit),
    ledger: dbStore.listShixingPointLedger(req.user.id, 30)
  });
});

// 学生进步曲线：取该学生历次批改的总分（百分制），按时间正序
app.get('/api/essay/trend', userAuth, (req, res) => {
  const studentId = String(req.query.student_id || '').trim();
  if (studentId) return res.json({ ok: true, points: dbStore.getEssayStudentTrend(req.user.id, studentId), students: [] });
  const name = String(req.query.student_name || '').trim();
  const all = dbStore.listEssayGradings(req.user.id, 300);
  // 有结构化分数的记录里，按学生名归集（不填名字的归一类）
  const points = all
    .filter(g => g.essay && typeof g.essay.total_100 === 'number')
    .filter(g => name ? (g.student_name || '') === name : true)
    .map(g => ({
      score: g.essay.total_100,
      label: (g.created_at || '').slice(5, 10).replace('-', '/'),
      created_at: g.created_at,
      student_name: g.student_name || ''
    }))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  // 候选学生名列表（有结构化分数的）
  const students = [...new Set(all.filter(g => g.essay && typeof g.essay.total_100 === 'number' && g.student_name).map(g => g.student_name))];
  res.json({ ok: true, points, students });
});

app.post('/api/essay/ocr', userAuth, async (req, res) => {
  if (!QWEN_API_KEY) {
    return res.status(503).json({ error: 'OCR 服务暂未配置，请联系管理员' });
  }
  const image = String(req.body.image || '');
  if (!image.startsWith('data:image/')) {
    return res.status(400).json({ error: '图片格式不正确' });
  }
  if (image.length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: '图片过大，请压缩后重试' });
  }
  if (!essayOcrAllowed(req.user.id)) {
    return res.status(429).json({ error: '今日 OCR 识别次数已达上限，请明天再试' });
  }
  try {
    const text = await qwenOcrImage(image);
    res.json({ ok: true, text });
  } catch (e) {
    console.log('[ESSAY] ocr failed:', e.message);
    res.status(502).json({ error: '识别失败：' + e.message });
  }
});

app.post('/api/essay/grade', userAuth, async (req, res) => {
  if (!essayAIConfigured()) {
    return res.status(503).json({ error: 'AI 批改服务暂未配置，请联系管理员' });
  }
  // 会员卡优先：有效期内且未到当日上限，不扣次数
  const plan = dbStore.getActiveEssayPlan(req.user.id);
  let usePlan = false;
  if (plan) {
    const todayCount = dbStore.countEssayGradingsToday(req.user.id);
    if (todayCount < plan.daily_limit) usePlan = true;
  }
  const balance = dbStore.getShixingPointBalance(req.user.id);
  if (!usePlan && balance < POINT_COSTS.essay) {
    if (plan) {
      return res.status(402).json({ error: '今日会员额度已用完，本次批改需要 ' + POINT_COSTS.essay + ' 师行积分', balance });
    }
    return res.status(402).json({ error: '师行积分不足，本次作文批改需要 ' + POINT_COSTS.essay + ' 积分', balance });
  }
  const essayText = String(req.body.essay_text || '').trim().slice(0, 6000);
  if (essayText.length < 30) {
    return res.status(400).json({ error: '作文内容过短，无法批改' });
  }
  const genre = ESSAY_GENRES.includes(req.body.genre) ? req.body.genre : '记叙文';
  const gradeLevel = ESSAY_GRADE_LEVELS.includes(req.body.grade_level) ? req.body.grade_level : '初二';
  const scoreType = ESSAY_SCORE_TYPES.includes(req.body.score_type) ? req.body.score_type : '百分制';
  const studentName = String(req.body.student_name || '').trim().slice(0, 30);
  const assignment = req.body.assignment_id ? dbStore.getEssayAssignment(req.user.id, String(req.body.assignment_id)) : null;
  if (req.body.assignment_id && !assignment) return res.status(404).json({ error: '作文作业不存在' });
  const submissionDetail = req.body.submission_id ? dbStore.getEssaySubmission(req.user.id, String(req.body.submission_id)) : null;
  if (req.body.submission_id && !submissionDetail) return res.status(404).json({ error: '学生作文记录不存在' });
  try {
    const prompt = buildEssayPrompt(essayText, genre, gradeLevel, scoreType, assignment);
    const graded = await gradeEssayAI(prompt);
    // 尝试解析结构化 JSON：成功则存结构化数据 + 兼容旧文本；失败则回退纯文本旧逻辑
    const structured = normalizeEssayData(extractEssayJson(graded.result));
    const resultText = structured ? essayDataToLegacyText(structured) : graded.result;
    const saved = dbStore.insertEssayGradingAndDebit({
      user_id: req.user.id,
      username: req.user.username,
      student_name: studentName,
      genre,
      grade_level: gradeLevel,
      score_type: scoreType,
      essay_text: essayText,
      result: resultText,
      model: graded.model,
      extra_json: structured ? { essay: structured } : null,
      skip_debit: usePlan,
      device_hash: deviceHashFromReq(req),
      created_at: new Date().toISOString()
    });
    if (submissionDetail) {
      dbStore.attachEssayGradingToSubmission(req.user.id, submissionDetail.submission.id, saved.grading.id, Number(req.body.revision_no) || submissionDetail.submission.current_version);
    }
    notifyUnifiedActivation(saved.referral_reward, req.user, '作文批改');
    // 邀请奖励：被邀请人累计完成3次批改，给邀请人发奖励（只发一次）
    try {
      const ref = dbStore.getUnifiedReferralByInvitee(req.user.id) ? null : dbStore.getEssayReferral(req.user.id);
      if (ref && !ref.grading_rewarded_at && dbStore.countEssayGradings(req.user.id) >= ESSAY_REFERRAL_GRADING_THRESHOLD) {
        const r = dbStore.rewardEssayReferralGrading(req.user.id, ESSAY_REFERRAL_GRADING_REWARD);
        if (r) {
          createUserMessage(
            r.inviter_user_id,
            'essay-referral',
            '邀请奖励到账',
            '你邀请的好友 ' + (r.invitee_username || req.user.username) + ' 已完成 ' + ESSAY_REFERRAL_GRADING_THRESHOLD + ' 次批改，奖励 ' + r.points + ' 师行积分已到账，当前余额 ' + r.balance + ' 积分。',
            {}
          );
        }
      }
    } catch (e) {
      console.log('[ESSAY] referral grading reward failed:', e.message);
    }
    res.json({
      ok: true,
      result: resultText,
      structured: structured || null,
      model: graded.model,
      balance: saved.balance,
      used_plan: usePlan,
      plan: plan ? { label: plan.plan_label, expires_at: plan.expires_at, daily_limit: plan.daily_limit, daily_used: dbStore.countEssayGradingsToday(req.user.id) } : null,
      grading_id: saved.grading.id,
      referral_reward: saved.referral_reward && !saved.referral_reward.duplicate ? {
        status: saved.referral_reward.status,
        invitee_reward_points: saved.referral_reward.invitee_reward_points,
        risk_reason: saved.referral_reward.risk_reason || ''
      } : null
    });
  } catch (e) {
    if (e.code === 'ESSAY_POINTS_EXHAUSTED' || e.code === 'SHIXING_POINTS_EXHAUSTED') {
      return res.status(402).json({ error: '师行积分不足，本次作文批改需要 ' + POINT_COSTS.essay + ' 积分', balance: dbStore.getShixingPointBalance(req.user.id) });
    }
    console.log('[ESSAY] grade failed:', e.message);
    res.status(502).json({ error: '批改失败：' + e.message });
  }
});

app.post('/api/essay/payments/package', userAuth, async (req, res) => {
  if (!yungouConfigured()) {
    return res.status(503).json({ error: '微信支付暂未配置，请联系管理员' });
  }
  const pointPkg = getPointPackage(req.body.package_key);
  const countPkg = pointPkg ? null : getEssayPackage(req.body.package_key);
  const timePkg = pointPkg || countPkg ? null : getEssayTimePackage(req.body.package_key);
  const pkg = pointPkg || countPkg || timePkg;
  if (!pkg) return res.status(400).json({ error: '套餐不存在' });
  if (!pointPkg && parseFloat(pkg.amount) > ESSAY_PAY_MAX) {
    return res.status(400).json({ error: '该套餐暂未开放微信支付，请通过闲鱼卡密购买' });
  }

  const outTradeNo = createPaymentOrderNo('ZW');
  const amount = moneyDisplay(pkg.amount);
  const baseUrl = getEssayBaseUrl(req);
  const payment = {
    out_trade_no: outTradeNo,
    user_id: req.user.id,
    username: req.user.username,
    plan: pkg.key,
    plan_days: timePkg ? timePkg.days : null,
    credits: pointPkg ? pointPkg.points : (countPkg ? countPkg.credits : 0),
    amount,
    status: 'created',
    created_at: new Date().toISOString(),
    source_product: pointPkg ? 'essay' : ''
  };
  state.store.payments.push(payment);
  dbStore.upsertPayment(payment);

  const requiredParams = {
    out_trade_no: outTradeNo,
    total_fee: amount,
    mch_id: YUNGOU_MCH_ID,
    body: pointPkg ? ('师行积分' + pointPkg.points) : (countPkg ? ('师行AI作文批改' + countPkg.credits + '次') : ('师行AI作文批改' + timePkg.label))
  };
  const params = {
    ...requiredParams,
    sign: yungouSign(requiredParams, YUNGOU_PAY_KEY),
    attach: req.user.id,
    notify_url: baseUrl + '/api/payments/yungou/notify',
    return_url: baseUrl + '/?pay_order=' + encodeURIComponent(outTradeNo),
    auto: '0'
  };
  if (YUNGOU_APP_ID) params.app_id = YUNGOU_APP_ID;

  try {
    const result = await yungouRequest('POST', '/api/pay/wxpay/cashierPay', params);
    payment.provider_response = result;
    if (!result || result.code !== 0) {
      payment.status = 'create_failed';
      payment.error = result && (result.msg || result.message) || '创建支付订单失败';
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
      credits: pointPkg ? pointPkg.points : (countPkg ? countPkg.credits : 0),
      points: pointPkg ? pointPkg.points : 0,
      plan_label: timePkg ? timePkg.label : '',
      pay_url: payUrl
    });
  } catch (e) {
    payment.status = 'create_failed';
    payment.error = e.message;
    dbStore.upsertPayment(payment);
    res.status(502).json({ error: '创建支付订单失败：' + e.message });
  }
});

app.post('/api/essay/redeem', userAuth, (req, res) => {
  if (!ESSAY_CARD_ENABLED) {
    return res.status(403).json({ error: '卡密兑换通道已关闭，请直接开通会员' });
  }
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '请输入卡密' });
  if (!/^ZUOWEN-\d+-[A-Z0-9]+$/.test(code)) {
    return res.status(400).json({ error: '卡密格式错误，正确格式如：ZUOWEN-50-ABCD2345' });
  }
  try {
    const result = dbStore.redeemEssayCard(code, req.user);
    res.json({ ok: true, credits: result.credits, balance: result.balance });
  } catch (e) {
    if (e.code === 'CARD_NOT_FOUND') return res.status(404).json({ error: e.message });
    if (e.code === 'CARD_USED') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: '兑换失败：' + e.message });
  }
});

// ==================== 思想圆桌 roundtable API ====================
}

module.exports = {
  installEssayRoutes,
};
