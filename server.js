const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const nodemailer = require('nodemailer');
const dbStore = require('./db');
const { POINT_COSTS, POINT_PACKAGES } = require('./shixing-points');
const { REFERRAL_REWARDS } = require('./unified-referrals');
const { isLearningHost } = require('./learning-membership');
const classroomPoints = require('./classroom-points');
const {
  buildLearningItems,
  buildPolishRetryUserPrompt,
  cleanLearningText,
  learningMinWordCountForGrade,
  learningToolPrompt,
  polishNeedsRetry
} = require('./learning-tools');

const state = require('./state');

// ---- http-utils（自 ./http-utils.js 引入）----
const __httpUtils = require('./http-utils');
// 以下符号被源码守卫测试要求以 function 声明存在：shixingHost, englishHost
function shixingHost() { return __httpUtils.shixingHost.apply(null, arguments); }
function englishHost() { return __httpUtils.englishHost.apply(null, arguments); }

const {
  commentHost, essayHost, learningHost, roundtableHost, parseCookieHeader, requestHost, authCookieDomain, cookieSecure, authCookieOptions, setAuthCookie, ANALYTICS_EVENTS, ANALYTICS_PRODUCTS, analyticsRateLimits, analyticsCookieOptions, analyticsVisitorHash, validAnalyticsVisitorId, analyticsPath, analyticsReferrerHost, analyticsSource, analyticsDevice, analyticsProductFromReq, analyticsVisitorFromReq, recordAnalyticsFromRequest, analyticsRequestAllowed, clearAuthCookie, referralCookieOptions, deviceCookieOptions, encodeInviteCookie, decodeInviteCookie, invitePayloadFromReq, deviceHashFromReq, clearInviteCookie, referralAttributionFromReq, authTokenFromReq, authTokenFromSocket
} = require('./http-utils');

// 可选：从本机私有密钥文件加载环境变量（优先级低于真实环境变量，不覆盖已有值）。
// 格式：每行 KEY=VALUE，# 开头为注释；路径可用 SECRETS_FILE 环境变量覆盖。
// 文件不存在是常态（服务器上用 systemd/nginx 注入环境变量），静默跳过。
// ---- 认证核心（自 auth-core.js 引入）----
const {
  paidPlanExpiresFromNow, paidPlanExpiresForUser, activateYearlyPlan, genCode, genUniqueBindCode, genUniqueTeacherCode, hashPassword, verifyPassword, setUserPassword, genToken, safeEqual, issueUserToken, revokeUserToken, findUserByToken, refreshUserTokenExpiry, getUserPlanStatus
} = require('./auth-core');

(function loadSecretsFile() {
  const secretsPath = process.env.SECRETS_FILE
    || path.join(require('os').homedir(), '.config', 'classroom-broadcast', 'secrets.env');
  try {
    let loaded = 0;
    for (const raw of fs.readFileSync(secretsPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
      loaded++;
    }
    console.log('[SECURITY] 已从私有密钥文件加载 ' + loaded + ' 个配置项');
  } catch (e) {
    // 密钥文件缺失时走配置文件/env 默认逻辑
  }
})();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
state.io = io;

// ---- 平台配置层（自 platform-config.js 引入）----
const {
  loadPaymentConfig, loadMailConfig, loadCommentConfig, loadEssayConfig, PAYMENT_CONFIG, MAIL_CONFIG, COMMENT_CONFIG, ESSAY_CONFIG, configValue, commentConfigValue, essayConfigValue, mailConfigValue, mailConfigBool, PORT, ADMIN_PASS, FREE_TRIAL_DAYS, PAID_PLAN_DAYS, YEARLY_PLAN_PRICE, PUBLIC_BASE_URL, COMMENT_BASE_URL, DEEPSEEK_API_KEY, DEEPSEEK_MODEL, YUNGOU_MCH_ID, YUNGOU_PAY_KEY, YUNGOU_APP_ID, YUNGOU_API_HOST, LEGACY_COMMENT_PACKAGES, LEGACY_ROUNDTABLE_PACKAGES, ROUNDTABLE_CARD_ENABLED, ROUNDTABLE_BASE_URL, ROUNDTABLE_SPEAK_CAP, ESSAY_BASE_URL, ENGLISH_BASE_URL, QWEN_API_KEY, QWEN_OCR_MODEL, MINIMAX_API_KEYS, MINIMAX_MODEL, FREE_ESSAY_CREDITS, ESSAY_OCR_DAILY_LIMIT, ESSAY_PAY_MAX, ESSAY_PACKAGES, ESSAY_CARD_ENABLED, ESSAY_TIME_PACKAGES, ESSAY_REFERRAL_GRADING_THRESHOLD, ESSAY_REFERRAL_GRADING_REWARD, ESSAY_REFERRAL_PURCHASE_REWARD, LEARNING_BASE_URL, LEARNING_MODEL, LEARNING_DAILY_LIMIT, LEARNING_PACKAGES, COMMENT_REFERRAL_USAGE_THRESHOLD, COMMENT_REFERRAL_USAGE_CREDITS, COMMENT_REFERRAL_PURCHASE_CREDITS, COMMENT_REFERRAL_UNPAID_USAGE_CAP, BROADCAST_REFERRAL_USAGE_DAYS, BROADCAST_REFERRAL_PURCHASE_DAYS, BROADCAST_REFERRAL_UNPAID_USAGE_CAP, LEGACY_PREMIUM_PLAN, SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM, RESET_CODE_TTL_MS, RESET_TOKEN_TTL_MS, RESET_CODE_COOLDOWN_MS, RESET_CODE_MAX_ATTEMPTS, REGISTRATION_CODE_TTL_MS, REGISTRATION_CODE_COOLDOWN_MS, REGISTRATION_CODE_MAX_ATTEMPTS, REGISTRATION_CODE_IP_HOURLY_LIMIT, AUTH_COOKIE_NAME, ADMIN_COOKIE_NAME, ANALYTICS_COOKIE_NAME, ADMIN_SESSION_TTL_MS, AUTH_TOKEN_TTL_MS, INVITE_COOKIE_NAME, DEVICE_COOKIE_NAME, INVITE_COOKIE_MAX_AGE_MS, INVITE_COOKIE_SECRET, ANALYTICS_HASH_SALT, ADMIN_PASS_IS_DEFAULT, ROADMAP_FEATURES
} = require('./platform-config');
app.set('trust proxy', true);

// ---------- SQLite Store ----------
function loadDB() {
  return dbStore.loadStore();
}

function saveDB(data) {
  dbStore.replaceStore(data);
}

let store = loadDB();
state.store = store;
if (normalizeStore(store)) saveDB(store);

function normalizeStore(data) {
  let changed = false;
  if (!Array.isArray(data.payments)) {
    data.payments = [];
    changed = true;
  }
  if (!Array.isArray(data.messages)) {
    data.messages = [];
    changed = true;
  }
  if (!Array.isArray(data.bulletins)) {
    data.bulletins = [];
    changed = true;
  }
  if (!Array.isArray(data.feature_subscriptions)) {
    data.feature_subscriptions = [];
    changed = true;
  }
  const maxMessageId = data.messages.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0);
  const maxBulletinId = data.bulletins.reduce((max, b) => Math.max(max, Number(b.id) || 0), 0);
  if (!data.nextMessageId || data.nextMessageId <= maxMessageId) {
    data.nextMessageId = maxMessageId + 1;
    changed = true;
  }
  if (!data.nextBulletinId || data.nextBulletinId <= maxBulletinId) {
    data.nextBulletinId = maxBulletinId + 1;
    changed = true;
  }
  const seenTeacherCodes = new Set();
  (data.users || []).forEach(user => {
    if (user.plan === LEGACY_PREMIUM_PLAN) {
      user.plan = 'yearly';
      if (!user.plan_expires) user.plan_expires = paidPlanExpiresFromNow();
      changed = true;
    }
    const teacherCode = String(user.teacher_code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(teacherCode) || seenTeacherCodes.has(teacherCode)) {
      user.teacher_code = genUniqueTeacherCode();
      changed = true;
    } else if (user.teacher_code !== teacherCode) {
      user.teacher_code = teacherCode;
      changed = true;
    }
    seenTeacherCodes.add(user.teacher_code);
  });
  (data.classes || []).forEach(cls => {
    if (!Array.isArray(cls.member_ids)) {
      cls.member_ids = [];
      changed = true;
    }
    const filtered = cls.member_ids.filter(id => id && id !== cls.user_id);
    const unique = Array.from(new Set(filtered));
    if (unique.length !== cls.member_ids.length) {
      cls.member_ids = unique;
      changed = true;
    }
  });
  return changed;
}


function isClassMember(cls, userId) {
  return cls && (cls.user_id === userId || (cls.member_ids || []).includes(userId));
}

function getVisibleClasses(userId) {
  return store.classes.filter(c => isClassMember(c, userId));
}

function getClassUsers(cls) {
  const ids = [cls.user_id].concat(cls.member_ids || []);
  return ids
    .map(id => store.users.find(u => u.id === id))
    .filter(Boolean)
    .map(u => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      teacher_code: u.teacher_code
    }));
}

function classResponse(cls, userId, onlineCounts) {
  const owner = store.users.find(u => u.id === cls.user_id);
  return {
    ...cls,
    is_owner: cls.user_id === userId,
    owner_name: owner ? owner.display_name : '',
    members: getClassUsers(cls),
    management_enabled: !!cls.management_enabled,
    points_sound_enabled: !!cls.points_sound_enabled,
    online: onlineCounts ? (onlineCounts[cls.id] || 0) : 0
  };
}

const DEFAULT_CLASS_SCORE_RULES = [
  { name: '认真听讲', delta: 1 },
  { name: '课堂发言', delta: 2 },
  { name: '作业优秀', delta: 3 },
  { name: '帮助同学', delta: 2 },
  { name: '课堂提醒', delta: -1 },
  { name: '作业未交', delta: -2 }
];

function ensureDefaultClassScoreRules(classId) {
  let rules = dbStore.listClassScoreRules(classId, { include_inactive: true });
  if (rules.length) return rules;
  const now = new Date().toISOString();
  rules = DEFAULT_CLASS_SCORE_RULES.map((rule, index) => dbStore.saveClassScoreRule({
    id: crypto.randomUUID(),
    class_id: classId,
    name: rule.name,
    delta: rule.delta,
    active: 1,
    sort_order: index * 10,
    created_at: now,
    updated_at: now
  }));
  return rules;
}

function classManagementPayload(cls) {
  const management = dbStore.getClassManagement(cls.id) || {
    class_id: cls.id,
    enabled: false,
    sound_enabled: false,
    archived_at: null
  };
  const periods = management.enabled ? dbStore.listClassScorePeriods(cls.id) : [];
  const currentPeriod = periods.find(period => period.status === 'current') || null;
  return {
    management,
    students: management.enabled ? dbStore.listClassStudents(cls.id) : [],
    rules: management.enabled ? dbStore.listClassScoreRules(cls.id) : [],
    periods,
    current_period: currentPeriod
  };
}

function scoreEntryResponse(entry) {
  return {
    ...entry,
    source_label: classroomPoints.sourceLabel(entry.source)
  };
}

function getTeacherName(user) {
  if (!user) return '';
  return user.display_name || user.username || '老师';
}

function normalizeContactInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const email = raw.toLowerCase();
  if (email.length <= 80 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { type: 'email', value: email };
  }
  const compact = raw.replace(/[\s-]/g, '');
  const cnPhone = compact.replace(/^\+86/, '');
  if (/^1[3-9]\d{9}$/.test(cnPhone)) {
    return { type: 'phone', value: cnPhone };
  }
  if (/^\+?\d{6,20}$/.test(compact)) {
    return { type: 'phone', value: compact };
  }
  return null;
}

function contactMatches(user, contact) {
  return !!(user && contact && String(user.contact_value || '') === contact.value);
}

function normalizeMinutesPerNotice(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 10) return null;
  return n;
}

function getNotificationSender(row) {
  return store.users.find(u => u.id === row.user_id);
}

function createUserMessage(userId, type, title, body, extra) {
  if (!store.messages) store.messages = [];
  const message = {
    id: store.nextMessageId++,
    user_id: userId,
    type,
    title,
    body,
    read_at: null,
    created_at: new Date().toISOString(),
    ...(extra || {})
  };
  store.messages.push(message);
  if (store.messages.length > 1000) store.messages = store.messages.slice(-1000);
  dbStore.upsertMessage(message);
  dbStore.setCounter('nextMessageId', store.nextMessageId);
  dbStore.pruneMessages(1000);
  io.to(`user:${userId}`).emit('teacher-message', message);
  return message;
}

function notifyUnifiedActivation(reward, invitee, productLabel) {
  if (!reward || reward.eligible === false || reward.duplicate) return;
  const label = productLabel || '师行工具';
  if (reward.status === 'approved') {
    const inviter = store.users.find(user => user.id === reward.inviter_user_id);
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
  const inviter = store.users.find(item => item.id === reward.inviter_user_id);
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

function getActiveBulletins(classId) {
  const now = Date.now();
  return (store.bulletins || [])
    .filter(b => b.class_id === classId && new Date(b.expires_at).getTime() > now)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 8);
}

function bulletinResponse(bulletin, cls, userId) {
  return {
    ...bulletin,
    class_name: cls ? cls.name : '',
    can_delete: !!(userId && cls && (bulletin.user_id === userId || cls.user_id === userId))
  };
}

function emitBulletins(classId) {
  io.to(`class:${classId}`).emit('bulletins-update', getActiveBulletins(classId));
}


function mailConfigured() {
  return !!(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && MAIL_FROM);
}

let mailTransporter = null;
function getMailTransporter() {
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      }
    });
  }
  return mailTransporter;
}

function genResetCode() {
  return ('000000' + crypto.randomInt(0, 1000000)).slice(-6);
}

// ---------- 管理员邮件通知（注册/收款）----------
const ADMIN_NOTIFY_EMAIL = mailConfigValue(['ADMIN_NOTIFY_EMAIL'], 'admin_notify_email', '465685289@qq.com');

const ADMIN_PLAN_LABELS = {
  yearly: '班级广播·半年会员',
  comment_100: '评语·100次', comment_200: '评语·200次',
  essay_50: '作文·50次', essay_100: '作文·100次',
  essay_week: '作文·周卡', essay_month: '作文·月卡', essay_term: '作文·学期卡'
};

// 发不出去只记日志，绝不影响注册/支付主流程
function notifyAdmin(subject, lines) {
  if (!mailConfigured() || !ADMIN_NOTIFY_EMAIL) return;
  getMailTransporter().sendMail({
    from: MAIL_FROM,
    to: ADMIN_NOTIFY_EMAIL,
    subject: subject,
    text: lines.join('\n')
  }).catch(e => console.log('[NOTIFY] 管理员邮件发送失败:', e.message));
}

function notifyAdminNewUser(user) {
  notifyAdmin('🆕 新用户注册：' + user.username, [
    '用户名：' + user.username,
    '称呼：' + (user.display_name || ''),
    '联系方式：' + (user.contact_value || '未填'),
    '时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    '当前总用户数：' + store.users.length,
    '',
    '数据仪表盘：https://notice.yingyuzuowen.asia/dashboard.html'
  ]);
}

function notifyAdminPayment(payment, user) {
  const label = ADMIN_PLAN_LABELS[payment.plan] || payment.plan;
  notifyAdmin('💰 收款 ¥' + payment.amount + '：' + label, [
    '用户：' + (user ? user.username : payment.username || ''),
    '套餐：' + label,
    '金额：¥' + payment.amount,
    '时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    '订单号：' + payment.out_trade_no,
    '',
    '数据仪表盘：https://notice.yingyuzuowen.asia/dashboard.html'
  ]);
}

function normalizeEmailInput(value) {
  const contact = normalizeContactInput(value);
  if (!contact || contact.type !== 'email') return null;
  return contact.value;
}

function genericResetCodeMessage() {
  return '如果用户名和邮箱匹配，验证码会发送到你的邮箱。验证码10分钟内有效。';
}

async function sendPasswordResetEmail(email, code) {
  const text = [
    '你正在重置班级广播账号密码。',
    '',
    '验证码：' + code,
    '',
    '验证码10分钟内有效。若不是你本人操作，请忽略这封邮件。'
  ].join('\n');
  await getMailTransporter().sendMail({
    from: MAIL_FROM,
    to: email,
    subject: '班级广播密码重置验证码',
    text
  });
}

async function sendRegistrationEmail(email, code) {
  const text = [
    '你正在注册师行账号。',
    '',
    '验证码：' + code,
    '',
    '验证码10分钟内有效。若不是你本人操作，请忽略这封邮件。'
  ].join('\n');
  await getMailTransporter().sendMail({
    from: MAIL_FROM,
    to: email,
    subject: '师行注册验证码',
    text
  });
}

function passwordResetIdentity(req) {
  const username = String(req.body.username || '').trim();
  const email = normalizeEmailInput(req.body.email || req.body.contact);
  const user = username ? store.users.find(u => u.username === username) : null;
  const matched = !!(user && email && contactMatches(user, { type: 'email', value: email }));
  return { username, email, user, matched };
}

function findUserByEmail(email) {
  return store.users.find(user => normalizeEmailInput(user.registration_email || user.contact_value) === email);
}

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
  return (store.payments || []).find(p => p.out_trade_no === outTradeNo);
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
function extendBroadcastPlanDays(user, days) {
  const current = user.plan === 'yearly' && user.plan_expires ? Date.parse(user.plan_expires) : 0;
  const base = current && current > Date.now() ? current : Date.now();
  user.plan = 'yearly';
  user.plan_expires = new Date(base + days * 86400000).toISOString();
  dbStore.upsertUser(user);
  return user.plan_expires;
}

function broadcastInviterIsPaid(userId) {
  return (store.payments || []).some(p => p.user_id === userId && p.status === 'paid' && p.plan === 'yearly');
}

function rewardBroadcastReferralOnPurchase(user) {
  try {
    const claimed = dbStore.claimAppReferralReward('broadcast', user.id, 'purchase_rewarded_at');
    if (!claimed) return;
    const inviter = store.users.find(u => u.id === claimed.inviter_user_id);
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
    const inviter = store.users.find(u => u.id === claimed.inviter_user_id);
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

function markPaymentPaid(payment, normalized, raw) {
  if (payment.status === 'paid') return payment;
  const previousStatus = payment.status;
  const user = store.users.find(u => u.id === payment.user_id);
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


function normalizeCommentStudent(input) {
  const raw = input || {};
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(t => String(t || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const minLen = Math.min(Math.max(parseInt(raw.minLen || raw.min_len || 120, 10) || 120, 60), 500);
  const maxLen = Math.min(Math.max(parseInt(raw.maxLen || raw.max_len || 180, 10) || 180, minLen), 700);
  const concreteNote = String(
    raw.concreteNote || raw.concrete_note || raw.specificNote || raw.specific_note || raw.impression || raw.event || ''
  ).trim().slice(0, 500);
  return {
    name: String(raw.name || '').trim().slice(0, 30),
    gender: String(raw.gender || '未知').trim().slice(0, 10),
    schoolStage: String(raw.schoolStage || raw.school_stage || '小学').trim().slice(0, 10),
    performance: String(raw.performance || '良好').trim().slice(0, 30),
    style: String(raw.style || 'gentle').trim().slice(0, 30),
    styleLabel: String(raw.styleLabel || raw.style_label || '').trim().slice(0, 30),
    tags,
    concreteNote,
    minLen,
    maxLen
  };
}

function normalizeCommentRosterStudents(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 500).map((row, index) => {
    const student = normalizeCommentStudent(row);
    student.id = String(row && row.id || index + 1).slice(0, 64);
    student.comment = String(row && row.comment || '').slice(0, 3000);
    return student.name ? student : null;
  }).filter(Boolean);
}

function normalizeRosterName(value) {
  const name = String(value || '').trim().slice(0, 40);
  return name || ('花名册 ' + new Date().toLocaleDateString('zh-CN'));
}

function commentStyleLabel(style) {
  const labels = {
    gentle: '温柔鼓励型',
    serious: '严肃指正型',
    humorous: '幽默风趣型',
    elegant: '深沉文雅型',
    passionate: '激情澎湃型'
  };
  return labels[style] || style || '温柔鼓励型';
}

function commentStyleGuide(style) {
  const guides = {
    gentle: '语气温和，多给孩子信心，夸奖要落在具体表现上。',
    serious: '可以把问题说清楚，直接但不尖锐，像真正在帮学生改进。',
    humorous: '可以有一点轻松口吻，幽默要自然贴近学生，不要写成段子。',
    elegant: '句子可以更有文采和余味，但不要堆砌辞藻。',
    passionate: '可以多一点鼓励和期待，但要有真情实感，不要喊口号。'
  };
  return guides[style] || guides.gentle;
}

function deepseekChatCompletion(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.72
    });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY
      },
      timeout: 60000
    }, resp => {
      let raw = '';
      resp.on('data', chunk => raw += chunk);
      resp.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          return reject(new Error('DeepSeek 返回格式异常'));
        }
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          return reject(new Error(data.error && data.error.message || 'DeepSeek 请求失败'));
        }
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        resolve(String(content || '').trim());
      });
    });
    req.on('timeout', () => req.destroy(new Error('DeepSeek 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 作文学习：用 deepseek-v4-flash 直连，速度快；system+user 双角色，温度偏高更有文采
function learningGenerateAI(system, user, temperature = 1.3) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: LEARNING_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature,
      max_tokens: 3000
    });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY
      },
      timeout: 90000
    }, resp => {
      let raw = '';
      resp.on('data', chunk => raw += chunk);
      resp.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { return reject(new Error('DeepSeek 返回格式异常')); }
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          return reject(new Error(data.error && data.error.message || 'DeepSeek 请求失败'));
        }
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        resolve(String(content || '').trim());
      });
    });
    req.on('timeout', () => req.destroy(new Error('DeepSeek 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function deepseekChatStream(messages, opts, res) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      stream: true,
      temperature: opts && opts.temperature != null ? opts.temperature : 0.85,
      max_tokens: (opts && opts.max_tokens) || 800
    });
    const upstream = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY
      },
      timeout: 120000
    }, up => {
      if (up.statusCode < 200 || up.statusCode >= 300) {
        let raw = '';
        up.on('data', c => raw += c);
        up.on('end', () => {
          let msg = 'DeepSeek 请求失败';
          try { const j = JSON.parse(raw); msg = (j.error && j.error.message) || msg; } catch (e) {}
          reject(new Error(msg));
        });
        return;
      }
      up.on('data', chunk => { res.write(chunk); });
      up.on('end', () => resolve());
      up.on('error', reject);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('DeepSeek 请求超时')));
    upstream.on('error', reject);
    upstream.write(body);
    upstream.end();
  });
}

async function generateAICommentForStudent(student) {
  const stage = student.schoolStage || '小学';
  const systemInstruction = [
    '你是一位文笔很好、带了多年班的班主任，正在给【' + stage + '】学生写期末评语。',
    '评语是写给学生本人看的，必须用第二人称“你”。',
    '语气像班主任对自己学生说话：亲切、真诚、有分量，有文采但不端着。'
  ].join('\n');
  const styleLabel = student.styleLabel || commentStyleLabel(student.style);
  const concreteLine = student.concreteNote
    ? '老师提供的具体事例或印象：' + student.concreteNote
    : '老师没有提供具体事例。此时要把标签写成可感知的日常画面，不要虚构具体事件、考试分数、家庭情况或老师没有提供的经历。';
  const userPrompt = [
    '学生信息：',
    '姓名：' + student.name,
    '性别：' + (student.gender || '未知'),
    '学段：' + stage,
    '整体水平：' + student.performance,
    '语气风格：' + styleLabel + '。' + commentStyleGuide(student.style),
    '特点标签：' + (student.tags.length ? student.tags.join('、') : '无特别标签'),
    concreteLine,
    '',
    '请写一段期末评语，严格遵守：',
    '【风格要求】',
    '1. 语言要生动、温暖，可以用比喻、修辞，展现文采。',
    '2. 每条评语里比喻不超过两个，贵精不贵多；不要堆满华丽词。',
    '3. 开头方式要多变，不要固定套用“你让我想到一个词”“你就像班里的XX”“你是一个有XX的孩子”这类句式。',
    '4. 结尾方式也要自然变化：可以深情展望，可以温和叮嘱，也可以轻松幽默收住，但不要每次都喊口号。',
    '',
    '【个性化要求】',
    '1. 必须紧扣这个学生的标签特点来写，让人一读就知道写的是这个孩子，而不是放在谁身上都行的套话。',
    '2. 如果老师填了具体事例或印象，务必把它融入评语，作为最亮的细节；围绕真事展开，比空洞夸奖更重要。',
    '3. 如果没有具体事例，就把标签写成可感知的日常画面，而不是简单把标签换成同义的漂亮词。',
    '4. 不要虚构没有提供的具体人物、奖项、分数、家庭情况或事件。',
    '',
    '【分寸把握】',
    '1. 优点要夸得有画面感，让学生读到觉得“老师真的看见我了”。',
    '2. 缺点要提得具体但不伤人，像真正关心这个学生的班主任。',
    '3. 评价要兼顾学生当前水平：优秀的学生可以提出更高期待，暂时落后的学生要让他看到可走的下一步。',
    '4. 字数控制在 ' + student.minLen + '-' + student.maxLen + ' 字之间，只输出评语正文，不要加“评语：”等前缀。'
  ].join('\n');
  return deepseekChatCompletion([
    { role: 'system', content: systemInstruction },
    { role: 'user', content: userPrompt }
  ]);
}

function commentRewriteGuide(mode) {
  const guides = {
    sincere: {
      key: 'sincere',
      label: '更真诚',
      instruction: '减少套话和泛泛夸奖，让语气更像班主任真心对这个学生说话。情感要更具体、更稳，不要煽情过度。'
    },
    concrete: {
      key: 'concrete',
      label: '更具体',
      instruction: '把标签和具体事例写得更有画面感，让学生读到觉得老师确实看见了他的日常表现。不要新增未提供的事件。'
    },
    shorter: {
      key: 'shorter',
      label: '更短一点',
      instruction: '压缩表达，删掉重复和空泛句子，保留最有分量的观察、提醒和鼓励。整体比原文短一些。'
    },
    literary: {
      key: 'literary',
      label: '更有文采',
      instruction: '语言更生动、有一点文采和余味，但比喻不超过两个，不要堆砌辞藻，不要写成作文腔。'
    },
    balanced: {
      key: 'balanced',
      label: '温和提不足',
      instruction: '在肯定优点的同时，更自然地补上一点具体不足和下一步建议。语气要温和，不伤人，不说教。'
    }
  };
  return guides[mode] || guides.sincere;
}

async function rewriteAICommentForStudent(student, currentComment, mode) {
  const stage = student.schoolStage || '小学';
  const guide = commentRewriteGuide(mode);
  const systemInstruction = [
    '你是一位文笔很好、带了多年班的班主任，正在帮老师二次修改一段期末评语。',
    '评语是写给【' + stage + '】学生本人看的，必须用第二人称“你”。',
    '你要保留原评语中的真实观察和老师态度，只按指定方向改得更好。'
  ].join('\n');
  const concreteLine = student.concreteNote
    ? '老师提供的具体事例或印象：' + student.concreteNote
    : '老师没有提供具体事例。不能虚构具体事件、考试分数、家庭情况或老师没有提供的经历。';
  const userPrompt = [
    '学生信息：',
    '姓名：' + student.name,
    '性别：' + (student.gender || '未知'),
    '学段：' + stage,
    '整体水平：' + student.performance,
    '语气风格：' + (student.styleLabel || commentStyleLabel(student.style)) + '。' + commentStyleGuide(student.style),
    '特点标签：' + (student.tags.length ? student.tags.join('、') : '无特别标签'),
    concreteLine,
    '',
    '原评语：',
    currentComment,
    '',
    '改写方向：' + guide.label,
    guide.instruction,
    '',
    '改写要求：',
    '1. 只改写这段评语，不要另起炉灶，不要改变学生事实和老师原本判断。',
    '2. 必须继续紧扣学生标签；如果有具体事例或印象，要把它保留下来或写得更自然。',
    '3. 语言亲切、真诚、有分量，可以有文采，但比喻不超过两个。',
    '4. 优点要有画面感，缺点要具体但不伤人。',
    '5. 字数尽量控制在 ' + student.minLen + '-' + student.maxLen + ' 字之间；如果改写方向是“更短一点”，可以适当低于下限。',
    '6. 只输出改写后的评语正文，不要加“评语：”“修改版：”等前缀。'
  ].join('\n');
  return deepseekChatCompletion([
    { role: 'system', content: systemInstruction },
    { role: 'user', content: userPrompt }
  ]);
}

// ---------- 作文批改 AI ----------
// 通用 OpenAI 兼容接口调用（qwen / MiniMax 都走这个）
function openAICompatChat(options) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens || 4096
    });
    const req = https.request({
      hostname: options.hostname,
      path: options.apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + options.apiKey
      },
      timeout: options.timeoutMs || 120000
    }, resp => {
      let raw = '';
      resp.on('data', chunk => raw += chunk);
      resp.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          return reject(new Error(options.label + ' 返回格式异常'));
        }
        if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
          return reject(new Error(options.label + ' 错误[' + data.base_resp.status_code + ']：' + (data.base_resp.status_msg || '')));
        }
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          return reject(new Error(data.error && data.error.message || options.label + ' 请求失败 HTTP ' + resp.statusCode));
        }
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (typeof content === 'string' && content.trim()) return resolve(content.trim());
        if (Array.isArray(content)) {
          const joined = content.map(c => c && c.text || '').join('').trim();
          if (joined) return resolve(joined);
        }
        reject(new Error(options.label + ' 响应无内容'));
      });
    });
    req.on('timeout', () => req.destroy(new Error(options.label + ' 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function qwenOcrImage(imageDataUrl) {
  return openAICompatChat({
    label: 'OCR',
    hostname: 'dashscope.aliyuncs.com',
    apiPath: '/compatible-mode/v1/chat/completions',
    apiKey: QWEN_API_KEY,
    model: QWEN_OCR_MODEL,
    temperature: 0.01,
    maxTokens: 4096,
    timeoutMs: 90000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text', text: 'OCR文字识别任务。请逐字逐句抄录图片中的所有手写或印刷文字。严格要求：\n1. 不遗漏任何文字，包括标题、正文、标点\n2. 保持原文段落格式，每段之间用空行分隔\n3. 严禁创作、改写、纠错或补全任何内容，原文写什么就抄什么\n4. 如有多列文字，按从左到右、从上到下顺序识别\n5. 只输出识别到的文字，不要任何解释说明、不要加引号、不要加markdown标记' }
      ]
    }]
  });
}

// 推理模型（如 MiniMax-M2.7）会在正文里输出 <think>…</think> 思考过程，批改结果必须剥掉
function stripThinkBlocks(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
}

// 批改：MiniMax 多 key 轮询，全部失败再 fallback 到 DeepSeek
async function gradeEssayAI(prompt) {
  let lastErr = null;
  for (let i = 0; i < MINIMAX_API_KEYS.length; i++) {
    try {
      const result = await openAICompatChat({
        label: 'MiniMax',
        hostname: 'api.minimaxi.com',
        apiPath: '/v1/chat/completions',
        apiKey: MINIMAX_API_KEYS[i],
        model: MINIMAX_MODEL,
        temperature: 0.7,
        maxTokens: 8000,
        timeoutMs: 150000,
        messages: [{ role: 'user', content: prompt }]
      });
      const cleaned = stripThinkBlocks(result);
      if (cleaned) return { result: cleaned, model: MINIMAX_MODEL };
      throw new Error('MiniMax 返回内容为空');
    } catch (e) {
      lastErr = e;
      console.log('[ESSAY] MiniMax key[' + i + '] 失败:', e.message);
    }
  }
  if (DEEPSEEK_API_KEY) {
    console.log('[ESSAY] MiniMax 全部失败，fallback 到 DeepSeek');
    const result = stripThinkBlocks(await deepseekChatCompletion([{ role: 'user', content: prompt }]));
    if (result) return { result, model: DEEPSEEK_MODEL };
  }
  throw lastErr || new Error('AI 批改服务暂不可用');
}

function essayAIConfigured() {
  return MINIMAX_API_KEYS.length > 0 || !!DEEPSEEK_API_KEY;
}

const ESSAY_GENRES = ['记叙文', '议论文', '说明文', '抒情散文'];
const ESSAY_GRADE_LEVELS = [
  '小学三年级', '小学四年级', '小学五年级', '小学六年级',
  '初一', '初二', '初三',
  '高一', '高二', '高三'
];
// '百分制' 为旧版兼容值，等同 '满分100分'
const ESSAY_SCORE_TYPES = ['满分100分', '满分60分', '满分50分', '满分40分', '满分30分', '等级制', '百分制'];

function essayTeacherStage(gradeLevel) {
  if (gradeLevel.indexOf('小学') === 0) return '小学';
  if (gradeLevel.indexOf('高') === 0) return '高中';
  return '初中';
}

function essayScoreRule(scoreType) {
  if (scoreType === '等级制') {
    return {
      instruction: '等级制，分为 A/B/C/D 四等（A为优秀），各维度和总分都给等级',
      detailLine: '【评分详情】立意:X等 内容:X等 结构:X等 语言:X等 卷面:X等 总评等级:X等'
    };
  }
  const m = String(scoreType).match(/\d+/);
  const full = m ? m[0] : '100';
  return {
    instruction: '满分 ' + full + ' 分制（考场作文分值），立意/内容/结构/语言/卷面各维度分值按比例分配，五项之和等于总分，总分不得超过 ' + full + ' 分',
    detailLine: '【评分详情】立意:XX分 内容:XX分 结构:XX分 语言:XX分 卷面:XX分 总分:XX分（满分' + full + '分）'
  };
}

// 八个固定评价维度（雷达图用），顺序固定
const ESSAY_DIMENSIONS = ['内容', '结构', '语言', '立意', '选材', '情感', '书写', '卷面'];

function buildEssayPrompt(text, genre, gradeLevel, scoreType, taskContext) {
  const stage = essayTeacherStage(gradeLevel);
  const m = String(scoreType).match(/\d+/);
  const full = (scoreType === '等级制') ? 100 : (m ? parseInt(m[0]) : 100);
  const isGrade = scoreType === '等级制';
  const totalRule = isGrade
    ? '等级制：display_total 给 A/B/C/D 等第（A为优秀），total_100 给对应的百分制数值（A≈92,B≈82,C≈72,D≈60 上下浮动），score_unit 填 "等"。'
    : '满分 ' + full + ' 分制：display_total 给本卷实际得分（不超过 ' + full + '），total_100 给换算到百分制的数值，score_unit 填 "/ ' + full + ' 分"。';
  const task = taskContext || {};
  const taskBlock = (task.title || task.material || task.requirements || (task.rubric && task.rubric.dimensions && task.rubric.dimensions.length))
    ? '\n【本次作文任务】\n题目：' + (task.title || '未填写') + '\n材料：' + (task.material || '无') + '\n写作要求：' + (task.requirements || '按年级通用要求')
      + '\n字数范围：' + (task.min_words || 0) + '-' + (task.max_words || 0)
      + '\n评分维度与权重：' + ((task.rubric && task.rubric.dimensions || []).map(d => d.name + ' ' + d.weight + '%').join('、') || '采用通用八维标准') + '\n'
    : '';
  return '你是一位资深' + stage + '语文教师，现在批改一篇' + gradeLevel + '学生写的' + genre + '。'
    + '评价标准必须符合' + gradeLevel + '学生的真实写作水平：不拔高、不放水，像真实的' + stage + '老师判卷一样。\n\n'
    + taskBlock
    + '【作文全文】\n' + text + '\n\n'
    + '【输出要求】只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块包裹。JSON 结构如下：\n'
    + '{\n'
    + '  "dimensions": [八个对象，name 依次为 内容、结构、语言、立意、选材、情感、书写、卷面，每个 score 为 0-100 的整数],\n'
    + '  "total_100": 0-100 的整数（综合得分，换算到百分制）,\n'
    + '  "display_total": "用于醒目展示的总分文字（见评分制说明）",\n'
    + '  "score_unit": "分值单位文字",\n'
    + '  "grade_label": "一句话等第，如 良·上 / 优 / 中等偏上",\n'
    + '  "annotations": [每个原文自然段一个对象 {"para":"该段原文（可截取前句）","comment":"针对该段的旁批，指出具体问题或亮点"}],\n'
    + '  "comments": {\n'
    + '    "strict": "严厉口吻的尾批总评，直指问题，3-5句",\n'
    + '    "warm": "温暖体察口吻的尾批总评，3-5句",\n'
    + '    "cheer": "鼓励成长口吻的尾批总评，3-5句"\n'
    + '  },\n'
    + '  "polish": [每个自然段一个对象 {"orig":"该段原文","polished":"保持学生原意、提升语言后的润色范文"}]\n'
    + '}\n\n'
    + '【评分制说明】' + totalRule + '\n'
    + '【注意】dimensions 必须正好 8 个且 name 完全按上述顺序；annotations 和 polish 的条数与作文自然段数一致；所有文本用中文；只输出 JSON。';
}

// 从模型输出里抠出 JSON 对象（容忍 ```json 围栏、<think> 残留、前后多余文字）
function extractEssayJson(raw) {
  let s = stripThinkBlocks(raw);
  s = s.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  // 从第一个 { 开始做括号配平，找到匹配的结尾 }
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}

// 规整结构化批改数据：补齐 8 维度、夹紧分数范围
function normalizeEssayData(data) {
  if (!data || typeof data !== 'object') return null;
  const clamp = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const dimMap = {};
  (Array.isArray(data.dimensions) ? data.dimensions : []).forEach(d => {
    if (d && d.name) dimMap[String(d.name).trim()] = clamp(d.score);
  });
  const dimensions = ESSAY_DIMENSIONS.map(name => ({ name, score: dimMap[name] != null ? dimMap[name] : (Number(data.total_100) ? clamp(data.total_100) : 0) }));
  return {
    structured: true,
    dimensions,
    total_100: clamp(data.total_100),
    display_total: String(data.display_total || data.total_100 || '').slice(0, 12),
    score_unit: String(data.score_unit || '').slice(0, 12),
    grade_label: String(data.grade_label || '').slice(0, 20),
    annotations: (Array.isArray(data.annotations) ? data.annotations : []).map(a => ({
      para: String(a && a.para || '').slice(0, 1000),
      comment: String(a && a.comment || '').slice(0, 1000)
    })),
    comments: {
      strict: String(data.comments && data.comments.strict || '').slice(0, 2000),
      warm: String(data.comments && data.comments.warm || '').slice(0, 2000),
      cheer: String(data.comments && data.comments.cheer || '').slice(0, 2000)
    },
    polish: (Array.isArray(data.polish) ? data.polish : []).map(p => ({
      orig: String(p && p.orig || '').slice(0, 2000),
      polished: String(p && p.polished || '').slice(0, 2000)
    }))
  };
}

// 把结构化数据转成旧版纯文本（批量批改 / Word 导出 / 历史展示沿用旧解析，保持兼容）
function essayDataToLegacyText(d) {
  let t = '';
  d.annotations.forEach((a, i) => { t += '第' + (i + 1) + '段旁批：' + a.comment + '\n'; });
  t += '\n尾批部分：\n';
  t += '【总评】' + (d.grade_label || '') + '\n';
  t += '【评分详情】' + d.dimensions.map(x => x.name + ':' + x.score).join(' ') + ' 总评:' + (d.display_total || d.total_100) + (d.score_unit || '') + '\n';
  t += '【教师评语】' + (d.comments.warm || d.comments.strict || '') + '\n';
  return t.trim();
}

const ENGLISH_TASK_TYPES = ['初中日常作文', '中考作文', '高中应用文', '读后续写'];
const ENGLISH_RUBRIC_PRESETS = Object.freeze({
  '初中日常作文': Object.freeze([
    { name: '任务完成', weight: 25 }, { name: '内容要点', weight: 25 },
    { name: '语言准确', weight: 20 }, { name: '词汇句式', weight: 15 },
    { name: '结构衔接', weight: 10 }, { name: '书写规范', weight: 5 }
  ]),
  '中考作文': Object.freeze([
    { name: '任务完成', weight: 25 }, { name: '内容要点', weight: 20 },
    { name: '语言准确', weight: 25 }, { name: '词汇句式', weight: 15 },
    { name: '结构衔接', weight: 10 }, { name: '书写规范', weight: 5 }
  ]),
  '高中应用文': Object.freeze([
    { name: '任务完成', weight: 30 }, { name: '内容完整', weight: 20 },
    { name: '语言质量', weight: 20 }, { name: '篇章组织', weight: 15 },
    { name: '文体得体', weight: 10 }, { name: '格式规范', weight: 5 }
  ]),
  '读后续写': Object.freeze([
    { name: '情节合理', weight: 25 }, { name: '原文衔接', weight: 20 },
    { name: '人物主题', weight: 15 }, { name: '语言表达', weight: 20 },
    { name: '篇章连贯', weight: 15 }, { name: '细节丰富', weight: 5 }
  ])
});

function englishRubricFor(taskType, assignment) {
  const custom = assignment && assignment.rubric && Array.isArray(assignment.rubric.dimensions)
    ? assignment.rubric.dimensions.filter(item => item && item.name)
    : [];
  const source = custom.length ? custom : (ENGLISH_RUBRIC_PRESETS[taskType] || ENGLISH_RUBRIC_PRESETS['中考作文']);
  const total = source.reduce((sum, item) => sum + (Number(item.weight) || 0), 0) || 100;
  return source.map(item => ({
    name: String(item.name || '').trim().slice(0, 30),
    weight: Math.round((Number(item.weight) || 0) * 10000 / total) / 100
  }));
}

function englishFullScore(scoreType) {
  const match = String(scoreType || '').match(/\d+/);
  return Math.max(1, Math.min(100, match ? Number(match[0]) : 20));
}

function buildEnglishEssayPrompt(text, taskType, gradeLevel, scoreType, assignment) {
  const rubric = englishRubricFor(taskType, assignment);
  const fullScore = englishFullScore(scoreType);
  const task = assignment || {};
  const wordCount = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const rubricText = rubric.map(item => item.name + ' ' + item.weight + '%').join('；');
  return [
    '你是一名有多年一线教学和阅卷经验的中国中学英语教师。请批改学生英语作文。',
    '你的任务是帮助教师判断和修改，而不是替学生代写。评分应符合学生学段，修改稿必须保留原意、原有水平和个人表达，不得改写成明显超出学生水平的范文。',
    '',
    '【学段与题型】' + gradeLevel + ' · ' + taskType,
    '【总分】' + fullScore + '分',
    '【作文题目】' + (task.title || '未填写'),
    '【题目材料】' + (task.material || '无'),
    '【写作要求】' + (task.requirements || '按该学段和题型的常规要求'),
    '【字数要求】' + (task.min_words || 0) + '-' + (task.max_words || 0) + '词；实写约' + wordCount + '词',
    '【评分维度】' + rubricText,
    '',
    '【学生原文】',
    text,
    '',
    '【评分规则】',
    '1. 先根据整篇表现判断档次，再在各维度内给分；维度 score 一律为0-100的质量分。',
    '2. 每个维度必须给出原文证据和中文理由；同一错误不能在多个维度重复扣分。',
    '3. 漏写要点、字数不足、格式错误等硬性问题放入 deductions；维度分中已经反映的问题不要二次扣除。',
    '4. 逐句问题分类限定为：语法、拼写、搭配、中式英语、衔接、标点格式、亮点。中文解释要让中国学生看得懂，英文建议要尽量小改。',
    '5. suggestion_en 只给局部修改；revised_version 才给完整修改稿，但必须保持学生原有水平。',
    '',
    '只输出一个合法 JSON 对象，不要 markdown，不要解释。结构：',
    JSON.stringify({
      band: '档次名称',
      dimensions: rubric.map(item => ({ name: item.name, weight: item.weight, score: 0, evidence: '原文证据', reason_zh: '中文评分理由' })),
      deductions: [{ type: '字数/漏点/格式', points: 0, evidence: '依据' }],
      annotations: [{ quote: '原句或短语', category: '语法', explanation_zh: '中文解释', suggestion_en: '英文修改建议', confidence: 0.9 }],
      strengths: ['具体优点'],
      overall_feedback_zh: '给学生的中文总评',
      next_steps: ['下一步练习建议'],
      revised_version: '保留学生水平的完整英文修改稿'
    })
  ].join('\n');
}

function normalizeEnglishEssayData(data, taskType, scoreType, assignment, originalText) {
  if (!data || typeof data !== 'object') return null;
  const clamp = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const rubric = englishRubricFor(taskType, assignment);
  const source = new Map((Array.isArray(data.dimensions) ? data.dimensions : []).map(item => [String(item && item.name || '').trim(), item || {}]));
  const dimensions = rubric.map(item => {
    const raw = source.get(item.name) || {};
    return {
      name: item.name,
      weight: item.weight,
      score: clamp(raw.score),
      evidence: String(raw.evidence || '').slice(0, 800),
      reason_zh: String(raw.reason_zh || raw.reason || '').slice(0, 1200)
    };
  });
  const total100 = clamp(dimensions.reduce((sum, item) => sum + item.score * item.weight / 100, 0));
  const fullScore = englishFullScore(scoreType);
  const actualScore = Math.max(0, Math.min(fullScore, Math.round(total100 * fullScore) / 100));
  const annotations = (Array.isArray(data.annotations) ? data.annotations : []).slice(0, 80).map(item => ({
    quote: String(item && item.quote || '').slice(0, 1000),
    category: String(item && item.category || '语言表达').slice(0, 20),
    explanation_zh: String(item && (item.explanation_zh || item.explanation) || '').slice(0, 1200),
    suggestion_en: String(item && (item.suggestion_en || item.suggestion) || '').slice(0, 1200),
    confidence: Math.max(0, Math.min(1, Number(item && item.confidence) || 0.7)),
    status: 'pending'
  })).filter(item => item.quote || item.explanation_zh || item.suggestion_en);
  return {
    structured: true,
    task_type: taskType,
    grade_level: String(assignment && assignment.grade_level || ''),
    full_score: fullScore,
    total_100: total100,
    actual_score: actualScore,
    display_total: actualScore + '/' + fullScore,
    band: String(data.band || '').slice(0, 30),
    word_count: String(originalText || '').trim().split(/\s+/).filter(Boolean).length,
    dimensions,
    deductions: (Array.isArray(data.deductions) ? data.deductions : []).slice(0, 12).map(item => ({
      type: String(item && item.type || '').slice(0, 30),
      points: Math.max(0, Number(item && item.points) || 0),
      evidence: String(item && item.evidence || '').slice(0, 800)
    })).filter(item => item.type),
    annotations,
    strengths: (Array.isArray(data.strengths) ? data.strengths : []).slice(0, 8).map(item => String(item || '').slice(0, 600)).filter(Boolean),
    overall_feedback_zh: String(data.overall_feedback_zh || '').slice(0, 3000),
    next_steps: (Array.isArray(data.next_steps) ? data.next_steps : []).slice(0, 6).map(item => String(item || '').slice(0, 600)).filter(Boolean),
    revised_version: String(data.revised_version || '').slice(0, 8000),
    teacher_review_required: true
  };
}

function englishDataToText(data) {
  return [
    '总分：' + data.display_total + (data.band ? ' · ' + data.band : ''),
    '维度：' + data.dimensions.map(item => item.name + ' ' + item.score).join('；'),
    '总评：' + data.overall_feedback_zh,
    '下一步：' + data.next_steps.join('；')
  ].join('\n');
}

// OCR 每用户每日限额（防滥用，内存计数，重启清零）
const essayOcrUsage = new Map();
function essayOcrAllowed(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const rec = essayOcrUsage.get(userId);
  if (!rec || rec.day !== today) {
    if (essayOcrUsage.size > 5000) essayOcrUsage.clear();
    essayOcrUsage.set(userId, { day: today, count: 1 });
    return true;
  }
  if (rec.count >= ESSAY_OCR_DAILY_LIMIT) return false;
  rec.count++;
  return true;
}

// ---------- Middleware ----------
// limit 提高到 10mb：作文批改 OCR 要上传 base64 图片
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.get('/invite/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const inviter = dbStore.findUnifiedInviterByCode(code);
  if (!inviter) return res.status(404).send('邀请码无效');
  const source = String(req.query.source || 'shixing').slice(0, 30);
  const cookies = parseCookieHeader(req.headers.cookie);
  let deviceId = String(cookies[DEVICE_COOKIE_NAME] || '');
  if (!deviceId) {
    deviceId = crypto.randomBytes(18).toString('base64url');
    res.cookie(DEVICE_COOKIE_NAME, deviceId, deviceCookieOptions(req));
  }
  const clickedAt = new Date().toISOString();
  dbStore.recordUnifiedReferralClick({
    click_token: crypto.randomBytes(18).toString('base64url'),
    inviter_user_id: inviter.id,
    invite_code: code,
    source_product: source,
    device_hash: crypto.createHash('sha256').update(deviceId).digest('hex'),
    ip_hash: crypto.createHmac('sha256', INVITE_COOKIE_SECRET).update(String(req.ip || '')).digest('hex'),
    clicked_at: clickedAt,
    expires_at: new Date(Date.parse(clickedAt) + INVITE_COOKIE_MAX_AGE_MS).toISOString()
  });
  res.cookie(INVITE_COOKIE_NAME, encodeInviteCookie({
    code,
    source,
    exp: Date.now() + INVITE_COOKIE_MAX_AGE_MS
  }), referralCookieOptions(req));
  return res.sendFile(path.join(__dirname, 'public', 'shixing', 'invite.html'));
});
app.get('/invite.html', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'shixing', 'invite.html'));
});
app.get('/dashboard.html', (req, res) => {
  return res.redirect(302, '/admin.html#overview');
});
app.get('/', (req, res, next) => {
  if (shixingHost(req)) return res.sendFile(path.join(__dirname, 'public', 'shixing', 'index.html'));
  if (commentHost(req)) return res.sendFile(path.join(__dirname, 'public', 'comment.html'));
  if (essayHost(req)) return res.sendFile(path.join(__dirname, 'public', 'zuowen.html'));
  if (englishHost(req)) return res.sendFile(path.join(__dirname, 'public', 'english.html'));
  if (roundtableHost(req)) return res.sendFile(path.join(__dirname, 'public', 'roundtable', 'index.html'));
  if (learningHost(req)) return res.sendFile(path.join(__dirname, 'public', 'xiezuo.html'));
  next();
});
app.get('/essay/revise/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'essay-revise.html')));
app.get('/english/revise/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'english-revise.html')));
app.use(express.static(path.join(__dirname, 'public')));

function userAuth(req, res, next) {
  const token = authTokenFromReq(req);
  if (!token) return res.status(401).json({ error: '请先登录' });
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ error: '登录已过期，请重新登录' });
  refreshUserTokenExpiry(user);
  req.user = user;
  req.planStatus = getUserPlanStatus(user);
  next();
}

// 管理员认证失败限流：同一 IP 15分钟内最多失败10次
const adminAuthFailures = new Map();
const adminSessions = new Map();
const ADMIN_FAIL_LIMIT = 10;
const ADMIN_FAIL_WINDOW_MS = 15 * 60 * 1000;

function adminAuth(req, res, next) {
  if (ADMIN_PASS_IS_DEFAULT) {
    return res.status(503).json({ error: '管理后台未启用：请先在服务器设置 ADMIN_PASS 环境变量' });
  }
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = adminAuthFailures.get(ip);
  if (rec && now - rec.first < ADMIN_FAIL_WINDOW_MS && rec.count >= ADMIN_FAIL_LIMIT) {
    return res.status(429).json({ error: '尝试次数过多，请15分钟后再试' });
  }
  const headerToken = String(req.headers['x-token'] || '');
  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionToken = String(cookies[ADMIN_COOKIE_NAME] || '');
  const session = sessionToken ? adminSessions.get(sessionToken) : null;
  const headerValid = !!headerToken && safeEqual(headerToken, ADMIN_PASS);
  const sessionValid = !!session && session.expires_at > now;
  if (!headerValid && !sessionValid) {
    if (sessionToken && session && session.expires_at <= now) adminSessions.delete(sessionToken);
    if (!rec || now - rec.first >= ADMIN_FAIL_WINDOW_MS) {
      if (adminAuthFailures.size > 1000) adminAuthFailures.clear();
      adminAuthFailures.set(ip, { first: now, count: 1 });
    } else {
      rec.count++;
    }
    return res.status(401).json({ error: '管理员密码错误' });
  }
  adminAuthFailures.delete(ip);
  req.admin_session_token = sessionValid ? sessionToken : '';
  req.admin_actor = sessionValid ? 'web-session' : 'header-token';
  next();
}

function adminCookieOptions(req) {
  const options = {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: ADMIN_SESSION_TTL_MS
  };
  if (cookieSecure(req)) options.secure = true;
  return options;
}

function clearAdminCookie(req, res) {
  const options = adminCookieOptions(req);
  delete options.maxAge;
  res.clearCookie(ADMIN_COOKIE_NAME, options);
}

function adminIpHash(req) {
  return crypto.createHmac('sha256', INVITE_COOKIE_SECRET).update(String(req.ip || '')).digest('hex');
}

function auditAdmin(req, row) {
  try {
    dbStore.insertAdminAuditLog({
      ...row,
      ip_hash: adminIpHash(req),
      created_at: new Date().toISOString(),
      extra_json: { actor: req.admin_actor || 'web-session', ...(row.extra_json || {}) }
    });
  } catch (e) {
    console.log('[ADMIN] audit log failed:', e.message);
  }
}

app.post('/api/admin/login', (req, res) => {
  if (ADMIN_PASS_IS_DEFAULT) return res.status(503).json({ error: '管理后台未启用' });
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = adminAuthFailures.get(ip);
  if (rec && now - rec.first < ADMIN_FAIL_WINDOW_MS && rec.count >= ADMIN_FAIL_LIMIT) {
    return res.status(429).json({ error: '尝试次数过多，请15分钟后再试' });
  }
  const password = String(req.body && req.body.password || '');
  if (!password || !safeEqual(password, ADMIN_PASS)) {
    if (!rec || now - rec.first >= ADMIN_FAIL_WINDOW_MS) {
      if (adminAuthFailures.size > 1000) adminAuthFailures.clear();
      adminAuthFailures.set(ip, { first: now, count: 1 });
    } else rec.count++;
    return res.status(401).json({ error: '管理员密码错误' });
  }
  adminAuthFailures.delete(ip);
  if (adminSessions.size > 1000) {
    const now = Date.now();
    for (const [token, session] of adminSessions) if (session.expires_at <= now) adminSessions.delete(token);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  adminSessions.set(token, { expires_at: Date.now() + ADMIN_SESSION_TTL_MS });
  res.cookie(ADMIN_COOKIE_NAME, token, adminCookieOptions(req));
  res.json({ ok: true, expires_at: new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString() });
});

app.get('/api/admin/session', adminAuth, (req, res) => {
  res.json({ ok: true });
});

app.post('/api/admin/logout', adminAuth, (req, res) => {
  if (req.admin_session_token) adminSessions.delete(req.admin_session_token);
  clearAdminCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/analytics/event', (req, res) => {
  if (!analyticsRequestAllowed(req)) return res.status(429).json({ error: '请求过于频繁' });
  const eventName = String(req.body && req.body.event_name || '');
  const product = String(req.body && req.body.product || '').toLowerCase();
  const visitorId = String(req.body && req.body.visitor_id || '');
  if (!ANALYTICS_EVENTS.has(eventName) || !ANALYTICS_PRODUCTS.has(product) || !validAnalyticsVisitorId(visitorId)) {
    return res.status(400).json({ error: '统计事件无效' });
  }
  const recorded = recordAnalyticsFromRequest(req, res, eventName, {
    visitor_id: visitorId,
    product,
    path: req.body.path,
    source: req.body.source,
    referrer: req.body.referrer,
    referrer_host: req.body.referrer_host
  });
  if (!recorded) return res.status(500).json({ error: '统计暂不可用' });
  res.status(202).json({ ok: true });
});

function requireActivePlan(req, res, next) {
  if (!req.planStatus.active) {
    return res.status(403).json({ error: '您的使用期限已到，请续费后继续使用', plan_status: req.planStatus });
  }
  next();
}

// ---------- User API ----------
app.post('/api/register/send-code', async (req, res) => {
  if (!mailConfigured()) {
    return res.status(503).json({ error: '邮箱验证码服务暂未配置，请联系管理员' });
  }

  const email = normalizeEmailInput(req.body.email);
  if (!email) return res.status(400).json({ error: '请输入有效邮箱地址' });
  if (findUserByEmail(email)) return res.status(400).json({ error: '该邮箱已注册，请直接登录' });

  const now = Date.now();
  const requestIp = req.ip || 'unknown';
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  if (dbStore.countRegistrationEmailCodesByIp(requestIp, hourAgo) >= REGISTRATION_CODE_IP_HOURLY_LIMIT) {
    return res.status(429).json({ error: '当前网络请求过于频繁，请1小时后再试' });
  }

  const recent = dbStore.getRecentRegistrationEmailCode(email, new Date(now - REGISTRATION_CODE_COOLDOWN_MS).toISOString());
  if (recent) return res.status(429).json({ error: '验证码已发送，请60秒后再试' });

  const code = genResetCode();
  const { hash, salt } = hashPassword(code);
  const row = dbStore.insertRegistrationEmailCode({
    email,
    request_ip: requestIp,
    code_hash: hash,
    code_salt: salt,
    attempts: 0,
    expires_at: new Date(now + REGISTRATION_CODE_TTL_MS).toISOString(),
    created_at: new Date(now).toISOString()
  });
  dbStore.pruneRegistrationEmailCodes(1000);

  try {
    await sendRegistrationEmail(email, code);
    recordAnalyticsFromRequest(req, res, 'code_request', { product: analyticsProductFromReq(req) });
    res.json({ ok: true, message: '验证码已发送到邮箱，10分钟内有效。' });
  } catch (e) {
    dbStore.deleteRegistrationEmailCode(row.id);
    console.log('[MAIL] registration code send failed:', e.message);
    res.status(500).json({ error: '验证码邮件发送失败，请联系管理员检查邮箱配置' });
  }
});

app.post('/api/register', (req, res) => {
  const { username, password, display_name } = req.body;
  const email = normalizeEmailInput(req.body.email);
  const code = String(req.body.code || '').trim();
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名2-20个字符' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少4位' });
  if (!email) return res.status(400).json({ error: '请输入有效邮箱地址' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '请输入6位邮箱验证码' });
  if (store.users.find(u => u.username === username)) {
    return res.status(400).json({ error: '用户名已存在' });
  }
  if (findUserByEmail(email)) return res.status(400).json({ error: '该邮箱已注册，请直接登录' });

  const codeRow = dbStore.getLatestRegistrationEmailCode(email);
  if (!codeRow || Date.parse(codeRow.expires_at) < Date.now() || codeRow.attempts >= REGISTRATION_CODE_MAX_ATTEMPTS) {
    return res.status(400).json({ error: '验证码不正确或已过期，请重新获取' });
  }
  if (!verifyPassword(code, codeRow.code_hash, codeRow.code_salt)) {
    dbStore.incrementRegistrationEmailCodeAttempts(codeRow.id);
    return res.status(400).json({ error: '验证码不正确或已过期，请重新获取' });
  }
  const referralAttribution = referralAttributionFromReq(req);
  if (referralAttribution.error) return res.status(400).json({ error: referralAttribution.error });
  if (!dbStore.markRegistrationEmailCodeUsed(codeRow.id)) {
    return res.status(400).json({ error: '验证码已使用，请重新获取' });
  }

  const { hash, salt } = hashPassword(password);
  const token = genToken();
  const user = {
    id: crypto.randomUUID(),
    username,
    display_name: display_name || username,
    teacher_code: genUniqueTeacherCode(),
    contact_type: 'email',
    contact_value: email,
    registration_email: email,
    password_hash: hash,
    password_salt: salt,
    plan: 'trial',
    plan_expires: null,
    token,
    token_expires: new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString(),
    created_at: new Date().toISOString()
  };
  let referralResult = { bound: false };
  try {
    referralResult = dbStore.registerUserWithReferral(user, referralAttribution.provided ? {
      inviter_user_id: referralAttribution.inviter.id,
      invite_code: referralAttribution.code,
      source_product: referralAttribution.source_product,
      device_hash: referralAttribution.device_hash
    } : null);
  } catch (e) {
    console.log('[REFERRAL] registration bind failed:', e.message, '\n', e.stack);
    return res.status(500).json({ error: '注册未完成，请稍后重试' });
  }
  store.users.push(user);
  notifyAdminNewUser(user);
  const status = getUserPlanStatus(user);
  setAuthCookie(req, res, token);
  recordAnalyticsFromRequest(req, res, 'registration_success', {
    product: analyticsProductFromReq(req),
    user_id: user.id
  });
  if (referralAttribution.provided) clearInviteCookie(req, res);
  res.json({
    ok: true,
    token,
    user: { id: user.id, username: user.username, display_name: user.display_name, teacher_code: user.teacher_code, contact_value: user.contact_value },
    plan_status: status,
    referral: referralAttribution.provided ? {
      bound: !!referralResult.bound,
      inviter_name: referralAttribution.inviter.display_name || referralAttribution.inviter.username,
      activation_inviter_points: REFERRAL_REWARDS.activation_inviter_points,
      activation_invitee_points: REFERRAL_REWARDS.activation_invitee_points
    } : { bound: false }
  });
});

app.get('/api/referral/context', (req, res) => {
  const bodyCode = String(req.query.code || '').trim().toUpperCase();
  const payload = invitePayloadFromReq(req);
  const code = bodyCode || String(payload && payload.code || '').trim().toUpperCase();
  if (!code) return res.json({ ok: true, valid: false });
  const inviter = dbStore.findUnifiedInviterByCode(code);
  if (!inviter) return res.status(404).json({ ok: false, valid: false, error: '邀请码无效' });
  res.json({
    ok: true,
    valid: true,
    code,
    inviter_name: inviter.display_name || inviter.username,
    signup_points: 1625,
    broadcast_trial_days: FREE_TRIAL_DAYS,
    activation_reward_points: REFERRAL_REWARDS.activation_invitee_points
  });
});

app.get('/api/referral', userAuth, (req, res) => {
  const center = dbStore.getUnifiedReferralCenter(req.user.id);
  res.json({
    ok: true,
    ...center,
    link: 'https://shixing.yingyuzuowen.asia/invite/' + encodeURIComponent(center.code),
    activation_inviter_points: REFERRAL_REWARDS.activation_inviter_points,
    activation_invitee_points: REFERRAL_REWARDS.activation_invitee_points,
    first_purchase_points: REFERRAL_REWARDS.first_purchase_points,
    first_purchase_broadcast_days: REFERRAL_REWARDS.first_purchase_broadcast_days,
    activation_monthly_limit: REFERRAL_REWARDS.activation_monthly_auto_limit
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const user = store.users.find(u => u.username === username);
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  issueUserToken(user);
  if (!user.teacher_code) user.teacher_code = genUniqueTeacherCode();
  dbStore.upsertUser(user);
  const status = getUserPlanStatus(user);
  setAuthCookie(req, res, user.token);
  recordAnalyticsFromRequest(req, res, 'login_success', {
    product: analyticsProductFromReq(req),
    user_id: user.id
  });
  res.json({ ok: true, token: user.token, user: { id: user.id, username: user.username, display_name: user.display_name, teacher_code: user.teacher_code }, plan_status: status });
});

app.post('/api/logout', (req, res) => {
  const token = authTokenFromReq(req);
  const user = token ? store.users.find(u => u.token === token) : null;
  if (user) revokeUserToken(user); // 服务端吊销，不只是清 cookie
  clearAuthCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/password-reset/send-code', async (req, res) => {
  if (!mailConfigured()) {
    return res.status(503).json({ error: '邮箱验证码服务暂未配置，请联系管理员' });
  }

  const identity = passwordResetIdentity(req);
  if (!identity.username || !identity.email) {
    return res.status(400).json({ error: '请输入用户名和注册时填写的邮箱' });
  }

  if (!identity.matched) {
    return res.json({ ok: true, message: genericResetCodeMessage() });
  }

  const since = new Date(Date.now() - RESET_CODE_COOLDOWN_MS).toISOString();
  const recent = dbStore.getRecentPasswordResetCode(identity.user.id, since);
  if (recent) {
    return res.json({ ok: true, message: '验证码已发送，请稍后查看邮箱。若没有收到，请60秒后再试。' });
  }

  const code = genResetCode();
  const { hash, salt } = hashPassword(code);
  dbStore.insertPasswordResetCode({
    user_id: identity.user.id,
    username: identity.user.username,
    email: identity.email,
    code_hash: hash,
    code_salt: salt,
    attempts: 0,
    expires_at: new Date(Date.now() + RESET_CODE_TTL_MS).toISOString(),
    created_at: new Date().toISOString()
  });
  dbStore.prunePasswordResetCodes(1000);

  try {
    await sendPasswordResetEmail(identity.email, code);
    res.json({ ok: true, message: genericResetCodeMessage() });
  } catch (e) {
    console.log('[MAIL] password reset send failed:', e.message);
    res.status(500).json({ error: '验证码邮件发送失败，请联系管理员检查邮箱配置' });
  }
});

app.post('/api/password-reset/verify-code', (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = normalizeEmailInput(req.body.email || req.body.contact);
  const code = String(req.body.code || '').trim();
  if (!username || !email || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '请输入用户名、邮箱和6位验证码' });
  }

  const row = dbStore.getLatestPasswordResetCode(username, email);
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now() || row.attempts >= RESET_CODE_MAX_ATTEMPTS) {
    return res.status(400).json({ error: '验证码不正确或已过期，请重新获取' });
  }

  if (!verifyPassword(code, row.code_hash, row.code_salt)) {
    dbStore.incrementPasswordResetCodeAttempts(row.id);
    return res.status(400).json({ error: '验证码不正确或已过期，请重新获取' });
  }

  const resetToken = genToken();
  const tokenHash = hashPassword(resetToken);
  dbStore.markPasswordResetCodeVerified(row.id, tokenHash.hash, tokenHash.salt);
  res.json({ ok: true, reset_token: resetToken, message: '验证通过，请设置新密码' });
});

app.post('/api/password-reset/confirm', (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = normalizeEmailInput(req.body.email || req.body.contact);
  const resetToken = String(req.body.reset_token || '').trim();
  const password = String(req.body.password || '');
  if (!username || !email || !resetToken) return res.status(400).json({ error: '请先完成邮箱验证码验证' });
  if (password.length < 4) return res.status(400).json({ error: '新密码至少4位' });

  const rows = dbStore.listVerifiedPasswordResetCodes(username, email);
  let matched = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const verifiedAt = Date.parse(row.verified_at || row.created_at);
    if (Date.now() - verifiedAt > RESET_TOKEN_TTL_MS) continue;
    if (row.token_hash && row.token_salt && verifyPassword(resetToken, row.token_hash, row.token_salt)) {
      matched = row;
      break;
    }
  }

  const user = store.users.find(u => u.username === username);
  if (!matched || !user || !contactMatches(user, { type: 'email', value: email })) {
    return res.status(400).json({ error: '重置凭证已失效，请重新获取验证码' });
  }

  setUserPassword(user, password);
  dbStore.markPasswordResetCodeUsed(matched.id);
  res.json({ ok: true, message: '密码已重置，请用新密码登录' });
});

app.post('/api/password-reset/request', (req, res) => {
  const username = String(req.body.username || '').trim();
  const contact = normalizeContactInput(req.body.contact);
  if (!username || !contact) return res.status(400).json({ error: '请输入用户名和注册时填写的邮箱或手机号码' });

  const user = store.users.find(u => u.username === username);
  if (contactMatches(user, contact)) {
    const request = {
      user_id: user.id,
      username: user.username,
      contact_value: contact.value,
      status: 'pending',
      requested_at: new Date().toISOString()
    };
    if (!store.password_reset_requests) store.password_reset_requests = [];
    store.password_reset_requests.push(request);
    dbStore.insertPasswordResetRequest(request);
  }

  res.json({
    ok: true,
    message: '如果账号与联系方式匹配，管理员会在后台看到你的重置申请。请联系管理员为你设置临时密码。'
  });
});

app.get('/api/profile', userAuth, (req, res) => {
  const u = req.user;
  const classCount = getVisibleClasses(u.id).length;
  const notifCount = store.notifications.filter(n => n.user_id === u.id).length;
  const featureSubscriptions = (store.feature_subscriptions || [])
    .filter(s => s.user_id === u.id)
    .map(s => s.feature_key);
  res.json({
    id: u.id, username: u.username, display_name: u.display_name, teacher_code: u.teacher_code,
    contact_type: u.contact_type || '', contact_value: u.contact_value || '',
    minutes_per_notice: Number(u.minutes_per_notice) || 3,
    avatar: u.avatar || 'a1',
    plan: u.plan, plan_expires: u.plan_expires, created_at: u.created_at,
    plan_status: req.planStatus,
    class_count: classCount,
    notif_count: notifCount,
    feature_subscriptions: featureSubscriptions
  });
});

app.post('/api/profile', userAuth, (req, res) => {
  const { display_name, avatar } = req.body;
  if (display_name !== undefined) {
    const name = String(display_name).trim();
    if (name.length < 1 || name.length > 20) return res.status(400).json({ error: '称呼1-20个字符' });
    req.user.display_name = name;
  }
  if (avatar !== undefined) {
    req.user.avatar = String(avatar).slice(0, 10);
  }
  if (req.body.contact !== undefined) {
    const contact = normalizeContactInput(req.body.contact);
    if (!contact) return res.status(400).json({ error: '请填写有效的邮箱或手机号码' });
    req.user.contact_type = contact.type;
    req.user.contact_value = contact.value;
  }
  if (req.body.minutes_per_notice !== undefined) {
    const minutes = normalizeMinutesPerNotice(req.body.minutes_per_notice);
    if (!minutes) return res.status(400).json({ error: '单次节省时间请设置为1-10分钟' });
    req.user.minutes_per_notice = minutes;
  }
  dbStore.upsertUser(req.user);
  res.json({
    ok: true,
    display_name: req.user.display_name,
    avatar: req.user.avatar || 'a1',
    contact_value: req.user.contact_value || '',
    minutes_per_notice: Number(req.user.minutes_per_notice) || 3
  });
});

app.post('/api/feedback', userAuth, (req, res) => {
  const content = String(req.body.content || '').trim();
  const category = String(req.body.category || '功能建议').trim().slice(0, 20) || '功能建议';
  if (content.length < 2) return res.status(400).json({ error: '请至少写两个字' });
  if (content.length > 1000) return res.status(400).json({ error: '反馈内容最多1000字' });
  const row = {
    user_id: req.user.id,
    username: req.user.username,
    display_name: getTeacherName(req.user),
    category,
    content,
    created_at: new Date().toISOString()
  };
  if (!store.feedback) store.feedback = [];
  store.feedback.push(row);
  if (store.feedback.length > 1000) store.feedback = store.feedback.slice(-1000);
  dbStore.insertFeedback(row);
  res.json({ ok: true, message: '已收到，谢谢你的反馈' });
});

app.post('/api/feature-subscriptions', userAuth, (req, res) => {
  const key = String(req.body.feature_key || '').trim();
  if (!ROADMAP_FEATURES[key]) return res.status(400).json({ error: '功能不存在' });
  if (!store.feature_subscriptions) store.feature_subscriptions = [];
  const existing = store.feature_subscriptions.find(s => s.user_id === req.user.id && s.feature_key === key);
  if (existing) {
    return res.json({ ok: true, feature_key: key, subscribed: true });
  }
  const row = {
    user_id: req.user.id,
    username: req.user.username,
    display_name: getTeacherName(req.user),
    feature_key: key,
    feature_name: ROADMAP_FEATURES[key],
    created_at: new Date().toISOString()
  };
  const saved = dbStore.upsertFeatureSubscription(row);
  store.feature_subscriptions.push(saved);
  res.json({ ok: true, feature_key: key, subscribed: true });
});

// ---------- Payment API ----------
app.get('/api/payments/config', userAuth, (req, res) => {
  res.json({
    enabled: yungouConfigured(),
    yearly_price: planPriceDisplay(),
    yearly_days: PAID_PLAN_DAYS
  });
});

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
  store.payments.push(payment);
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
            const inviter = store.users.find(u => u.id === claimed.inviter_user_id);
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

// ---------- 学生作文学习助手 API ----------
function requireLearningMember(req, res, next) {
  const status = dbStore.getLearningMembershipStatus(req.user);
  if (!status.active) return res.status(403).json({ error: '体验已结束，请开通学期卡或年卡', membership: status });
  req.learningMembership = status;
  next();
}

function learningUsageAllowed(userId) {
  return dbStore.countLearningUsageToday(userId) < LEARNING_DAILY_LIMIT;
}

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
  store.payments.push(payment);
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
  store.payments.push(payment);
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
  const inviter = store.users.find(u => String(u.teacher_code || '').toUpperCase() === ref);
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
  const usageCount = store.notifications.filter(n => n.user_id === req.user.id).length;
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
  store.payments.push(payment);
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
  store.payments.push(payment);
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

app.post('/api/payments/yearly', userAuth, async (req, res) => {
  if (!yungouConfigured()) {
    return res.status(503).json({ error: '微信支付暂未配置，请联系管理员' });
  }

  const outTradeNo = createPaymentOrderNo();
  const amount = planPriceDisplay();
  const baseUrl = getBaseUrl(req);
  const payment = {
    out_trade_no: outTradeNo,
    user_id: req.user.id,
    username: req.user.username,
    plan: 'yearly',
    plan_days: PAID_PLAN_DAYS,
    amount,
    status: 'created',
    created_at: new Date().toISOString()
  };
  store.payments.push(payment);
  dbStore.upsertPayment(payment);

  const requiredParams = {
    out_trade_no: outTradeNo,
    total_fee: amount,
    mch_id: YUNGOU_MCH_ID,
    body: '班级广播半年会员'
  };
  const params = {
    ...requiredParams,
    sign: yungouSign(requiredParams, YUNGOU_PAY_KEY),
    attach: req.user.id,
    notify_url: baseUrl + '/api/payments/yungou/notify',
    return_url: baseUrl + '/teacher.html?pay_order=' + encodeURIComponent(outTradeNo),
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
      pay_url: payUrl
    });
  } catch (e) {
    payment.status = 'create_failed';
    payment.error = e.message;
    dbStore.upsertPayment(payment);
    res.status(502).json({ error: '创建支付订单失败：' + e.message });
  }
});

app.get('/api/payments/:outTradeNo', userAuth, (req, res) => {
  const payment = findPayment(req.params.outTradeNo);
  if (!payment || payment.user_id !== req.user.id) {
    return res.status(404).json({ error: '订单不存在' });
  }
  const pointBalance = dbStore.getShixingPointBalance(req.user.id);
  res.json({
    out_trade_no: payment.out_trade_no,
    status: payment.status,
    amount: payment.amount,
    plan: payment.plan,
    credits: Number(payment.credits) || 0,
    paid_at: payment.paid_at || null,
    plan_expires: payment.plan_expires || null,
    plan_status: getUserPlanStatus(req.user),
    point_balance: pointBalance,
    comment_balance: pointBalance,
    roundtable_balance: pointBalance,
    essay_balance: pointBalance,
    legacy_essay_balance: dbStore.getEssayCreditBalance(req.user.id)
  });
});

app.all('/api/payments/yungou/notify', (req, res) => {
  if (!yungouConfigured()) return res.status(503).send('fail');

  const raw = { ...(req.query || {}), ...(req.body || {}) };
  const sign = readFirst(raw, ['sign']);
  const normalized = normalizeYungouNotify(raw);
  if (!sign || !normalized.outTradeNo) return res.status(400).send('fail');
  if (!checkYungouNotifySign(raw, normalized, sign)) {
    console.log('[PAY] invalid notify sign', normalized.outTradeNo, raw);
    return res.status(400).send('fail');
  }
  if (normalized.mchId && normalized.mchId !== YUNGOU_MCH_ID) {
    console.log('[PAY] mch mismatch', normalized.mchId, normalized.outTradeNo);
    return res.status(400).send('fail');
  }
  const payment = findPayment(normalized.outTradeNo);
  if (!payment) {
    console.log('[PAY] payment not found', normalized.outTradeNo);
    return res.status(404).send('fail');
  }
  if (yuanToCents(normalized.money) !== yuanToCents(payment.amount)) {
    console.log('[PAY] amount mismatch', normalized.money, normalized.outTradeNo);
    return res.status(400).send('fail');
  }
  try {
    markPaymentPaid(payment, normalized, raw);
    dbStore.upsertPayment(payment);
    res.send('success');
  } catch (e) {
    console.log('[PAY] credit failed', normalized.outTradeNo, e.message);
    res.status(500).send('fail');
  }
});

const SCREEN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const screenSessions = new Map();

function issueScreenSession(cls) {
  if (screenSessions.size > 5000) {
    const now = Date.now();
    for (const [token, session] of screenSessions) {
      if (session.expires_at <= now) screenSessions.delete(token);
    }
  }
  const token = crypto.randomBytes(32).toString('base64url');
  screenSessions.set(token, {
    class_id: cls.id,
    expires_at: Date.now() + SCREEN_SESSION_TTL_MS
  });
  return token;
}

function screenSessionAuth(req, res, next) {
  const token = String(req.get('X-Screen-Token') || '');
  const session = token ? screenSessions.get(token) : null;
  if (!session || session.expires_at <= Date.now()) {
    if (token) screenSessions.delete(token);
    return res.status(401).json({ error: '教室端连接已失效，请重新绑定' });
  }
  const cls = store.classes.find(row => row.id === session.class_id);
  if (!cls) return res.status(404).json({ error: '班级不存在' });
  session.expires_at = Date.now() + SCREEN_SESSION_TTL_MS;
  req.screenClass = cls;
  req.screenSessionToken = token;
  next();
}

function classOwnerPlanStatus(cls) {
  const owner = cls && store.users.find(user => user.id === cls.user_id);
  return getUserPlanStatus(owner);
}

function requireActiveScreenClassPlan(req, res, next) {
  const planStatus = classOwnerPlanStatus(req.screenClass);
  if (!planStatus.active) {
    return res.status(403).json({ error: '班级广播使用期限已到，请联系老师续费', plan_status: planStatus });
  }
  next();
}

function visibleClassForRequest(classId, userId) {
  return store.classes.find(cls => cls.id === classId && isClassMember(cls, userId));
}

function managementClassForRequest(req, res) {
  const cls = visibleClassForRequest(req.params.classId, req.user.id);
  if (!cls) {
    res.status(404).json({ error: '班级不存在' });
    return null;
  }
  return cls;
}

function enabledManagementClass(req, res) {
  const cls = managementClassForRequest(req, res);
  if (!cls) return null;
  if (!cls.management_enabled) {
    res.status(400).json({ error: '该班级尚未开启班级管理' });
    return null;
  }
  return cls;
}

function classScoreScope(classId, scope, periodId) {
  let period = null;
  if (periodId) {
    period = dbStore.listClassScorePeriods(classId).find(item => item.id === periodId) || null;
    if (!period) throw new Error('积分周期不存在');
  } else {
    period = dbStore.ensureCurrentClassScorePeriod(classId, new Date().toISOString());
  }
  const bounds = classroomPoints.scoreScopeBounds(scope || 'term', new Date(), period, 8 * 60);
  return { period, bounds };
}

function createClassScoreEntries(cls, body, source, actorUserId) {
  const rule = dbStore.getClassScoreRule(cls.id, String(body.rule_id || ''));
  if (!rule || !rule.active) throw new Error('积分规则不存在或已停用');
  const period = dbStore.ensureCurrentClassScorePeriod(cls.id, new Date().toISOString());
  const entries = classroomPoints.buildScoreEntries({
    client_operation_id: body.client_operation_id,
    student_ids: body.student_ids,
    class_id: cls.id,
    period_id: period.id,
    rule_id: rule.id,
    rule_name_snapshot: rule.name,
    delta: rule.delta,
    source,
    actor_user_id: actorUserId || null,
    client_created_at: body.client_created_at,
    created_at: new Date().toISOString()
  });
  return dbStore.appendClassScoreEntries(entries);
}

function emitClassScoreEntries(classId, entries) {
  entries.forEach(entry => io.to(`class:${classId}`).emit('class-score-entry', scoreEntryResponse(entry)));
}

// ---------- Class API ----------
app.get('/api/classes', userAuth, (req, res) => {
  const userClasses = getVisibleClasses(req.user.id);
  const onlineCounts = {};
  for (const [, s] of io.of('/').sockets) {
    if (s.classId) onlineCounts[s.classId] = (onlineCounts[s.classId] || 0) + 1;
  }
  res.json(userClasses.map(r => classResponse(r, req.user.id, onlineCounts)));
});

app.post('/api/classes', userAuth, requireActivePlan, (req, res) => {
  const { name, grade } = req.body;
  if (!name) return res.status(400).json({ error: '请输入班级名称' });
  if (!grade || !['primary','junior','senior'].includes(grade)) return res.status(400).json({ error: '请选择学段' });
  const userClasses = store.classes.filter(c => c.user_id === req.user.id);
  if (userClasses.length >= 20) return res.status(400).json({ error: '最多创建20个班级' });
  const id = crypto.randomUUID();
  const bind_code = genUniqueBindCode();
  const cls = {
    id,
    user_id: req.user.id,
    name,
    grade,
    bind_code,
    member_ids: [],
    management_enabled: false,
    points_sound_enabled: false,
    archived_at: null,
    created_at: new Date().toISOString()
  };
  store.classes.push(cls);
  dbStore.upsertClass(cls);
  res.json(classResponse(cls, req.user.id));
});

app.delete('/api/classes/:id', userAuth, (req, res) => {
  const cls = store.classes.find(c => c.id === req.params.id && c.user_id === req.user.id);
  if (!cls) return res.status(404).json({ error: '班级不存在' });
  const archived = dbStore.classHasManagementHistory(req.params.id);
  store.classes = store.classes.filter(c => c.id !== req.params.id);
  if (archived) {
    dbStore.archiveClass(req.params.id);
  } else {
    store.notifications = store.notifications.filter(n => n.class_id !== req.params.id);
    store.bulletins = store.bulletins.filter(b => b.class_id !== req.params.id);
    dbStore.deleteClass(req.params.id);
  }
  res.json({ ok: true, archived });
});

app.post('/api/classes/:id/invite', userAuth, requireActivePlan, (req, res) => {
  const cls = store.classes.find(c => c.id === req.params.id && c.user_id === req.user.id);
  if (!cls) return res.status(404).json({ error: '只有班级创建者可以邀请老师' });

  const teacherCode = String(req.body.teacher_code || '').trim().toUpperCase();
  if (!teacherCode) return res.status(400).json({ error: '请输入对方教师码' });

  const target = store.users.find(u => u.teacher_code === teacherCode);
  if (!target) return res.status(404).json({ error: '未找到该教师码对应的用户' });
  if (target.id === cls.user_id) return res.status(400).json({ error: '创建者已经在班级中' });

  if (!Array.isArray(cls.member_ids)) cls.member_ids = [];
  if (cls.member_ids.includes(target.id)) return res.status(400).json({ error: '该老师已经在班级中' });
  if (!cls.member_ids.includes(target.id)) cls.member_ids.push(target.id);
  createUserMessage(
    target.id,
    'class-invite',
    '班级协作邀请',
    getTeacherName(req.user) + ' 邀请你加入「' + cls.name + '」',
    {
      class_id: cls.id,
      class_name: cls.name,
      actor_id: req.user.id,
      actor_name: getTeacherName(req.user)
    }
  );
  dbStore.upsertClass(cls);
  res.json({ ok: true, class: classResponse(cls, req.user.id), teacher: { id: target.id, display_name: target.display_name, teacher_code: target.teacher_code } });
});

function sendClassPointsError(res, error) {
  const message = String(error && error.message || '操作失败');
  const friendly = message.includes('UNIQUE constraint failed: class_students.class_id, class_students.student_no')
    ? '该学号已存在'
    : message;
  return res.status(400).json({ error: friendly });
}

app.get('/api/classes/:classId/management', userAuth, (req, res) => {
  const cls = managementClassForRequest(req, res);
  if (!cls) return;
  res.json(classManagementPayload(cls));
});

app.put('/api/classes/:classId/management', userAuth, requireActivePlan, (req, res) => {
  const cls = managementClassForRequest(req, res);
  if (!cls) return;
  if (cls.user_id !== req.user.id) return res.status(403).json({ error: '只有班级创建者可以开启或关闭班级管理' });
  try {
    const management = dbStore.setClassManagement(cls.id, {
      enabled: req.body.enabled,
      sound_enabled: req.body.sound_enabled,
      updated_at: new Date().toISOString()
    });
    cls.management_enabled = management.enabled;
    cls.points_sound_enabled = management.sound_enabled;
    if (management.enabled) {
      ensureDefaultClassScoreRules(cls.id);
      dbStore.ensureCurrentClassScorePeriod(cls.id, new Date().toISOString());
    }
    const payload = classManagementPayload(cls);
    io.to(`class:${cls.id}`).emit('class-management-update', payload);
    res.json(payload);
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.post('/api/classes/:classId/students', userAuth, requireActivePlan, (req, res) => {
  const cls = enabledManagementClass(req, res);
  if (!cls) return;
  try {
    const student = dbStore.createClassStudent({
      id: crypto.randomUUID(),
      class_id: cls.id,
      name: req.body.name,
      student_no: req.body.student_no,
      seat_row: req.body.seat_row,
      seat_col: req.body.seat_col,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    io.to(`class:${cls.id}`).emit('class-roster-update', { class_id: cls.id });
    res.json({ student });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.patch('/api/classes/:classId/students/:studentId', userAuth, requireActivePlan, (req, res) => {
  const cls = enabledManagementClass(req, res);
  if (!cls) return;
  try {
    const student = dbStore.updateClassStudent(cls.id, req.params.studentId, {
      name: req.body.name,
      student_no: req.body.student_no,
      seat_row: req.body.seat_row,
      seat_col: req.body.seat_col,
      archived: req.body.archived,
      updated_at: new Date().toISOString()
    });
    io.to(`class:${cls.id}`).emit('class-roster-update', { class_id: cls.id });
    res.json({ student });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.post('/api/classes/:classId/score-rules', userAuth, requireActivePlan, (req, res) => {
  const cls = enabledManagementClass(req, res);
  if (!cls) return;
  try {
    const now = new Date().toISOString();
    const rule = dbStore.saveClassScoreRule({
      id: crypto.randomUUID(),
      class_id: cls.id,
      name: req.body.name,
      delta: req.body.delta,
      active: req.body.active === undefined ? true : !!req.body.active,
      sort_order: Number(req.body.sort_order) || dbStore.listClassScoreRules(cls.id, { include_inactive: true }).length * 10,
      created_at: now,
      updated_at: now
    });
    io.to(`class:${cls.id}`).emit('class-score-rules-update', { class_id: cls.id });
    res.json({ rule });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.patch('/api/classes/:classId/score-rules/:ruleId', userAuth, requireActivePlan, (req, res) => {
  const cls = enabledManagementClass(req, res);
  if (!cls) return;
  const current = dbStore.getClassScoreRule(cls.id, req.params.ruleId);
  if (!current) return res.status(404).json({ error: '积分规则不存在' });
  try {
    const rule = dbStore.saveClassScoreRule({
      id: current.id,
      class_id: cls.id,
      name: req.body.name === undefined ? current.name : req.body.name,
      delta: req.body.delta === undefined ? current.delta : req.body.delta,
      active: req.body.active === undefined ? current.active : !!req.body.active,
      sort_order: req.body.sort_order === undefined ? current.sort_order : Number(req.body.sort_order),
      created_at: current.created_at,
      updated_at: new Date().toISOString()
    });
    io.to(`class:${cls.id}`).emit('class-score-rules-update', { class_id: cls.id });
    res.json({ rule });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.post('/api/classes/:classId/score-periods', userAuth, requireActivePlan, (req, res) => {
  const cls = enabledManagementClass(req, res);
  if (!cls) return;
  if (cls.user_id !== req.user.id) return res.status(403).json({ error: '只有班级创建者可以开始新学期' });
  try {
    dbStore.startClassScorePeriod(cls.id, {
      name: req.body.name,
      starts_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    });
    const payload = classManagementPayload(cls);
    io.to(`class:${cls.id}`).emit('class-management-update', { class_id: cls.id, ...payload });
    res.json(payload);
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.post('/api/classes/:classId/points/entries', userAuth, requireActivePlan, (req, res) => {
  const cls = enabledManagementClass(req, res);
  if (!cls) return;
  try {
    const entries = createClassScoreEntries(cls, req.body || {}, 'teacher', req.user.id);
    emitClassScoreEntries(cls.id, entries);
    res.json({ entries: entries.map(scoreEntryResponse) });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.post('/api/classes/:classId/points/entries/:entryId/reverse', userAuth, requireActivePlan, (req, res) => {
  const cls = enabledManagementClass(req, res);
  if (!cls) return;
  try {
    const entry = dbStore.reverseClassScoreEntry({
      id: crypto.randomUUID(),
      class_id: cls.id,
      entry_id: req.params.entryId,
      client_operation_id: String(req.body.client_operation_id || crypto.randomUUID()),
      source: 'teacher',
      actor_user_id: req.user.id,
      client_created_at: req.body.client_created_at,
      created_at: new Date().toISOString()
    });
    io.to(`class:${cls.id}`).emit('class-score-reversal', scoreEntryResponse(entry));
    res.json({ entry: scoreEntryResponse(entry) });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.get('/api/classes/:classId/points/ledger', userAuth, (req, res) => {
  const cls = enabledManagementClass(req, res);
  if (!cls) return;
  try {
    const scoped = classScoreScope(cls.id, req.query.scope || 'term', String(req.query.period_id || ''));
    const items = dbStore.listClassScoreLedger({
      class_id: cls.id,
      period_id: scoped.period.id,
      student_id: String(req.query.student_id || ''),
      source: String(req.query.source || ''),
      direction: String(req.query.direction || ''),
      from: scoped.bounds.from,
      to: scoped.bounds.to,
      limit: req.query.limit
    }).map(scoreEntryResponse);
    res.json({ items, scope: req.query.scope || 'term', current_period: scoped.period });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.get('/api/classes/:classId/points/leaderboard', userAuth, (req, res) => {
  const cls = enabledManagementClass(req, res);
  if (!cls) return;
  try {
    const scoped = classScoreScope(cls.id, req.query.scope || 'term', String(req.query.period_id || ''));
    const items = dbStore.getClassScoreLeaderboard({
      class_id: cls.id,
      period_id: scoped.period.id,
      from: scoped.bounds.from,
      to: scoped.bounds.to
    });
    res.json({ items, scope: req.query.scope || 'term', current_period: scoped.period });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.post('/api/screen/session', (req, res) => {
  const bindCode = String(req.body.bind_code || '').trim().toUpperCase();
  const cls = store.classes.find(row => row.bind_code === bindCode);
  if (!cls) return res.status(404).json({ error: '绑定码无效' });
  const screenToken = issueScreenSession(cls);
  res.json({
    screen_token: screenToken,
    class: {
      id: cls.id,
      name: cls.name,
      grade: cls.grade || 'junior',
      management_enabled: !!cls.management_enabled,
      points_sound_enabled: !!cls.points_sound_enabled
    }
  });
});

app.get('/api/screen/classroom-state', screenSessionAuth, (req, res) => {
  const cls = req.screenClass;
  const payload = classManagementPayload(cls);
  if (!payload.management.enabled) {
    return res.json({ ...payload, leaderboard: [], recent: [], today_entry_count: 0 });
  }
  try {
    const requestedScope = String(req.query.scope || 'term').toLowerCase();
    const scoped = classScoreScope(cls.id, requestedScope);
    const todayBounds = classroomPoints.scoreScopeBounds('today', new Date(), scoped.period, 8 * 60);
    const ledgerLimit = requestedScope === 'today' ? 100 : 20;
    const leaderboard = dbStore.getClassScoreLeaderboard({
      class_id: cls.id,
      period_id: scoped.period.id,
      from: scoped.bounds.from,
      to: scoped.bounds.to
    });
    const recent = dbStore.listClassScoreLedger({
      class_id: cls.id,
      period_id: scoped.period.id,
      from: scoped.bounds.from,
      to: scoped.bounds.to,
      limit: ledgerLimit
    }).map(scoreEntryResponse);
    const todayEntryCount = requestedScope === 'today'
      ? recent.length
      : dbStore.listClassScoreLedger({
          class_id: cls.id,
          period_id: scoped.period.id,
          from: todayBounds.from,
          to: todayBounds.to,
          limit: 500
        }).length;
    res.json({
      ...payload,
      current_period: scoped.period,
      scope: requestedScope,
      leaderboard,
      recent,
      today_entry_count: todayEntryCount
    });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.post('/api/screen/points/entries', screenSessionAuth, requireActiveScreenClassPlan, (req, res) => {
  const cls = req.screenClass;
  if (!cls.management_enabled) return res.status(400).json({ error: '该班级尚未开启班级管理' });
  try {
    const entries = createClassScoreEntries(cls, req.body || {}, 'screen', null);
    emitClassScoreEntries(cls.id, entries);
    res.json({ entries: entries.map(scoreEntryResponse) });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

app.post('/api/screen/points/entries/:entryId/reverse', screenSessionAuth, requireActiveScreenClassPlan, (req, res) => {
  const cls = req.screenClass;
  if (!cls.management_enabled) return res.status(400).json({ error: '该班级尚未开启班级管理' });
  try {
    const entry = dbStore.reverseClassScoreEntry({
      id: crypto.randomUUID(),
      class_id: cls.id,
      entry_id: req.params.entryId,
      client_operation_id: String(req.body.client_operation_id || crypto.randomUUID()),
      source: 'screen',
      actor_user_id: null,
      client_created_at: req.body.client_created_at,
      created_at: new Date().toISOString()
    });
    io.to(`class:${cls.id}`).emit('class-score-reversal', scoreEntryResponse(entry));
    res.json({ entry: scoreEntryResponse(entry) });
  } catch (error) {
    sendClassPointsError(res, error);
  }
});

// ---------- Message Center API ----------
app.get('/api/messages', userAuth, (req, res) => {
  const messages = (store.messages || [])
    .filter(m => m.user_id === req.user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 100);
  res.json(messages);
});

app.post('/api/messages/read', userAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(id => parseInt(id)).filter(Boolean) : null;
  const now = new Date().toISOString();
  (store.messages || []).forEach(m => {
    if (m.user_id !== req.user.id || m.read_at) return;
    if (ids && !ids.includes(m.id)) return;
    m.read_at = now;
  });
  dbStore.markMessagesRead(req.user.id, ids, now);
  res.json({ ok: true });
});

// ---------- Notification API ----------
app.post('/api/notify', userAuth, requireActivePlan, (req, res) => {
  const { class_id, content, signature, student_name, repeat_count } = req.body;
  if (!class_id || !content) return res.status(400).json({ error: '请选择班级并输入内容' });

  const cls = store.classes.find(c => c.id === class_id && isClassMember(c, req.user.id));
  if (!cls) return res.status(404).json({ error: '班级不存在' });

  const rc = Math.min(Math.max(parseInt(repeat_count) || 1, 1), 10);
  const senderName = String(signature || '').trim() || getTeacherName(req.user);
  const notification = {
    id: store.nextNotifId++,
    class_id,
    user_id: req.user.id,
    content,
    signature: signature || '',
    sender_name: senderName,
    student_name: student_name || '',
    repeat_count: rc,
    created_at: new Date().toISOString()
  };
  store.notifications.push(notification);
  if (store.notifications.length > 5000) store.notifications = store.notifications.slice(-5000);
  dbStore.upsertNotification(notification);
  dbStore.setCounter('nextNotifId', store.nextNotifId);
  dbStore.pruneNotifications(5000);

  const emitData = { ...notification, class_name: cls.name, avatar: req.user.avatar || 'a1' };
  io.to(`class:${class_id}`).emit('notification', emitData);

  let unifiedReward = null;
  try {
    unifiedReward = dbStore.activateUnifiedReferral({
      invitee_user_id: req.user.id,
      product: 'broadcast',
      source_record_id: 'broadcast:' + notification.id,
      device_hash: deviceHashFromReq(req),
      created_at: notification.created_at
    });
    notifyUnifiedActivation(unifiedReward, req.user, '教室广播');
  } catch (e) {
    console.log('[REFERRAL] broadcast activation failed:', e.message);
  }

  // 邀请奖励：被邀请人发出首条通知，给邀请人 +5 天（未付费邀请人封顶3笔）
  try {
    const ref = dbStore.getUnifiedReferralByInvitee(req.user.id) ? null : dbStore.getAppReferral('broadcast', req.user.id);
    if (ref && !ref.usage_rewarded_at) {
      const inviterPaid = broadcastInviterIsPaid(ref.inviter_user_id);
      if (inviterPaid || dbStore.countAppReferralUsageRewards('broadcast', ref.inviter_user_id) < BROADCAST_REFERRAL_UNPAID_USAGE_CAP) {
        const claimed = dbStore.claimAppReferralReward('broadcast', req.user.id, 'usage_rewarded_at');
        if (claimed) {
          const inviter = store.users.find(u => u.id === claimed.inviter_user_id);
          if (inviter) {
            const expires = extendBroadcastPlanDays(inviter, BROADCAST_REFERRAL_USAGE_DAYS);
            createUserMessage(
              inviter.id,
              'broadcast-referral',
              '邀请奖励到账',
              '你邀请的好友 ' + (claimed.invitee_username || req.user.username) + ' 已发出第一条班级通知，奖励 ' + BROADCAST_REFERRAL_USAGE_DAYS + ' 天会员时长已到账，有效期至 ' + new Date(expires).toLocaleDateString('zh-CN') + '。',
              {}
            );
          }
        }
      }
    }
  } catch (e) {
    console.log('[REF] broadcast usage reward failed:', e.message);
  }

  res.json({ ...emitData, referral_reward: unifiedReward && !unifiedReward.duplicate ? {
    status: unifiedReward.status,
    invitee_reward_points: unifiedReward.invitee_reward_points,
    risk_reason: unifiedReward.risk_reason || ''
  } : null });
});

app.get('/api/history/:classId', userAuth, (req, res) => {
  const cls = store.classes.find(c => c.id === req.params.classId && isClassMember(c, req.user.id));
  if (!cls) return res.status(404).json({ error: '班级不存在' });
  const rows = store.notifications
    .filter(n => n.class_id === req.params.classId)
    .sort((a, b) => b.id - a.id)
    .slice(0, 50)
    .map(n => {
      const sender = getNotificationSender(n);
      return { ...n, sender_name: n.sender_name || n.signature || getTeacherName(sender) };
    });
  res.json(rows);
});

app.post('/api/resend/:id', userAuth, requireActivePlan, (req, res) => {
  const row = store.notifications.find(n => n.id === parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const cls = store.classes.find(c => c.id === row.class_id && isClassMember(c, req.user.id));
  if (!cls) return res.status(404).json({ error: '班级不存在' });
  const sender = store.users.find(u => u.id === row.user_id) || req.user;
  io.to(`class:${row.class_id}`).emit('notification', {
    ...row,
    class_name: cls.name,
    avatar: sender.avatar || 'a1',
    sender_name: row.sender_name || row.signature || getTeacherName(sender),
    created_at: new Date().toISOString()
  });
  res.json({ ok: true });
});

// ---------- Bulletin API ----------
app.get('/api/bulletins/:classId', userAuth, (req, res) => {
  const cls = store.classes.find(c => c.id === req.params.classId && isClassMember(c, req.user.id));
  if (!cls) return res.status(404).json({ error: '班级不存在' });
  res.json(getActiveBulletins(cls.id).map(b => bulletinResponse(b, cls, req.user.id)));
});

app.post('/api/bulletins', userAuth, requireActivePlan, (req, res) => {
  const classId = String(req.body.class_id || '');
  const cls = store.classes.find(c => c.id === classId && isClassMember(c, req.user.id));
  if (!cls) return res.status(404).json({ error: '班级不存在' });

  const title = String(req.body.title || '班级告示').trim().slice(0, 40) || '班级告示';
  const content = String(req.body.content || '').trim();
  const expiresAt = String(req.body.expires_at || '').trim();
  const expiresTime = Date.parse(expiresAt);
  if (!content) return res.status(400).json({ error: '请输入告示内容' });
  if (content.length > 1000) return res.status(400).json({ error: '告示内容最多1000字' });
  if (!expiresTime || expiresTime <= Date.now()) return res.status(400).json({ error: '请选择未来的展示截止时间' });

  const bulletin = {
    id: store.nextBulletinId++,
    class_id: cls.id,
    user_id: req.user.id,
    title,
    content,
    sender_name: getTeacherName(req.user),
    expires_at: new Date(expiresTime).toISOString(),
    created_at: new Date().toISOString()
  };
  store.bulletins.push(bulletin);
  if (store.bulletins.length > 500) store.bulletins = store.bulletins.slice(-500);
  dbStore.upsertBulletin(bulletin);
  dbStore.setCounter('nextBulletinId', store.nextBulletinId);
  dbStore.pruneBulletins(500);
  emitBulletins(cls.id);
  res.json(bulletinResponse(bulletin, cls, req.user.id));
});

app.delete('/api/bulletins/:id', userAuth, (req, res) => {
  const bulletin = store.bulletins.find(b => b.id === parseInt(req.params.id));
  if (!bulletin) return res.status(404).json({ error: '告示不存在' });
  const cls = store.classes.find(c => c.id === bulletin.class_id && isClassMember(c, req.user.id));
  if (!cls) return res.status(404).json({ error: '班级不存在' });
  if (bulletin.user_id !== req.user.id && cls.user_id !== req.user.id) {
    return res.status(403).json({ error: '只有发布人或班级管理员可以删除告示' });
  }
  store.bulletins = store.bulletins.filter(b => b.id !== bulletin.id);
  dbStore.deleteBulletin(bulletin.id);
  emitBulletins(cls.id);
  res.json({ ok: true });
});

// ---------- TTS ----------
// TTS 限流：同一 IP 每分钟最多20次
const ttsRateMap = new Map();
const TTS_RATE_LIMIT = 20;
const TTS_RATE_WINDOW_MS = 60 * 1000;

function ttsRateLimited(ip) {
  const now = Date.now();
  const rec = ttsRateMap.get(ip);
  if (!rec || now - rec.first >= TTS_RATE_WINDOW_MS) {
    if (ttsRateMap.size > 5000) ttsRateMap.clear();
    ttsRateMap.set(ip, { first: now, count: 1 });
    return false;
  }
  rec.count++;
  return rec.count > TTS_RATE_LIMIT;
}

app.post('/api/tts', (req, res) => {
  if (ttsRateLimited(req.ip || 'unknown')) return res.status(429).end();
  // 鉴权：教室端带绑定码，老师端带登录 token，二者必居其一
  const bindCode = String(req.body.bind_code || '').trim().toUpperCase();
  const boundClass = bindCode ? store.classes.find(c => c.bind_code === bindCode) : null;
  const authedUser = findUserByToken(authTokenFromReq(req));
  if (!boundClass && !authedUser) return res.status(401).end();
  const text = String(req.body.text || '').slice(0, 500);
  console.log('[TTS] text:', text ? text.slice(0, 30) : '(empty)', 'len:', text.length);
  if (!text) return res.status(400).end();

  const reqPath = '/text2audio?tex=' + encodeURIComponent(text) +
    '&cuid=baidu_speech_demo&lan=zh&ctp=1&pdt=301&vol=15&rate=32&per=0&spd=4';
  console.log('[TTS] path:', reqPath.slice(0, 200));

  https.get({
    hostname: 'tts.baidu.com',
    path: reqPath,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.baidu.com',
      'Accept': '*/*'
    }
  }, (resp) => {
    const ct = resp.headers['content-type'] || '';
    console.log('[TTS] baidu resp:', resp.statusCode, ct);
    if (resp.statusCode !== 200 || ct.indexOf('audio') === -1) {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => { console.log('[TTS] baidu body:', body.slice(0, 300)); });
      return res.status(500).end();
    }
    res.set('Content-Type', ct);
    resp.pipe(res);
  }).on('error', (e) => { console.log('[TTS] error:', e.message); res.status(500).end(); });
});

// ---------- Admin API ----------
app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = store.users.map(u => ({
    id: u.id, username: u.username, display_name: u.display_name,
    contact_type: u.contact_type || '', contact_value: u.contact_value || '',
    plan: u.plan, plan_expires: u.plan_expires, created_at: u.created_at,
    plan_status: getUserPlanStatus(u),
    class_count: store.classes.filter(c => c.user_id === u.id).length,
    notif_count: store.notifications.filter(n => n.user_id === u.id).length,
    comment_balance: dbStore.getCommentCreditBalance(u.id),
    learning_membership: dbStore.getLearningMembershipStatus(u)
  }));
  res.json(users);
});

function adminUserSummary(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    contact_type: u.contact_type || '',
    contact_value: u.contact_value || '',
    created_at: u.created_at,
    plan: u.plan,
    plan_expires: u.plan_expires,
    plan_status: getUserPlanStatus(u),
    point_balance: dbStore.getShixingPointBalance(u.id),
    class_count: store.classes.filter(c => c.user_id === u.id || (c.member_ids || []).includes(u.id)).length,
    notif_count: store.notifications.filter(n => n.user_id === u.id).length,
    learning_membership: dbStore.getLearningMembershipStatus(u)
  };
}

app.get('/api/admin/users/search', adminAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(10, Math.min(100, parseInt(req.query.limit, 10) || 30));
  const filtered = store.users.filter(u => {
    if (!q) return true;
    return [u.username, u.display_name, u.contact_value, u.registration_email]
      .some(value => String(value || '').toLowerCase().includes(q));
  }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const offset = (page - 1) * limit;
  res.json({
    ok: true,
    items: filtered.slice(offset, offset + limit).map(adminUserSummary),
    total: filtered.length,
    page,
    limit,
    pages: Math.max(1, Math.ceil(filtered.length / limit))
  });
});

app.get('/api/admin/users/:userId', adminAuth, (req, res) => {
  const user = store.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({
    ok: true,
    user: adminUserSummary(user),
    point_ledger: dbStore.listShixingPointLedger(user.id, 50),
    payments: (store.payments || []).filter(p => p.user_id === user.id)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 50),
    referral: dbStore.getUnifiedReferralByInvitee(user.id),
    invited: dbStore.getUnifiedReferralCenter(user.id)
  });
});

app.get('/api/admin/orders', adminAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim();
  const product = String(req.query.product || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(10, Math.min(100, parseInt(req.query.limit, 10) || 30));
  const main = (store.payments || []).map(p => ({ ...p, product: paymentProduct(p.plan, p.source_product) }));
  const math = dbStore.listEdulabAdminPayments(500).map(p => ({ ...p, product: 'edulab' }));
  const filtered = main.concat(math).filter(order => {
    if (status && order.status !== status) return false;
    if (product && order.product !== product) return false;
    if (!q) return true;
    return [order.out_trade_no, order.username, order.user_id].some(value => String(value || '').toLowerCase().includes(q));
  }).sort((a, b) => String(b.paid_at || b.created_at || '').localeCompare(String(a.paid_at || a.created_at || '')));
  const offset = (page - 1) * limit;
  res.json({ ok: true, items: filtered.slice(offset, offset + limit), total: filtered.length, page, limit, pages: Math.max(1, Math.ceil(filtered.length / limit)) });
});

app.get('/api/admin/products', adminAuth, (req, res) => {
  const now = new Date();
  const broadcastMembers = store.users.filter(u => u.plan === 'yearly' && u.plan_expires && new Date(u.plan_expires) > now);
  res.json({
    ok: true,
    broadcast: { active_members: broadcastMembers.length, total_classes: store.classes.length, total_notifications: store.notifications.length },
    comment: dbStore.getCommentAdminStats(),
    essay: dbStore.getEssayAdminStats(),
    english: dbStore.getEnglishAdminStats(),
    roundtable: dbStore.getRoundtableAdminStats(),
    edulab: dbStore.getEdulabAdminStats(),
    learning: dbStore.getLearningAdminStats(now),
    shared_points: dbStore.getSharedPointAdminStats()
  });
});

app.get('/api/admin/audit', adminAuth, (req, res) => {
  res.json({ ok: true, items: dbStore.listAdminAuditLogs(Number(req.query.limit) || 100) });
});

app.get('/api/admin/password-resets', adminAuth, (req, res) => {
  const rows = (store.password_reset_requests || [])
    .filter(r => r.status !== 'handled')
    .sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at))
    .slice(0, 50)
    .map(r => {
      const user = store.users.find(u => u.id === r.user_id);
      return {
        id: r.id,
        user_id: r.user_id,
        username: r.username || (user ? user.username : ''),
        display_name: user ? user.display_name : '',
        contact_value: r.contact_value || (user ? user.contact_value : ''),
        requested_at: r.requested_at,
        status: r.status || 'pending'
      };
    });
  res.json(rows);
});

app.get('/api/admin/feedback', adminAuth, (req, res) => {
  res.json(dbStore.listFeedback(50));
});

app.get('/api/admin/feature-subscriptions', adminAuth, (req, res) => {
  const recent = dbStore.listFeatureSubscriptions(200);
  const stats = dbStore.listFeatureSubscriptionStats().map(row => ({
    feature_key: row.feature_key,
    feature_name: ROADMAP_FEATURES[row.feature_key] || row.feature_name || row.feature_key,
    total: row.total,
    latest_at: row.latest_at
  }));
  res.json({ stats, recent });
});

app.get('/api/admin/comment-usage', adminAuth, (req, res) => {
  res.json({
    stats: dbStore.getCommentAdminStats(),
    users: dbStore.listCommentAdminUsage(100)
  });
});

app.post('/api/admin/comment-credits', adminAuth, (req, res) => {
  const userId = String(req.body.user_id || '');
  const delta = parseInt(req.body.delta, 10);
  const note = String(req.body.note || '').trim().slice(0, 120);
  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: '请输入非 0 的整数积分' });
  }
  if (Math.abs(delta) > 1000000) {
    return res.status(400).json({ error: '单次调整不能超过 1000000 积分' });
  }
  const user = store.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  try {
    const balance = dbStore.adjustShixingPoints({
      user_id: user.id,
      username: user.username,
      delta,
      reason: 'admin_adjustment',
      product: 'all',
      note: note || '管理员调整',
      created_at: new Date().toISOString()
    });
    auditAdmin(req, {
      action: 'points_adjust', target_type: 'user', target_id: user.id,
      summary: '调整 ' + user.username + ' 的师行积分 ' + (delta > 0 ? '+' : '') + delta,
      note: note || '管理员调整', extra_json: { delta, balance }
    });
    res.json({ ok: true, user_id: user.id, delta, balance });
  } catch (e) {
    if (e.code === 'SHIXING_POINTS_EXHAUSTED') {
      return res.status(400).json({ error: e.message, balance: e.balance });
    }
    res.status(500).json({ error: '调整失败：' + e.message });
  }
});

app.get('/api/admin/essay-usage', adminAuth, (req, res) => {
  res.json({
    stats: dbStore.getEssayAdminStats(),
    users: dbStore.listEssayAdminUsage(100)
  });
});

app.post('/api/admin/essay-credits', adminAuth, (req, res) => {
  const userId = String(req.body.user_id || '');
  const delta = parseInt(req.body.delta, 10);
  const note = String(req.body.note || '').trim().slice(0, 120);
  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: '请输入非 0 的整数次数' });
  }
  if (Math.abs(delta) > 10000) {
    return res.status(400).json({ error: '单次调整不能超过 10000 次' });
  }
  const user = store.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  try {
    const balance = dbStore.adjustEssayCredits({
      user_id: user.id,
      username: user.username,
      delta,
      note: note || '管理员调整',
      created_at: new Date().toISOString()
    });
    res.json({ ok: true, user_id: user.id, delta, balance });
  } catch (e) {
    if (e.code === 'NEGATIVE_ESSAY_BALANCE') {
      return res.status(400).json({ error: e.message, balance: e.balance });
    }
    res.status(500).json({ error: '调整失败：' + e.message });
  }
});

app.post('/api/admin/learning-membership', adminAuth, (req, res) => {
  const userId = String(req.body.user_id || '');
  const days = parseInt(req.body.days, 10);
  const note = String(req.body.note || '').trim().slice(0, 120);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: '续费天数必须是 1-3650 的整数' });
  const user = store.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const membership = dbStore.renewLearningMembership({ user_id: user.id, username: user.username, days, plan_key: 'manual', plan_label: '管理员续费', note: note || '管理员续费' });
  auditAdmin(req, {
    action: 'learning_membership_renew', target_type: 'user', target_id: user.id,
    summary: '为 ' + user.username + ' 续费作文学习 ' + days + ' 天',
    note: note || '管理员续费', extra_json: { days, expires_at: membership.expires_at }
  });
  res.json({ ok: true, membership: dbStore.getLearningMembershipStatus(user), expires_at: membership.expires_at });
});

app.post('/api/admin/essay-cards', adminAuth, (req, res) => {
  const count = parseInt(req.body.count, 10);
  const credits = parseInt(req.body.credits, 10);
  const note = String(req.body.note || '').trim().slice(0, 120);
  if (!Number.isFinite(count) || count < 1 || count > 200) {
    return res.status(400).json({ error: '单次生成数量为 1-200 张' });
  }
  if (!Number.isFinite(credits) || credits < 1 || credits > 10000) {
    return res.status(400).json({ error: '每张卡密次数为 1-10000' });
  }
  const codes = dbStore.createEssayCards(count, credits, note);
  res.json({ ok: true, count: codes.length, credits, codes });
});

app.get('/api/admin/essay-cards', adminAuth, (req, res) => {
  const status = String(req.query.status || '').trim() || null;
  res.json({ ok: true, cards: dbStore.listEssayCards(status, 500) });
});

// ---------- 思想圆桌 后台 ----------
app.get('/api/admin/roundtable-usage', adminAuth, (req, res) => {
  res.json({
    stats: dbStore.getRoundtableAdminStats(),
    conversations: dbStore.listRoundtableAdminUsage(100)
  });
});

app.post('/api/admin/roundtable-credits', adminAuth, (req, res) => {
  const userId = String(req.body.user_id || '');
  const delta = parseInt(req.body.delta, 10);
  const note = String(req.body.note || '').trim().slice(0, 120);
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: '请输入非 0 的整数积分' });
  if (Math.abs(delta) > 1000000) return res.status(400).json({ error: '单次调整不能超过 1000000 积分' });
  const user = store.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  try {
    const balance = dbStore.adjustShixingPoints({
      user_id: user.id, username: user.username, delta,
      reason: 'admin_adjustment', product: 'all',
      note: note || '管理员调整', created_at: new Date().toISOString()
    });
    res.json({ ok: true, user_id: user.id, delta, balance });
  } catch (e) {
    if (e.code === 'SHIXING_POINTS_EXHAUSTED') return res.status(400).json({ error: e.message, balance: e.balance });
    res.status(500).json({ error: '调整失败：' + e.message });
  }
});

app.post('/api/admin/roundtable-cards', adminAuth, (req, res) => {
  const count = parseInt(req.body.count, 10);
  const credits = parseInt(req.body.credits, 10);
  const note = String(req.body.note || '').trim().slice(0, 120);
  if (!Number.isFinite(count) || count < 1 || count > 200) return res.status(400).json({ error: '单次生成数量为 1-200 张' });
  if (!Number.isFinite(credits) || credits < 1 || credits > 10000) return res.status(400).json({ error: '每张卡密次数为 1-10000' });
  const codes = dbStore.createRoundtableCards(count, credits, note);
  res.json({ ok: true, count: codes.length, credits, codes });
});

app.get('/api/admin/roundtable-cards', adminAuth, (req, res) => {
  const status = String(req.query.status || '').trim() || null;
  res.json({ ok: true, cards: dbStore.listRoundtableCards(status, 500) });
});

app.post('/api/admin/activate', adminAuth, (req, res) => {
  const { user_id, plan } = req.body;
  const user = store.users.find(u => u.id === user_id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (plan === 'yearly') {
    user.plan = plan;
    user.plan_expires = paidPlanExpiresFromNow();
  } else {
    return res.status(400).json({ error: '套餐类型无效' });
  }
  dbStore.upsertUser(user);
  auditAdmin(req, {
    action: 'broadcast_membership_activate', target_type: 'user', target_id: user.id,
    summary: '为 ' + user.username + ' 开通广播半年会员', note: String(req.body.note || '')
  });
  res.json({ ok: true, plan_status: getUserPlanStatus(user) });
});

app.post('/api/admin/reset-password', adminAuth, (req, res) => {
  const userId = String(req.body.user_id || '');
  const requestId = req.body.request_id ? parseInt(req.body.request_id) : null;
  const password = String(req.body.password || '');
  if (password.length < 3) return res.status(400).json({ error: '新密码至少3位' });

  const user = store.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  setUserPassword(user, password);

  if (requestId) {
    const reqRow = (store.password_reset_requests || []).find(r => r.id === requestId);
    if (reqRow) {
      reqRow.status = 'handled';
      reqRow.handled_at = new Date().toISOString();
    }
    dbStore.markPasswordResetRequestHandled(requestId);
  }
  auditAdmin(req, {
    action: 'password_reset', target_type: 'user', target_id: user.id,
    summary: '重置账号 ' + user.username + ' 的密码', note: String(req.body.note || '')
  });
  res.json({ ok: true });
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const total = store.users.length;
  const active = store.users.filter(u => getUserPlanStatus(u).active).length;
  const paid = store.users.filter(u => u.plan === 'yearly').length;
  const commentStats = dbStore.getCommentAdminStats();
  res.json({
    total_users: total,
    active_users: active,
    paid_users: paid,
    total_notifications: store.notifications.length,
    total_classes: store.classes.length,
    total_feature_subscriptions: (store.feature_subscriptions || []).length,
    total_comment_generations: commentStats.total_generations,
    total_comment_rosters: commentStats.total_rosters,
    active_comment_users: commentStats.active_comment_users,
    purchased_comment_credits: commentStats.purchased_credits
  });
});

app.get('/api/admin/referrals', adminAuth, (req, res) => {
  res.json({
    ok: true,
    stats: dbStore.getUnifiedReferralAdminStats(),
    pending: dbStore.listUnifiedReferralPending(Number(req.query.limit) || 100)
  });
});

app.get('/api/admin/conversions', adminAuth, (req, res) => {
  const report = dbStore.getConversionReport(req.query.days);
  res.json({ ok: true, generated_at: new Date().toISOString(), ...report });
});

app.post('/api/admin/referrals/:eventId/review', adminAuth, (req, res) => {
  try {
    const event = dbStore.reviewUnifiedReferralEvent({
      event_id: Number(req.params.eventId),
      decision: req.body && req.body.decision,
      note: req.body && req.body.note,
      reviewer: 'admin'
    });
    auditAdmin(req, {
      action: 'referral_review', target_type: 'referral_event', target_id: String(req.params.eventId),
      summary: '邀请奖励审核：' + String(req.body && req.body.decision || ''),
      note: String(req.body && req.body.note || ''), extra_json: { decision: req.body && req.body.decision }
    });
    res.json({ ok: true, event });
  } catch (e) {
    if (e.code === 'REFERRAL_EVENT_NOT_FOUND') return res.status(404).json({ error: e.message });
    res.status(400).json({ error: e.message || '审核失败' });
  }
});

// ---------- 统一数据仪表盘 ----------
function paymentProduct(plan, sourceProduct) {
  if (plan === 'yearly') return 'broadcast';
  if (String(plan || '').indexOf('comment_') === 0) return 'comment';
  if (String(plan || '').indexOf('essay_') === 0) return 'essay';
  if (String(plan || '').indexOf('learning_') === 0) return 'learning';
  if (getPointPackage(plan)) return sourceProduct || 'shared_points';
  if (sourceProduct) return sourceProduct;
  return 'other';
}

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const monthStr = now.toISOString().slice(0, 7);
  const weekAgoIso = new Date(now.getTime() - 7 * 86400000).toISOString();

  // ---- 支付（主服务 + 数学服务）----
  const paid = (store.payments || []).filter(p => p.status === 'paid')
    .concat(dbStore.listEdulabAdminPayments(500).filter(p => p.status === 'paid'));
  const revenueBy = { broadcast: 0, comment: 0, essay: 0, english: 0, roundtable: 0, edulab: 0, learning: 0, shared_points: 0, other: 0 };
  let revenueTotal = 0, revenueMonth = 0, revenueToday = 0;
  paid.forEach(p => {
    const amt = parseFloat(p.amount) || 0;
    revenueTotal += amt;
    const product = paymentProduct(p.plan || p.package, p.source_product);
    revenueBy[product] = (revenueBy[product] || 0) + amt;
    if (getPointPackage(p.plan)) revenueBy.shared_points += amt;
    const paidAt = String(p.paid_at || p.created_at || '');
    if (paidAt.slice(0, 7) === monthStr) revenueMonth += amt;
    if (paidAt.slice(0, 10) === todayStr) revenueToday += amt;
  });

  // 30 天收入曲线
  const revDaily = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    revDaily.push({ date: d, amount: 0, orders: 0 });
  }
  const revMap = {};
  revDaily.forEach(r => { revMap[r.date] = r; });
  paid.forEach(p => {
    const d = String(p.paid_at || p.created_at || '').slice(0, 10);
    if (revMap[d]) { revMap[d].amount += parseFloat(p.amount) || 0; revMap[d].orders++; }
  });
  revDaily.forEach(r => { r.amount = Math.round(r.amount * 100) / 100; });

  // ---- 用户 ----
  const todayNewUsers = store.users.filter(u => String(u.created_at || '').slice(0, 10) === todayStr).length;
  const weekNewUsers = store.users.filter(u => String(u.created_at || '') >= weekAgoIso).length;

  // ---- 广播 ----
  const in7d = new Date(now.getTime() + 7 * 86400000);
  const broadcastMembers = store.users.filter(u => u.plan === 'yearly' && u.plan_expires && new Date(u.plan_expires) > now);
  const notifToday = store.notifications.filter(n => String(n.created_at || '').slice(0, 10) === todayStr).length;

  // ---- 评语 / 作文 ----
  const commentStats = dbStore.getCommentAdminStats();
  const essayStats = dbStore.getEssayAdminStats();
  const englishStats = dbStore.getEnglishAdminStats();
  const roundtableStats = dbStore.getRoundtableAdminStats();
  const edulabStats = dbStore.getEdulabAdminStats();
  const learningStats = dbStore.getLearningAdminStats(now);
  const sharedPointStats = dbStore.getSharedPointAdminStats();
  const unifiedReferralStats = dbStore.getUnifiedReferralAdminStats();
  const todayIso = todayStr;
  const usageDays = 14;

  res.json({
    generated_at: now.toISOString(),
    overview: {
      total_users: store.users.length,
      today_new_users: todayNewUsers,
      week_new_users: weekNewUsers,
      revenue_total: Math.round(revenueTotal * 100) / 100,
      revenue_month: Math.round(revenueMonth * 100) / 100,
      revenue_today: Math.round(revenueToday * 100) / 100,
      paid_orders: paid.length,
      revenue_by_product: {
        broadcast: Math.round(revenueBy.broadcast * 100) / 100,
        comment: Math.round(revenueBy.comment * 100) / 100,
        essay: Math.round(revenueBy.essay * 100) / 100,
        english: Math.round(revenueBy.english * 100) / 100,
        roundtable: Math.round(revenueBy.roundtable * 100) / 100,
        edulab: Math.round(revenueBy.edulab * 100) / 100,
        shared_points: Math.round(revenueBy.shared_points * 100) / 100,
        learning: Math.round(revenueBy.learning * 100) / 100
      }
    },
    revenue_daily: revDaily,
    usage_daily: {
      days: usageDays,
      essay_gradings: dbStore.dailyCounts('essay_gradings', usageDays),
      comment_generations: dbStore.dailyCounts('comment_generations', usageDays),
      learning_usage: dbStore.dailyCounts('learning_usage', usageDays)
    },
    broadcast: {
      active_members: broadcastMembers.length,
      expiring_7d: broadcastMembers.filter(u => new Date(u.plan_expires) < in7d).length,
      total_classes: store.classes.length,
      total_notifications: store.notifications.length,
      notifications_today: notifToday,
      revenue: Math.round(revenueBy.broadcast * 100) / 100
    },
    comment: {
      total_generations: commentStats.total_generations,
      generations_today: dbStore.countRowsSince('comment_generations', todayIso),
      active_users: commentStats.active_comment_users,
      consumed_credits: commentStats.consumed_credits,
      purchased_credits: commentStats.purchased_credits,
      revenue: Math.round(revenueBy.comment * 100) / 100
    },
    essay: {
      total_gradings: essayStats.total_gradings,
      gradings_today: dbStore.countRowsSince('essay_gradings', todayIso),
      active_users: essayStats.active_essay_users,
      consumed_credits: essayStats.consumed_credits,
      purchased_credits: essayStats.purchased_credits,
      card_credits: essayStats.card_credits,
      unused_cards: essayStats.unused_cards,
      used_cards: essayStats.used_cards,
      active_plan_users: dbStore.getEssayActivePlanUserCount(),
      revenue: Math.round(revenueBy.essay * 100) / 100
    },
    english: { ...englishStats, revenue: Math.round(revenueBy.english * 100) / 100 },
    roundtable: { ...roundtableStats, revenue: Math.round(revenueBy.roundtable * 100) / 100 },
    edulab: { ...edulabStats, revenue: Math.round(revenueBy.edulab * 100) / 100 },
    learning: {
      total_usage: learningStats.total_usage,
      usage_today: dbStore.countRowsSince('learning_usage', todayIso),
      active_users: learningStats.active_users,
      saved_total: learningStats.saved_total,
      checkin_today: learningStats.checkin_today,
      active_members: learningStats.active_members,
      revenue: Math.round(revenueBy.learning * 100) / 100
    },
    shared_points: sharedPointStats,
    referrals: unifiedReferralStats,
    recent_payments: paid
      .slice()
      .sort((a, b) => String(b.paid_at || '').localeCompare(String(a.paid_at || '')))
      .slice(0, 10)
      .map(p => ({
        paid_at: p.paid_at, username: p.username, plan: p.plan,
        amount: p.amount, product: paymentProduct(p.plan || p.package, p.source_product)
      })),
    recent_users: store.users
      .slice()
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 10)
      .map(u => ({ username: u.username, display_name: u.display_name, created_at: u.created_at, contact: u.contact_value || '' }))
  });
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  socket.on('teacher-auth', (token) => {
    if (socket.userId) {
      socket.leave(`user:${socket.userId}`);
      socket.userId = null;
    }
    (socket.teacherClassRooms || []).forEach(room => socket.leave(room));
    socket.teacherClassRooms = [];
    const authToken = token || authTokenFromSocket(socket);
    const user = findUserByToken(authToken);
    if (!user) return socket.emit('teacher-auth-error');
    socket.userId = user.id;
    socket.join(`user:${user.id}`);
    socket.teacherClassRooms = getVisibleClasses(user.id).map(cls => `class:${cls.id}`);
    socket.teacherClassRooms.forEach(room => socket.join(room));
    socket.emit('teacher-auth-success');
  });

  socket.on('teacher-logout', () => {
    if (!socket.userId) return;
    socket.leave(`user:${socket.userId}`);
    (socket.teacherClassRooms || []).forEach(room => socket.leave(room));
    socket.teacherClassRooms = [];
    socket.userId = null;
  });

  socket.on('bind-screen', (bindCode) => {
    const cls = store.classes.find(c => c.bind_code === bindCode);
    if (!cls) return socket.emit('bind-error', '绑定码无效');
    socket.classId = cls.id;
    socket.join(`class:${cls.id}`);
    socket.emit('bind-success', {
      id: cls.id,
      name: cls.name,
      grade: cls.grade || 'junior',
      management_enabled: !!cls.management_enabled,
      points_sound_enabled: !!cls.points_sound_enabled,
      screen_token: issueScreenSession(cls)
    });
    socket.emit('bulletins-update', getActiveBulletins(cls.id));
    io.emit('online-update');
  });

  socket.on('screen-reply', (data) => {
    if (!socket.classId) return;
    const cls = store.classes.find(c => c.id === socket.classId);
    if (!cls) return;
    const replyText = String(data && data.reply_text || '').trim().slice(0, 50);
    if (!replyText) return;
    const reply = {
      class_id: socket.classId,
      class_name: cls.name,
      reply_text: replyText,
      created_at: new Date().toISOString()
    };
    if (!store.replies) store.replies = [];
    store.replies.push(reply);
    if (store.replies.length > 500) store.replies = store.replies.slice(-500);
    dbStore.insertReply(reply);
    dbStore.pruneReplies(500);
    getClassUsers(cls).forEach(user => {
      createUserMessage(
        user.id,
        'screen-reply',
        cls.name + ' 的教室回复',
        replyText,
        {
          class_id: cls.id,
          class_name: cls.name,
          reply_text: replyText
        }
      );
      io.to(`user:${user.id}`).emit('screen-reply', reply);
    });
  });

  socket.on('disconnect', () => {
    if (socket.classId) io.emit('online-update');
  });
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
});
