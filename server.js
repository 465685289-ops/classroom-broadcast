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

const {
  mailConfigured, mailTransporter, getMailTransporter, genResetCode, ADMIN_NOTIFY_EMAIL, ADMIN_PLAN_LABELS, notifyAdmin, notifyAdminNewUser, notifyAdminPayment, genericResetCodeMessage, sendPasswordResetEmail, sendRegistrationEmail
} = require('./mail-center.js');

const {
  createUserMessage, notifyUnifiedActivation, rewardUnifiedPurchaseForPayment, extendBroadcastPlanDays, broadcastInviterIsPaid, rewardBroadcastReferralOnPurchase, rewardCommentReferralOnPurchase, rewardEssayReferralOnPurchase
} = require('./messaging-referrals.js');

const {
  yuanToCents, planPriceDisplay, moneyDisplay, getBaseUrl, getCommentBaseUrl, yungouConfigured, yungouSign, yungouRequest, createPaymentOrderNo, findPayment, extractPayUrl, readFirst, publicPointPackages, getPointPackage, getLegacyCommentPackage, publicEssayPackages, getEssayPackage, getEssayTimePackage, publicEssayTimePackages, getEssayBaseUrl, getLearningBaseUrl, getLearningPackage, publicCommentPackages, publicRoundtablePackages, getLegacyRoundtablePackage, getRoundtableBaseUrl, normalizeYungouNotify, checkYungouNotifySign, markPaymentPaid
} = require('./payment-engine.js');

const {
  normalizeCommentStudent, normalizeCommentRosterStudents, normalizeRosterName, commentStyleLabel, commentStyleGuide, deepseekChatCompletion, learningGenerateAI, deepseekChatStream, generateAICommentForStudent, commentRewriteGuide, rewriteAICommentForStudent, openAICompatChat, qwenOcrImage, stripThinkBlocks, gradeEssayAI, essayAIConfigured, ESSAY_GENRES, ESSAY_GRADE_LEVELS, ESSAY_SCORE_TYPES, essayTeacherStage, essayScoreRule, ESSAY_DIMENSIONS, buildEssayPrompt, extractEssayJson, normalizeEssayData, essayDataToLegacyText, ENGLISH_TASK_TYPES, ENGLISH_RUBRIC_PRESETS, englishRubricFor, englishFullScore, buildEnglishEssayPrompt, normalizeEnglishEssayData, englishDataToText, essayOcrUsage, essayOcrAllowed
} = require('./ai-engines.js');

const {
  installAdminSessionRoutes, userAuth, adminAuthFailures, adminSessions, ADMIN_FAIL_LIMIT, ADMIN_FAIL_WINDOW_MS, adminAuth, adminCookieOptions, clearAdminCookie, adminIpHash, auditAdmin, requireLearningMember, learningUsageAllowed, SCREEN_SESSION_TTL_MS, screenSessions, issueScreenSession, screenSessionAuth, classOwnerPlanStatus, requireActiveScreenClassPlan
} = require('./middleware.js');

const {
  installCommentRoutes
} = require('./comment-routes.js');

const {
  installLearningRoutes
} = require('./learning-routes.js');

const {
  installEnglishRoutes
} = require('./english-routes.js');

const {
  installReferralRoutes
} = require('./referral-routes.js');

const {
  installRoundtableRoutes
} = require('./roundtable-routes.js');

const {
  installEssayRoutes
} = require('./essay-routes.js');

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


function normalizeEmailInput(value) {
  const contact = normalizeContactInput(value);
  if (!contact || contact.type !== 'email') return null;
  return contact.value;
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

// ---- 应用级中间件与页面路由（保持原顺序）----
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
installAdminSessionRoutes(app);
installCommentRoutes(app);
installLearningRoutes(app);
installEnglishRoutes(app);
installReferralRoutes(app);
installRoundtableRoutes(app);
installEssayRoutes(app);

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

// ── 工作台会话换广播令牌（同域统一账号 SSO 的最后一环）──

const WORKBENCH_SSO_URL = (process.env.WORKBENCH_SSO_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '')

app.post('/api/sso/from-workbench', async (req, res) => {
  const bearer = String(req.headers.authorization || '')
  const workbenchToken = bearer.startsWith('Bearer ') ? bearer.slice(7) : ''
  if (!workbenchToken) return res.status(401).json({ error: '缺少工作台会话' })
  let me
  try {
    const resp = await fetch(`${WORKBENCH_SSO_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${workbenchToken}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return res.status(401).json({ error: '工作台会话已过期，请重新登录工作台' })
    me = await resp.json()
  } catch {
    return res.status(503).json({ error: '工作台账号服务暂时不可用' })
  }
  if (!me?.id) return res.status(401).json({ error: '工作台会话已过期，请重新登录工作台' })
  const state = store
  const shixingSuffix = String(me.shixingUserId || '').startsWith('shixing:')
    ? String(me.shixingUserId).slice('shixing:'.length)
    : ''
  const workbenchLink = `workbench:${me.id}`
  const email = String(me.email || '').trim().toLowerCase()
  let user
  if (shixingSuffix) user = state.users.find((item) => item.id === shixingSuffix)
  if (!user && email) {
    user = state.users.find((item) => item.contact_type === 'email'
      && String(item.contact_value || '').trim().toLowerCase() === email)
  }
  if (!user) {
    return res.status(404).json({ error: '未找到同名广播账号，请直接用广播账号登录一次' })
  }
  user.workbenchUserId = workbenchLink
  let token = user.token
  if (!(token && user.token_expires && Date.parse(user.token_expires) > Date.now())) {
    token = genToken()
    user.token = token
    user.token_expires = new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString()
  }
  saveDB(state)
  res.set('Cache-Control', 'no-store')
  res.json({ token, username: user.username, display_name: user.display_name, plan_status: getUserPlanStatus(user) })
})

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

installCommentRoutes(app);

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
