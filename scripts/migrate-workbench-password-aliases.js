'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const SOURCE = 'student-growth-v7';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function readState(db) {
  const row = db.prepare('SELECT state_json FROM app_state WHERE id = 1').get();
  if (!row) throw new Error('工作台状态不存在');
  return JSON.parse(row.state_json);
}

function decryptLegacyPassword(record, key) {
  if (record.passwordEncryptionVersion !== 1) throw new Error('不支持的旧密码格式');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.passwordIv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(record.passwordTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.passwordCiphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    password_hash: crypto.scryptSync(password, salt, 64).toString('hex'),
    password_salt: salt
  };
}

function verifyPassword(password, record) {
  try {
    const actual = Buffer.from(crypto.scryptSync(password, record.password_salt, 64).toString('hex'), 'hex');
    const expected = Buffer.from(String(record.password_hash || ''), 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function canonicalMasterUser(oldUser, currentUsers, masterUsers) {
  const email = normalizeEmail(oldUser.email);
  const currentMatches = currentUsers.filter(user => normalizeEmail(user.email) === email);
  if (currentMatches.length === 1 && currentMatches[0].shixingUserId) {
    const linkedId = String(currentMatches[0].shixingUserId).replace(/^shixing:/, '');
    const linked = masterUsers.find(user => String(user.id) === linkedId);
    if (linked) return { user: linked, reason: 'linked' };
  }

  const registered = masterUsers.filter(user => normalizeEmail(user.registration_email) === email);
  if (registered.length === 1) return { user: registered[0], reason: 'registration_email' };
  if (registered.length > 1) return { ambiguous: true };

  const contacts = masterUsers.filter(user => user.contact_type === 'email'
    && normalizeEmail(user.contact_value) === email);
  if (contacts.length === 1) return { user: contacts[0], reason: 'contact_email' };
  if (contacts.length > 1) return { ambiguous: true };

  const usernames = masterUsers.filter(user => normalizeEmail(user.username) === email);
  if (usernames.length === 1) return { user: usernames[0], reason: 'username' };
  if (usernames.length > 1) return { ambiguous: true };
  return { missing: true };
}

function migrateWorkbenchPasswords({
  oldWorkbenchDb,
  currentWorkbenchDb,
  masterDb,
  encryptionKey,
  apply = false
}) {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
    throw new Error('PASSWORD_ENCRYPTION_KEY 必须为 32 字节');
  }
  const oldDb = new Database(oldWorkbenchDb, { readonly: true });
  const currentDb = new Database(currentWorkbenchDb, { readonly: true });
  const master = new Database(masterDb, { readonly: !apply });
  try {
    const oldUsers = readState(oldDb).users || [];
    const currentUsers = readState(currentDb).users || [];
    const masterUsers = master.prepare(`
      SELECT id, username, contact_type, contact_value, registration_email,
        password_hash, password_salt
      FROM users
    `).all();
    const aliases = master.prepare(`
      SELECT user_id, source, password_hash, password_salt
      FROM account_password_aliases
      WHERE source = ?
    `).all(SOURCE);
    const aliasByUser = new Map(aliases.map(alias => [String(alias.user_id), alias]));
    const summary = {
      oldUsers: oldUsers.length,
      mapped: 0,
      alreadyCompatible: 0,
      aliasesCreated: 0,
      aliasesAlreadyPresent: 0,
      registrationEmailsAssigned: 0,
      skippedAmbiguous: 0,
      skippedMissing: 0,
      decryptFailures: 0
    };
    const aliasWrites = [];
    const registrationWrites = [];

    for (const oldUser of oldUsers) {
      const mapping = canonicalMasterUser(oldUser, currentUsers, masterUsers);
      if (mapping.ambiguous) {
        summary.skippedAmbiguous += 1;
        continue;
      }
      if (!mapping.user) {
        summary.skippedMissing += 1;
        continue;
      }
      summary.mapped += 1;
      let password;
      try {
        password = decryptLegacyPassword(oldUser, encryptionKey);
      } catch {
        summary.decryptFailures += 1;
        continue;
      }

      const masterUser = mapping.user;
      if (verifyPassword(password, masterUser)) {
        summary.alreadyCompatible += 1;
      } else {
        const existingAlias = aliasByUser.get(String(masterUser.id));
        if (existingAlias && verifyPassword(password, existingAlias)) {
          summary.aliasesAlreadyPresent += 1;
        } else {
          aliasWrites.push({ user_id: masterUser.id, source: SOURCE, ...hashPassword(password) });
          summary.aliasesCreated += 1;
        }
      }
      password = null;

      const email = normalizeEmail(oldUser.email);
      const registrationOwner = masterUsers.find(user => normalizeEmail(user.registration_email) === email);
      if (!masterUser.registration_email && (!registrationOwner || registrationOwner.id === masterUser.id)) {
        registrationWrites.push({ user_id: masterUser.id, email });
        masterUser.registration_email = email;
        summary.registrationEmailsAssigned += 1;
      }
    }

    if (apply) {
      const applyChanges = master.transaction(() => {
        const upsertAlias = master.prepare(`
          INSERT INTO account_password_aliases (user_id, source, password_hash, password_salt, created_at)
          VALUES (@user_id, @source, @password_hash, @password_salt, @created_at)
          ON CONFLICT(user_id, source) DO UPDATE SET
            password_hash = excluded.password_hash,
            password_salt = excluded.password_salt,
            created_at = excluded.created_at
        `);
        const setRegistrationEmail = master.prepare(`
          UPDATE users SET registration_email = ?
          WHERE id = ? AND (registration_email IS NULL OR registration_email = '')
        `);
        const createdAt = new Date().toISOString();
        for (const alias of aliasWrites) upsertAlias.run({ ...alias, created_at: createdAt });
        for (const row of registrationWrites) setRegistrationEmail.run(row.email, row.user_id);
      });
      applyChanges();
    }
    return summary;
  } finally {
    oldDb.close();
    currentDb.close();
    master.close();
  }
}

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--')) args[arg.slice(2)] = argv[++i];
  }
  return args;
}

function readEncryptionKey(envFile) {
  const text = fs.readFileSync(envFile, 'utf8');
  const line = text.split(/\r?\n/).find(item => item.trim().startsWith('PASSWORD_ENCRYPTION_KEY='));
  if (!line) throw new Error('环境文件缺少 PASSWORD_ENCRYPTION_KEY');
  let value = line.slice(line.indexOf('=') + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return Buffer.from(value, 'base64');
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const name of ['old-workbench-db', 'current-workbench-db', 'master-db', 'env-file']) {
      if (!args[name]) throw new Error(`缺少 --${name}`);
    }
    const result = migrateWorkbenchPasswords({
      oldWorkbenchDb: args['old-workbench-db'],
      currentWorkbenchDb: args['current-workbench-db'],
      masterDb: args['master-db'],
      encryptionKey: readEncryptionKey(args['env-file']),
      apply: args.apply
    });
    console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', ...result }));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}

module.exports = { migrateWorkbenchPasswords };
