#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  grantTeacherDayMemberships,
  isTeachersDay2026,
  previewTeacherDayMemberships,
  shanghaiDayKey,
} = require('../teacher-day-campaign');

function parseArgs(argv) {
  const options = { db: '', apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') options.db = String(argv[++index] || '');
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('不支持的参数：' + arg);
  }
  return options;
}

function usage() {
  return [
    '用法：node scripts/grant-teachers-day-2026.js --db /absolute/path/broadcast.db [--apply]',
    '默认只输出活动受众与预计变更；仅在上海时间 2026-09-10 加 --apply 才会在一个 SQLite 事务内发放。',
  ].join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (!options.db || !path.isAbsolute(options.db)) throw new Error('--db 必须是绝对路径');
  if (!fs.existsSync(options.db)) throw new Error('数据库不存在：' + options.db);
  if (options.apply && !isTeachersDay2026()) throw new Error('仅可在上海时间 2026-09-10 执行教师节发放');

  const db = new Database(options.db);
  try {
    const result = options.apply
      ? grantTeacherDayMemberships(db)
      : previewTeacherDayMemberships(db);
    process.stdout.write(JSON.stringify({
      ok: true,
      mode: options.apply ? 'applied' : 'dry-run',
      shanghai_date: shanghaiDayKey(),
      database: options.db,
      ...result,
    }) + '\n');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write('教师节发放未执行：' + (error && error.message || String(error)) + '\n');
  process.exitCode = 1;
}
