'use strict';
// 审查 F07：大屏重连后按最后通知 ID 补取漏接通知（30 分钟有效期）
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const test = require('node:test');

const testDir = mkdtempSync(join(tmpdir(), 'shixing-missed-'));
process.env.SQLITE_FILE = join(testDir, 'test.db');
process.env.LEGACY_JSON_FILE = join(testDir, 'missing-data.json');
process.env.BACKUP_DIR = join(testDir, 'backups');
process.env.ADMIN_PASS = 'test-admin';

const dbStore = require('../db.js');
const ownerToken = 'missed-owner-token';
dbStore.upsertUser({
  id: 'missed-owner', username: 'missed-teacher', display_name: '补取老师',
  password_hash: 'hash', password_salt: 'salt',
  contact_type: 'email', contact_value: 'missed@example.test',
  registration_email: 'missed@example.test',
  plan: 'yearly', plan_expires: new Date(Date.now() + 86400000).toISOString(),
  token: ownerToken, token_expires: new Date(Date.now() + 86400000).toISOString(),
  created_at: new Date().toISOString(),
});
dbStore.upsertClass({
  id: 'missed-class-1', user_id: 'missed-owner', name: '补取班', grade: 'junior',
  bind_code: 'MISSED1', member_ids: [], created_at: new Date().toISOString(),
});

const root = join(__dirname, '..');
let app = null;
let appStderr = '';
let baseUrl = '';

test.before(async () => {
  const rootDir = root;
  const pre = createServer();
  const port = await new Promise((resolve) => pre.listen(0, '127.0.0.1', () => { const p = pre.address().port; pre.close(() => resolve(p)); }));
  baseUrl = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', (d) => { appStderr += String(d) });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { const r = await fetch(`${baseUrl}/api/classes`); if (r.status) up = true } catch (e) {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, 'server did not start: ' + appStderr.slice(0, 300));
});

test.after(async () => {
  if (app) app.kill();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(testDir, { recursive: true, force: true });
});

const screenHeaders = async () => {
  const session = await fetch(`${baseUrl}/api/screen/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bind_code: 'MISSED1' }),
  })
  assert.equal(session.status, 200)
  const { screen_token } = await session.json()
  assert.ok(screen_token, '应签发屏幕会话令牌')
  return { 'X-Screen-Token': screen_token }
}

test('补取端点要求屏幕会话', async () => {
  const r = await fetch(`${baseUrl}/api/screen/missed/missed-class-1?after=0`)
  assert.equal(r.status, 401)
})

test('按 lastId 过滤且只返回本班通知', async () => {
  const headers = await screenHeaders()
  const send = (content) => fetch(`${baseUrl}/api/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Token': ownerToken },
    body: JSON.stringify({ class_id: 'missed-class-1', content }),
  })
  await send('第一条通知')
  await send('第二条通知')

  const empty = await fetch(`${baseUrl}/api/screen/missed/missed-class-1?after=99999`, { headers })
  assert.equal(empty.status, 200)
  assert.deepEqual((await empty.json()).notifications, [], 'after 之后无新通知')

  const missed = await fetch(`${baseUrl}/api/screen/missed/missed-class-1?after=0`, { headers })
  assert.equal(missed.status, 200)
  const list = (await missed.json()).notifications
  assert.ok(list.length >= 2, '应补取全部未读通知')
  assert.ok(list.every((item) => /通知$/.test(item.content)), '只包含本班通知')
})
