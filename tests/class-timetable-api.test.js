const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-class-timetable-api-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');
const OWNER_TOKEN = 'timetable-owner-token';
const MEMBER_TOKEN = 'timetable-member-token';
const OUTSIDER_TOKEN = 'timetable-outsider-token';
const EXPIRED_TOKEN = 'timetable-expired-token';
const CLASS_ID = 'timetable-class-1';
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
      ...(options.token === null ? {} : { 'X-Token': options.token || OWNER_TOKEN })
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
  const activeExpiry = new Date(Date.now() + 86400000 * 30).toISOString();
  const tokenExpiry = new Date(Date.now() + 86400000).toISOString();
  const users = [
    ['teacher-owner', '课表管理员', OWNER_TOKEN, activeExpiry],
    ['teacher-member', '协作老师', MEMBER_TOKEN, activeExpiry],
    ['teacher-outsider', '其他老师', OUTSIDER_TOKEN, activeExpiry],
    ['teacher-expired', '过期老师', EXPIRED_TOKEN, '2026-01-01T00:00:00.000Z']
  ];
  users.forEach(([id, displayName, token, planExpires]) => dbStore.upsertUser({
    id,
    username: id,
    display_name: displayName,
    password_hash: 'hash',
    password_salt: 'salt',
    token,
    token_expires: tokenExpiry,
    plan: 'yearly',
    plan_expires: planExpires,
    created_at: '2026-08-30T08:00:00.000Z'
  }));
  dbStore.upsertClass({
    id: CLASS_ID,
    user_id: 'teacher-owner',
    name: '八年级一班',
    grade: 'junior',
    bind_code: 'TAB123',
    member_ids: ['teacher-member'],
    created_at: '2026-08-30T08:00:00.000Z'
  });
  dbStore.upsertClass({
    id: 'expired-class',
    user_id: 'teacher-expired',
    name: '过期班级',
    grade: 'junior',
    bind_code: 'TABOLD',
    member_ids: [],
    created_at: '2026-08-30T08:00:00.000Z'
  });

  const portServer = http.createServer();
  port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ADMIN_PASS: 'timetable-test-admin' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForApp();
});

test.after(() => {
  if (app && !app.killed) app.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('class members can read a normalized empty timetable while outsiders cannot', async () => {
  const memberView = await request('/api/classes/' + CLASS_ID + '/timetable', { token: MEMBER_TOKEN });
  assert.equal(memberView.status, 200);
  assert.equal(memberView.body.is_owner, false);
  assert.deepEqual(Object.keys(memberView.body.timetable.entries), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.equal(memberView.body.timetable.entries.mon.length, 12);

  const outsiderView = await request('/api/classes/' + CLASS_ID + '/timetable', { token: OUTSIDER_TOKEN });
  assert.equal(outsiderView.status, 404);

  const anonymousView = await request('/api/classes/' + CLASS_ID + '/timetable', { token: null });
  assert.equal(anonymousView.status, 401);
});

test('only an active class owner can save the shared timetable', async () => {
  const memberWrite = await request('/api/classes/' + CLASS_ID + '/timetable', {
    method: 'PUT',
    token: MEMBER_TOKEN,
    body: { entries: { mon: ['语文'] } }
  });
  assert.equal(memberWrite.status, 403);

  const saved = await request('/api/classes/' + CLASS_ID + '/timetable', {
    method: 'PUT',
    body: { entries: { mon: [' 语文 '], fri: ['', '班会'], sat: ['不应保存'] } }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.is_owner, true);
  assert.equal(saved.body.timetable.entries.mon[0], '语文');
  assert.equal(saved.body.timetable.entries.fri[1], '班会');
  assert.equal(saved.body.timetable.entries.sat[0], '不应保存');
  assert.ok(Date.parse(saved.body.timetable.updated_at));

  const reloaded = await request('/api/classes/' + CLASS_ID + '/timetable', { token: MEMBER_TOKEN });
  assert.equal(reloaded.body.timetable.entries.mon[0], '语文');
  assert.equal(reloaded.body.timetable.entries.fri[1], '班会');

  const expired = await request('/api/classes/expired-class/timetable', {
    method: 'PUT',
    token: EXPIRED_TOKEN,
    body: { entries: { mon: ['语文'] } }
  });
  assert.equal(expired.status, 403);
});
