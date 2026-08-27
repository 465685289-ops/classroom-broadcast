const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'public', 'zuowen.html'), 'utf8');

test('essay teacher page exposes the complete teaching workflow', () => {
  for (const label of ['批改工作台', '班级与作业', '历史记录', '整班讲评']) assert.match(page, new RegExp(label));
  for (const label of ['作文题目', '写作材料', '写作要求', '字数范围', '评分维度与权重', '保存为量规模板']) assert.match(page, new RegExp(label));
  for (const label of ['接受', '修改', '删除', '教师已定稿', '学生返修链接', '原稿', '修改稿', '二次批改']) assert.match(page, new RegExp(label));
  for (const label of ['待批', '待复核', '已返还', '已返修', '归档', '复制为新任务']) assert.match(page, new RegExp(label));
});

test('history has filters and mobile layout fixes', () => {
  for (const key of ['historyClassFilter', 'historyAssignmentFilter', 'historyStudentFilter', 'historyStatusFilter', 'historyDateFrom', 'historyDateTo']) {
    assert.match(page, new RegExp(key));
  }
  assert.match(page, /@media\s*\(max-width:\s*640px\)[\s\S]*mobile-shell-links/);
  assert.match(page, /footer-links/);
  assert.match(page, /button[^>]+class="mode-tab"/);
  assert.doesNotMatch(page, /\.mode-tab[^\n]*outline:\s*none/);
});

test('student revision page is present and scripts compile', () => {
  const revision = fs.readFileSync(path.join(ROOT, 'public', 'essay-revise.html'), 'utf8');
  for (const label of ['作文修改', '教师反馈', '提交修改稿']) assert.match(revision, new RegExp(label));
  for (const [name, html] of [['zuowen.html', page], ['essay-revise.html', revision]]) {
    [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1].trim()).filter(Boolean)
      .forEach((source, index) => new vm.Script(source, { filename: name + '#script-' + index }));
  }
});

test('desktop onboarding uses both side rails and keeps advanced settings optional', () => {
  assert.match(page, /class="grade-desktop-grid"/);
  assert.match(page, /class="onboarding-rail"/);
  assert.match(page, /class="context-rail"/);
  for (const label of ['第一次使用', '放入作文', '生成并审核', '本次批改', '批改后你会得到']) assert.match(page, new RegExp(label));
  assert.match(page, /showAdvancedTask/);
  assert.match(page, /任务与评分设置（选填）/);
  assert.match(page, /@media\s*\(min-width:\s*1280px\)[\s\S]*grid-template-columns:\s*240px\s+minmax\(0,900px\)\s+260px/);
});

test('photo action stays beside the editor and footer routes to the complete product homepage', () => {
  assert.doesNotMatch(page, /<button[^>]+class="ocr-btn"/);
  assert.match(page, /class="btn-primary inline-ocr"/);
  assert.match(page, /\.inline-ocr\s*\{\s*display:inline-flex/);
  assert.match(page, /href="https:\/\/shixing\.yingyuzuowen\.asia\/"[^>]*>查看全部师行工具/);
});
