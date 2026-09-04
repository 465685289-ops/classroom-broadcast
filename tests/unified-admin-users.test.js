const assert = require('node:assert/strict');
const test = require('node:test');

const { mergeWorkbenchProfiles } = require('../workbench-admin');

test('merges workbench profiles into master accounts by explicit id first and unique email second', () => {
  const masterUsers = [{
    id: 'master-a', username: 'a@example.test', registration_email: 'a@example.test',
    contact_type: 'email', contact_value: 'a@example.test', last_login_at: null
  }, {
    id: 'master-b', username: 'legacy-b', registration_email: null,
    contact_type: 'email', contact_value: 'b@example.test', last_login_at: '2026-09-01T08:00:00.000Z'
  }];
  const workbenchUsers = [{
    shixingUserId: 'shixing:master-a', email: 'other@example.test', name: '甲老师',
    school: '示例中学', subject: '语文', role: 'homeroom',
    classCount: 2, observationCount: 8, lastLoginAt: '2026-09-02T09:10:00.000Z'
  }, {
    shixingUserId: '', email: 'b@example.test', name: '乙老师', school: '', subject: '数学',
    role: 'teacher', classCount: 1, observationCount: 3, lastLoginAt: '2026-08-30T09:00:00.000Z'
  }];

  const merged = mergeWorkbenchProfiles(masterUsers, workbenchUsers);
  assert.equal(merged.get('master-a').workbench.name, '甲老师');
  assert.equal(merged.get('master-a').last_login_at, '2026-09-02T09:10:00.000Z');
  assert.equal(merged.get('master-b').workbench.name, '乙老师');
  assert.equal(merged.get('master-b').last_login_at, '2026-09-01T08:00:00.000Z');
});

test('does not guess when the same email belongs to multiple master accounts', () => {
  const masterUsers = [{ id: 'one', contact_type: 'email', contact_value: 'same@example.test' },
    { id: 'two', contact_type: 'email', contact_value: 'same@example.test' }];
  const workbenchUsers = [{ email: 'same@example.test', name: '不应自动绑定' }];
  const merged = mergeWorkbenchProfiles(masterUsers, workbenchUsers);
  assert.equal(merged.get('one').workbench, null);
  assert.equal(merged.get('two').workbench, null);
});

test('admin page presents one full-platform user list with workbench data and recent login', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.match(html, /全平台用户/);
  assert.match(html, /工作台资料/);
  assert.match(html, /最近登录/);
  assert.match(html, /last_login_at/);
});
