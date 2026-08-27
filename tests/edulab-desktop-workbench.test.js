const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function compileInlineScripts(html, filename) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(source => source && !source.includes('__LESSON_DATA__'));
  scripts.forEach((source, index) => new vm.Script(source, { filename: filename + '#script-' + index }));
}

test('function lessons use a full desktop three-column workbench', () => {
  const page = read('templates/edulab/func.html');
  assert.match(page, /class="workspace"/);
  assert.match(page, /grid-template-columns:\s*minmax\(/);
  assert.match(page, /class="left-column"/);
  assert.match(page, /class="[^"]*analysis-card/);
  assert.match(page, /class="[^"]*plot-card/);
  assert.match(page, /@media\s*\(max-width:\s*760px\)/);
  assert.doesNotMatch(page, /max-width:\s*560px/);
  compileInlineScripts(page, 'templates/edulab/func.html');
});

test('the generator embeds the generated lesson instead of leaving the result column blank', () => {
  const page = read('public/edulab/pro.html');
  const controller = read('public/edulab/teacher-workbench.js');
  assert.match(page, /id="coursewareFrame"/);
  assert.match(page, /class="[^"]*preview-card/);
  assert.match(page, /新窗口打开课件/);
  assert.match(page, /再次消耗 75 积分/);
  assert.match(controller, /confirm\(/);
});

test('math solving uses V4 Pro thinking and a separate verification pass', () => {
  const server = read('edulab-product.js');
  assert.match(server, /EDULAB_SOLVE_MODEL/);
  assert.match(server, /deepseek-v4-pro/);
  assert.match(server, /max_tokens:\s*18000/);
  assert.match(server, /reasoning_effort:\s*['"]high['"]/);
  assert.match(server, /thinking:\s*\{\s*type:\s*['"]enabled['"]/);
  assert.match(server, /async function verifySolution/);
  assert.match(server, /await verifySolution\(problem, draft\)/);
  assert.match(server, /AI 返回正文为空/);
});

test('the reported dual-function lesson keeps the corrected conclusions', () => {
  const lesson = JSON.parse(read('tests/fixtures/edulab-dual-function.corrected.json'));
  const serialized = JSON.stringify(lesson);
  assert.match(lesson.lesson.answer, /① √，② √，③ ×/);
  assert.match(lesson.lesson.answer, /a>\\dfrac38/);
  assert.match(serialized, /一次函数是对偶函数的充要条件为 \$k=1\$/);
  assert.doesNotMatch(serialized, /a\\leq|a\\geq 1|k=-1/);
});

test('lesson data injection preserves display-math double dollar delimiters', () => {
  const server = read('edulab-product.js');
  const renderer = read('scripts/render-edulab-function-page.js');
  const rebuilder = read('scripts/rebuild-edulab-function-pages.js');
  assert.equal((server.match(/replace\('__LESSON_DATA__', \(\) => json\)/g) || []).length, 3);
  assert.match(renderer, /replace\('__LESSON_DATA__', \(\) => json\)/);
  assert.match(rebuilder, /replace\('__LESSON_DATA__', \(\) => json\)/);
  const sample = '<script>__LESSON_DATA__</script>'.replace('__LESSON_DATA__', () => JSON.stringify({ formula:'$$x^2$$' }));
  assert.match(sample, /\$\$x\^2\$\$/);
});
