const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-unified-admin-' + Date.now());
let app;
let port;

function read(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }

function compileInlineScripts(file) {
  const html = read(file);
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim()).filter(Boolean)
    .forEach((source, index) => new vm.Script(source, { filename: file + '#script-' + index }));
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function request(pathname, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + pathname, {
    redirect: options.redirect || 'manual',
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.token ? { 'X-Token': options.token } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch (e) {}
  return { status: response.status, body, headers: response.headers };
}

async function waitForApp() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/api/admin/session');
      if (response.status) return;
    } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

test.before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const portServer = http.createServer();
  port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SQLITE_FILE: path.join(TMP, 'test.db'),
      LEGACY_JSON_FILE: path.join(TMP, 'missing-data.json'),
      BACKUP_DIR: path.join(TMP, 'backups'),
      ADMIN_PASS: 'test-admin-pass'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForApp();
});

test.after(() => {
  if (app && !app.killed) app.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('admin authentication uses a revocable HttpOnly session instead of persisting the password', async () => {
  const invalid = await request('/api/admin/login', { method: 'POST', body: { password: 'wrong' } });
  assert.equal(invalid.status, 401);

  const login = await request('/api/admin/login', { method: 'POST', body: { password: 'test-admin-pass' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.ok, true);
  assert.equal(JSON.stringify(login.body).includes('test-admin-pass'), false);
  const setCookie = String(login.headers.get('set-cookie') || '');
  assert.match(setCookie, /shixing_admin=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.match(/shixing_admin=[^;]+/)[0];

  assert.equal((await request('/api/admin/session', { cookie })).status, 200);
  assert.equal((await request('/api/admin/stats', { cookie })).status, 200);
  assert.equal((await request('/api/admin/audit', { cookie })).status, 200);

  const logout = await request('/api/admin/logout', { method: 'POST', cookie });
  assert.equal(logout.status, 200);
  assert.equal((await request('/api/admin/stats', { cookie })).status, 401);
});

test('admin login keeps the existing failed-attempt rate limit', async () => {
  const resetFailures = await request('/api/admin/login', { method: 'POST', body: { password: 'test-admin-pass' } });
  assert.equal(resetFailures.status, 200);
  for (let i = 0; i < 10; i++) {
    const attempt = await request('/api/admin/login', { method: 'POST', body: { password: 'wrong-' + i } });
    assert.equal(attempt.status, 401);
  }
  const limited = await request('/api/admin/login', { method: 'POST', body: { password: 'still-wrong' } });
  assert.equal(limited.status, 429);
});

test('the one admin page contains all eight modules and loads them independently', () => {
  const html = read('public/admin.html');
  for (const name of ['概览', '转化', '用户', '财务', '产品', '邀请', '客服', '系统']) assert.match(html, new RegExp(name));
  for (const endpoint of ['/api/admin/login', '/api/admin/dashboard', '/api/admin/conversions', '/api/admin/users/search', '/api/admin/orders', '/api/admin/products', '/api/admin/referrals', '/api/admin/audit']) {
    assert.match(html, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), endpoint);
  }
  assert.doesNotMatch(html, /localStorage[^\n]{0,80}admin_token|admin_token[^\n]{0,80}localStorage/i);
  assert.doesNotMatch(html, /\bprompt\s*\(|\bconfirm\s*\(/);
  assert.match(html, /半年会员/);
  compileInlineScripts('public/admin.html');
});

test('the old dashboard redirects and duplicate mutation routes are removed', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/dashboard\.html'[\s\S]{0,220}\/admin\.html#overview/);
  assert.equal((server.match(/app\.post\('\/api\/admin\/activate'/g) || []).length, 1);
  assert.equal((server.match(/app\.post\('\/api\/admin\/reset-password'/g) || []).length, 1);
});

test('the dashboard payload uses unified referrals and includes every product family', () => {
  const server = read('server.js');
  const dashboard = server.slice(server.indexOf("app.get('/api/admin/dashboard'"), server.indexOf('// ---------- Socket.IO'));
  assert.match(dashboard, /getUnifiedReferralAdminStats/);
  for (const key of ['broadcast', 'comment', 'essay', 'english', 'roundtable', 'edulab', 'learning', 'shared_points']) {
    assert.match(dashboard, new RegExp('\\b' + key + '\\b'), key);
  }
  assert.match(dashboard, /english:\s*Math\.round\(revenueBy\.english/);
  assert.match(dashboard, /english:\s*\{\s*\.\.\.englishStats,\s*revenue:\s*Math\.round\(revenueBy\.english/);
  assert.doesNotMatch(dashboard, /getAppReferralStats|getEssayReferralStats/);
});
