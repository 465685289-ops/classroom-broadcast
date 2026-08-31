const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-classroom-onboarding-api-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');
const TOKENS = {
  empty: 'onboarding-empty-token',
  fresh: 'onboarding-fresh-token',
  legacy: 'onboarding-legacy-token',
  member: 'onboarding-member-token'
};
let app;
let port;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function request(pathname, token, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + pathname, {
    method: options.method || 'GET',
    headers: {
      ...(token ? { 'X-Token': token } : {}),
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
      const response = await request('/api/classes', TOKENS.empty);
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
  const activeExpiry = new Date(Date.now() + 86400000 * 30).toISOString();
  const tokenExpiry = new Date(Date.now() + 86400000).toISOString();
  Object.entries(TOKENS).forEach(([role, token]) => dbStore.upsertUser({
    id: 'teacher-' + role,
    username: 'onboarding-' + role,
    display_name: role,
    password_hash: 'hash',
    password_salt: 'salt',
    token,
    token_expires: tokenExpiry,
    plan: 'yearly',
    plan_expires: activeExpiry,
    created_at: '2026-08-31T01:00:00.000Z'
  }));
  dbStore.upsertClass({
    id: 'fresh-class', user_id: 'teacher-fresh', name: '八年级一班', grade: 'junior',
    bind_code: 'FRESH1', member_ids: ['teacher-member'], created_at: '2026-08-31T01:01:00.000Z'
  });
  dbStore.upsertClass({
    id: 'legacy-class', user_id: 'teacher-legacy', name: '七年级二班', grade: 'junior',
    bind_code: 'LEGACY', member_ids: [], created_at: '2026-08-31T01:02:00.000Z'
  });
  dbStore.upsertNotification({
    id: 8, class_id: 'legacy-class', user_id: 'teacher-legacy', content: '历史通知',
    signature: '', sender_name: 'legacy', student_name: '', repeat_count: 1,
    created_at: '2026-08-31T01:03:00.000Z'
  });

  const portServer = http.createServer();
  port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ADMIN_PASS: 'onboarding-test-admin' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForApp();
});

test.after(() => {
  if (app && !app.killed) app.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('onboarding state is personal, authenticated, and starts at the first missing step', async () => {
  const anonymous = await request('/api/classroom-onboarding');
  assert.equal(anonymous.status, 401);

  const empty = await request('/api/classroom-onboarding', TOKENS.empty);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.classroom, null);
  assert.deepEqual(empty.body.steps, {
    class_created: false,
    screen_connected: false,
    first_notice_sent: false
  });
  assert.equal(empty.body.next_step, 'create_class');
  assert.equal(empty.body.completed, false);

  const fresh = await request('/api/classroom-onboarding', TOKENS.fresh);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.classroom.id, 'fresh-class');
  assert.equal(fresh.body.classroom.online, 0);
  assert.deepEqual(fresh.body.steps, {
    class_created: true,
    screen_connected: false,
    first_notice_sent: false
  });
  assert.equal(fresh.body.next_step, 'connect_screen');

  const collaborator = await request('/api/classroom-onboarding', TOKENS.member);
  assert.equal(collaborator.status, 200);
  assert.equal(collaborator.body.classroom, null);
  assert.equal(collaborator.body.next_step, 'create_class');
});

test('historic owners are backfilled as complete without exposing or using collaborator activity', async () => {
  const legacy = await request('/api/classroom-onboarding', TOKENS.legacy);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.classroom.id, 'legacy-class');
  assert.deepEqual(legacy.body.steps, {
    class_created: true,
    screen_connected: true,
    first_notice_sent: true
  });
  assert.equal(legacy.body.next_step, 'complete');
  assert.equal(legacy.body.completed, true);
});

test('creating a class and successfully sending a notice update only the owner onboarding milestones', async () => {
  const created = await request('/api/classes', TOKENS.empty, {
    method: 'POST',
    body: { name: '新建测试班', grade: 'junior' }
  });
  assert.equal(created.status, 200);

  const afterCreate = await request('/api/classroom-onboarding', TOKENS.empty);
  assert.equal(afterCreate.body.classroom.id, created.body.id);
  assert.equal(afterCreate.body.next_step, 'connect_screen');

  const sent = await request('/api/notify', TOKENS.empty, {
    method: 'POST',
    body: { class_id: created.body.id, content: '测试通知：班级广播已连接成功。', repeat_count: 1, broadcast_mode: 'voice' }
  });
  assert.equal(sent.status, 200);

  const afterNotice = await request('/api/classroom-onboarding', TOKENS.empty);
  assert.equal(afterNotice.body.steps.first_notice_sent, true);
  assert.equal(afterNotice.body.steps.screen_connected, false);
  assert.equal(afterNotice.body.next_step, 'connect_screen');

  const deleted = await request('/api/classes/' + created.body.id, TOKENS.empty, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const afterDelete = await request('/api/classroom-onboarding', TOKENS.empty);
  assert.equal(afterDelete.body.classroom, null);
  assert.equal(afterDelete.body.next_step, 'create_class');
});
