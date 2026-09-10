const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'purge-test-accounts.js');

function runPurge(dbFile, apply) {
  const args = [SCRIPT, '--db', dbFile, '--user', 'test-user'];
  if (apply) args.push('--apply');
  return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
}

test('test-account purge is dry-run by default and removes only direct account data plus owned class data', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shixing-purge-test-'));
  const dbFile = path.join(temp, 'broadcast.db');
  const db = new Database(dbFile);
  try {
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, registration_email TEXT, contact_type TEXT, contact_value TEXT);
      CREATE TABLE classes (id TEXT PRIMARY KEY, user_id TEXT);
      CREATE TABLE class_students (id TEXT PRIMARY KEY, class_id TEXT, name TEXT);
      CREATE TABLE payments (id TEXT PRIMARY KEY, user_id TEXT);
      CREATE TABLE shixing_point_ledger (id INTEGER PRIMARY KEY, user_id TEXT);
      CREATE TABLE registration_email_codes (id INTEGER PRIMARY KEY, email TEXT);
      CREATE TABLE password_reset_codes (id INTEGER PRIMARY KEY, user_id TEXT, username TEXT, email TEXT);
      CREATE TABLE app_referrals (id INTEGER PRIMARY KEY, invitee_user_id TEXT, inviter_user_id TEXT);
    `);
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('test-user', 'mailtest', 'mailtest@example.test', 'email', 'mailtest@example.test');
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('keep-user', 'teacher', 'teacher@example.test', 'email', 'teacher@example.test');
    db.prepare('INSERT INTO classes VALUES (?,?)').run('test-class', 'test-user');
    db.prepare('INSERT INTO classes VALUES (?,?)').run('keep-class', 'keep-user');
    db.prepare('INSERT INTO class_students VALUES (?,?,?)').run('test-student', 'test-class', '测试学生');
    db.prepare('INSERT INTO class_students VALUES (?,?,?)').run('keep-student', 'keep-class', '保留学生');
    db.prepare('INSERT INTO payments VALUES (?,?)').run('test-payment', 'test-user');
    db.prepare('INSERT INTO payments VALUES (?,?)').run('keep-payment', 'keep-user');
    db.prepare('INSERT INTO shixing_point_ledger VALUES (?,?)').run(1, 'test-user');
    db.prepare('INSERT INTO shixing_point_ledger VALUES (?,?)').run(2, 'keep-user');
    db.prepare('INSERT INTO registration_email_codes VALUES (?,?)').run(1, 'mailtest@example.test');
    db.prepare('INSERT INTO registration_email_codes VALUES (?,?)').run(2, 'teacher@example.test');
    db.prepare('INSERT INTO password_reset_codes VALUES (?,?,?,?)').run(1, 'test-user', 'mailtest', 'mailtest@example.test');
    db.prepare('INSERT INTO password_reset_codes VALUES (?,?,?,?)').run(2, 'keep-user', 'teacher', 'teacher@example.test');
    db.prepare('INSERT INTO app_referrals VALUES (?,?,?)').run(1, 'test-user', 'keep-user');
    db.prepare('INSERT INTO app_referrals VALUES (?,?,?)').run(2, 'keep-user', 'keep-user');
  } finally {
    db.close();
  }

  const dryRun = runPurge(dbFile, false);
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.matched_accounts, 1);
  assert.equal(dryRun.owned_class_ids, 1);
  assert.equal(dryRun.total_rows, 8);

  let check = new Database(dbFile, { readonly: true });
  try {
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM class_students').get().n, 2);
  } finally {
    check.close();
  }

  const applied = runPurge(dbFile, true);
  assert.equal(applied.mode, 'applied');
  assert.equal(applied.total_rows, 8);

  check = new Database(dbFile, { readonly: true });
  try {
    for (const table of ['users', 'classes', 'class_students', 'payments', 'shixing_point_ledger', 'registration_email_codes', 'password_reset_codes', 'app_referrals']) {
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n, 1, table + ' keeps only the unrelated row');
    }
    assert.equal(check.prepare("SELECT id FROM users WHERE id = 'keep-user'").get().id, 'keep-user');
    assert.equal(check.prepare("SELECT id FROM class_students WHERE id = 'keep-student'").get().id, 'keep-student');
  } finally {
    check.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
