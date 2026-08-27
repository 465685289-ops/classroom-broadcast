'use strict';

function installReferralRoutes(app) {
// 英语作文批改路由：班级 / 题目 / 批改 / 分享页。
// @WIRE
const dbStore = require('./db');
const {
  broadcastInviterIsPaid
} = require('./messaging-referrals');
const {
  userAuth
} = require('./middleware');
const {
  getBaseUrl, getCommentBaseUrl
} = require('./payment-engine');
const {
  BROADCAST_REFERRAL_PURCHASE_DAYS, BROADCAST_REFERRAL_UNPAID_USAGE_CAP, BROADCAST_REFERRAL_USAGE_DAYS, COMMENT_REFERRAL_PURCHASE_CREDITS, COMMENT_REFERRAL_UNPAID_USAGE_CAP, COMMENT_REFERRAL_USAGE_CREDITS, COMMENT_REFERRAL_USAGE_THRESHOLD
} = require('./platform-config');
const {
  POINT_COSTS
} = require('./shixing-points');
const state = require('./state');

app.post('/api/essay/referral/bind', userAuth, (req, res) => {
  const inviter = appReferralBindGuard(req, res, dbStore.countEssayGradings(req.user.id));
  if (!inviter) return;
  const bound = dbStore.bindEssayReferral(req.user.id, req.user.username, inviter.id);
  if (!bound) return res.status(409).json({ error: '该账号已绑定过邀请关系' });
  res.json({ ok: true });
});

// 邀请绑定通用校验：邀请码有效、非自己、新账号（72小时内）、尚未使用过该产品
function appReferralBindGuard(req, res, usageCount) {
  const ref = String(req.body.ref || '').trim().toUpperCase();
  if (!ref) { res.status(400).json({ error: '邀请码为空' }); return null; }
  const inviter = state.store.users.find(u => String(u.teacher_code || '').toUpperCase() === ref);
  if (!inviter) { res.status(404).json({ error: '邀请码无效' }); return null; }
  if (inviter.id === req.user.id) { res.status(400).json({ error: '不能邀请自己' }); return null; }
  const accountAgeMs = Date.now() - Date.parse(req.user.created_at || 0);
  if (accountAgeMs > 72 * 3600 * 1000) { res.status(400).json({ error: '仅新注册账号可绑定邀请关系' }); return null; }
  if (usageCount > 0) { res.status(400).json({ error: '该账号已使用过本产品，无法绑定邀请关系' }); return null; }
  return inviter;
}

// ---------- 评语邀请 ----------
app.post('/api/comment/referral/bind', userAuth, (req, res) => {
  const inviter = appReferralBindGuard(req, res, dbStore.countCommentGenerations(req.user.id));
  if (!inviter) return;
  const bound = dbStore.bindAppReferral('comment', req.user.id, req.user.username, inviter.id);
  if (!bound) return res.status(409).json({ error: '该账号已绑定过邀请关系' });
  res.json({ ok: true });
});

app.get('/api/comment/referral', userAuth, (req, res) => {
  const invitees = dbStore.listAppReferralsByInviter('comment', req.user.id, 100);
  let earned = 0;
  invitees.forEach(i => {
    if (i.usage_rewarded) earned += COMMENT_REFERRAL_USAGE_CREDITS;
    if (i.purchase_rewarded) earned += COMMENT_REFERRAL_PURCHASE_CREDITS;
  });
  res.json({
    ok: true,
    code: req.user.teacher_code,
    link: getCommentBaseUrl(req) + '/?ref=' + encodeURIComponent(req.user.teacher_code),
    invitees,
    invited_count: invitees.length,
    earned_credits: earned,
    earned_points: earned * POINT_COSTS.comment,
    usage_threshold: COMMENT_REFERRAL_USAGE_THRESHOLD,
    usage_reward: COMMENT_REFERRAL_USAGE_CREDITS,
    usage_reward_points: COMMENT_REFERRAL_USAGE_CREDITS * POINT_COSTS.comment,
    purchase_reward: COMMENT_REFERRAL_PURCHASE_CREDITS,
    purchase_reward_points: COMMENT_REFERRAL_PURCHASE_CREDITS * POINT_COSTS.comment,
    inviter_paid: dbStore.hasCommentPurchase(req.user.id),
    unpaid_usage_cap: COMMENT_REFERRAL_UNPAID_USAGE_CAP,
    usage_rewards_used: dbStore.countAppReferralUsageRewards('comment', req.user.id)
  });
});

// ---------- 广播邀请 ----------
app.post('/api/broadcast/referral/bind', userAuth, (req, res) => {
  const usageCount = state.store.notifications.filter(n => n.user_id === req.user.id).length;
  const inviter = appReferralBindGuard(req, res, usageCount);
  if (!inviter) return;
  const bound = dbStore.bindAppReferral('broadcast', req.user.id, req.user.username, inviter.id);
  if (!bound) return res.status(409).json({ error: '该账号已绑定过邀请关系' });
  res.json({ ok: true });
});

app.get('/api/broadcast/referral', userAuth, (req, res) => {
  const invitees = dbStore.listAppReferralsByInviter('broadcast', req.user.id, 100);
  let earnedDays = 0;
  invitees.forEach(i => {
    if (i.usage_rewarded) earnedDays += BROADCAST_REFERRAL_USAGE_DAYS;
    if (i.purchase_rewarded) earnedDays += BROADCAST_REFERRAL_PURCHASE_DAYS;
  });
  res.json({
    ok: true,
    code: req.user.teacher_code,
    link: getBaseUrl(req) + '/teacher.html?ref=' + encodeURIComponent(req.user.teacher_code),
    invitees,
    invited_count: invitees.length,
    earned_days: earnedDays,
    usage_reward_days: BROADCAST_REFERRAL_USAGE_DAYS,
    purchase_reward_days: BROADCAST_REFERRAL_PURCHASE_DAYS,
    inviter_paid: broadcastInviterIsPaid(req.user.id),
    unpaid_usage_cap: BROADCAST_REFERRAL_UNPAID_USAGE_CAP,
    usage_rewards_used: dbStore.countAppReferralUsageRewards('broadcast', req.user.id)
  });
});
}

module.exports = {
  installReferralRoutes,
};
