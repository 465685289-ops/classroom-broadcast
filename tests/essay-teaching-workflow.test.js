const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'shixing-essay-workflow-' + Date.now());
const DB_FILE = path.join(TMP, 'test.db');
const TOKEN = 'essay-workflow-test-token';
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
      const response = await fetch('http://127.0.0.1:' + port + '/api/essay/public/not-a-token');
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
    id: 'essay-user-1', username: 'essay-teacher', display_name: '作文老师',
    password_hash: 'hash', password_salt: 'salt', token: TOKEN,
    token_expires: new Date(Date.now() + 86400000).toISOString(), created_at: new Date().toISOString()
  });

  const portServer = http.createServer();
  port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ADMIN_PASS: 'essay-test-admin' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForApp();
});

test.after(() => {
  if (app && !app.killed) app.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('teacher can create a class, stable student, rubric and assignment', async () => {
  const cls = await request('/api/essay/classes', { method: 'POST', body: { name: '八年级一班', grade: '初二' } });
  assert.equal(cls.status, 200);
  assert.ok(cls.body.class.id);

  const student = await request('/api/essay/classes/' + cls.body.class.id + '/students', {
    method: 'POST', body: { name: '李明', student_no: '080101' }
  });
  assert.equal(student.status, 200);
  assert.equal(student.body.student.name, '李明');

  const rubric = await request('/api/essay/rubrics', {
    method: 'POST', body: { name: '记叙文量规', dimensions: [{ name: '内容', weight: 60 }, { name: '语言', weight: 40 }] }
  });
  assert.equal(rubric.status, 200);

  const assignment = await request('/api/essay/assignments', {
    method: 'POST', body: {
      class_id: cls.body.class.id, title: '那一次，我长大了', material: '结合亲身经历',
      requirements: '写清事情经过和内心变化', min_words: 600, max_words: 900,
      genre: '记叙文', grade_level: '初二', score_type: '满分100分', rubric_id: rubric.body.rubric.id
    }
  });
  assert.equal(assignment.status, 200);
  assert.equal(assignment.body.assignment.title, '那一次，我长大了');
  assert.equal(assignment.body.assignment.rubric.dimensions[0].weight, 60);

  const listed = await request('/api/essay/assignments?class_id=' + cls.body.class.id);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.assignments.length, 1);
});

test('student revision token keeps the submission in one workflow', async () => {
  const classes = await request('/api/essay/classes');
  const students = await request('/api/essay/classes/' + classes.body.classes[0].id + '/students');
  const assignments = await request('/api/essay/assignments?class_id=' + classes.body.classes[0].id);
  const submission = await request('/api/essay/submissions', {
    method: 'POST', body: {
      assignment_id: assignments.body.assignments[0].id,
      student_id: students.body.students[0].id,
      essay_text: '这是第一稿。事情发生以后，我终于懂得了成长不仅是年龄增加，更是愿意承担责任。'
    }
  });
  assert.equal(submission.status, 200);
  assert.match(submission.body.submission.share_url, /essay\/revise\//);

  const token = submission.body.submission.share_token;
  const publicView = await request('/api/essay/public/' + token, { public: true });
  assert.equal(publicView.status, 200);
  assert.equal(publicView.body.assignment.title, '那一次，我长大了');

  const beforeFinal = await request('/api/essay/public/' + token + '/revisions', {
    public: true, method: 'POST', body: { essay_text: '这份修改稿不应该在教师定稿前被接收，因为学生还看不到最终的教师反馈。' }
  });
  assert.equal(beforeFinal.status, 400);

  const finalized = await request('/api/essay/submissions/' + submission.body.submission.id + '/review', {
    method: 'PUT', body: { status: 'finalized', score_override: '86/100', summary_override: '细节更具体，结尾再收束主题。', annotations: [{ para: '这是第一稿。', comment: '补充动作细节', status: 'edited' }] }
  });
  assert.equal(finalized.status, 200);

  const revised = await request('/api/essay/public/' + token + '/revisions', {
    public: true, method: 'POST', body: { essay_text: '这是修改稿。我补充了事情的细节，也具体写出了从逃避到主动承担责任的过程。' }
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.revision.version_no, 2);

  const detail = await request('/api/essay/submissions/' + submission.body.submission.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.submission.status, 'revision_submitted');
  assert.equal(detail.body.revisions.length, 2);
});

test('history filters and class report use assignment and stable student ids', async () => {
  const classes = await request('/api/essay/classes');
  const assignments = await request('/api/essay/assignments?class_id=' + classes.body.classes[0].id);
  const history = await request('/api/essay/workflow/history?class_id=' + classes.body.classes[0].id + '&status=revision_submitted&q=%E6%9D%8E%E6%98%8E');
  assert.equal(history.status, 200);
  assert.equal(history.body.items.length, 1);
  assert.ok(history.body.items[0].student_id);

  const report = await request('/api/essay/assignments/' + assignments.body.assignments[0].id + '/report');
  assert.equal(report.status, 200);
  assert.equal(report.body.report.submission_count, 1);
  assert.ok(Array.isArray(report.body.report.score_distribution));
  assert.ok(Array.isArray(report.body.report.common_issues));
  assert.equal(typeof report.body.report.teaching_suggestion, 'string');
});
