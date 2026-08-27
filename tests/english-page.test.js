const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('English teacher page exposes the agreed teacher workflow', () => {
  const page = read('public/english.html');
  for (const label of ['英语作文批改', '单篇批改', '整班批改', '班级与作业', '教师审核', '历史记录', '整班报告']) {
    assert.match(page, new RegExp(label));
  }
  for (const label of ['初中日常作文', '中考作文', '高中应用文', '读后续写']) assert.match(page, new RegExp(label));
  for (const label of ['中文解释', '英文修改建议', '接受', '修改', '删除', '教师已定稿']) assert.match(page, new RegExp(label));
  assert.match(page, /50积分\/篇/);
  assert.match(page, /生成时再登录/);
  assert.match(page, /request_id/);
});

test('English pages compile and use the shared account without exposing Chinese classes', () => {
  for (const file of ['public/english.html', 'public/english-revise.html']) {
    const html = read(file);
    [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1].trim()).filter(Boolean)
      .forEach((source, index) => new vm.Script(source, { filename: file + '#script-' + index }));
  }
  const page = read('public/english.html');
  assert.match(page, /\/api\/english\/classes/);
  assert.doesNotMatch(page, /\/api\/essay\/classes/);
  assert.match(page, /<meta\s+name="description"\s+content="[^"]+">/);
  assert.match(page, /<link\s+rel="canonical"\s+href="https:\/\/notice\.yingyuzuowen\.asia\/english\.html">/);
});

test('English recharge stays inside the shared-points flow instead of opening broadcast pricing', () => {
  const page = read('public/english.html');
  // refactor: 该路由已迁至 english-routes.js
  const server = read('english-routes.js');

  assert.doesNotMatch(page, /pricing\.html/);
  assert.match(page, /id="rechargeButton"/);
  assert.match(page, /\/api\/english\/payments\/package/);
  assert.match(page, /pay_order/);

  const routeStart = server.indexOf("app.post('/api/english/payments/package'");
  assert.notEqual(routeStart, -1, 'English should expose its own point-package payment endpoint');
  const route = server.slice(routeStart, routeStart + 3200);
  assert.match(route, /source_product:\s*'english'/);
  assert.match(route, /english\.html\?pay_order=/);
});

test('recharge routes preserve product billing boundaries across all platforms', () => {
  const pointProducts = {
    'public/comment.html': /\/api\/comment\/payments\/package/,
    'public/zuowen.html': /\/api\/essay\/payments\/package/,
    'public/english.html': /\/api\/english\/payments\/package/,
    'public/roundtable/index.html': /\/api\/roundtable\/payments\/package/,
    'public/edulab/teacher-workbench.js': /\/pay\/create/
  };
  for (const [file, endpoint] of Object.entries(pointProducts)) {
    const source = read(file);
    assert.match(source, endpoint, file + ' should use shared-point recharge');
    assert.doesNotMatch(source, /pricing\.html/, file + ' must not open broadcast subscription pricing');
  }

  assert.match(read('public/teacher.html'), /href="\/pricing\.html"/);
  assert.match(read('public/pricing.html'), /广播|班级通知/);
});
