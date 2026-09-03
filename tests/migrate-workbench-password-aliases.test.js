const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { migrateWorkbenchPasswords } = require('../scripts/migrate-workbench-password-aliases');

function encryptPassword(password, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return {
    passwordEncryptionVersion: 1,
    passwordCiphertext: ciphertext.toString('base64'),
    passwordIv: iv.toString('base64'),
    passwordTag: cipher.getAuthTag().toString('base64')
  };
}

function createStateDb(file, state) {
  const db = new Database(file);
  db.exec('CREATE TABLE app_state (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, state_json TEXT NOT NULL)');
  db.prepare('INSERT INTO app_state (id, revision, state_json) VALUES (1, 1, ?)').run(JSON.stringify(state));
  db.close();
}

function masterPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

test('migration maps linked duplicate emails and preserves a different old workbench password as one-way alias', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-password-migration-'));
  const oldDbFile = path.join(tmp, 'old.sqlite');
  const currentDbFile = path.join(tmp, 'current.sqlite');
  const masterDbFile = path.join(tmp, 'master.sqlite');
  const key = crypto.randomBytes(32);
  try {
    createStateDb(oldDbFile, {
      users: [{
        id: 'old-linked', email: 'shared@example.com',
        ...encryptPassword('shared-password', key)
      }, {
        id: 'old-alias', email: 'alias@example.com',
        ...encryptPassword('old-workbench-password', key)
      }]
    });
    createStateDb(currentDbFile, {
      users: [{ id: 'current-linked', email: 'shared@example.com', shixingUserId: 'shixing:canonical-shared' },
        { id: 'current-alias', email: 'alias@example.com' }]
    });

    const master = new Database(masterDbFile);
    master.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        contact_type TEXT, contact_value TEXT, registration_email TEXT,
        password_hash TEXT NOT NULL, password_salt TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_users_registration_email
        ON users(registration_email) WHERE registration_email IS NOT NULL;
      CREATE TABLE account_password_aliases (
        user_id TEXT NOT NULL, source TEXT NOT NULL,
        password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (user_id, source)
      );
    `);
    const insert = master.prepare(`
      INSERT INTO users (id, username, contact_type, contact_value, registration_email, password_hash, password_salt)
      VALUES (?, ?, 'email', ?, ?, ?, ?)
    `);
    insert.run('canonical-shared', 'shared-one', 'shared@example.com', null,
      masterPassword('shared-password', 'shared-one-salt'), 'shared-one-salt');
    insert.run('duplicate-shared', 'shared-two', 'shared@example.com', null,
      masterPassword('shared-password', 'shared-two-salt'), 'shared-two-salt');
    insert.run('canonical-alias', 'alias-user', 'alias@example.com', 'alias@example.com',
      masterPassword('master-password', 'alias-master-salt'), 'alias-master-salt');
    master.close();

    const first = migrateWorkbenchPasswords({
      oldWorkbenchDb: oldDbFile,
      currentWorkbenchDb: currentDbFile,
      masterDb: masterDbFile,
      encryptionKey: key,
      apply: true
    });
    assert.deepEqual(first, {
      oldUsers: 2,
      mapped: 2,
      alreadyCompatible: 1,
      aliasesCreated: 1,
      aliasesAlreadyPresent: 0,
      registrationEmailsAssigned: 1,
      skippedAmbiguous: 0,
      skippedMissing: 0,
      decryptFailures: 0
    });

    const check = new Database(masterDbFile, { readonly: true });
    const canonical = check.prepare('SELECT registration_email FROM users WHERE id = ?').get('canonical-shared');
    assert.equal(canonical.registration_email, 'shared@example.com');
    const alias = check.prepare('SELECT password_hash, password_salt FROM account_password_aliases WHERE user_id = ?').get('canonical-alias');
    assert.ok(alias);
    assert.equal(
      crypto.scryptSync('old-workbench-password', alias.password_salt, 64).toString('hex'),
      alias.password_hash
    );
    check.close();

    const second = migrateWorkbenchPasswords({
      oldWorkbenchDb: oldDbFile,
      currentWorkbenchDb: currentDbFile,
      masterDb: masterDbFile,
      encryptionKey: key,
      apply: true
    });
    assert.equal(second.aliasesCreated, 0);
    assert.equal(second.aliasesAlreadyPresent, 1);
    assert.equal(second.registrationEmailsAssigned, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
