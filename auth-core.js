'use strict';
// 认证核心：验证码/密码散列/登录令牌/会员套餐状态。
const crypto = require('crypto');
const dbStore = require('./db');
const state = require('./state');
const { PAID_PLAN_DAYS, FREE_TRIAL_DAYS, AUTH_TOKEN_TTL_MS } = require('./platform-config');

function paidPlanExpiresFromNow() {
  return new Date(Date.now() + PAID_PLAN_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function paidPlanExpiresForUser(user) {
  const current = user && user.plan === 'yearly' && user.plan_expires ? Date.parse(user.plan_expires) : 0;
  const base = current && current > Date.now() ? current : Date.now();
  return new Date(base + PAID_PLAN_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function activateYearlyPlan(user) {
  user.plan = 'yearly';
  user.plan_expires = paidPlanExpiresForUser(user);
  return getUserPlanStatus(user);
}

function genCode(length = 6) {
  let code = '';
  while (code.length < length) {
    code += crypto.randomBytes(6).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  }
  return code.slice(0, length);
}

function genUniqueBindCode() {
  let code = genCode();
  while (state.store.classes.find(c => c.bind_code === code)) code = genCode();
  return code;
}

function genUniqueTeacherCode() {
  let code = genCode();
  while (state.store.users.find(u => u.teacher_code === code)) code = genCode();
  return code;
}

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const result = crypto.scryptSync(password, salt, 64).toString('hex');
  return result === hash;
}

function setUserPassword(user, password) {
  const { hash, salt } = hashPassword(password);
  user.password_hash = hash;
  user.password_salt = salt;
  issueUserToken(user); // 改密码即吊销旧登录
  dbStore.upsertUser(user);
}

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function issueUserToken(user) {
  user.token = genToken();
  user.token_expires = new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString();
  return user.token;
}

function revokeUserToken(user) {
  user.token = null;
  user.token_expires = null;
  dbStore.upsertUser(user);
}

// 按 token 查找用户并校验有效期。老数据没有 token_expires 的，首次访问时补发有效期。
function findUserByToken(token) {
  if (!token) return null;
  const user = state.store.users.find(u => u.token === token);
  if (!user) return null;
  if (!user.token_expires) {
    user.token_expires = new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString();
    dbStore.upsertUser(user);
    return user;
  }
  if (Date.parse(user.token_expires) <= Date.now()) return null;
  return user;
}

// 滑动续期：剩余有效期不足一半时才写库，避免每个请求都写
function refreshUserTokenExpiry(user) {
  const expires = user.token_expires ? Date.parse(user.token_expires) : 0;
  if (expires - Date.now() < AUTH_TOKEN_TTL_MS / 2) {
    user.token_expires = new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString();
    dbStore.upsertUser(user);
  }
}

function getUserPlanStatus(user) {
  if (!user) return { active: false, reason: 'not_found' };
  if (user.plan === 'yearly') {
    const label = '会员';
    if (user.plan_expires && new Date(user.plan_expires) > new Date()) {
      return { active: true, plan: user.plan, label, expires: user.plan_expires };
    }
    return { active: false, reason: 'expired', label: label + '已过期' };
  }
  // trial
  const created = new Date(user.created_at);
  const trialEnd = new Date(created.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
  if (new Date() < trialEnd) {
    return { active: true, plan: 'trial', label: '免费试用', expires: trialEnd.toISOString() };
  }
  return { active: false, reason: 'trial_expired', label: '试用已结束' };
}

module.exports = {
  paidPlanExpiresFromNow,
  paidPlanExpiresForUser,
  activateYearlyPlan,
  genCode,
  genUniqueBindCode,
  genUniqueTeacherCode,
  hashPassword,
  verifyPassword,
  setUserPassword,
  genToken,
  issueUserToken,
  revokeUserToken,
  findUserByToken,
  refreshUserTokenExpiry,
  getUserPlanStatus,
};
