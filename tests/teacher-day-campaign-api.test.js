const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-day-campaign-api-'));
const DB_FILE = path.join(TMP, 'broadcast.db');
const TOKEN = 'teacher-day-test-token';
let app;
let port;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function request(pathname, token) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: token ? { 'X-Token': token } : {},
  });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { status: response.status, body };
}

async function waitForApp() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/profile`);
      if (response.status) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

test.before(async () => {
  process.env.SQLITE_FILE = DB_FILE;
  process.env.LEGACY_JSON_FILE = path.join(TMP, 'missing-data.json');
  process.env.BACKUP_DIR = path.join(TMP, 'backups');
  const dbStore = require('../db');
  dbStore.upsertUser({
    id: 'teacher-day-user', username: 'teacher-day@example.test', display_name: '教师节老师',
    password_hash: 'hash', password_salt: 'salt', token: TOKEN,
    token_expires: '2099-01-01T00:00:00.000Z', plan: 'trial', plan_expires: null,
    created_at: '2026-09-01T00:00:00.000Z',
  });
  const { grantTeacherDayMemberships } = require('../teacher-day-campaign');
  const db = new Database(DB_FILE);
  grantTeacherDayMemberships(db, { now: new Date('2026-09-10T02:00:00.000Z') });
  db.close();

  const portServer = http.createServer();
  port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      SQLITE_FILE: DB_FILE,
      LEGACY_JSON_FILE: path.join(TMP, 'missing-data.json'),
      BACKUP_DIR: path.join(TMP, 'backups'),
      TEACHERS_DAY_TEST_NOW: '2026-09-10T08:00:00.000Z',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForApp();
});

test.after(() => {
  if (app && !app.killed) app.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('教师节弹窗接口只向当天已获赠且登录的账号返回一次完整祝福', async () => {
  assert.equal((await request('/api/campaigns/teachers-day-2026/popup')).status, 401);

  const first = await request('/api/campaigns/teachers-day-2026/popup', TOKEN);
  assert.equal(first.status, 200);
  assert.equal(first.body.popup.title, '教师节快乐｜师行为您增加了 7 天会员时长');
  assert.match(first.body.popup.body, /一位一线老师/);

  const repeated = await request('/api/campaigns/teachers-day-2026/popup', TOKEN);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.popup, null);
});
