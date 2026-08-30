const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-broadcast-notification-api-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');
const TOKEN = 'notification-owner-token';
const CLASS_ID = 'notification-class-1';
let app;
let port;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function request(pathname, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + pathname, {
    method: options.method || 'GET',
    headers: {
      'X-Token': TOKEN,
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch (e) {}
  return { status: response.status, body };
}

async function waitForApp() {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try {
      const response = await request('/api/classes');
      if (response.status) return;
    } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

test.before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  process.env.SQLITE_FILE = DB_FILE;
  process.env.LEGACY_JSON_FILE = path.join(TMP, 'missing-data.json');
  process.env.BACKUP_DIR = path.join(TMP, 'backups');
  const dbStore = require('../db');
  dbStore.upsertUser({
    id: 'teacher-owner',
    username: 'notification-owner',
    display_name: '班主任',
    password_hash: 'hash',
    password_salt: 'salt',
    token: TOKEN,
    token_expires: new Date(Date.now() + 86400000).toISOString(),
    plan: 'yearly',
    plan_expires: new Date(Date.now() + 86400000 * 30).toISOString(),
    created_at: '2026-08-30T08:00:00.000Z'
  });
  dbStore.upsertClass({
    id: CLASS_ID,
    user_id: 'teacher-owner',
    name: '八年级一班',
    grade: 'junior',
    bind_code: 'NOT123',
    member_ids: [],
    created_at: '2026-08-30T08:00:00.000Z'
  });

  const portServer = http.createServer();
  port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ADMIN_PASS: 'notification-test-admin' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForApp();
});

test.after(() => {
  if (app && !app.killed) app.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('notification API preserves text mode and defaults legacy requests to voice', async () => {
  const textNotice = await request('/api/notify', {
    method: 'POST',
    body: {
      class_id: CLASS_ID,
      content: '请安静完成午练',
      repeat_count: 10,
      broadcast_mode: 'text'
    }
  });
  assert.equal(textNotice.status, 200);
  assert.equal(textNotice.body.broadcast_mode, 'text');
  assert.equal(textNotice.body.repeat_count, 1);

  const legacyVoice = await request('/api/notify', {
    method: 'POST',
    body: {
      class_id: CLASS_ID,
      content: '旧版教师端通知',
      repeat_count: 3
    }
  });
  assert.equal(legacyVoice.status, 200);
  assert.equal(legacyVoice.body.broadcast_mode, 'voice');
  assert.equal(legacyVoice.body.repeat_count, 3);

  const invalidMode = await request('/api/notify', {
    method: 'POST',
    body: {
      class_id: CLASS_ID,
      content: '无效模式回退',
      repeat_count: 2,
      broadcast_mode: 'silent'
    }
  });
  assert.equal(invalidMode.status, 200);
  assert.equal(invalidMode.body.broadcast_mode, 'voice');

  const history = await request('/api/history/' + CLASS_ID);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.map(row => row.broadcast_mode), ['voice', 'voice', 'text']);
  assert.equal(history.body.find(row => row.content === '请安静完成午练').repeat_count, 1);
});
