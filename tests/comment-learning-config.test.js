'use strict';

// 回归守卫（2026-09-05 审查 F01）：带有效会话的产品配置路由必须返回真实 JSON，
// 防止路由模块缺失依赖（如 dbStore）只被 401 前置中间件掩盖、上线十天无人发现。
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const test = require('node:test');

const testDir = mkdtempSync(join(tmpdir(), 'shixing-config-'));
process.env.SQLITE_FILE = join(testDir, 'test.db');
process.env.LEGACY_JSON_FILE = join(testDir, 'missing-data.json');
process.env.BACKUP_DIR = join(testDir, 'backups');
process.env.ADMIN_PASS = 'test-admin';
process.env.PORT = '0';

const dbStore = require('../db.js');
const USER_TOKEN = 'config-test-token';
dbStore.upsertUser({
  id: 'config-user-1',
  username: 'config-teacher',
  display_name: '配置老师',
  password_hash: 'hash',
  password_salt: 'salt',
  contact_type: 'email',
  contact_value: 'config@example.test',
  registration_email: 'config@example.test',
  token: USER_TOKEN,
  token_expires: new Date(Date.now() + 86400000).toISOString(),
  plan: 'yearly',
  plan_expires: new Date(Date.now() + 86400000).toISOString(),
  created_at: new Date().toISOString(),
});

const root = join(__dirname, '..');

let app = null;
let port = 0;
let appStderr = '';

test.before(async () => {
  const pre = createServer();
  port = await new Promise((resolve) => pre.listen(0, '127.0.0.1', () => { const p = pre.address().port; pre.close(() => resolve(p)); }));
  app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', (d) => { appStderr += String(d); process.stderr.write('[child.err] ' + d) });
  app.stdout.on('data', (d) => process.stdout.write('[child.out] ' + d));
  app.on('exit', (code, sig) => console.log('[child exit]', code, sig));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/classes`); if (r.status) up = true } catch (e) {}
    if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(up, 'server did not start: ' + appStderr.slice(0, 300));
});

test.after(async () => {
  if (app) app.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  rmSync(testDir, { recursive: true, force: true });
});

const authedCases = [
  ['/api/comment/config', '评语'],
  ['/api/learning/config', '学习助手'],
  ['/api/essay/config', '作文批改'],
  ['/api/english/config', '英语批改'],
  ['/api/roundtable/config', '思想圆桌'],
  ['/api/profile', '个人资料'],
];

test('带有效会话读取各产品配置返回 200 JSON（审查 F01 守卫）', async () => {
  let checked = 0;
  for (const [path, label] of authedCases) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'X-Token': USER_TOKEN } });
    assert.equal(r.status, 200, `${label} ${path} 应返回 200`);
    const body = await r.json();
    assert.equal(typeof body, 'object', `${label} 应返回 JSON 对象`);
    checked += 1;
  }
  assert.equal(checked, authedCases.length);
});
