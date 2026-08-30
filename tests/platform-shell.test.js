const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('the bare shixing host serves the shared product homepage', () => {
  const server = read('server.js');
  assert.match(server, /function\s+shixingHost\s*\(/);
  assert.match(server, /if\s*\(shixingHost\(req\)\)\s*return\s+res\.sendFile\([^\n]+public[^\n]+shixing[^\n]+index\.html/);
});

test('the English subdomain serves the English teacher workspace', () => {
  const server = read('server.js');
  assert.match(server, /function\s+englishHost\s*\(/);
  assert.match(server, /if\s*\(englishHost\(req\)\)\s*return\s+res\.sendFile\([^\n]+public[^\n]+english\.html/);
});

test('all public product entries expose descriptions and canonical URLs', () => {
  const pages = [
    'public/shixing/index.html',
    'public/index.html',
    'public/comment.html',
    'public/zuowen.html',
    'public/english.html',
    'public/roundtable/index.html',
    'public/edulab/pro.html'
  ];
  for (const file of pages) {
    const html = read(file);
    assert.match(html, /<meta\s+name="description"\s+content="[^"]+">/, `${file} description`);
    assert.match(html, /<link\s+rel="canonical"\s+href="https:\/\/[^\"]+">/, `${file} canonical`);
  }
});

test('homepage navigation stays in the current tab and comment can return home', () => {
  const home = read('public/shixing/index.html');
  const comment = read('public/comment.html');
  assert.doesNotMatch(home, /class="rpanel"[^>]+target="_blank"/);
  assert.match(home, /href="https:\/\/notice\.yingyuzuowen\.asia\/english\.html"[^>]*aria-label="进入英语作文批改"/);
  assert.match(home, /七件趁手的工具/);
  assert.match(comment, /class="shixing-home-link"[^>]+href="https:\/\/shixing\.yingyuzuowen\.asia\/"/);
});

test('math mobile header does not collide with home navigation and allows zoom', () => {
  const html = read('public/edulab/pro.html');
  assert.doesNotMatch(html, /user-scalable=no/);
  assert.match(html, /@media\(max-width:600px\)[\s\S]*?\.header\{padding-top:54px/);
  assert.match(html, /id="authOverlay"[^>]+role="dialog"[^>]+aria-modal="true"/);
});

test('roundtable previews the product before login and uses mobile-safe height', () => {
  const html = read('public/roundtable/index.html');
  assert.match(html, /height:\s*100dvh/);
  assert.match(html, /if\s*\(!authToken\)\s*\{\s*hideAuth\(\);\s*return;\s*\}/);
  assert.match(html, /pendingSend\s*=\s*true;\s*showAuth\(\)/);
  assert.match(html, /<button[^>]+class="at-chip/);
  assert.match(html, /class="close-x"[^>]+onclick="hideAuth\(\)"[^>]+aria-label="关闭登录窗口"/);
});

test('comment and essay preview their full workbenches and defer auth until generation', () => {
  const comment = read('public/comment.html');
  const essay = read('public/zuowen.html');

  assert.match(comment, /function\s+enterGuestApp\s*\(/);
  assert.match(comment, /if\s*\(!currentUser\)\s*\{\s*openAuth\(\{\s*type:\s*'one'/);
  assert.match(comment, /\.catch\(function\(\)\{[\s\S]{0,160}enterGuestApp\(\);[\s\S]{0,40}\}\);/);

  assert.match(essay, /v-if="showAuthModal"[^>]+class="overlay auth-overlay"/);
  assert.doesNotMatch(essay, /<div\s+v-if="user"\s+class="container"/);
  assert.match(essay, /openAuth\(pendingOcrFile\.value\s*\?\s*'single-photo-grade'\s*:\s*'single-grade'\)/);
  assert.match(essay, /pendingOcrFile\.value\s*=\s*file/);
  assert.match(essay, /action\s*===\s*'single-photo-grade'/);
});

test('classroom broadcast remains subscription-gated instead of consuming AI points', () => {
  const server = read('server.js');
  assert.match(server, /function\s+requireActivePlan\s*\(/);
  assert.match(server, /app\.post\('\/api\/notify',\s*userAuth,\s*requireActivePlan/);
});

test('class timetable API is installed as its own route domain', () => {
  const server = read('server.js');
  const routes = read('timetable-routes.js');
  assert.match(server, /require\('\.\/timetable-routes\.js'\)/);
  assert.match(server, /installTimetableRoutes\(app,\s*\{\s*requireActivePlan\s*\}\)/);
  assert.match(routes, /function\s+installTimetableRoutes\s*\(/);
  assert.match(routes, /app\.get\('\/api\/classes\/:classId\/timetable'/);
  assert.match(routes, /app\.put\('\/api\/classes\/:classId\/timetable'/);
  assert.match(server, /socket\.emit\('bind-success',[\s\S]{0,500}timetable:\s*normalizeClassTimetable\(cls\.timetable\)/);
  assert.match(routes, /state\.io\.to\(`class:\$\{cls\.id\}`\)\.emit\('class-timetable-update',\s*cls\.timetable\)/);
});

test('server startup logs never print the administrator password', () => {
  const server = read('server.js');
  assert.doesNotMatch(server, /console\.log\(`管理密码:\s*\$\{ADMIN_PASS\}`\)/);
});

test('authentication controls expose labels and dialog semantics', () => {
  const comment = read('public/comment.html');
  const essay = read('public/zuowen.html');
  const roundtable = read('public/roundtable/index.html');
  const math = read('public/edulab/pro.html');
  assert.match(comment, /<label\s+for="loginUser">用户名<\/label>/);
  assert.match(comment, /id="authPage"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(essay, /<label\s+for="essayLoginUser">用户名<\/label>/);
  assert.match(roundtable, /<label\s+class="sr-only"\s+for="authUser">用户名<\/label>/);
  assert.match(math, /<label\s+class="sr-only"\s+for="loginUser">用户名<\/label>/);
});
