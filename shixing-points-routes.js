'use strict';

const dbStore = require('./db');
const { safeEqual } = require('./auth-core');
const { userAuth } = require('./middleware');
const {
  createPaymentOrderNo,
  extractPayUrl,
  getBaseUrl,
  getPointPackage,
  moneyDisplay,
  publicPointPackages,
  yungouConfigured,
  yungouRequest,
  yungouSign
} = require('./payment-engine');
const {
  PUBLIC_BASE_URL,
  WORKBENCH_POINTS_SECRET,
  YUNGOU_APP_ID,
  YUNGOU_MCH_ID,
  YUNGOU_PAY_KEY
} = require('./platform-config');
const { POINT_COSTS } = require('./shixing-points');
const state = require('./state');

function serviceSecretValid(req) {
  const supplied = String(req.headers['x-workbench-points-secret'] || '');
  return Boolean(WORKBENCH_POINTS_SECRET && supplied && safeEqual(supplied, WORKBENCH_POINTS_SECRET));
}

function installShixingPointsRoutes(app) {
  app.get('/api/points/config', userAuth, (req, res) => {
    const balance = dbStore.getShixingPointBalance(req.user.id);
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      payment_enabled: yungouConfigured(),
      balance,
      point_balance: balance,
      point_costs: { family_message: POINT_COSTS.family_message },
      first_topup_available: !dbStore.hasShixingPointTopup(req.user.id),
      packages: publicPointPackages(req.user.id),
      ledger: dbStore.listShixingPointLedger(req.user.id, 30)
    });
  });

  app.post('/api/points/payments/package', userAuth, async (req, res) => {
    if (!yungouConfigured()) return res.status(503).json({ error: '微信支付暂未配置，请联系管理员' });
    const pkg = getPointPackage(req.body.package_key);
    if (!pkg) return res.status(400).json({ error: '积分套餐不存在' });

    const outTradeNo = createPaymentOrderNo('WB');
    const amount = moneyDisplay(pkg.amount);
    const baseUrl = PUBLIC_BASE_URL || getBaseUrl(req);
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
      source_product: 'workbench'
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
      return_url: baseUrl + '/student-growth/?page=family&points_order=' + encodeURIComponent(outTradeNo),
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
      res.json({ ok: true, out_trade_no: outTradeNo, amount, points: pkg.points, pay_url: payUrl });
    } catch (error) {
      payment.status = 'create_failed';
      payment.error = error.message;
      dbStore.upsertPayment(payment);
      res.status(502).json({ error: '创建支付订单失败' });
    }
  });

  app.post('/api/points/consume', userAuth, (req, res) => {
    if (!serviceSecretValid(req)) return res.status(403).json({ error: '不允许的积分操作' });
    const operationId = String(req.body.operation_id || '').trim();
    const product = String(req.body.product || '').trim();
    if (product !== 'family_message') return res.status(400).json({ error: '不支持的积分用途' });
    if (!/^[A-Za-z0-9_-]{12,100}$/.test(operationId)) return res.status(400).json({ error: '扣分操作号无效' });
    try {
      const result = dbStore.consumeShixingPoints({
        user_id: req.user.id,
        username: req.user.username,
        operation_id: operationId,
        product,
        note: '家校沟通建议生成'
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (error.code === 'SHIXING_POINTS_EXHAUSTED') {
        return res.status(402).json({ error: '师行积分不足，本次需要 ' + POINT_COSTS.family_message + ' 积分', balance: error.balance });
      }
      if (/操作号已被/.test(error.message)) return res.status(409).json({ error: error.message });
      res.status(400).json({ error: error.message || '积分扣除失败' });
    }
  });
}

module.exports = { installShixingPointsRoutes, serviceSecretValid };
