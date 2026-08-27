'use strict';
// 支付引擎：云狗网关客户端 / 套餐解析 / 回调验签 / 入账编排。
const https = require('https');
const dbStore = require('./db');
const { POINT_COSTS, POINT_PACKAGES } = require('./shixing-points');
const crypto = require('crypto');
// @WIRE
const {
  activateYearlyPlan, safeEqual
} = require('./auth-core');
const {
  notifyAdminPayment
} = require('./mail-center');
const {
  createUserMessage, rewardBroadcastReferralOnPurchase, rewardCommentReferralOnPurchase, rewardEssayReferralOnPurchase, rewardUnifiedPurchaseForPayment
} = require('./messaging-referrals');
const {
  COMMENT_BASE_URL, ESSAY_BASE_URL, ESSAY_PACKAGES, ESSAY_PAY_MAX, ESSAY_TIME_PACKAGES, LEARNING_BASE_URL, LEARNING_PACKAGES, LEGACY_COMMENT_PACKAGES, LEGACY_ROUNDTABLE_PACKAGES, PUBLIC_BASE_URL, ROUNDTABLE_BASE_URL, YEARLY_PLAN_PRICE, YUNGOU_API_HOST, YUNGOU_MCH_ID, YUNGOU_PAY_KEY
} = require('./platform-config');
const state = require('./state');

function yuanToCents(value) {
  return Math.round(parseFloat(value || '0') * 100);
}

function planPriceDisplay() {
  return (parseFloat(YEARLY_PLAN_PRICE) || 0).toFixed(2);
}

function moneyDisplay(value) {
  return (parseFloat(value || '0') || 0).toFixed(2);
}

function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return req.protocol + '://' + req.get('host');
}

function getCommentBaseUrl(req) {
  if (COMMENT_BASE_URL) return COMMENT_BASE_URL;
  return req.protocol + '://' + req.get('host');
}

function yungouConfigured() {
  return !!(YUNGOU_MCH_ID && YUNGOU_PAY_KEY);
}

function yungouSign(params, key) {
  const keys = Object.keys(params).sort();
  const parts = keys.map(k => k + '=' + params[k]);
  parts.push('key=' + key);
  return crypto.createHash('md5').update(parts.join('&')).digest('hex').toUpperCase();
}

function yungouRequest(method, apiPath, params) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(params).toString();
    const isGet = method === 'GET';
    const options = {
      hostname: YUNGOU_API_HOST,
      path: apiPath + (isGet ? '?' + query : ''),
      method,
      headers: {}
    };
    let body = '';
    if (!isGet) {
      body = query;
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(options, resp => {
      let raw = '';
      resp.on('data', chunk => raw += chunk);
      resp.on('end', () => {
        try {
          const data = JSON.parse(raw);
          resolve(data);
        } catch (e) {
          reject(new Error('云狗支付返回格式异常：' + raw.slice(0, 120)));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createPaymentOrderNo(prefix) {
  return (prefix || 'CB') + Date.now() + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function findPayment(outTradeNo) {
  return (state.store.payments || []).find(p => p.out_trade_no === outTradeNo);
}

function extractPayUrl(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  return data.pay_url || data.payUrl || data.url || data.cashier_url || data.cashierUrl || data.code_url || data.codeUrl || data.mweb_url || '';
}

function readFirst(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const value = obj[keys[i]];
    if (value !== undefined && value !== null && String(value) !== '') return String(value);
  }
  return '';
}

function publicPointPackages(userId) {
  const firstTopupAvailable = !dbStore.hasShixingPointTopup(userId);
  return Object.values(POINT_PACKAGES).map(pkg => ({
    key: pkg.key,
    label: pkg.label,
    points: pkg.points,
    credits: pkg.points,
    amount: moneyDisplay(pkg.amount),
    first_bonus: firstTopupAvailable ? pkg.first_bonus : 0,
    first_award: firstTopupAvailable ? pkg.points + pkg.first_bonus : pkg.points
  }));
}

function getPointPackage(key) {
  return POINT_PACKAGES[String(key || '').trim()] || null;
}

function getLegacyCommentPackage(key) {
  return LEGACY_COMMENT_PACKAGES[String(key || '').trim()] || null;
}

function publicEssayPackages() {
  return Object.values(ESSAY_PACKAGES).map(pkg => ({
    key: pkg.key,
    label: pkg.label,
    credits: pkg.credits,
    amount: moneyDisplay(pkg.amount)
  }));
}

function getEssayPackage(key) {
  return ESSAY_PACKAGES[String(key || '').trim()] || null;
}

function getEssayTimePackage(key) {
  return ESSAY_TIME_PACKAGES[String(key || '').trim()] || null;
}

function publicEssayTimePackages() {
  return Object.values(ESSAY_TIME_PACKAGES)
    .filter(pkg => parseFloat(pkg.amount) <= ESSAY_PAY_MAX)
    .map(pkg => ({
      key: pkg.key,
      label: pkg.label,
      days: pkg.days,
      daily_limit: pkg.daily_limit,
      amount: moneyDisplay(pkg.amount)
    }));
}

function getEssayBaseUrl(req) {
  if (ESSAY_BASE_URL) return ESSAY_BASE_URL;
  return req.protocol + '://' + req.get('host');
}

function getLearningBaseUrl(req) {
  if (LEARNING_BASE_URL) return LEARNING_BASE_URL;
  return req.protocol + '://' + req.get('host');
}

function getLearningPackage(key) {
  return LEARNING_PACKAGES[String(key || '').trim()] || null;
}

function publicCommentPackages(userId) {
  return publicPointPackages(userId);
}

function publicRoundtablePackages(userId) {
  return publicPointPackages(userId);
}

function getLegacyRoundtablePackage(key) {
  return LEGACY_ROUNDTABLE_PACKAGES[String(key || '').trim()] || null;
}

function getRoundtableBaseUrl(req) {
  if (ROUNDTABLE_BASE_URL) return ROUNDTABLE_BASE_URL;
  return req.protocol + '://' + req.get('host');
}

function normalizeYungouNotify(raw) {
  return {
    code: readFirst(raw, ['code']),
    orderNo: readFirst(raw, ['orderNo', 'order_no']),
    outTradeNo: readFirst(raw, ['outTradeNo', 'out_trade_no']),
    payNo: readFirst(raw, ['payNo', 'pay_no']),
    money: readFirst(raw, ['money', 'total_fee', 'totalFee']),
    mchId: readFirst(raw, ['mchId', 'mch_id'])
  };
}

function checkYungouNotifySign(raw, normalized, sign) {
  const notifyParams = {
    code: normalized.code,
    orderNo: normalized.orderNo,
    outTradeNo: normalized.outTradeNo,
    payNo: normalized.payNo,
    money: normalized.money,
    mchId: normalized.mchId
  };
  const expected = yungouSign(notifyParams, YUNGOU_PAY_KEY);
  if (safeEqual(expected, sign)) return true;

  const rawParams = {};
  Object.keys(raw).sort().forEach(key => {
    if (key !== 'sign' && key !== 'signType' && key !== 'sign_type') rawParams[key] = raw[key];
  });
  return safeEqual(yungouSign(rawParams, YUNGOU_PAY_KEY), sign);
}

// 给广播会员延长天数（用于邀请奖励）；从当前到期日或现在顺延

function markPaymentPaid(payment, normalized, raw) {
  if (payment.status === 'paid') return payment;
  const previousStatus = payment.status;
  const user = state.store.users.find(u => u.id === payment.user_id);
  if (!user) return payment;
  payment.status = 'paid';
  payment.provider_order_no = normalized.orderNo || payment.provider_order_no || '';
  payment.provider_pay_no = normalized.payNo || payment.provider_pay_no || '';
  payment.paid_at = new Date().toISOString();
  payment.notify_payload = raw;
  notifyAdminPayment(payment, user);
  if (payment.plan === 'yearly') {
    payment.plan_expires = activateYearlyPlan(user).expires;
    dbStore.upsertUser(user);
    dbStore.upsertPayment(payment);
    createUserMessage(
      user.id,
      'payment-success',
      '会员已开通',
      '微信支付成功，班级广播会员已开通至 ' + new Date(payment.plan_expires).toLocaleDateString('zh-CN'),
      { out_trade_no: payment.out_trade_no }
    );
    const unifiedReward = rewardUnifiedPurchaseForPayment(user, payment, 'broadcast');
    if (!unifiedReward) rewardBroadcastReferralOnPurchase(user);
    return payment;
  }
  const learningPkg = getLearningPackage(payment.plan);
  if (learningPkg) {
    const membership = dbStore.renewLearningMembership({
      user_id: user.id,
      username: user.username,
      days: learningPkg.days,
      plan_key: learningPkg.key,
      plan_label: learningPkg.label,
      note: '微信支付 ' + payment.out_trade_no
    });
    payment.plan_expires = membership.expires_at;
    dbStore.upsertPayment(payment);
    createUserMessage(user.id, 'learning-plan-success', '作文学习会员已开通', '微信支付成功，' + learningPkg.label + '已开通，有效期至 ' + new Date(membership.expires_at).toLocaleDateString('zh-CN') + '。', { out_trade_no: payment.out_trade_no });
    return payment;
  }
  const pointPkg = getPointPackage(payment.plan);
  if (pointPkg) {
    let added;
    try {
      added = dbStore.addShixingPointsForPayment({
        user_id: user.id,
        username: user.username,
        package_key: pointPkg.key,
        out_trade_no: payment.out_trade_no,
        product: payment.source_product || 'all',
        created_at: payment.paid_at
      });
    } catch (e) {
      payment.status = previousStatus;
      payment.paid_at = null;
      throw e;
    }
    dbStore.upsertPayment(payment);
    const bonusText = added.bonus_points ? '，首充加赠 ' + added.bonus_points + ' 积分' : '';
    createUserMessage(
      user.id,
      'shixing-points-success',
      '师行积分已到账',
      '微信支付成功，已到账 ' + pointPkg.points + ' 积分' + bonusText + '。当前余额 ' + added.balance + ' 积分。',
      { out_trade_no: payment.out_trade_no, point_balance: added.balance, awarded_points: added.awarded_points }
    );
    const unifiedReward = rewardUnifiedPurchaseForPayment(user, payment, 'points');
    if (!unifiedReward && payment.source_product === 'comment') rewardCommentReferralOnPurchase(user);
    if (!unifiedReward && payment.source_product === 'essay') rewardEssayReferralOnPurchase(user);
    return payment;
  }
  if (getLegacyCommentPackage(payment.plan) && Number(payment.credits) > 0) {
    const balance = dbStore.addCommentCreditsForPayment({
      user_id: user.id,
      username: user.username,
      credits: Number(payment.credits),
      package_key: payment.plan,
      out_trade_no: payment.out_trade_no,
      note: payment.credits + '次评语生成',
      created_at: payment.paid_at
    });
    dbStore.upsertPayment(payment);
    createUserMessage(
      user.id,
      'comment-credits-success',
      '师行积分已到账',
      '微信支付成功，旧评语套餐已折算为 ' + (Number(payment.credits) * POINT_COSTS.comment) + ' 师行积分。当前余额 ' + balance + ' 积分。',
      { out_trade_no: payment.out_trade_no, point_balance: balance }
    );
    const unifiedReward = rewardUnifiedPurchaseForPayment(user, payment, 'points');
    if (!unifiedReward) rewardCommentReferralOnPurchase(user);
    return payment;
  }
  if (getEssayPackage(payment.plan) && Number(payment.credits) > 0) {
    const balance = dbStore.addEssayCreditsForPayment({
      user_id: user.id,
      username: user.username,
      credits: Number(payment.credits),
      package_key: payment.plan,
      out_trade_no: payment.out_trade_no,
      note: payment.credits + '次作文批改',
      created_at: payment.paid_at
    });
    dbStore.upsertPayment(payment);
    createUserMessage(
      user.id,
      'essay-credits-success',
      '作文批改次数已到账',
      '微信支付成功，已为你充值 ' + payment.credits + ' 次作文批改。当前剩余 ' + balance + ' 次。',
      { out_trade_no: payment.out_trade_no, essay_balance: balance }
    );
    const unifiedReward = rewardUnifiedPurchaseForPayment(user, payment, 'points');
    if (!unifiedReward) rewardEssayReferralOnPurchase(user);
    return payment;
  }
  if (getLegacyRoundtablePackage(payment.plan) && Number(payment.credits) > 0) {
    const balance = dbStore.addRoundtableCreditsForPayment({
      user_id: user.id,
      username: user.username,
      credits: Number(payment.credits),
      package_key: payment.plan,
      out_trade_no: payment.out_trade_no,
      note: payment.credits + '次圆桌讨论',
      created_at: payment.paid_at
    });
    dbStore.upsertPayment(payment);
    createUserMessage(
      user.id,
      'roundtable-credits-success',
      '师行积分已到账',
      '微信支付成功，旧圆桌套餐已折算为 ' + (Number(payment.credits) * POINT_COSTS.roundtable) + ' 师行积分。当前余额 ' + balance + ' 积分。',
      { out_trade_no: payment.out_trade_no, point_balance: balance }
    );
    rewardUnifiedPurchaseForPayment(user, payment, 'points');
    return payment;
  }
  const essayTimePkg = getEssayTimePackage(payment.plan);
  if (essayTimePkg) {
    const plan = dbStore.addEssayPlanForPayment({
      user_id: user.id,
      plan_key: essayTimePkg.key,
      plan_label: essayTimePkg.label,
      days: essayTimePkg.days,
      daily_limit: essayTimePkg.daily_limit,
      out_trade_no: payment.out_trade_no
    });
    dbStore.upsertPayment(payment);
    createUserMessage(
      user.id,
      'essay-plan-success',
      '作文批改会员已开通',
      '微信支付成功，' + essayTimePkg.label + '已开通，有效期至 ' + (plan ? new Date(plan.expires_at).toLocaleDateString('zh-CN') : '') + '，期间每天可批 ' + essayTimePkg.daily_limit + ' 篇。',
      { out_trade_no: payment.out_trade_no }
    );
    const unifiedReward = rewardUnifiedPurchaseForPayment(user, payment, 'points');
    if (!unifiedReward) rewardEssayReferralOnPurchase(user);
    return payment;
  }
  dbStore.upsertPayment(payment);
  return payment;
}

module.exports = {
  yuanToCents,
  planPriceDisplay,
  moneyDisplay,
  getBaseUrl,
  getCommentBaseUrl,
  yungouConfigured,
  yungouSign,
  yungouRequest,
  createPaymentOrderNo,
  findPayment,
  extractPayUrl,
  readFirst,
  publicPointPackages,
  getPointPackage,
  getLegacyCommentPackage,
  publicEssayPackages,
  getEssayPackage,
  getEssayTimePackage,
  publicEssayTimePackages,
  getEssayBaseUrl,
  getLearningBaseUrl,
  getLearningPackage,
  publicCommentPackages,
  publicRoundtablePackages,
  getLegacyRoundtablePackage,
  getRoundtableBaseUrl,
  normalizeYungouNotify,
  checkYungouNotifySign,
  markPaymentPaid,
};
