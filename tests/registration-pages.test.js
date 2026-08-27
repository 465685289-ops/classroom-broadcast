const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pages = ['teacher.html', 'comment.html', 'zuowen.html', 'xiezuo.html'];

for (const pageName of pages) {
  test(pageName + ' collects and sends an email registration code', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', pageName), 'utf8');
    assert.match(page, /邮箱验证码/);
    assert.match(page, /\/api\/register\/send-code/);
    assert.match(page, /email/);
    assert.match(page, /code/);
  });
}
