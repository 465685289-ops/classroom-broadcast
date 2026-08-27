const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-english-workflow-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');
const TOKEN = 'english-workflow-test-token';
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
      ...(options.public ? {} : { 'X-Token': TOKEN })
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
      const response = await fetch('http://127.0.0.1:' + port + '/api/english/config', { headers: { 'X-Token': TOKEN } });
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
    id: 'english-user-1', username: 'english-teacher', display_name: '英语老师',
    password_hash: 'hash', password_salt: 'salt', token: TOKEN,
    token_expires: new Date(Date.now() + 86400000).toISOString(), created_at: new Date().toISOString()
  });
  dbStore.adjustShixingPoints({
    user_id: 'english-user-1', username: 'english-teacher', delta: 500,
    reason: 'test', product: 'english', note: '测试积分'
  });

  const portServer = http.createServer();
  port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ADMIN_PASS: 'english-test-admin' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForApp();
});

test.after(() => {
  if (app && !app.killed) app.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('English classes, students and assignments stay outside the Chinese workspace', async () => {
  const chinese = await request('/api/essay/classes', { method: 'POST', body: { name: '八年级语文班', grade: '初二' } });
  assert.equal(chinese.status, 200);

  const english = await request('/api/english/classes', { method: 'POST', body: { name: '八年级英语一班', grade: '初中' } });
  assert.equal(english.status, 200);
  assert.equal(english.body.class.subject, 'english');

  const chineseList = await request('/api/essay/classes');
  const englishList = await request('/api/english/classes');
  assert.deepEqual(chineseList.body.classes.map(item => item.name), ['八年级语文班']);
  assert.deepEqual(englishList.body.classes.map(item => item.name), ['八年级英语一班']);

  const student = await request('/api/english/classes/' + english.body.class.id + '/students', {
    method: 'POST', body: { name: 'Lucy', student_no: '0801' }
  });
  assert.equal(student.status, 200);
  assert.equal(student.body.student.subject, 'english');

  const crossSubjectStudent = await request('/api/english/classes/' + chinese.body.class.id + '/students', {
    method: 'POST', body: { name: '不应创建' }
  });
  assert.equal(crossSubjectStudent.status, 404);

  const assignment = await request('/api/english/assignments', {
    method: 'POST', body: {
      class_id: english.body.class.id,
      title: 'A Meaningful School Activity',
      requirements: 'Write at least 80 words.',
      task_type: '中考作文',
      grade_level: '初中',
      score_type: '满分20分'
    }
  });
  assert.equal(assignment.status, 200);
  assert.equal(assignment.body.assignment.subject, 'english');
  assert.equal(assignment.body.assignment.genre, '中考作文');
  assert.equal(assignment.body.assignment.rubric.dimensions.reduce((sum, d) => sum + d.weight, 0), 100);
});

test('English rubric presets cover junior, application and continuation writing', async () => {
  const config = await request('/api/english/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.point_cost, 50);
  assert.deepEqual(config.body.task_types, ['初中日常作文', '中考作文', '高中应用文', '读后续写']);
  for (const type of config.body.task_types) {
    const rubric = config.body.rubric_presets[type];
    assert.ok(Array.isArray(rubric) && rubric.length >= 5, type);
    assert.equal(rubric.reduce((sum, d) => sum + d.weight, 0), 100, type);
  }
  assert.ok(config.body.rubric_presets['读后续写'].some(d => d.name === '原文衔接'));
});

test('copying an existing roster creates independent English records', async () => {
  const chineseClasses = await request('/api/essay/classes');
  const chineseClass = chineseClasses.body.classes[0];
  await request('/api/essay/classes/' + chineseClass.id + '/students', {
    method: 'POST', body: { name: '王同学', student_no: 'C-01' }
  });
  const sources = await request('/api/english/import-sources');
  assert.equal(sources.status, 200);
  assert.ok(sources.body.sources.some(item => item.id === chineseClass.id && item.student_count === 1));

  const copied = await request('/api/english/classes/import', {
    method: 'POST', body: { source_class_id: chineseClass.id, name: '英语名单副本' }
  });
  assert.equal(copied.status, 200);
  assert.equal(copied.body.class.subject, 'english');
  assert.equal(copied.body.student_count, 1);
  const englishStudents = await request('/api/english/classes/' + copied.body.class.id + '/students');
  assert.equal(englishStudents.body.students[0].name, '王同学');
  assert.notEqual(englishStudents.body.students[0].class_id, chineseClass.id);
});

test('English revision links use the English student page', async () => {
  const assignments = await request('/api/english/assignments');
  const assignment = assignments.body.assignments[0];
  const students = await request('/api/english/classes/' + assignment.class_id + '/students');
  const submission = await request('/api/english/submissions', {
    method: 'POST', body: {
      assignment_id: assignment.id,
      student_id: students.body.students[0].id,
      essay_text: 'Last Friday, our class took part in a school clean-up activity. I learned that small actions can make our school better.'
    }
  });
  assert.equal(submission.status, 200);
  assert.match(submission.body.submission.share_url, /english\/revise\//);

  const publicView = await request('/api/english/public/' + submission.body.submission.share_token, { public: true });
  assert.equal(publicView.status, 200);
  assert.equal(publicView.body.assignment.subject, 'english');
});
