'use strict';

function installLearningRoutes(app) {
// 学习助手路由：生成 / 打卡 / 金句本 / OCR / 次数包。
// @WIRE
const {
  essayAIConfigured, learningGenerateAI, qwenOcrImage
} = require('./ai-engines');
const {
  buildLearningItems, buildPolishRetryUserPrompt, cleanLearningText, learningMinWordCountForGrade, learningToolPrompt, polishNeedsRetry
} = require('./learning-tools');
const {
  learningUsageAllowed, requireLearningMember, userAuth
} = require('./middleware');
const {
  createPaymentOrderNo, extractPayUrl, getLearningBaseUrl, getLearningPackage, moneyDisplay, yungouConfigured, yungouRequest, yungouSign
} = require('./payment-engine');
const {
  LEARNING_PACKAGES, QWEN_API_KEY, YUNGOU_MCH_ID, YUNGOU_PAY_KEY
} = require('./platform-config');
const state = require('./state');

// ---------- 学生作文学习助手 API ----------

app.get('/api/learning/config', userAuth, (req, res) => {
  const membership = dbStore.getLearningMembershipStatus(req.user);
  res.json({
    ok: true,
    enabled: essayAIConfigured(),
    ocr_enabled: !!QWEN_API_KEY,
    membership,
    growth: dbStore.getLearningGrowth(req.user),
    packages: Object.values(LEARNING_PACKAGES).map(p => ({ key: p.key, label: p.label, days: p.days, amount: moneyDisplay(p.amount) }))
  });
});

app.post('/api/learning/generate', userAuth, requireLearningMember, async (req, res) => {
  const tool = String(req.body.tool || '').trim();
  const input = String(req.body.input || '').trim().slice(0, 6000);
  const grade = String(req.body.grade || '').trim().slice(0, 10);
  const prompt = input ? learningToolPrompt(tool, input, { grade }) : null;
  if (!prompt) return res.status(400).json({ error: '学习内容不完整或工具类型无效' });
  if (!learningUsageAllowed(req.user.id)) return res.status(429).json({ error: '今日使用较多，请明天再继续学习' });
  try {
    const user = (grade ? '学生年级：' + grade + '\n' : '') + input;
    let raw = await learningGenerateAI(prompt.system, user);
    let result = cleanLearningText(raw);
    if (!result) throw new Error('生成内容为空');
    if (tool === 'polish') {
      const minWordCount = learningMinWordCountForGrade(grade);
      if (polishNeedsRetry(result, grade)) {
        const retryUser = buildPolishRetryUserPrompt(user, result, minWordCount);
        raw = await learningGenerateAI(prompt.system, retryUser, 1.1);
        result = cleanLearningText(raw);
        if (!result) throw new Error('生成内容为空');
        if (polishNeedsRetry(result, grade)) throw new Error('润色结果未达到最低字数要求');
      }
    }
    const items = buildLearningItems(tool, input, raw);
    dbStore.insertLearningUsage(req.user.id, tool);
    const title = input.split('\n')[0].slice(0, 40);
    dbStore.insertLearningHistory(req.user.id, { tool_key: tool, title, input, result });
    res.json({ ok: true, result, items, growth: dbStore.getLearningGrowth(req.user) });
  } catch (e) {
    console.log('[LEARNING] generate failed:', e.message);
    res.status(502).json({ error: '生成失败，请稍后重试' });
  }
});

// ---------- 个人中心：打卡 / 金句本 / 历史 ----------
app.post('/api/learning/checkin', userAuth, (req, res) => {
  const fresh = dbStore.recordLearningCheckin(req.user.id);
  res.json({ ok: true, checkedIn: fresh, growth: dbStore.getLearningGrowth(req.user) });
});

app.get('/api/learning/saved', userAuth, (req, res) => {
  res.json({ ok: true, items: dbStore.listLearningSaved(req.user.id, req.query.type) });
});

app.post('/api/learning/saved', userAuth, (req, res) => {
  const content = String(req.body.content || '').trim().slice(0, 8000);
  if (!content) return res.status(400).json({ error: '收藏内容不能为空' });
  const item = dbStore.addLearningSaved(req.user.id, { type: req.body.type, title: req.body.title, content });
  res.json({ ok: true, item, growth: dbStore.getLearningGrowth(req.user) });
});

app.delete('/api/learning/saved/:id', userAuth, (req, res) => {
  const ok = dbStore.deleteLearningSaved(req.user.id, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: '该收藏不存在' });
  res.json({ ok: true, growth: dbStore.getLearningGrowth(req.user) });
});

app.get('/api/learning/history', userAuth, (req, res) => {
  res.json({ ok: true, items: dbStore.listLearningHistory(req.user.id, req.query.limit) });
});

app.post('/api/learning/ocr', userAuth, requireLearningMember, async (req, res) => {
  const image = String(req.body.image || '');
  if (!QWEN_API_KEY) return res.status(503).json({ error: '识别服务暂未配置' });
  if (!image.startsWith('data:image/') || image.length > 8 * 1024 * 1024) return res.status(400).json({ error: '图片格式不正确或过大' });
  if (!learningUsageAllowed(req.user.id)) return res.status(429).json({ error: '今日使用较多，请明天再继续学习' });
  try {
    const text = await qwenOcrImage(image);
    dbStore.insertLearningUsage(req.user.id, 'ocr');
    res.json({ ok: true, text });
  } catch (e) {
    console.log('[LEARNING] ocr failed:', e.message);
    res.status(502).json({ error: '识别失败，请稍后重试' });
  }
});

app.post('/api/learning/payments/package', userAuth, async (req, res) => {
  if (!yungouConfigured()) return res.status(503).json({ error: '微信支付暂未配置，请联系管理员' });
  const pkg = getLearningPackage(req.body.package_key);
  if (!pkg) return res.status(400).json({ error: '套餐不存在' });
  const outTradeNo = createPaymentOrderNo('XL');
  const amount = moneyDisplay(pkg.amount);
  const payment = { out_trade_no: outTradeNo, user_id: req.user.id, username: req.user.username, plan: pkg.key, plan_days: pkg.days, credits: 0, amount, status: 'created', created_at: new Date().toISOString() };
  state.state.store.payments.push(payment);
  dbStore.upsertPayment(payment);
  const required = { out_trade_no: outTradeNo, total_fee: amount, mch_id: YUNGOU_MCH_ID, body: '师行作文学习助手' + pkg.label };
  try {
    const result = await yungouRequest('POST', '/api/pay/wxpay/cashierPay', { ...required, sign: yungouSign(required, YUNGOU_PAY_KEY), attach: req.user.id, notify_url: getLearningBaseUrl(req) + '/api/payments/yungou/notify', return_url: getLearningBaseUrl(req) + '/?pay_order=' + encodeURIComponent(outTradeNo), auto: '0' });
    const payUrl = result && result.code === 0 && extractPayUrl(result.data);
    if (!payUrl) throw new Error('支付链接为空');
    payment.status = 'pending'; dbStore.upsertPayment(payment);
    res.json({ ok: true, out_trade_no: outTradeNo, amount, plan_label: pkg.label, pay_url: payUrl });
  } catch (e) {
    payment.status = 'create_failed'; dbStore.upsertPayment(payment);
    res.status(502).json({ error: '创建支付订单失败' });
  }
});

// ---------- 英语作文批改 API ----------
}

module.exports = { installLearningRoutes };
