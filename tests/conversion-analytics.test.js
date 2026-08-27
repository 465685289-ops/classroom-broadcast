const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-conversion-analytics-' + Date.now());
let app;
let port;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function request(pathname, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + pathname, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {})
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
      ADMIN_PASS: 'test-admin-pass',
      ANALYTICS_HASH_SALT: 'test-analytics-salt'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForApp();
});

test.after(() => {
  if (app && !app.killed) app.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('anonymous conversion events are sanitized, deduplicated and visible only to admins', async () => {
  const visitorA = '550e8400-e29b-41d4-a716-446655440000';
  const firstView = await request('/api/analytics/event', {
    method: 'POST',
    body: {
      visitor_id: visitorA,
      event_name: 'page_view',
      product: 'shixing',
      path: '/?invite=private-code',
      source: 'wechat',
      referrer: 'https://mp.weixin.qq.com/s?__biz=private-value'
    }
  });
  assert.equal(firstView.status, 202);
  assert.equal(firstView.body.ok, true);
  assert.match(String(firstView.headers.get('set-cookie') || ''), /shixing_vid=/);
  assert.match(String(firstView.headers.get('set-cookie') || ''), /HttpOnly/i);

  const duplicateView = await request('/api/analytics/event', {
    method: 'POST',
    body: {
      visitor_id: visitorA,
      event_name: 'page_view',
      product: 'shixing',
      path: '/',
      source: 'wechat',
      referrer: 'https://mp.weixin.qq.com/another-private-path'
    }
  });
  assert.equal(duplicateView.status, 202);

  const productClick = await request('/api/analytics/event', {
    method: 'POST',
    body: {
      visitor_id: visitorA,
      event_name: 'product_click',
      product: 'broadcast',
      path: '/',
      source: 'shixing'
    }
  });
  assert.equal(productClick.status, 202);

  const secondVisitor = await request('/api/analytics/event', {
    method: 'POST',
    body: {
      visitor_id: '621f1d66-b666-4cf2-9047-cb3fdf94c1f2',
      event_name: 'page_view',
      product: 'comment',
      path: '/comment.html',
      referrer: 'https://www.xiaohongshu.com/explore/secret-note'
    }
  });
  assert.equal(secondVisitor.status, 202);

  const rejected = await request('/api/analytics/event', {
    method: 'POST',
    body: {
      visitor_id: 'not-a-valid-id',
      event_name: 'arbitrary_event',
      product: 'unknown',
      path: '/'
    }
  });
  assert.equal(rejected.status, 400);

  assert.equal((await request('/api/admin/conversions?days=30')).status, 401);
  const login = await request('/api/admin/login', {
    method: 'POST',
    body: { password: 'test-admin-pass' }
  });
  assert.equal(login.status, 200);
  const cookie = String(login.headers.get('set-cookie') || '').match(/shixing_admin=[^;]+/)[0];
  const report = await request('/api/admin/conversions?days=30', { cookie });
  assert.equal(report.status, 200);
  assert.equal(report.body.days, 30);
  assert.equal(report.body.summary.page_views, 2);
  assert.equal(report.body.summary.unique_visitors, 2);
  assert.equal(report.body.summary.product_clicks, 1);
  assert.equal(report.body.products.find(row => row.product === 'shixing').page_views, 1);
  assert.equal(report.body.products.find(row => row.product === 'comment').page_views, 1);
  assert.equal(report.body.sources.find(row => row.source === 'wechat').page_views, 1);
  assert.equal(report.body.sources.find(row => row.source === 'www.xiaohongshu.com').page_views, 1);

  const serialized = JSON.stringify(report.body);
  assert.doesNotMatch(serialized, /private-code|private-value|secret-note|550e8400/i);
  assert.doesNotMatch(serialized, /127\.0\.0\.1/);
});

test('the shared analytics client and unified admin expose the conversion funnel', () => {
  const analytics = fs.readFileSync(path.join(ROOT, 'public', 'analytics.js'), 'utf8');
  assert.match(analytics, /\/api\/analytics\/event/);
  assert.match(analytics, /page_view/);
  assert.match(analytics, /product_click/);
  assert.doesNotMatch(analytics, /document\.referrer\s*[,}]/);

  const admin = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  assert.match(admin, /转化/);
  assert.match(admin, /\/api\/admin\/conversions/);
  assert.match(admin, /访问人数/);
  assert.match(admin, /注册成功/);

  for (const file of [
    'public/shixing/index.html',
    'public/shixing/invite.html',
    'public/index.html',
    'public/teacher.html',
    'public/comment.html',
    'public/zuowen.html',
    'public/english.html',
    'public/roundtable/index.html',
    'public/edulab/pro.html',
    'public/xiezuo.html'
  ]) {
    assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'), /src="\/analytics\.js"/, file);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public', 'screen.html'), 'utf8'), /analytics\.js/);
});
