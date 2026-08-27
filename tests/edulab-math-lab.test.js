const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('math lab evaluates supported expressions without eval', () => {
  const core = require('../public/edulab/math-lab-core.js');
  const parabola = core.compileExpression('2*a*x^2-1');
  const sine = core.compileExpression('sin(x)');

  assert.equal(parabola({ x: 2, a: 0.5 }), 3);
  assert.ok(Math.abs(sine({ x: Math.PI / 2, a: 1 }) - 1) < 1e-9);
  assert.throws(() => core.compileExpression('window.alert(1)'), /不支持|无法识别/);
  assert.doesNotMatch(read('public/edulab/math-lab-core.js'), /\beval\s*\(|new\s+Function\s*\(/);
});

test('math lab samples finite graph points and reports invalid regions as gaps', () => {
  const core = require('../public/edulab/math-lab-core.js');
  const samples = core.sampleExpression('sqrt(x)', 1, -1, 1, 5);

  assert.equal(samples.length, 5);
  assert.equal(samples[0].y, null);
  assert.equal(samples[2].y, 0);
  assert.equal(samples[4].y, 1);
  assert.equal(core.formatNumber(-0), '0');
  assert.equal(core.formatNumber(Math.PI), '3.14');
});

test('interactive math lab exposes the selected teacher workspace and responsive controls', () => {
  const page = read('public/edulab/lab.html');

  assert.match(page, /<title>互动数学实验室[^<]*<\/title>/);
  assert.match(page, /class="math-platform-nav"/);
  assert.match(page, /id="mathCanvas"/);
  assert.match(page, /id="parameterA"/);
  assert.match(page, /id="functionList"/);
  assert.match(page, /课堂讲解步骤/);
  assert.match(page, /生成讲解课件/);
  assert.match(page, /@media\s*\(max-width:\s*760px\)/);
  assert.match(page, /math-lab-core\.js/);
  assert.match(page, /math-lab\.js/);
});

test('math lab browser controller parses and the generator links into the same platform shell', () => {
  const controller = read('public/edulab/math-lab.js');
  const generator = read('public/edulab/pro.html');

  new vm.Script(controller, { filename: 'public/edulab/math-lab.js' });
  assert.match(controller, /requestAnimationFrame\(draw\)/);
  assert.match(controller, /requestFullscreen/);
  assert.match(generator, /class="math-platform-nav"/);
  assert.match(generator, /href="lab\.html"[^>]*>[\s\S]{0,80}互动实验室/);
});

test('math lab teaches the first workflow and leaves normal wheel scrolling to the page', () => {
  const page = read('public/edulab/lab.html');
  const controller = read('public/edulab/math-lab.js');

  assert.match(page, /id="quickStart"/);
  assert.match(page, /id="guideOverlay"/);
  assert.match(page, /id="guideStart"/);
  assert.match(page, /普通滚轮滚动页面/);
  assert.match(controller, /function\s+openGuide/);
  assert.match(controller, /edulab_lab_guide_seen_v2/);
  assert.match(controller, /if\s*\(!event\.ctrlKey\s*&&\s*!event\.metaKey\)\s*return/);
  assert.match(controller, /if\s*\(!localStorage\.getItem\('edulab_lab_guide_seen_v2'\)\)[\s\S]{0,120}openGuide/);
  assert.match(controller, /pro\.html\?from=lab#generator/);
  const teacherController = read('public/edulab/teacher-workbench.js');
  assert.match(teacherController, /function\s+loadLabDraft/);
  assert.match(teacherController, /edulab_lab_draft/);
});
