'use strict';
// 中间件与会话层：用户/管理员鉴权 / 套餐校验 / 大屏绑定会话 / 学习会员门控。
const crypto = require('crypto');
// @WIRE
const {
  findUserByToken, getUserPlanStatus, refreshUserTokenExpiry, safeEqual
} = require('./auth-core');
const {
  authTokenFromReq, cookieSecure, parseCookieHeader
} = require('./http-utils');
const {
  ADMIN_COOKIE_NAME, ADMIN_PASS, ADMIN_PASS_IS_DEFAULT, ADMIN_SESSION_TTL_MS, INVITE_COOKIE_SECRET, LEARNING_DAILY_LIMIT
} = require('./platform-config');
const state = require('./state');

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

// 管理员会话路由（与中间件强内聚，随本模块安装）
function installAdminSessionRoutes(app) {
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
}

function requireLearningMember(req, res, next) {
  const status = dbStore.getLearningMembershipStatus(req.user);
  if (!status.active) return res.status(403).json({ error: '体验已结束，请开通学期卡或年卡', membership: status });
  req.learningMembership = status;
  next();
}

function learningUsageAllowed(userId) {
  return dbStore.countLearningUsageToday(userId) < LEARNING_DAILY_LIMIT;
}

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
  const cls = state.store.classes.find(row => row.id === session.class_id);
  if (!cls) return res.status(404).json({ error: '班级不存在' });
  session.expires_at = Date.now() + SCREEN_SESSION_TTL_MS;
  req.screenClass = cls;
  req.screenSessionToken = token;
  next();
}

function classOwnerPlanStatus(cls) {
  const owner = cls && state.store.users.find(user => user.id === cls.user_id);
  return getUserPlanStatus(owner);
}

function requireActiveScreenClassPlan(req, res, next) {
  const planStatus = classOwnerPlanStatus(req.screenClass);
  if (!planStatus.active) {
    return res.status(403).json({ error: '班级广播使用期限已到，请联系老师续费', plan_status: planStatus });
  }
  next();
}

module.exports = {
  installAdminSessionRoutes,
  userAuth,
  adminAuthFailures,
  adminSessions,
  ADMIN_FAIL_LIMIT,
  ADMIN_FAIL_WINDOW_MS,
  adminAuth,
  adminCookieOptions,
  clearAdminCookie,
  adminIpHash,
  auditAdmin,
  requireLearningMember,
  learningUsageAllowed,
  SCREEN_SESSION_TTL_MS,
  screenSessions,
  issueScreenSession,
  screenSessionAuth,
  classOwnerPlanStatus,
  requireActiveScreenClassPlan,
};
