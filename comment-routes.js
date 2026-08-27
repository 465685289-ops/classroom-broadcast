'use strict';

function installCommentRoutes(app) {
// 评语生成器路由：花名册 / 次数包购买 / 生成与改写。
// @WIRE
const {
  commentRewriteGuide, generateAICommentForStudent, normalizeCommentRosterStudents, normalizeCommentStudent, normalizeRosterName, rewriteAICommentForStudent
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
  createPaymentOrderNo, extractPayUrl, getCommentBaseUrl, getPointPackage, moneyDisplay, publicCommentPackages, yungouConfigured, yungouRequest, yungouSign
} = require('./payment-engine');
const {
  COMMENT_REFERRAL_UNPAID_USAGE_CAP, COMMENT_REFERRAL_USAGE_CREDITS, COMMENT_REFERRAL_USAGE_THRESHOLD, DEEPSEEK_API_KEY, DEEPSEEK_MODEL, YUNGOU_APP_ID, YUNGOU_MCH_ID, YUNGOU_PAY_KEY
} = require('./platform-config');
const {
  POINT_COSTS
} = require('./shixing-points');
const state = require('./state');


// ---------- Comment Generator API ----------
app.get('/api/comment/config', userAuth, (req, res) => {
  const balance = dbStore.getShixingPointBalance(req.user.id);
  res.json({
    ok: true,
    enabled: !!DEEPSEEK_API_KEY,
    payment_enabled: yungouConfigured(),
    balance,
    point_balance: balance,
    point_cost: POINT_COSTS.comment,
    first_topup_available: !dbStore.hasShixingPointTopup(req.user.id),
    packages: publicCommentPackages(req.user.id)
  });
});

app.get('/api/comment/history', userAuth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '60', 10) || 60, 1), 200);
  res.json({
    ok: true,
    balance: dbStore.getCommentCreditBalance(req.user.id),
    generations: dbStore.listCommentGenerations(req.user.id, limit),
    ledger: dbStore.listCommentCreditLedger(req.user.id, 30)
  });
});

app.get('/api/comment/rosters', userAuth, (req, res) => {
  res.json({
    ok: true,
    rosters: dbStore.listCommentRosters(req.user.id, 50)
  });
});

app.get('/api/comment/rosters/:id', userAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const roster = dbStore.getCommentRoster(req.user.id, id);
  if (!roster) return res.status(404).json({ error: '花名册不存在' });
  res.json({ ok: true, roster });
});

app.post('/api/comment/rosters', userAuth, (req, res) => {
  const id = req.body.id ? parseInt(req.body.id, 10) : null;
  if (id && !dbStore.getCommentRoster(req.user.id, id)) {
    return res.status(404).json({ error: '花名册不存在' });
  }
  const students = normalizeCommentRosterStudents(req.body.students);
  if (!students.length) return res.status(400).json({ error: '请先导入或添加学生' });
  const roster = dbStore.upsertCommentRoster({
    id,
    user_id: req.user.id,
    username: req.user.username,
    name: normalizeRosterName(req.body.name),
    student_count: students.length,
    students,
    source: String(req.body.source || '').slice(0, 80),
    updated_at: new Date().toISOString()
  });
  res.json({ ok: true, roster });
});

app.delete('/api/comment/rosters/:id', userAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const changes = dbStore.deleteCommentRoster(req.user.id, id);
  if (!changes) return res.status(404).json({ error: '花名册不存在' });
  res.json({ ok: true });
});

app.post('/api/comment/payments/package', userAuth, async (req, res) => {
  if (!yungouConfigured()) {
    return res.status(503).json({ error: '微信支付暂未配置，请联系管理员' });
  }
  const pkg = getPointPackage(req.body.package_key);
  if (!pkg) return res.status(400).json({ error: '积分套餐不存在' });

  const outTradeNo = createPaymentOrderNo('CM');
  const amount = moneyDisplay(pkg.amount);
  const baseUrl = getCommentBaseUrl(req);
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
    source_product: 'comment'
  };
  state.state.store.payments.push(payment);
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
    return_url: baseUrl + '/comment.html?pay_order=' + encodeURIComponent(outTradeNo),
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

app.post('/api/comment/generate', userAuth, async (req, res) => {
  if (!DEEPSEEK_API_KEY) {
    return res.status(503).json({ error: 'AI 生成服务暂未配置，请联系管理员' });
  }
  const balance = dbStore.getCommentCreditBalance(req.user.id);
  if (balance < POINT_COSTS.comment) {
    return res.status(402).json({ error: '师行积分不足，本次需要 ' + POINT_COSTS.comment + ' 积分', balance });
  }
  const student = normalizeCommentStudent(req.body.student || req.body);
  if (!student.name) return res.status(400).json({ error: '请填写学生姓名' });
  try {
    const comment = await generateAICommentForStudent(student);
    if (!comment) return res.status(502).json({ error: 'AI 没有返回有效评语，请稍后再试' });
    const saved = dbStore.insertCommentGenerationAndDebit({
      user_id: req.user.id,
      username: req.user.username,
      student_name: student.name,
      school_stage: student.schoolStage,
      performance: student.performance,
      style: student.style,
      tags: student.tags,
      concrete_note: student.concreteNote,
      min_len: student.minLen,
      max_len: student.maxLen,
      comment,
      model: DEEPSEEK_MODEL,
      device_hash: deviceHashFromReq(req),
      created_at: new Date().toISOString()
    });
    notifyUnifiedActivation(saved.referral_reward, req.user, '评语生成');
    // 邀请奖励：被邀请人累计生成3条评语，给邀请人 +20 次（未付费邀请人封顶2笔）
    try {
      const ref = dbStore.getUnifiedReferralByInvitee(req.user.id) ? null : dbStore.getAppReferral('comment', req.user.id);
      if (ref && !ref.usage_rewarded_at && dbStore.countCommentGenerations(req.user.id) >= COMMENT_REFERRAL_USAGE_THRESHOLD) {
        const inviterPaid = dbStore.hasCommentPurchase(ref.inviter_user_id);
        if (inviterPaid || dbStore.countAppReferralUsageRewards('comment', ref.inviter_user_id) < COMMENT_REFERRAL_UNPAID_USAGE_CAP) {
          const claimed = dbStore.claimAppReferralReward('comment', req.user.id, 'usage_rewarded_at');
          if (claimed) {
            const inviter = state.state.store.users.find(u => u.id === claimed.inviter_user_id);
            const bal = dbStore.addCommentReferralCredits(claimed.inviter_user_id, inviter && inviter.username, COMMENT_REFERRAL_USAGE_CREDITS, '邀请好友完成评语生成');
            const rewardPoints = COMMENT_REFERRAL_USAGE_CREDITS * POINT_COSTS.comment;
            createUserMessage(
              claimed.inviter_user_id,
              'comment-referral',
              '邀请奖励到账',
              '你邀请的好友 ' + (claimed.invitee_username || req.user.username) + ' 已生成 3 条评语，奖励 ' + rewardPoints + ' 师行积分已到账，当前余额 ' + bal + ' 积分。',
              {}
            );
          }
        }
      }
    } catch (e) {
      console.log('[REF] comment usage reward failed:', e.message);
    }
    res.json({
      ok: true,
      comment,
      balance: saved.balance,
      generation_id: saved.generation.id,
      referral_reward: saved.referral_reward && !saved.referral_reward.duplicate ? {
        status: saved.referral_reward.status,
        invitee_reward_points: saved.referral_reward.invitee_reward_points,
        risk_reason: saved.referral_reward.risk_reason || ''
      } : null
    });
  } catch (e) {
    if (e.code === 'COMMENT_CREDITS_EXHAUSTED') {
      return res.status(402).json({ error: '师行积分不足，本次需要 ' + POINT_COSTS.comment + ' 积分', balance: dbStore.getShixingPointBalance(req.user.id) });
    }
    console.log('[COMMENT] generate failed:', e.message);
    res.status(502).json({ error: '生成失败：' + e.message });
  }
});

app.post('/api/comment/rewrite', userAuth, async (req, res) => {
  if (!DEEPSEEK_API_KEY) {
    return res.status(503).json({ error: 'AI 生成服务暂未配置，请联系管理员' });
  }
  const balance = dbStore.getCommentCreditBalance(req.user.id);
  if (balance < POINT_COSTS.comment) {
    return res.status(402).json({ error: '师行积分不足，本次需要 ' + POINT_COSTS.comment + ' 积分', balance });
  }
  const student = normalizeCommentStudent(req.body.student || {});
  const currentComment = String(req.body.comment || req.body.current_comment || '').trim().slice(0, 3000);
  const guide = commentRewriteGuide(String(req.body.mode || '').trim());
  if (!student.name) return res.status(400).json({ error: '请填写学生姓名' });
  if (!currentComment) return res.status(400).json({ error: '请先生成或填写一段评语' });
  try {
    const comment = await rewriteAICommentForStudent(student, currentComment, guide.key);
    if (!comment) return res.status(502).json({ error: 'AI 没有返回有效评语，请稍后再试' });
    const saved = dbStore.insertCommentGenerationAndDebit({
      user_id: req.user.id,
      username: req.user.username,
      student_name: student.name,
      school_stage: student.schoolStage,
      performance: student.performance,
      style: student.style,
      tags: student.tags,
      concrete_note: student.concreteNote,
      min_len: student.minLen,
      max_len: student.maxLen,
      comment,
      model: DEEPSEEK_MODEL,
      created_at: new Date().toISOString(),
      extra_json: {
        is_rewrite: true,
        rewrite_mode: guide.key,
        rewrite_label: guide.label,
        source_comment_preview: currentComment.slice(0, 160)
      }
    });
    res.json({
      ok: true,
      comment,
      balance: saved.balance,
      generation_id: saved.generation.id,
      rewrite_label: guide.label
    });
  } catch (e) {
    if (e.code === 'COMMENT_CREDITS_EXHAUSTED') {
      return res.status(402).json({ error: '师行积分不足，本次需要 ' + POINT_COSTS.comment + ' 积分', balance: dbStore.getShixingPointBalance(req.user.id) });
    }
    console.log('[COMMENT] rewrite failed:', e.message);
    res.status(502).json({ error: '改写失败：' + e.message });
  }
});
}

module.exports = {
  installCommentRoutes,
};
