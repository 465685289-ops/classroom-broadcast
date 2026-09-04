const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pages = [
  'teacher.html',
  'comment.html',
  'zuowen.html',
  'english.html',
  'xiezuo.html',
  'roundtable/index.html',
  'edulab/pro.html'
];

for (const pageName of pages) {
  test(pageName + ' collects and sends an email registration code', () => {
    let page = fs.readFileSync(path.join(__dirname, '..', 'public', pageName), 'utf8');
    if (pageName === 'edulab/pro.html') {
      page += fs.readFileSync(path.join(__dirname, '..', 'public', 'edulab', 'teacher-workbench.js'), 'utf8');
    }
    assert.match(page, /邮箱验证码/);
    assert.match(page, /\/api\/register\/send-code/);
    assert.match(page, /email/);
    assert.match(page, /code/);
    assert.match(page, /registration-email-helper\.js/, pageName + ' should load the shared email correction UI');
    assert.match(page, /ShixingRegistrationEmail\.showFailure/, pageName + ' should offer the shared correction controls');
  });
}

test('all product registration forms use verified email as the account instead of a custom username', () => {
  const sources = pages.map(pageName => ({
    pageName,
    page: fs.readFileSync(path.join(__dirname, '..', 'public', pageName), 'utf8')
  }));
  for (const { pageName, page } of sources) {
    assert.match(page, /邮箱/, pageName + ' should collect an email');
    assert.match(page, /验证码/, pageName + ' should collect an email code');
    assert.match(page, /称呼|显示名称|姓名/, pageName + ' should collect a display name');
  }

  assert.doesNotMatch(sources.find(item => item.pageName === 'teacher.html').page, /id="regUser"/);
  assert.doesNotMatch(sources.find(item => item.pageName === 'comment.html').page, /id="regUser"/);
  assert.doesNotMatch(sources.find(item => item.pageName === 'zuowen.html').page, /id="essayRegUser"/);
  assert.doesNotMatch(sources.find(item => item.pageName === 'english.html').page, /id="regUser"/);
  assert.doesNotMatch(sources.find(item => item.pageName === 'edulab/pro.html').page, /id="regUser"/);
});

test('the shixing homepage exposes the one shared account entry', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'shixing', 'index.html'), 'utf8');
  assert.match(page, />师行账号<\/a>/);
  assert.match(page, /notice\.yingyuzuowen\.asia\/student-growth\//);
});
