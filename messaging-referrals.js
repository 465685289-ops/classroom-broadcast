'use strict';
// 消息与推荐奖励引擎：站内消息 / 邀请激活返奖 / 各产品购买返奖。
const crypto = require('crypto');
const dbStore = require('./db');
// @WIRE
const {
  addCommentReferralCredits, claimAppReferralReward, getUnifiedReferralByInvitee, pruneMessages, rewardEssayReferralPurchase, rewardUnifiedFirstPurchase, setCounter, upsertMessage, upsertUser
} = require('./db');
const {
  BROADCAST_REFERRAL_PURCHASE_DAYS, COMMENT_REFERRAL_PURCHASE_CREDITS, ESSAY_REFERRAL_PURCHASE_REWARD
} = require('./platform-config');
const {
  POINT_COSTS
} = require('./shixing-points');
const state = require('./state');

function createUserMessage(userId, type, title, body, extra) {
  if (!state.store.messages) state.store.messages = [];
  const message = {
    id: state.store.nextMessageId++,
    user_id: userId,
    type,
    title,
    body,
    read_at: null,
    created_at: new Date().toISOString(),
    ...(extra || {})
  };
  state.store.messages.push(message);
  if (state.store.messages.length > 1000) state.store.messages = state.store.messages.slice(-1000);
  dbStore.upsertMessage(message);
  dbStore.setCounter('nextMessageId', state.store.nextMessageId);
  dbStore.pruneMessages(1000);
  state.io.to(`user:${userId}`).emit('teacher-message', message);
  return message;
}

function notifyUnifiedActivation(reward, invitee, productLabel) {
  if (!reward || reward.eligible === false || reward.duplicate) return;
  const label = productLabel || '师行工具';
  if (reward.status === 'approved') {
    const inviter = state.store.users.find(user => user.id === reward.inviter_user_id);
    if (inviter) {
      createUserMessage(
        inviter.id,
        'referral-activation',
        '邀请奖励到账',
        '你邀请的好友 ' + ((invitee && invitee.username) || '老师') + ' 已首次使用' + label + '，500 师行积分已到账。',
        { referral_event_id: reward.id }
      );
    }
    if (invitee) {
      createUserMessage(
        invitee.id,
        'referral-activation',
        '受邀新人奖励到账',
        '首次使用' + label + '成功，500 师行积分已到账。',
        { referral_event_id: reward.id }
      );
    }
  } else if (reward.status === 'pending' && reward.invitee_rewarded_at && invitee) {
    createUserMessage(
      invitee.id,
      'referral-activation',
      '受邀新人奖励到账',
      '首次使用' + label + '成功，500 师行积分已到账；邀请人的奖励正在审核。',
      { referral_event_id: reward.id }
    );
  }
}

function rewardUnifiedPurchaseForPayment(user, payment, purchaseType) {
  const relation = dbStore.getUnifiedReferralByInvitee(user.id);
  if (!relation) return null;
  const reward = dbStore.rewardUnifiedFirstPurchase({
    invitee_user_id: user.id,
    purchase_type: purchaseType,
    source_product: payment.source_product || purchaseType,
    source_record_id: payment.out_trade_no,
    created_at: payment.paid_at || new Date().toISOString()
  });
  if (!reward || reward.eligible === false || reward.duplicate) return reward;
  const inviter = state.store.users.find(item => item.id === reward.inviter_user_id);
  if (!inviter) return reward;
  if (purchaseType === 'broadcast') {
    inviter.plan = 'yearly';
    inviter.plan_expires = reward.broadcast_expires_at;
    createUserMessage(
      inviter.id,
      'referral-first-purchase',
      '邀请付费奖励到账',
      '你邀请的好友 ' + user.username + ' 首次开通了教室广播会员，30 天会员时长已到账，有效期至 ' + new Date(reward.broadcast_expires_at).toLocaleDateString('zh-CN') + '。',
      { referral_event_id: reward.id, out_trade_no: payment.out_trade_no }
    );
  } else {
    createUserMessage(
      inviter.id,
      'referral-first-purchase',
      '邀请付费奖励到账',
      '你邀请的好友 ' + user.username + ' 完成了首次积分充值，1500 师行积分已到账。',
      { referral_event_id: reward.id, out_trade_no: payment.out_trade_no }
    );
  }
  return reward;
}

function extendBroadcastPlanDays(user, days) {
  const current = user.plan === 'yearly' && user.plan_expires ? Date.parse(user.plan_expires) : 0;
  const base = current && current > Date.now() ? current : Date.now();
  user.plan = 'yearly';
  user.plan_expires = new Date(base + days * 86400000).toISOString();
  dbStore.upsertUser(user);
  return user.plan_expires;
}

function broadcastInviterIsPaid(userId) {
  return (state.store.payments || []).some(p => p.user_id === userId && p.status === 'paid' && p.plan === 'yearly');
}

function rewardBroadcastReferralOnPurchase(user) {
  try {
    const claimed = dbStore.claimAppReferralReward('broadcast', user.id, 'purchase_rewarded_at');
    if (!claimed) return;
    const inviter = state.store.users.find(u => u.id === claimed.inviter_user_id);
    if (!inviter) return;
    const expires = extendBroadcastPlanDays(inviter, BROADCAST_REFERRAL_PURCHASE_DAYS);
    createUserMessage(
      inviter.id,
      'broadcast-referral',
      '邀请奖励到账',
      '你邀请的好友 ' + (claimed.invitee_username || user.username) + ' 开通了半年会员，奖励 ' + BROADCAST_REFERRAL_PURCHASE_DAYS + ' 天会员时长已到账，有效期至 ' + new Date(expires).toLocaleDateString('zh-CN') + '。',
      {}
    );
  } catch (e) {
    console.log('[REF] broadcast purchase reward failed:', e.message);
  }
}

function rewardCommentReferralOnPurchase(user) {
  try {
    const claimed = dbStore.claimAppReferralReward('comment', user.id, 'purchase_rewarded_at');
    if (!claimed) return;
    const inviter = state.store.users.find(u => u.id === claimed.inviter_user_id);
    if (!inviter) return;
    const balance = dbStore.addCommentReferralCredits(inviter.id, inviter.username, COMMENT_REFERRAL_PURCHASE_CREDITS, '邀请好友首次付费奖励');
    const rewardPoints = COMMENT_REFERRAL_PURCHASE_CREDITS * POINT_COSTS.comment;
    createUserMessage(
      inviter.id,
      'comment-referral',
      '邀请奖励到账',
      '你邀请的好友 ' + (claimed.invitee_username || user.username) + ' 完成了首次付费，奖励 ' + rewardPoints + ' 师行积分已到账，当前余额 ' + balance + ' 积分。',
      {}
    );
  } catch (e) {
    console.log('[REF] comment purchase reward failed:', e.message);
  }
}

function rewardEssayReferralOnPurchase(user) {
  try {
    const r = dbStore.rewardEssayReferralPurchase(user.id, ESSAY_REFERRAL_PURCHASE_REWARD);
    if (r) {
      createUserMessage(
        r.inviter_user_id,
        'essay-referral',
        '邀请奖励到账',
        '你邀请的好友 ' + (r.invitee_username || user.username) + ' 完成了首次付费，奖励 ' + r.points + ' 师行积分已到账，当前余额 ' + r.balance + ' 积分。',
        {}
      );
    }
  } catch (e) {
    console.log('[ESSAY] referral purchase reward failed:', e.message);
  }
}

module.exports = {
  createUserMessage,
  notifyUnifiedActivation,
  rewardUnifiedPurchaseForPayment,
  extendBroadcastPlanDays,
  broadcastInviterIsPaid,
  rewardBroadcastReferralOnPurchase,
  rewardCommentReferralOnPurchase,
  rewardEssayReferralOnPurchase,
};
