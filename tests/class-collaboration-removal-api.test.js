const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-class-collaboration-removal-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');
const OWNER_TOKEN = 'owner-token';
const MEMBER_TOKEN = 'member-token';
const OUTSIDER_TOKEN = 'outsider-token';
const CLASS_ID = 'class-collaboration-removal';
let app;
let port;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function request(pathname, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + pathname, {
    method: options.method || 'GET',
    headers: { ...(options.token === null ? {} : { 'X-Token': options.token || OWNER_TOKEN }) }
  });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { status: response.status, body };
}

test.before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  process.env.SQLITE_FILE = DB_FILE;
  process.env.LEGACY_JSON_FILE = path.join(TMP, 'missing-data.json');
  process.env.BACKUP_DIR = path.join(TMP, 'backups');
  const dbStore = require('../db');
  const expiry = new Date(Date.now() + 86400000 * 30).toISOString();
  const tokenExpiry = new Date(Date.now() + 86400000).toISOString();
  [
    ['teacher-owner', '班主任', OWNER_TOKEN],
    ['teacher-member', '协作老师', MEMBER_TOKEN],
    ['teacher-outsider', '其他老师', OUTSIDER_TOKEN]
  ].forEach(([id, displayName, token]) => dbStore.upsertUser({
    id, username: id, display_name: displayName, password_hash: 'hash', password_salt: 'salt',
    token, token_expires: tokenExpiry, plan: 'yearly', plan_expires: expiry, created_at: new Date().toISOString()
  }));
  dbStore.upsertClass({
    id: CLASS_ID, user_id: 'teacher-owner', name: '八年级一班', grade: 'junior',
    bind_code: 'REMOVE1', member_ids: ['teacher-member'], created_at: new Date().toISOString()
  });
  const portServer = http.createServer();
  port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ADMIN_PASS: 'class-collaboration-removal-test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await request('/api/classes');
      if (response.status) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
});

test.after(() => {
  if (app && !app.killed) app.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('only the broadcast class creator can remove a collaborator', async () => {
  const denied = await request('/api/classes/' + CLASS_ID + '/members/teacher-member', {
    method: 'DELETE', token: OUTSIDER_TOKEN
  });
  assert.equal(denied.status, 404);

  const removed = await request('/api/classes/' + CLASS_ID + '/members/teacher-member', {
    method: 'DELETE', token: OWNER_TOKEN
  });
  assert.equal(removed.status, 200);

  const memberClasses = await request('/api/classes', { token: MEMBER_TOKEN });
  assert.deepEqual(memberClasses.body, []);
});
