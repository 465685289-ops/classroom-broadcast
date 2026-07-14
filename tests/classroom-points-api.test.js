const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-classroom-points-api-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');
const OWNER_TOKEN = 'classroom-owner-token';
const MEMBER_TOKEN = 'classroom-member-token';
const EXPIRED_TOKEN = 'classroom-expired-token';
const CLASS_ID = 'class-api-1';
const BIND_CODE = 'PTS123';
let app;
let port;
let studentId;
let ruleId;
let screenToken;
let firstScreenEntryId;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function request(pathname, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + pathname, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token === null ? {} : { 'X-Token': options.token || OWNER_TOKEN }),
      ...(options.screenToken ? { 'X-Screen-Token': options.screenToken } : {})
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
  dbStore.upsertUser({
    id: 'teacher-owner', username: 'points-owner', display_name: '班主任',
    password_hash: 'hash', password_salt: 'salt', token: OWNER_TOKEN,
    token_expires: tokenExpiry, plan: 'yearly', plan_expires: activeExpiry,
    created_at: new Date().toISOString()
  });
  dbStore.upsertUser({
    id: 'teacher-member', username: 'points-member', display_name: '任课教师',
    password_hash: 'hash', password_salt: 'salt', token: MEMBER_TOKEN,
    token_expires: tokenExpiry, plan: 'yearly', plan_expires: activeExpiry,
    created_at: new Date().toISOString()
  });
  dbStore.upsertUser({
    id: 'teacher-expired', username: 'points-expired', display_name: '过期教师',
    password_hash: 'hash', password_salt: 'salt', token: EXPIRED_TOKEN,
    token_expires: tokenExpiry, plan: 'yearly', plan_expires: '2026-01-01T00:00:00.000Z',
    created_at: '2025-01-01T00:00:00.000Z'
  });
  dbStore.upsertClass({
    id: CLASS_ID, user_id: 'teacher-owner', name: '八年级一班', grade: 'junior',
    bind_code: BIND_CODE, member_ids: ['teacher-member'], created_at: new Date().toISOString()
  });
  dbStore.upsertClass({
    id: 'class-expired', user_id: 'teacher-expired', name: '过期班级', grade: 'junior',
    bind_code: 'OLD123', member_ids: [], created_at: new Date().toISOString()
  });

  const portServer = http.createServer();
  port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PASS: 'classroom-points-test-admin'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForApp();
});

test.after(() => {
  if (app && !app.killed) app.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('class management is opt-in and only the class owner can toggle it', async () => {
  const initial = await request('/api/classes/' + CLASS_ID + '/management');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.management.enabled, false);
  assert.deepEqual(initial.body.students, []);

  const memberToggle = await request('/api/classes/' + CLASS_ID + '/management', {
    method: 'PUT', token: MEMBER_TOKEN, body: { enabled: true }
  });
  assert.equal(memberToggle.status, 403);

  const enabled = await request('/api/classes/' + CLASS_ID + '/management', {
    method: 'PUT', body: { enabled: true, sound_enabled: false }
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.management.enabled, true);
  assert.ok(enabled.body.current_period.id);
  assert.ok(enabled.body.rules.length >= 4);
});

test('teacher can configure students and rules for a management-enabled class', async () => {
  const student = await request('/api/classes/' + CLASS_ID + '/students', {
    method: 'POST', body: { name: '李明', student_no: '080101', seat_row: 2, seat_col: 3 }
  });
  assert.equal(student.status, 200);
  studentId = student.body.student.id;

  const rule = await request('/api/classes/' + CLASS_ID + '/score-rules', {
    method: 'POST', body: { name: '课堂发言', delta: 2 }
  });
  assert.equal(rule.status, 200);
  ruleId = rule.body.rule.id;

  const memberView = await request('/api/classes/' + CLASS_ID + '/management', { token: MEMBER_TOKEN });
  assert.equal(memberView.status, 200);
  assert.equal(memberView.body.students[0].id, studentId);
  assert.ok(memberView.body.rules.some(item => item.id === ruleId));
});

test('screen and teacher writes share one idempotent ledger and leaderboard', async () => {
  const session = await request('/api/screen/session', {
    method: 'POST', token: null, body: { bind_code: BIND_CODE }
  });
  assert.equal(session.status, 200);
  assert.equal(session.body.class.management_enabled, true);
  screenToken = session.body.screen_token;

  const state = await request('/api/screen/classroom-state', { token: null, screenToken });
  assert.equal(state.status, 200);
  assert.equal(state.body.students[0].id, studentId);

  const screenScoreBody = {
    client_operation_id: 'screen-api-op-1',
    client_created_at: '2026-07-14T08:00:00.000Z',
    student_ids: [studentId],
    rule_id: ruleId
  };
  const scored = await request('/api/screen/points/entries', {
    method: 'POST', token: null, screenToken, body: screenScoreBody
  });
  assert.equal(scored.status, 200);
  assert.equal(scored.body.entries[0].source_label, '教室端登记');
  firstScreenEntryId = scored.body.entries[0].id;

  const retried = await request('/api/screen/points/entries', {
    method: 'POST', token: null, screenToken, body: screenScoreBody
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.entries[0].id, firstScreenEntryId);

  const teacherScore = await request('/api/classes/' + CLASS_ID + '/points/entries', {
    method: 'POST', token: MEMBER_TOKEN, body: {
      client_operation_id: 'teacher-api-op-1', student_ids: [studentId], rule_id: ruleId
    }
  });
  assert.equal(teacherScore.status, 200);
  assert.equal(teacherScore.body.entries[0].source_label, '教师端登记');

  const ledger = await request('/api/classes/' + CLASS_ID + '/points/ledger?scope=term');
  assert.equal(ledger.status, 200);
  assert.equal(ledger.body.items.length, 2);

  const leaderboard = await request('/api/classes/' + CLASS_ID + '/points/leaderboard?scope=term');
  assert.equal(leaderboard.status, 200);
  assert.equal(leaderboard.body.items[0].score, 4);
});

test('reversal is auditable and an expired class screen cannot add points', async () => {
  const reversed = await request('/api/screen/points/entries/' + firstScreenEntryId + '/reverse', {
    method: 'POST', token: null, screenToken,
    body: { client_operation_id: 'screen-reversal-op-1' }
  });
  assert.equal(reversed.status, 200);
  assert.equal(reversed.body.entry.delta, -2);
  assert.equal(reversed.body.entry.reversal_of_id, firstScreenEntryId);

  const duplicateReverse = await request('/api/screen/points/entries/' + firstScreenEntryId + '/reverse', {
    method: 'POST', token: null, screenToken,
    body: { client_operation_id: 'screen-reversal-op-2' }
  });
  assert.equal(duplicateReverse.status, 400);

  const expiredSession = await request('/api/screen/session', {
    method: 'POST', token: null, body: { bind_code: 'OLD123' }
  });
  assert.equal(expiredSession.status, 200);
  const expiredWrite = await request('/api/screen/points/entries', {
    method: 'POST', token: null, screenToken: expiredSession.body.screen_token,
    body: { client_operation_id: 'expired-op', student_ids: ['none'], rule_id: 'none' }
  });
  assert.equal(expiredWrite.status, 403);
});
