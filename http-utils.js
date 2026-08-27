'use strict';
// HTTP 工具层：子域识别 / Cookie 签名与解析 / 访客分析埋点 / 邀请归因。
const crypto = require('crypto');
const dbStore = require('./db');
const { safeEqual } = require('./auth-core');
const {
  AUTH_COOKIE_NAME, ANALYTICS_COOKIE_NAME, INVITE_COOKIE_NAME, DEVICE_COOKIE_NAME, INVITE_COOKIE_MAX_AGE_MS, INVITE_COOKIE_SECRET, ANALYTICS_HASH_SALT
} = require('./platform-config');

function commentHost(req) {
  const host = String(req.get('host') || '').split(':')[0].toLowerCase();
  return host === 'comment.yingyuzuowen.asia' || host.startsWith('comment.');
}

function shixingHost(req) {
  const host = String(req.get('host') || '').split(':')[0].toLowerCase();
  return host === 'shixing.yingyuzuowen.asia' || host.startsWith('shixing.');
}

function essayHost(req) {
  const host = String(req.get('host') || '').split(':')[0].toLowerCase();
  return host === 'zuowen.yingyuzuowen.asia' || host.startsWith('zuowen.');
}

function englishHost(req) {
  const host = String(req.get('host') || '').split(':')[0].toLowerCase();
  return host === 'english.yingyuzuowen.asia' || host.startsWith('english.');
}

function learningHost(req) {
  return isLearningHost(req.get('host'));
}

function roundtableHost(req) {
  const host = String(req.get('host') || '').split(':')[0].toLowerCase();
  return host === 'roundtable.yingyuzuowen.asia' || host.startsWith('roundtable.');
}

function parseCookieHeader(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(value);
    } catch (e) {
      out[key] = value;
    }
  });
  return out;
}

function requestHost(req) {
  return String(req.hostname || req.get('host') || '').split(':')[0].toLowerCase();
}

function authCookieDomain(req) {
  const host = requestHost(req);
  if (host === 'yingyuzuowen.asia' || host.endsWith('.yingyuzuowen.asia')) {
    return '.yingyuzuowen.asia';
  }
  return undefined;
}

function cookieSecure(req) {
  return req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
}

function authCookieOptions(req) {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 30
  };
  const domain = authCookieDomain(req);
  if (domain) options.domain = domain;
  if (cookieSecure(req)) options.secure = true;
  return options;
}

function setAuthCookie(req, res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions(req));
}

const ANALYTICS_EVENTS = new Set([
  'page_view',
  'product_click',
  'auth_prompt',
  'code_request',
  'registration_success',
  'login_success'
]);
const ANALYTICS_PRODUCTS = new Set([
  'shixing',
  'broadcast',
  'comment',
  'essay',
  'english',
  'roundtable',
  'edulab',
  'learning'
]);
const analyticsRateLimits = new Map();

function analyticsCookieOptions(req) {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60 * 1000
  };
  const domain = authCookieDomain(req);
  if (domain) options.domain = domain;
  if (cookieSecure(req)) options.secure = true;
  return options;
}

function analyticsVisitorHash(visitorId) {
  return crypto.createHmac('sha256', ANALYTICS_HASH_SALT).update(String(visitorId)).digest('hex');
}

function validAnalyticsVisitorId(value) {
  return /^[a-zA-Z0-9_-]{16,80}$/.test(String(value || ''));
}

function analyticsPath(value) {
  let pathname = String(value || '/').split(/[?#]/)[0];
  if (!pathname.startsWith('/')) pathname = '/';
  return pathname.slice(0, 180) || '/';
}

function analyticsReferrerHost(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase().slice(0, 120);
  } catch (e) {
    return /^[a-z0-9.-]+$/i.test(raw) ? raw.toLowerCase().slice(0, 120) : '';
  }
}

function analyticsSource(value, referrerHost) {
  const clean = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  return clean || referrerHost || 'direct';
}

function analyticsDevice(req) {
  const ua = String(req.get('user-agent') || '').toLowerCase();
  if (/ipad|tablet/.test(ua)) return 'tablet';
  if (/mobile|iphone|android/.test(ua)) return 'mobile';
  return 'desktop';
}

function analyticsProductFromReq(req, explicit) {
  const named = String(explicit || '').trim().toLowerCase();
  if (ANALYTICS_PRODUCTS.has(named)) return named;
  const host = requestHost(req);
  if (host.startsWith('shixing.')) return 'shixing';
  if (host.startsWith('comment.')) return 'comment';
  if (host.startsWith('zuowen.')) return 'essay';
  if (host.startsWith('english.')) return 'english';
  if (host.startsWith('roundtable.')) return 'roundtable';
  if (host.startsWith('xiezuo.')) return 'learning';
  let pathname = String(req.path || '/');
  try {
    const referrer = req.get('referer');
    if (referrer) pathname = new URL(referrer).pathname || pathname;
  } catch (e) {}
  if (pathname.startsWith('/comment')) return 'comment';
  if (pathname.startsWith('/zuowen') || pathname.startsWith('/essay')) return 'essay';
  if (pathname.startsWith('/english')) return 'english';
  if (pathname.startsWith('/roundtable')) return 'roundtable';
  if (pathname.startsWith('/edulab')) return 'edulab';
  if (pathname.startsWith('/xiezuo') || pathname.startsWith('/learning')) return 'learning';
  return 'broadcast';
}

function analyticsVisitorFromReq(req, res, requestedId) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const cookieId = String(cookies[ANALYTICS_COOKIE_NAME] || '');
  const bodyId = String(requestedId || '');
  const visitorId = validAnalyticsVisitorId(bodyId)
    ? bodyId
    : (validAnalyticsVisitorId(cookieId) ? cookieId : crypto.randomBytes(18).toString('base64url'));
  if (visitorId !== cookieId) res.cookie(ANALYTICS_COOKIE_NAME, visitorId, analyticsCookieOptions(req));
  return visitorId;
}

function recordAnalyticsFromRequest(req, res, eventName, options = {}) {
  try {
    const visitorId = analyticsVisitorFromReq(req, res, options.visitor_id);
    const referrerHost = analyticsReferrerHost(options.referrer || options.referrer_host || req.get('referer'));
    return dbStore.recordConversionEvent({
      visitor_hash: analyticsVisitorHash(visitorId),
      user_id: options.user_id || null,
      product: analyticsProductFromReq(req, options.product),
      event_name: eventName,
      path: analyticsPath(options.path || req.path),
      source: analyticsSource(options.source, referrerHost),
      referrer_host: referrerHost || null,
      device: analyticsDevice(req),
      created_at: new Date().toISOString()
    });
  } catch (e) {
    console.log('[ANALYTICS] record failed:', e.message);
    return null;
  }
}

function analyticsRequestAllowed(req) {
  const now = Date.now();
  const key = crypto.createHmac('sha256', ANALYTICS_HASH_SALT).update(String(req.ip || '')).digest('hex');
  const row = analyticsRateLimits.get(key);
  if (!row || now - row.started_at >= 60 * 1000) {
    if (analyticsRateLimits.size > 5000) analyticsRateLimits.clear();
    analyticsRateLimits.set(key, { started_at: now, count: 1 });
    return true;
  }
  row.count++;
  return row.count <= 120;
}

function clearAuthCookie(req, res) {
  const options = authCookieOptions(req);
  delete options.maxAge;
  res.clearCookie(AUTH_COOKIE_NAME, options);
}

function referralCookieOptions(req) {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: INVITE_COOKIE_MAX_AGE_MS
  };
  const domain = authCookieDomain(req);
  if (domain) options.domain = domain;
  if (cookieSecure(req)) options.secure = true;
  return options;
}

function deviceCookieOptions(req) {
  const options = referralCookieOptions(req);
  options.maxAge = 365 * 24 * 60 * 60 * 1000;
  return options;
}

function encodeInviteCookie(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', INVITE_COOKIE_SECRET).update(body).digest('hex');
  return body + '.' + signature;
}

function decodeInviteCookie(value) {
  const raw = String(value || '');
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', INVITE_COOKIE_SECRET).update(body).digest('hex');
  if (!safeEqual(expected, signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.code || Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function invitePayloadFromReq(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  return decodeInviteCookie(cookies[INVITE_COOKIE_NAME]);
}

function deviceHashFromReq(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const deviceId = String(cookies[DEVICE_COOKIE_NAME] || '');
  return deviceId ? crypto.createHash('sha256').update(deviceId).digest('hex') : '';
}

function clearInviteCookie(req, res) {
  const options = referralCookieOptions(req);
  delete options.maxAge;
  res.clearCookie(INVITE_COOKIE_NAME, options);
}

function referralAttributionFromReq(req) {
  const bodyCode = String(req.body && req.body.ref || '').trim().toUpperCase();
  const cookiePayload = invitePayloadFromReq(req);
  const code = bodyCode || String(cookiePayload && cookiePayload.code || '').trim().toUpperCase();
  if (!code) return { provided: false };
  const inviter = dbStore.findUnifiedInviterByCode(code);
  if (!inviter) return { provided: true, error: '邀请码无效，请检查后重试' };
  return {
    provided: true,
    inviter,
    code,
    source_product: String(bodyCode ? (req.body.source_product || 'manual') : (cookiePayload.source || 'shixing')).slice(0, 30),
    device_hash: deviceHashFromReq(req)
  };
}

function authTokenFromReq(req) {
  const headerToken = req.headers['x-token'];
  if (headerToken) return headerToken;
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[AUTH_COOKIE_NAME] || '';
}

function authTokenFromSocket(socket) {
  const cookies = parseCookieHeader(socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie);
  return cookies[AUTH_COOKIE_NAME] || '';
}

module.exports = {
  commentHost,
  shixingHost,
  essayHost,
  englishHost,
  learningHost,
  roundtableHost,
  parseCookieHeader,
  requestHost,
  authCookieDomain,
  cookieSecure,
  authCookieOptions,
  setAuthCookie,
  ANALYTICS_EVENTS,
  ANALYTICS_PRODUCTS,
  analyticsRateLimits,
  analyticsCookieOptions,
  analyticsVisitorHash,
  validAnalyticsVisitorId,
  analyticsPath,
  analyticsReferrerHost,
  analyticsSource,
  analyticsDevice,
  analyticsProductFromReq,
  analyticsVisitorFromReq,
  recordAnalyticsFromRequest,
  analyticsRequestAllowed,
  clearAuthCookie,
  referralCookieOptions,
  deviceCookieOptions,
  encodeInviteCookie,
  decodeInviteCookie,
  invitePayloadFromReq,
  deviceHashFromReq,
  clearInviteCookie,
  referralAttributionFromReq,
  authTokenFromReq,
  authTokenFromSocket,
};
