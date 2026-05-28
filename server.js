const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

function loadPaymentConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'payment-config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

const PAYMENT_CONFIG = loadPaymentConfig();
function configValue(envName, fileName, fallback) {
  const value = process.env[envName] !== undefined ? process.env[envName] : PAYMENT_CONFIG[fileName];
  return String(value === undefined || value === null ? fallback : value).trim();
}

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'change-me-in-production';
const DB_FILE = path.join(__dirname, 'data.json');
const FREE_TRIAL_DAYS = 3;
const PAID_PLAN_DAYS = 365;
const YEARLY_PLAN_PRICE = configValue('YEARLY_PLAN_PRICE', 'yearly_plan_price', '9.90');
const PUBLIC_BASE_URL = configValue('PUBLIC_BASE_URL', 'public_base_url', '').replace(/\/+$/, '');
const YUNGOU_MCH_ID = configValue('YUNGOU_MCH_ID', 'yungou_mch_id', '');
const YUNGOU_PAY_KEY = configValue('YUNGOU_PAY_KEY', 'yungou_pay_key', '');
const YUNGOU_APP_ID = configValue('YUNGOU_APP_ID', 'yungou_app_id', '');
const YUNGOU_API_HOST = 'api.pay.yungouos.com';
const LEGACY_PREMIUM_PLAN = 'life' + 'time';

app.set('trust proxy', true);

// ---------- JSON Store ----------
function loadDB() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.users) data.users = [];
    if (!data.classes) data.classes = [];
    if (!data.notifications) data.notifications = [];
    if (!data.replies) data.replies = [];
    if (!data.messages) data.messages = [];
    if (!data.bulletins) data.bulletins = [];
    if (!data.payments) data.payments = [];
    if (!data.nextNotifId) data.nextNotifId = 1;
    if (!data.nextMessageId) data.nextMessageId = 1;
    if (!data.nextBulletinId) data.nextBulletinId = 1;
    return data;
  } catch {
    return {
      users: [],
      classes: [],
      notifications: [],
      replies: [],
      messages: [],
      bulletins: [],
      payments: [],
      nextNotifId: 1,
      nextMessageId: 1,
      nextBulletinId: 1
    };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let store = loadDB();
if (normalizeStore(store)) saveDB(store);

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

function genCode(length = 6) {
  let code = '';
  while (code.length < length) {
    code += crypto.randomBytes(6).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  }
  return code.slice(0, length);
}

function genUniqueBindCode() {
  let code = genCode();
  while (store.classes.find(c => c.bind_code === code)) code = genCode();
  return code;
}

function genUniqueTeacherCode() {
  let code = genCode();
  while (store.users.find(u => u.teacher_code === code)) code = genCode();
  return code;
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
    online: onlineCounts ? (onlineCounts[cls.id] || 0) : 0
  };
}

function getTeacherName(user) {
  if (!user) return '';
  return user.display_name || user.username || '老师';
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
  io.to(`user:${userId}`).emit('teacher-message', message);
  return message;
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

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const result = crypto.scryptSync(password, salt, 64).toString('hex');
  return result === hash;
}

function yuanToCents(value) {
  return Math.round(parseFloat(value || '0') * 100);
}

function planPriceDisplay() {
  return (parseFloat(YEARLY_PLAN_PRICE) || 0).toFixed(2);
}

function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
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

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
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

function createPaymentOrderNo() {
  return 'CB' + Date.now() + crypto.randomBytes(4).toString('hex').toUpperCase();
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

function markPaymentPaid(payment, normalized, raw) {
  if (payment.status === 'paid') return payment;
  const user = store.users.find(u => u.id === payment.user_id);
  if (!user) return payment;
  payment.status = 'paid';
  payment.provider_order_no = normalized.orderNo || payment.provider_order_no || '';
  payment.provider_pay_no = normalized.payNo || payment.provider_pay_no || '';
  payment.paid_at = new Date().toISOString();
  payment.notify_payload = raw;
  payment.plan_expires = activateYearlyPlan(user).expires;
  createUserMessage(
    user.id,
    'payment-success',
    '年费版已开通',
    '微信支付成功，班级广播年费版已开通至 ' + new Date(payment.plan_expires).toLocaleDateString('zh-CN'),
    { out_trade_no: payment.out_trade_no }
  );
  return payment;
}

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getUserPlanStatus(user) {
  if (!user) return { active: false, reason: 'not_found' };
  if (user.plan === 'yearly') {
    const label = '年费版';
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

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

function userAuth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: '请先登录' });
  const user = store.users.find(u => u.token === token);
  if (!user) return res.status(401).json({ error: '登录已过期，请重新登录' });
  req.user = user;
  req.planStatus = getUserPlanStatus(user);
  next();
}

function adminAuth(req, res, next) {
  const token = req.headers['x-token'];
  if (token !== ADMIN_PASS) return res.status(401).json({ error: '管理员密码错误' });
  next();
}

function requireActivePlan(req, res, next) {
  if (!req.planStatus.active) {
    return res.status(403).json({ error: '您的使用期限已到，请续费后继续使用', plan_status: req.planStatus });
  }
  next();
}

// ---------- User API ----------
app.post('/api/register', (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名2-20个字符' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少4位' });
  if (store.users.find(u => u.username === username)) {
    return res.status(400).json({ error: '用户名已存在' });
  }
  const { hash, salt } = hashPassword(password);
  const token = genToken();
  const user = {
    id: crypto.randomUUID(),
    username,
    display_name: display_name || username,
    teacher_code: genUniqueTeacherCode(),
    password_hash: hash,
    password_salt: salt,
    plan: 'trial',
    plan_expires: null,
    token,
    created_at: new Date().toISOString()
  };
  store.users.push(user);
  saveDB(store);
  const status = getUserPlanStatus(user);
  res.json({ ok: true, token, user: { id: user.id, username: user.username, display_name: user.display_name, teacher_code: user.teacher_code }, plan_status: status });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const user = store.users.find(u => u.username === username);
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  user.token = genToken();
  if (!user.teacher_code) user.teacher_code = genUniqueTeacherCode();
  saveDB(store);
  const status = getUserPlanStatus(user);
  res.json({ ok: true, token: user.token, user: { id: user.id, username: user.username, display_name: user.display_name, teacher_code: user.teacher_code }, plan_status: status });
});

app.get('/api/profile', userAuth, (req, res) => {
  const u = req.user;
  const classCount = getVisibleClasses(u.id).length;
  const notifCount = store.notifications.filter(n => n.user_id === u.id).length;
  res.json({
    id: u.id, username: u.username, display_name: u.display_name, teacher_code: u.teacher_code,
    avatar: u.avatar || 'a1',
    plan: u.plan, plan_expires: u.plan_expires, created_at: u.created_at,
    plan_status: req.planStatus,
    class_count: classCount,
    notif_count: notifCount
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
  saveDB(store);
  res.json({ ok: true, display_name: req.user.display_name, avatar: req.user.avatar || 'a1' });
});

// ---------- Payment API ----------
app.get('/api/payments/config', userAuth, (req, res) => {
  res.json({
    enabled: yungouConfigured(),
    yearly_price: planPriceDisplay(),
    yearly_days: PAID_PLAN_DAYS
  });
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
  saveDB(store);

  const requiredParams = {
    out_trade_no: outTradeNo,
    total_fee: amount,
    mch_id: YUNGOU_MCH_ID,
    body: '班级广播年费版'
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
      saveDB(store);
      return res.status(502).json({ error: payment.error });
    }
    const payUrl = extractPayUrl(result.data);
    if (!payUrl) {
      payment.status = 'create_failed';
      payment.error = '支付链接为空';
      saveDB(store);
      return res.status(502).json({ error: payment.error });
    }
    payment.status = 'pending';
    saveDB(store);
    res.json({
      ok: true,
      out_trade_no: outTradeNo,
      amount,
      pay_url: payUrl
    });
  } catch (e) {
    payment.status = 'create_failed';
    payment.error = e.message;
    saveDB(store);
    res.status(502).json({ error: '创建支付订单失败：' + e.message });
  }
});

app.get('/api/payments/:outTradeNo', userAuth, (req, res) => {
  const payment = findPayment(req.params.outTradeNo);
  if (!payment || payment.user_id !== req.user.id) {
    return res.status(404).json({ error: '订单不存在' });
  }
  res.json({
    out_trade_no: payment.out_trade_no,
    status: payment.status,
    amount: payment.amount,
    paid_at: payment.paid_at || null,
    plan_expires: payment.plan_expires || null,
    plan_status: getUserPlanStatus(req.user)
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
  if (yuanToCents(normalized.money) !== yuanToCents(YEARLY_PLAN_PRICE)) {
    console.log('[PAY] amount mismatch', normalized.money, normalized.outTradeNo);
    return res.status(400).send('fail');
  }

  const payment = findPayment(normalized.outTradeNo);
  if (!payment) {
    console.log('[PAY] payment not found', normalized.outTradeNo);
    return res.status(404).send('fail');
  }
  markPaymentPaid(payment, normalized, raw);
  saveDB(store);
  res.send('success');
});

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
  const cls = { id, user_id: req.user.id, name, grade, bind_code, member_ids: [], created_at: new Date().toISOString() };
  store.classes.push(cls);
  saveDB(store);
  res.json(classResponse(cls, req.user.id));
});

app.delete('/api/classes/:id', userAuth, (req, res) => {
  const cls = store.classes.find(c => c.id === req.params.id && c.user_id === req.user.id);
  if (!cls) return res.status(404).json({ error: '班级不存在' });
  store.classes = store.classes.filter(c => c.id !== req.params.id);
  store.notifications = store.notifications.filter(n => n.class_id !== req.params.id);
  store.bulletins = store.bulletins.filter(b => b.class_id !== req.params.id);
  saveDB(store);
  res.json({ ok: true });
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
  saveDB(store);
  res.json({ ok: true, class: classResponse(cls, req.user.id), teacher: { id: target.id, display_name: target.display_name, teacher_code: target.teacher_code } });
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
  saveDB(store);
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
  saveDB(store);

  const emitData = { ...notification, class_name: cls.name, avatar: req.user.avatar || 'a1' };
  io.to(`class:${class_id}`).emit('notification', emitData);
  res.json(emitData);
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
  saveDB(store);
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
  saveDB(store);
  emitBulletins(cls.id);
  res.json({ ok: true });
});

// ---------- TTS ----------
app.post('/api/tts', (req, res) => {
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
    plan: u.plan, plan_expires: u.plan_expires, created_at: u.created_at,
    plan_status: getUserPlanStatus(u),
    class_count: store.classes.filter(c => c.user_id === u.id).length,
    notif_count: store.notifications.filter(n => n.user_id === u.id).length
  }));
  res.json(users);
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
  saveDB(store);
  res.json({ ok: true, plan_status: getUserPlanStatus(user) });
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const total = store.users.length;
  const active = store.users.filter(u => getUserPlanStatus(u).active).length;
  const paid = store.users.filter(u => u.plan === 'yearly').length;
  res.json({ total_users: total, active_users: active, paid_users: paid, total_notifications: store.notifications.length, total_classes: store.classes.length });
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  socket.on('teacher-auth', (token) => {
    if (socket.userId) {
      socket.leave(`user:${socket.userId}`);
      socket.userId = null;
    }
    const user = store.users.find(u => u.token === token);
    if (!user) return socket.emit('teacher-auth-error');
    socket.userId = user.id;
    socket.join(`user:${user.id}`);
    socket.emit('teacher-auth-success');
  });

  socket.on('teacher-logout', () => {
    if (!socket.userId) return;
    socket.leave(`user:${socket.userId}`);
    socket.userId = null;
  });

  socket.on('bind-screen', (bindCode) => {
    const cls = store.classes.find(c => c.bind_code === bindCode);
    if (!cls) return socket.emit('bind-error', '绑定码无效');
    socket.classId = cls.id;
    socket.join(`class:${cls.id}`);
    socket.emit('bind-success', { id: cls.id, name: cls.name, grade: cls.grade || 'junior' });
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
    saveDB(store);
  });

  socket.on('disconnect', () => {
    if (socket.classId) io.emit('online-update');
  });
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
  console.log(`管理密码: ${ADMIN_PASS}`);
});
