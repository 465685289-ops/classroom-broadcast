const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('courseware metadata is normalized and bounded', () => {
  const modulePath = path.join(root, 'edulab-courseware.js');
  assert.ok(fs.existsSync(modulePath), 'edulab-courseware.js should exist');
  const { normalizeCoursewarePatch, normalizeTeachingPreferences, deriveCoursewareTitle } = require(modulePath);

  assert.deepEqual(normalizeCoursewarePatch({
    title: '  二次函数与参数范围  ',
    knowledge_points: [' 二次函数 ', '参数范围', '二次函数', '', 'x'.repeat(80)],
    favorite: true
  }), {
    title: '二次函数与参数范围',
    knowledge_points: ['二次函数', '参数范围', 'x'.repeat(24)],
    favorite: true
  });
  assert.deepEqual(normalizeTeachingPreferences({ grade: '八年级', detail: '探究', dynamic: true, questions: true }), {
    grade: '八年级', detail: '探究', dynamic: true, questions: true
  });
  assert.equal(deriveCoursewareTitle('已知函数 y=x²-2x+1，求最小值。', '函数'), '已知函数 y=x²-2x+1，求最小值');
});

test('failed generation finalization rolls back the point debit', () => {
  const Database = require('better-sqlite3');
  const { createShixingPoints } = require('../shixing-points');
  const { createGenerationFinalizer } = require('../edulab-courseware');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE edulab_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT,
      problem TEXT,
      problem_hash TEXT UNIQUE,
      solution TEXT,
      url TEXT,
      created_at TEXT
    );
    INSERT INTO users (id, username) VALUES ('u1', '数学老师');
  `);
  const pointStore = createShixingPoints(db);
  pointStore.adjust({ user_id: 'u1', username: '数学老师', delta: 150, reason: 'test', product: 'all' });
  const finalizer = createGenerationFinalizer(db, pointStore, db.prepare(`
    INSERT INTO edulab_generations (user_id,type,problem,problem_hash,solution,url,created_at)
    VALUES (?,?,?,?,?,?,?)
  `));
  const input = {
    user: { id: 'u1', username: '数学老师' }, type: 'function', problem: 'x² 的图像', problemHash: 'same',
    solution: '解答', url: 'https://example.com/lesson.html', createdAt: '2026-07-14T00:00:00.000Z'
  };

  const startingBalance = pointStore.getBalance('u1');
  const completed = finalizer(input);
  assert.equal(completed.balance, startingBalance - 75);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM edulab_generations').get().count, 1);
  assert.throws(() => finalizer(input), /UNIQUE/);
  assert.equal(pointStore.getBalance('u1'), startingBalance - 75);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM edulab_generations').get().count, 1);
  db.close();
});

test('math service exposes user-scoped courseware management', () => {
  const source = read('edulab-product.js');

  for (const column of ['title TEXT', 'knowledge_points TEXT', 'favorite INTEGER', 'deleted_at TEXT']) {
    assert.match(source, new RegExp(column.replace(' ', '\\s+')));
  }
  assert.match(source, /Access-Control-Allow-Methods[^\n]+PATCH[^\n]+DELETE/);
  assert.match(source, /\/history\/\(\\d\+\)\$|historyMatch/);
  assert.match(source, /req\.method==='PATCH'/);
  assert.match(source, /req\.method==='DELETE'/);
  assert.match(source, /WHERE id = \? AND user_id = \?/);
  assert.match(source, /generation_id/);
  assert.match(source, /route\.endsWith\('\/ocr'\)[\s\S]{0,180}req\.method==='POST'/);
});

test('teacher platform has complete real workbench sections', () => {
  const page = read('public/edulab/pro.html');

  assert.match(page, /<title>师行数学教师工作台<\/title>/);
  assert.match(page, /rel="icon"[^>]+href="favicon\.svg"/);
  assert.ok(fs.existsSync(path.join(root, 'public/edulab/favicon.svg')));
  assert.match(page, /class="math-platform-nav"/);
  for (const route of ['dashboard', 'generator', 'library', 'knowledge', 'account']) {
    assert.match(page, new RegExp(`data-route="${route}"`));
    assert.match(page, new RegExp(`data-view="${route}"`));
  }
  for (const copy of ['教师工作台', '拍题生成', '互动课件', '我的课件', '题库与知识点', '数据与账户']) {
    assert.match(page, new RegExp(copy));
  }
  for (const id of ['metricBalance', 'metricTotal', 'metricFavorites', 'metricMonth', 'recentCourseware', 'libraryList']) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(page, /id="problemText"/);
  assert.match(page, /id="gradeSelect"/);
  assert.match(page, /id="dynamicOption"/);
  assert.match(page, /生成课件（消耗 75 积分）/);
  assert.match(page, /识别题目[\s\S]+深度解答[\s\S]+独立验算[\s\S]+制作课件/);
  assert.match(page, /teacher-workbench\.css/);
  assert.match(page, /teacher-workbench\.js/);
});

test('teacher workbench controller keeps generation gated and manages real records', () => {
  const source = read('public/edulab/teacher-workbench.js');
  new vm.Script(source, { filename: 'public/edulab/teacher-workbench.js' });

  assert.match(source, /if\s*\(!state\.loggedIn\)\s*\{[\s\S]{0,120}state\.pendingGenerate\s*=\s*true[\s\S]{0,120}openAuth/);
  assert.match(source, /fetch\(API\s*\+\s*'\/history'/);
  assert.match(source, /method:\s*'PATCH'/);
  assert.match(source, /method:\s*'DELETE'/);
  assert.match(source, /function\s+filterLibrary/);
  assert.match(source, /function\s+toggleFavorite/);
  assert.match(source, /function\s+saveCoursewareMeta/);
  assert.match(source, /function\s+renderKnowledge/);
  assert.match(source, /function\s+recognizeProblem/);
  assert.match(source, /function\s+recognizeProblem[\s\S]+response\.status\s*===\s*401[\s\S]{0,160}hideLoading\(true\)/);
  assert.match(source, /function\s+generate[\s\S]+response\.status\s*===\s*402[\s\S]{0,160}hideLoading\(true\)/);
  assert.doesNotMatch(source, /连续学习|预测分数|模拟数据/);
});

test('interactive lab links back into every teacher platform route', () => {
  const page = read('public/edulab/lab.html');
  for (const route of ['dashboard', 'generator', 'library', 'knowledge']) {
    assert.match(page, new RegExp(`pro\\.html#${route}`));
  }
});

test('teacher platform has a mobile-first fallback without horizontal page overflow', () => {
  const css = read('public/edulab/teacher-workbench.css');
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /\.mobile-math-nav/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /grid-template-columns:\s*1fr/);
});
