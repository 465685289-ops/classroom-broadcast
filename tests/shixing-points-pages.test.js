const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function compileInlineScripts(file) {
  const html = read(file);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
  scripts.forEach((source, index) => new vm.Script(source, { filename: file + '#script-' + index }));
}

test('all active DeepSeek calls default to deepseek-v4-flash', () => {
  for (const file of ['platform-config.js', 'ai-engines.js', 'edulab-product.js', 'public/edulab/solver.html', '.env.example', 'comment-config.example.json']) {
    const source = read(file);
    assert.match(source, /deepseek-v4-flash/, file);
    assert.doesNotMatch(source, /deepseek-chat/, file);
  }
});

test('the four AI product pages show shared point costs and first-top-up packages', () => {
  const comment = read('public/comment.html');
  const essay = read('public/zuowen.html');
  const roundtable = read('public/roundtable/index.html');
  const math = read('public/edulab/pro.html');

  assert.match(comment, /每生成或改写 1 条评语消耗 25 积分/);
  assert.match(essay, /50 师行积分\/次/);
  assert.match(essay, /作文批改每次消耗 \{\{pointCost\}\} 积分/);
  assert.match(roundtable, /一个完整话题消耗 50 积分/);
  assert.match(math, /生成课件（消耗 75 积分）/);
  for (const page of [comment, essay, roundtable, math]) {
    assert.match(page, /首充赠/);
    assert.match(page, /师行积分/);
  }
});

test('edited product pages keep valid inline JavaScript', () => {
  compileInlineScripts('public/comment.html');
  compileInlineScripts('public/zuowen.html');
  compileInlineScripts('public/roundtable/index.html');
  compileInlineScripts('public/edulab/pro.html');
  compileInlineScripts('public/edulab/solver.html');
});
