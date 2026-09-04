const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-unified-referral-api-' + Date.now());
const messages = [];
let smtpServer;
let app;
let appPort;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function createSmtpServer() {
  return net.createServer(socket => {
    let dataMode = false;
    let message = '';
    let buffer = '';
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk;
      let lineEnd;
      while ((lineEnd = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
        buffer = buffer.slice(lineEnd + 1);
        if (dataMode) {
          if (line === '.') {
            messages.push(message);
            message = '';
            dataMode = false;
            socket.write('250 Message accepted\r\n');
          } else message += line + '\n';
          continue;
        }
        if (/^(EHLO|HELO) /i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH /i.test(line)) socket.write('235 Authentication successful\r\n');
        else if (/^(MAIL FROM|RCPT TO)/i.test(line)) socket.write('250 OK\r\n');
        else if (/^DATA$/i.test(line)) { dataMode = true; socket.write('354 End data\r\n'); }
        else if (/^QUIT$/i.test(line)) socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
}

async function waitForApp() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + appPort + '/api/referral/context');
      if (response.status) return;
    } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

async function request(pathname, options = {}) {
  const response = await fetch('http://127.0.0.1:' + appPort + pathname, {
    redirect: options.redirect || 'follow',
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { 'X-Token': options.token } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.forwardedHost ? { 'X-Forwarded-Host': options.forwardedHost, 'X-Forwarded-Proto': 'https' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function codeFromMessage(message) {
  const direct = message.match(/验证码[：:]\s*(\d{6})/);
  if (direct) return direct[1];
  const decoded = message.split(/\n\n/).map(part => {
    try { return Buffer.from(part.replace(/\s/g, ''), 'base64').toString('utf8'); } catch (e) { return ''; }
  }).join('\n');
  const match = decoded.match(/验证码[：:]\s*(\d{6})/);
  if (!match) throw new Error('registration code missing');
  return match[1];
}

async function register(username, email, extra = {}, cookie = '') {
  const sent = await request('/api/register/send-code', { method: 'POST', body: { email } });
  assert.equal(sent.status, 200);
  // 并行负载下 SMTP 投递可能晚于下一次请求：轮询等待包含验证码的邮件（最长约5秒）
  let code = null;
  for (let i = 0; i < 100 && !code; i++) {
    const last = messages.at(-1);
    if (last) {
      try { code = codeFromMessage(last); } catch (e) { /* 邮件未到，继续等 */ }
    }
    if (!code) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(code, 'verification email not received in time');
  return request('/api/register', {
    method: 'POST', cookie,
    body: { username, email, code, password: 'secure-password', display_name: username, ...extra }
  });
}

test.before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  smtpServer = createSmtpServer();
  const smtpPort = await listen(smtpServer);
  const portServer = http.createServer();
  appPort = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      SQLITE_FILE: path.join(TMP, 'test.db'),
      LEGACY_JSON_FILE: path.join(TMP, 'missing-data.json'),
      BACKUP_DIR: path.join(TMP, 'backups'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false',
      SMTP_USER: 'test-user', SMTP_PASS: 'test-pass', MAIL_FROM: '师行 <no-reply@example.test>',
      EMAIL_DOMAIN_DNS_CHECK: 'false',
      ADMIN_PASS: 'test-admin-pass', INVITE_COOKIE_SECRET: 'test-invite-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForApp();
});

test.after(async () => {
  if (app && !app.killed) app.kill();
  if (smtpServer) await new Promise(resolve => smtpServer.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('one invite link attributes registration across products and appears in one center', async () => {
  const inviter = await register('inviter', 'inviter@example.com');
  assert.equal(inviter.status, 200);

  const centerBefore = await request('/api/referral', { token: inviter.body.token });
  assert.equal(centerBefore.status, 200);
  assert.match(centerBefore.body.link, /shixing\.yingyuzuowen\.asia\/invite\//);
  assert.equal(centerBefore.body.invited_count, 0);

  const landing = await request('/invite/' + centerBefore.body.code + '?source=comment', {
    forwardedHost: 'shixing.yingyuzuowen.asia', redirect: 'manual'
  });
  assert.equal(landing.status, 200);
  assert.match(String(landing.headers.get('set-cookie')), /shixing_ref=/);
  assert.match(String(landing.headers.get('set-cookie')), /Domain=\.yingyuzuowen\.asia/i);
  assert.match(String(landing.headers.get('set-cookie')), /Max-Age=604800/i);

  const cookieMatch = String(landing.headers.get('set-cookie')).match(/shixing_ref=[^;]+/);
  assert.ok(cookieMatch);
  const cookie = cookieMatch[0];
  const friend = await register('friend', 'friend@example.com', {}, cookie);
  assert.equal(friend.status, 200);
  assert.equal(friend.body.referral.bound, true);
  assert.equal(friend.body.referral.inviter_name, 'inviter');

  const centerAfter = await request('/api/referral', { token: inviter.body.token });
  assert.equal(centerAfter.status, 200);
  assert.equal(centerAfter.body.invited_count, 1);
  assert.equal(centerAfter.body.invitees[0].activation_status, 'waiting');

  const context = await request('/api/referral/context', { cookie });
  assert.equal(context.status, 200);
  assert.equal(context.body.valid, true);
  assert.equal(context.body.inviter_name, 'inviter');
});

test('request-body invite code supports cross-device registration and invalid codes are explicit', async () => {
  const inviter = await register('inviter-two', 'inviter-two@example.com');
  const center = await request('/api/referral', { token: inviter.body.token });
  const friend = await register('friend-two', 'friend-two@example.com', { ref: center.body.code });
  assert.equal(friend.status, 200);
  assert.equal(friend.body.referral.bound, true);

  const invalid = await register('friend-bad', 'friend-bad@example.com', { ref: 'NOT-A-CODE' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /邀请码无效/);
});
