#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getMailTransporter, mailConfigured } = require('../mail-center');
const { MAIL_FROM } = require('../platform-config');
const {
  isTeachersDay2026,
  previewTeacherDayEmails,
  sendTeacherDayEmails,
} = require('../teacher-day-email-campaign');

function parseArgs(argv) {
  const options = { db: '', apply: false, retryFailed: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') options.db = String(argv[++index] || '');
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--retry-failed') options.retryFailed = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('不支持的参数：' + arg);
  }
  return options;
}

function usage() {
  return [
    '用法：node scripts/send-teachers-day-2026-email.js --db /absolute/path/broadcast.db [--apply] [--retry-failed]',
    '默认只统计活动受众；仅在上海时间 2026-09-10 加 --apply 才实际发送。发送账本不保存明文邮箱，已成功或发送中的地址不会重复投递。',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (!options.db || !path.isAbsolute(options.db)) throw new Error('--db 必须是绝对路径');
  if (!fs.existsSync(options.db)) throw new Error('数据库不存在：' + options.db);
  if (options.apply && !isTeachersDay2026()) throw new Error('仅可在上海时间 2026-09-10 发送教师节祝福邮件');
  if (options.apply && !mailConfigured()) throw new Error('SMTP 未配置，未发送邮件');

  const db = new Database(options.db);
  try {
    const result = options.apply
      ? await sendTeacherDayEmails(db, { from: MAIL_FROM, mailer: getMailTransporter(), retryFailed: options.retryFailed })
      : previewTeacherDayEmails(db);
    process.stdout.write(JSON.stringify({ ok: true, mode: options.apply ? 'applied' : 'dry-run', ...result }) + '\n');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write('教师节邮件未发送：' + (error?.message || String(error)) + '\n');
  process.exitCode = 1;
});
