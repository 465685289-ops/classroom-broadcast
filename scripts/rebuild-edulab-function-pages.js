#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..');
const templateFile = process.env.EDULAB_FUNCTION_TEMPLATE || path.join(appDir, 'templates', 'edulab', 'func.html');
const publicDir = process.env.EDULAB_PUBLIC_DIR || path.join(appDir, 'public', 'edulab');
const onlyFile = process.argv[2] ? path.basename(process.argv[2]) : '';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = process.env.EDULAB_REBUILD_BACKUP_DIR || path.join(appDir, 'backups', 'edulab-function-layout-' + stamp);
const template = fs.readFileSync(templateFile, 'utf8');

if (!template.includes('__LESSON_DATA__')) throw new Error('函数模板缺少数据占位符');

const files = onlyFile
  ? [onlyFile]
  : fs.readdirSync(publicDir).filter(name => /^function_.*\.html$/i.test(name)).sort();

let rebuilt = 0;
let skipped = 0;
for (const name of files) {
  const file = path.join(publicDir, name);
  if (!fs.existsSync(file)) { skipped++; continue; }
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/<script id="lesson-data" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) { skipped++; continue; }
  let data;
  try { data = JSON.parse(match[1]); } catch (e) { skipped++; continue; }
  const json = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
  const output = template.replace('__LESSON_DATA__', () => json);
  const stat = fs.statSync(file);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(file, path.join(backupDir, name));
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, output, { mode: stat.mode & 0o777 });
  try { fs.chownSync(temp, stat.uid, stat.gid); } catch (e) {}
  fs.renameSync(temp, file);
  rebuilt++;
}

console.log(JSON.stringify({ ok: true, rebuilt, skipped, backup_dir: backupDir }));
