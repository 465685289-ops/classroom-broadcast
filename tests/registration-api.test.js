const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-registration-api-' + Date.now());
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
          } else {
            message += line + '\n';
          }
          continue;
        }
        if (/^(EHLO|HELO) /i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH /i.test(line)) socket.write('235 Authentication successful\r\n');
        else if (/^(MAIL FROM|RCPT TO)/i.test(line)) socket.write('250 OK\r\n');
        else if (/^DATA$/i.test(line)) {
          dataMode = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT$/i.test(line)) socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
}

async function waitForApp() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + appPort + '/api/register/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (response.status) return;
    } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

async function post(pathname, body, token) {
  const response = await fetch('http://127.0.0.1:' + appPort + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.20', ...(token ? { 'X-Token': token } : {}) },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let responseBody = {};
  try { responseBody = JSON.parse(text); } catch (e) {}
  return { status: response.status, body: responseBody };
}

function codeFromMessage(message) {
  const direct = message.match(/验证码[：:]\s*(\d{6})/);
  if (direct) return direct[1];
  const encoded = message.split(/\n\n/).map(part => Buffer.from(part.replace(/\s/g, ''), 'base64').toString('utf8')).join('\n');
  const match = encoded.match(/验证码[：:]\s*(\d{6})/);
  if (!match) throw new Error('registration code was not found in SMTP message');
  return match[1];
}

test.before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const legacyPassword = 'legacy-password';
  const legacySalt = 'legacy-user-test-salt';
  const aliasMasterSalt = 'alias-master-test-salt';
  const aliasShadowSalt = 'alias-shadow-test-salt';
  const duplicateOneSalt = 'duplicate-one-test-salt';
  const duplicateTwoSalt = 'duplicate-two-test-salt';
  const conflictOwnerSalt = 'conflict-owner-test-salt';
  const conflictLinkedSalt = 'conflict-linked-test-salt';
  fs.writeFileSync(path.join(TMP, 'legacy.json'), JSON.stringify({
    users: [{
      id: 'legacy-user-id',
      username: 'legacy-user',
      display_name: '老用户',
      teacher_code: 'LEGACY',
      contact_type: 'email',
      contact_value: 'legacy@example.com',
      registration_email: '',
      password_hash: crypto.scryptSync(legacyPassword, legacySalt, 64).toString('hex'),
      password_salt: legacySalt,
      plan: 'trial',
      plan_expires: null,
      token: null,
      token_expires: null,
      created_at: '2026-01-01T00:00:00.000Z'
    }, {
      id: 'alias-user-id',
      username: 'alias-user',
      display_name: '密码兼容用户',
      teacher_code: 'ALIAS1',
      contact_type: 'email',
      contact_value: 'alias@example.com',
      registration_email: 'alias@example.com',
      password_hash: crypto.scryptSync('master-password', aliasMasterSalt, 64).toString('hex'),
      password_salt: aliasMasterSalt,
      plan: 'trial',
      plan_expires: null,
      token: null,
      token_expires: null,
      created_at: '2026-01-02T00:00:00.000Z'
    }, {
      id: 'alias-shadow-id',
      username: 'alias@example.com',
      display_name: '旧用户名占位账号',
      teacher_code: 'SHADOW',
      contact_type: 'email',
      contact_value: 'shadow-contact@example.com',
      registration_email: '',
      password_hash: crypto.scryptSync('shadow-password', aliasShadowSalt, 64).toString('hex'),
      password_salt: aliasShadowSalt,
      plan: 'trial',
      plan_expires: null,
      token: null,
      token_expires: null,
      created_at: '2026-01-02T12:00:00.000Z'
    }, {
      id: 'conflict-owner-id',
      username: 'conflict-owner',
      display_name: '邮箱登记账号',
      teacher_code: 'CON001',
      contact_type: 'email',
      contact_value: 'conflict@example.com',
      registration_email: 'conflict@example.com',
      password_hash: crypto.scryptSync('conflict-owner-password', conflictOwnerSalt, 64).toString('hex'),
      password_salt: conflictOwnerSalt,
      plan: 'trial',
      plan_expires: null,
      token: null,
      token_expires: null,
      created_at: '2026-01-05T00:00:00.000Z'
    }, {
      id: 'conflict-linked-id',
      username: 'conflict-linked',
      display_name: '工作台绑定账号',
      teacher_code: 'CON002',
      contact_type: 'email',
      contact_value: 'conflict@example.com',
      registration_email: '',
      password_hash: crypto.scryptSync('linked-master-password', conflictLinkedSalt, 64).toString('hex'),
      password_salt: conflictLinkedSalt,
      plan: 'trial',
      plan_expires: null,
      token: null,
      token_expires: null,
      created_at: '2026-01-06T00:00:00.000Z'
    }, {
      id: 'duplicate-one-id',
      username: 'duplicate-one',
      display_name: '重名用户甲',
      teacher_code: 'DUP001',
      contact_type: 'email',
      contact_value: 'duplicate@example.com',
      registration_email: '',
      password_hash: crypto.scryptSync('duplicate-one-password', duplicateOneSalt, 64).toString('hex'),
      password_salt: duplicateOneSalt,
      plan: 'trial',
      plan_expires: null,
      token: null,
      token_expires: null,
      created_at: '2026-01-03T00:00:00.000Z'
    }, {
      id: 'duplicate-two-id',
      username: 'duplicate-two',
      display_name: '重名用户乙',
      teacher_code: 'DUP002',
      contact_type: 'email',
      contact_value: 'duplicate@example.com',
      registration_email: '',
      password_hash: crypto.scryptSync('duplicate-two-password', duplicateTwoSalt, 64).toString('hex'),
      password_salt: duplicateTwoSalt,
      plan: 'trial',
      plan_expires: null,
      token: null,
      token_expires: null,
      created_at: '2026-01-04T00:00:00.000Z'
    }],
    classes: [], notifications: [], replies: [], messages: [], bulletins: [], payments: [],
    nextNotifId: 1, nextMessageId: 1, nextBulletinId: 1
  }));
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
      LEGACY_JSON_FILE: path.join(TMP, 'legacy.json'),
      BACKUP_DIR: path.join(TMP, 'backups'),
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtpPort),
      SMTP_SECURE: 'false',
      SMTP_USER: 'test-user',
      SMTP_PASS: 'test-pass',
      MAIL_FROM: '师行 <no-reply@example.test>',
      ADMIN_PASS: 'test-admin-pass'
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

test('registers only after an emailed code and rejects reuse', async () => {
  const email = 'new-user@example.com';
  const send = await post('/api/register/send-code', { email });
  assert.equal(send.status, 200);
  const code = codeFromMessage(messages.at(-1));

  const registration = await post('/api/register', { password: 'secure-password', display_name: '新用户', email, code });
  assert.equal(registration.status, 200);
  assert.equal(registration.body.user.username, email);
  assert.equal(registration.body.user.contact_value, email);

  const profile = await post('/api/profile', { contact: '13800138000' }, registration.body.token);
  assert.equal(profile.status, 200);
  const duplicateAfterContactChange = await post('/api/register/send-code', { email });
  assert.equal(duplicateAfterContactChange.status, 400);

  const reuse = await post('/api/register', { password: 'secure-password', display_name: '另一位用户', email, code });
  assert.equal(reuse.status, 400);
});

test('rejects a duplicate email and enforces the IP hourly send limit', async () => {
  const duplicate = await post('/api/register/send-code', { email: 'new-user@example.com' });
  assert.equal(duplicate.status, 400);

  for (let i = 0; i < 9; i++) {
    const response = await post('/api/register/send-code', { email: 'rate-' + i + '@example.com' });
    assert.equal(response.status, 200);
  }
  const limited = await post('/api/register/send-code', { email: 'rate-limited@example.com' });
  assert.equal(limited.status, 429);
});

test('legacy users can log in by username or unique email and reset with email only', async () => {
  const usernameLogin = await post('/api/login', { username: 'legacy-user', password: 'legacy-password' });
  assert.equal(usernameLogin.status, 200);

  const emailLogin = await post('/api/login', { username: 'legacy@example.com', password: 'legacy-password' });
  assert.equal(emailLogin.status, 200);

  const sent = await post('/api/password-reset/send-code', { email: 'legacy@example.com' });
  assert.equal(sent.status, 200);
  const code = codeFromMessage(messages.at(-1));

  const verified = await post('/api/password-reset/verify-code', { email: 'legacy@example.com', code });
  assert.equal(verified.status, 200);
  assert.ok(verified.body.reset_token);

  const confirmed = await post('/api/password-reset/confirm', {
    email: 'legacy@example.com',
    reset_token: verified.body.reset_token,
    password: 'new-legacy-password'
  });
  assert.equal(confirmed.status, 200);

  const updatedLogin = await post('/api/login', { username: 'legacy@example.com', password: 'new-legacy-password' });
  assert.equal(updatedLogin.status, 200);
});

test('duplicate legacy email is resolved only when one account password matches', async () => {
  const first = await post('/api/login', {
    username: 'duplicate@example.com',
    password: 'duplicate-one-password'
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.user.id, 'duplicate-one-id');

  const second = await post('/api/login', {
    username: 'duplicate@example.com',
    password: 'duplicate-two-password'
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.user.id, 'duplicate-two-id');
});

test('a legacy alias can select its linked account even when another account owns the registration email', async () => {
  const aliasSalt = 'conflict-workbench-alias-salt';
  const sqlite = new Database(path.join(TMP, 'test.db'));
  try {
    sqlite.prepare(`
      INSERT INTO account_password_aliases (user_id, source, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'conflict-linked-id',
      'student-growth-v7',
      crypto.scryptSync('conflict-workbench-password', aliasSalt, 64).toString('hex'),
      aliasSalt,
      new Date().toISOString()
    );
  } finally {
    sqlite.close();
  }

  const result = await post('/api/login', {
    username: 'conflict@example.com',
    password: 'conflict-workbench-password'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.id, 'conflict-linked-id');
});

test('legacy workbench password alias logs in until the user resets the canonical password', async () => {
  const aliasSalt = 'old-workbench-alias-salt';
  const sqlite = new Database(path.join(TMP, 'test.db'));
  try {
    sqlite.prepare(`
      INSERT INTO account_password_aliases (user_id, source, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'alias-user-id',
      'student-growth-v7',
      crypto.scryptSync('old-workbench-password', aliasSalt, 64).toString('hex'),
      aliasSalt,
      new Date().toISOString()
    );
  } finally {
    sqlite.close();
  }

  const legacyLogin = await post('/api/login', {
    username: 'alias@example.com',
    password: 'old-workbench-password'
  });
  assert.equal(legacyLogin.status, 200);
  assert.equal(legacyLogin.body.user.id, 'alias-user-id');

  const sent = await post('/api/password-reset/send-code', { email: 'alias@example.com' });
  assert.equal(sent.status, 200);
  const code = codeFromMessage(messages.at(-1));
  const verified = await post('/api/password-reset/verify-code', { email: 'alias@example.com', code });
  assert.equal(verified.status, 200);
  const confirmed = await post('/api/password-reset/confirm', {
    email: 'alias@example.com',
    reset_token: verified.body.reset_token,
    password: 'final-unified-password'
  });
  assert.equal(confirmed.status, 200);

  const oldAlias = await post('/api/login', {
    username: 'alias@example.com',
    password: 'old-workbench-password'
  });
  assert.equal(oldAlias.status, 401);
  const finalLogin = await post('/api/login', {
    username: 'alias@example.com',
    password: 'final-unified-password'
  });
  assert.equal(finalLogin.status, 200);
});

test('successful login stores an exact last login timestamp in the master account', async () => {
  const before = Date.now();
  const result = await post('/api/login', {
    username: 'duplicate-one',
    password: 'duplicate-one-password'
  });
  assert.equal(result.status, 200);

  const sqlite = new Database(path.join(TMP, 'test.db'), { readonly: true });
  try {
    const row = sqlite.prepare('SELECT last_login_at FROM users WHERE id = ?').get('duplicate-one-id');
    assert.ok(row.last_login_at);
    assert.ok(Date.parse(row.last_login_at) >= before);
    assert.ok(Date.parse(row.last_login_at) <= Date.now());
  } finally {
    sqlite.close();
  }
});
