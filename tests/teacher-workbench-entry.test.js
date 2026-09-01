'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('广播首页的教师入口直达师行教师工作台广播模块', () => {
  const home = read('public/index.html');
  const pricing = read('public/pricing.html');
  assert.match(home, /href="\/student-growth\/?\?page=broadcast"[^>]*class="t"/);
  assert.doesNotMatch(home, /href="\/teacher\.html"/);
  assert.match(pricing, /href="\/student-growth\/?\?page=broadcast&panel=account"/);
  assert.doesNotMatch(pricing, /href="\/teacher\.html"/);
});

test('旧教师端地址保留为兼容跳转，支付完成后也返回工作台', () => {
  const teacher = read('public/teacher.html');
  const server = read('server.js');
  assert.match(teacher, /student-growth\/?\?page=broadcast/);
  assert.match(server, /return_url:\s*baseUrl\s*\+\s*'\/student-growth\/\?page=broadcast&panel=account&pay_order='/);
});
