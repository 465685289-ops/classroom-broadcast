'use strict';

function installRoundtableRoutes(app) {
// 英语作文批改路由：班级 / 题目 / 批改 / 分享页。
// @WIRE
const dbStore = require('./db');
const {
  deepseekChatStream
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
  createPaymentOrderNo, extractPayUrl, getPointPackage, getRoundtableBaseUrl, moneyDisplay, publicRoundtablePackages, yungouConfigured, yungouRequest, yungouSign
} = require('./payment-engine');
const {
  DEEPSEEK_API_KEY, DEEPSEEK_MODEL, ROUNDTABLE_CARD_ENABLED, ROUNDTABLE_SPEAK_CAP, YUNGOU_APP_ID, YUNGOU_MCH_ID, YUNGOU_PAY_KEY
} = require('./platform-config');
const {
  POINT_COSTS
} = require('./shixing-points');
const state = require('./state');

app.get('/api/roundtable/config', userAuth, (req, res) => {
  const balance = dbStore.getShixingPointBalance(req.user.id);
  res.json({
    ok: true,
    enabled: !!DEEPSEEK_API_KEY,
    pay_enabled: yungouConfigured(),
    card_enabled: ROUNDTABLE_CARD_ENABLED,
    balance,
    point_balance: balance,
    point_cost: POINT_COSTS.roundtable,
    first_topup_available: !dbStore.hasShixingPointTopup(req.user.id),
    packages: publicRoundtablePackages(req.user.id),
    username: req.user.username,
    display_name: req.user.display_name || req.user.username
  });
});

app.get('/api/roundtable/history', userAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  res.json({
    ok: true,
    balance: dbStore.getRoundtableCreditBalance(req.user.id),
    generations: dbStore.listRoundtableGenerations(req.user.id, limit),
    ledger: dbStore.listRoundtableCreditLedger(req.user.id, 30)
  });
});

// 开一个新话题：扣 1 次
app.post('/api/roundtable/start', userAuth, (req, res) => {
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: 'AI 服务暂未配置，请联系管理员' });
  const topic = String(req.body.topic || '').trim().slice(0, 2000);
  if (topic.length < 2) return res.status(400).json({ error: '请输入话题' });
  const atTargets = String(req.body.at_targets || '').slice(0, 200);
  try {
    const r = dbStore.startRoundtableGeneration({
      user_id: req.user.id, username: req.user.username,
      topic, at_targets: atTargets, model: DEEPSEEK_MODEL,
      device_hash: deviceHashFromReq(req)
    });
    notifyUnifiedActivation(r.referral_reward, req.user, '思想圆桌');
    res.json({
      ok: true,
      generation_id: r.generation_id,
      balance: r.balance,
      referral_reward: r.referral_reward && !r.referral_reward.duplicate ? {
        status: r.referral_reward.status,
        invitee_reward_points: r.referral_reward.invitee_reward_points,
        risk_reason: r.referral_reward.risk_reason || ''
      } : null
    });
  } catch (e) {
    if (e.code === 'ROUNDTABLE_CREDITS_EXHAUSTED') {
      return res.status(402).json({ error: '师行积分不足，本话题需要 ' + POINT_COSTS.roundtable + ' 积分', balance: dbStore.getShixingPointBalance(req.user.id) });
    }
    res.status(500).json({ error: '创建话题失败：' + e.message });
  }
});

// 单个角色发言：流式转发 DeepSeek（同一话题内不额外扣费）
app.post('/api/roundtable/speak', userAuth, async (req, res) => {
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: 'AI 服务暂未配置' });
  const genId = parseInt(req.body.generation_id, 10);
  const messages = Array.isArray(req.body.messages) ? req.body.messages : null;
  if (!genId || !messages || !messages.length) return res.status(400).json({ error: '参数错误' });
  if (JSON.stringify(messages).length > 60000) return res.status(413).json({ error: '上下文过长' });
  try {
    dbStore.touchRoundtableGeneration(genId, req.user.id, ROUNDTABLE_SPEAK_CAP);
  } catch (e) {
    const map = { GEN_NOT_FOUND: 404, GEN_EXPIRED: 410, GEN_LIMIT: 429 };
    return res.status(map[e.code] || 400).json({ error: e.message });
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  const temp = parseFloat(req.body.temperature);
  try {
    await deepseekChatStream(messages, {
      temperature: isNaN(temp) ? 0.85 : Math.max(0, Math.min(1.2, temp)),
      max_tokens: Math.min(parseInt(req.body.max_tokens, 10) || 800, 1200)
    }, res);
    res.end();
  } catch (e) {
    try { res.write('data: ' + JSON.stringify({ error: e.message }) + '\n\n'); } catch (_) {}
    res.end();
  }
});

// 一轮讨论结束后保存完整对话实录（供后台查看）
app.post('/api/roundtable/finish', userAuth, (req, res) => {
  const genId = parseInt(req.body.generation_id, 10);
  const transcript = Array.isArray(req.body.transcript) ? req.body.transcript : [];
  if (!genId) return res.status(400).json({ error: '参数错误' });
  try {
    dbStore.saveRoundtableTranscript(genId, req.user.id, transcript.slice(0, 60));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/roundtable/payments/package', userAuth, async (req, res) => {
  if (!yungouConfigured()) return res.status(503).json({ error: '微信支付暂未配置，请联系管理员' });
  const pkg = getPointPackage(req.body.package_key);
  if (!pkg) return res.status(400).json({ error: '积分套餐不存在' });
  const outTradeNo = createPaymentOrderNo('RT');
  const amount = moneyDisplay(pkg.amount);
  const baseUrl = getRoundtableBaseUrl(req);
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
    source_product: 'roundtable'
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
    return_url: baseUrl + '/?pay_order=' + encodeURIComponent(outTradeNo),
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
    res.json({ ok: true, out_trade_no: outTradeNo, amount, credits: pkg.points, points: pkg.points, pay_url: payUrl });
  } catch (e) {
    payment.status = 'create_failed';
    payment.error = e.message;
    dbStore.upsertPayment(payment);
    res.status(502).json({ error: '创建支付订单失败：' + e.message });
  }
});

app.post('/api/roundtable/redeem', userAuth, (req, res) => {
  if (!ROUNDTABLE_CARD_ENABLED) return res.status(403).json({ error: '卡密兑换通道已关闭' });
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '请输入卡密' });
  if (!/^ROUND-\d+-[A-Z0-9]+$/.test(code)) return res.status(400).json({ error: '卡密格式错误，正确格式如：ROUND-60-ABCD2345' });
  try {
    const result = dbStore.redeemRoundtableCard(code, req.user);
    res.json({ ok: true, credits: result.credits, points: result.points, balance: result.balance });
  } catch (e) {
    if (e.code === 'CARD_NOT_FOUND') return res.status(404).json({ error: e.message });
    if (e.code === 'CARD_USED') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: '兑换失败：' + e.message });
  }
});
}

module.exports = {
  installRoundtableRoutes,
};
