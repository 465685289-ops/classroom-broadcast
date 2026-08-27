const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TMP = path.join(os.tmpdir(), 'shixing-english-billing-' + Date.now());
process.env.SQLITE_FILE = path.join(TMP, 'test.db');
process.env.LEGACY_JSON_FILE = path.join(TMP, 'missing.json');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
fs.mkdirSync(TMP, { recursive: true });
const dbStore = require('../db');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('same English grading request is charged only once', () => {
  dbStore.upsertUser({
    id: 'billing-user', username: 'billing-teacher', display_name: '英语老师',
    password_hash: 'hash', password_salt: 'salt', token: 'token',
    token_expires: new Date(Date.now() + 86400000).toISOString(), created_at: new Date().toISOString()
  });
  dbStore.adjustShixingPoints({ user_id: 'billing-user', username: 'billing-teacher', delta: 100, reason: 'test', product: 'english' });
  const startingBalance = dbStore.getShixingPointBalance('billing-user');

  const input = {
    user_id: 'billing-user', username: 'billing-teacher', student_name: 'Amy',
    genre: '中考作文', grade_level: '初中', score_type: '满分20分', subject: 'english',
    essay_text: 'I took part in a school activity and learned how important teamwork is for everyone.',
    result: '批改完成', model: 'test-model', request_id: 'same-request-id',
    extra_json: { english: { total_100: 85, dimensions: [] } }
  };
  const first = dbStore.insertEssayGradingAndDebit(input);
  const second = dbStore.insertEssayGradingAndDebit(input);

  assert.equal(first.balance, startingBalance - 50);
  assert.equal(second.balance, startingBalance - 50);
  assert.equal(second.duplicate, true);
  assert.equal(second.grading.id, first.grading.id);
  assert.equal(dbStore.listShixingPointLedger('billing-user', 20).filter(row => row.product === 'english' && row.delta === -50).length, 1);
});
