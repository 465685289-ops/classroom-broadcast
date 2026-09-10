#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const USER_REFERENCE_COLUMNS = new Set([
  'user_id', 'owner_user_id', 'invitee_user_id', 'inviter_user_id',
  'target_user_id', 'admin_id', 'used_by'
]);
const ACCOUNT_IDENTIFIER_TABLES = new Set([
  'registration_email_codes', 'password_reset_codes'
]);

function quoteIdentifier(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function parseArgs(argv) {
  const options = { db: '', userIds: [], apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') options.db = String(argv[++i] || '');
    else if (arg === '--user') options.userIds.push(String(argv[++i] || '').trim());
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('不支持的参数：' + arg);
  }
  options.userIds = [...new Set(options.userIds.filter(Boolean))];
  return options;
}

function usage() {
  return [
    '用法：node scripts/purge-test-accounts.js --db /absolute/path/broadcast.db --user USER_ID [--user USER_ID] [--apply]',
    '默认仅输出删除计划；加 --apply 才会在一个 SQLite 事务内执行。'
  ].join('\n');
}

function listTableColumns(db, table) {
  return db.prepare('PRAGMA table_info(' + quoteIdentifier(table) + ')').all()
    .map(row => String(row.name));
}

function loadTargetAccounts(db, userIds) {
  const userColumns = new Set(listTableColumns(db, 'users'));
  if (!userColumns.has('id')) throw new Error('数据库缺少 users.id，已拒绝执行');
  const selected = ['id', 'username', 'registration_email', 'contact_type', 'contact_value']
    .filter(column => userColumns.has(column));
  const rows = db.prepare('SELECT ' + selected.map(quoteIdentifier).join(',') + ' FROM users WHERE id IN (' + placeholders(userIds) + ')')
    .all(...userIds);
  const found = new Set(rows.map(row => String(row.id)));
  const missing = userIds.filter(userId => !found.has(userId));
  if (missing.length) throw new Error('以下账号不存在，已拒绝执行：' + missing.join(','));

  const emails = new Set();
  const usernames = new Set();
  for (const row of rows) {
    if (row.username) usernames.add(String(row.username).trim().toLowerCase());
    if (row.registration_email) emails.add(String(row.registration_email).trim().toLowerCase());
    if (row.contact_type === 'email' && row.contact_value) emails.add(String(row.contact_value).trim().toLowerCase());
  }
  return { rows, emails: [...emails].filter(Boolean), usernames: [...usernames].filter(Boolean) };
}

function ownedClassIds(db, userIds) {
  const columns = new Set(listTableColumns(db, 'classes'));
  if (!columns.has('id') || !columns.has('user_id')) return [];
  return db.prepare('SELECT id FROM classes WHERE user_id IN (' + placeholders(userIds) + ')').all(...userIds)
    .map(row => String(row.id)).filter(Boolean);
}

function deletionPredicate(table, columns, userIds, emails, usernames, classIds) {
  const terms = [];
  const params = [];
  if (table === 'users' && columns.includes('id')) {
    terms.push(quoteIdentifier('id') + ' IN (' + placeholders(userIds) + ')');
    params.push(...userIds);
  }
  for (const column of columns) {
    if (!USER_REFERENCE_COLUMNS.has(column)) continue;
    terms.push(quoteIdentifier(column) + ' IN (' + placeholders(userIds) + ')');
    params.push(...userIds);
  }
  if (classIds.length && columns.includes('class_id')) {
    terms.push(quoteIdentifier('class_id') + ' IN (' + placeholders(classIds) + ')');
    params.push(...classIds);
  }
  if (ACCOUNT_IDENTIFIER_TABLES.has(table) && emails.length && columns.includes('email')) {
    terms.push('lower(' + quoteIdentifier('email') + ') IN (' + placeholders(emails) + ')');
    params.push(...emails);
  }
  if (ACCOUNT_IDENTIFIER_TABLES.has(table) && usernames.length && columns.includes('username')) {
    terms.push('lower(' + quoteIdentifier('username') + ') IN (' + placeholders(usernames) + ')');
    params.push(...usernames);
  }
  return terms.length ? { where: terms.join(' OR '), params } : null;
}

function buildPlan(db, userIds) {
  const accounts = loadTargetAccounts(db, userIds);
  const classIds = ownedClassIds(db, userIds);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => String(row.name)).sort((a, b) => (a === 'users') - (b === 'users'));
  const plan = [];
  for (const table of tables) {
    const predicate = deletionPredicate(table, listTableColumns(db, table), userIds, accounts.emails, accounts.usernames, classIds);
    if (!predicate) continue;
    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + quoteIdentifier(table) + ' WHERE ' + predicate.where).get(...predicate.params).n) || 0;
    if (count) plan.push({ table, ...predicate, count });
  }
  return { accounts, classIds, plan };
}

function executePlan(db, plan) {
  return db.transaction(() => plan.map(item => {
    const result = db.prepare('DELETE FROM ' + quoteIdentifier(item.table) + ' WHERE ' + item.where).run(...item.params);
    if (result.changes !== item.count) throw new Error(item.table + ' 删除行数变化，事务已回滚');
    return { table: item.table, deleted: result.changes };
  }))();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (!options.db || !path.isAbsolute(options.db)) throw new Error('--db 必须是绝对路径');
  if (!options.userIds.length) throw new Error('至少提供一个 --user');
  if (!fs.existsSync(options.db)) throw new Error('数据库不存在：' + options.db);

  const db = new Database(options.db);
  try {
    const { accounts, classIds, plan } = buildPlan(db, options.userIds);
    const deleted = options.apply ? executePlan(db, plan) : plan.map(item => ({ table: item.table, planned: item.count }));
    process.stdout.write(JSON.stringify({
      mode: options.apply ? 'applied' : 'dry-run',
      database: options.db,
      target_user_ids: options.userIds,
      matched_accounts: accounts.rows.length,
      owned_class_ids: classIds.length,
      total_rows: plan.reduce((total, item) => total + item.count, 0),
      results: deleted
    }) + '\n');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write('清理未执行：' + (error && error.message || String(error)) + '\n');
  process.exitCode = 1;
}
