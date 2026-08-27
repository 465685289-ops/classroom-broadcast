#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..');
const dataFile = process.argv[2];
const outputFile = process.argv[3];
if (!dataFile || !outputFile) {
  console.error('用法：node scripts/render-edulab-function-page.js <data.json> <output.html>');
  process.exit(2);
}

const templateFile = process.env.EDULAB_FUNCTION_TEMPLATE || path.join(appDir, 'templates', 'edulab', 'func.html');
const template = fs.readFileSync(templateFile, 'utf8');
if (!template.includes('__LESSON_DATA__')) throw new Error('函数模板缺少数据占位符');

const data = JSON.parse(fs.readFileSync(path.resolve(dataFile), 'utf8'));
const json = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
const output = template.replace('__LESSON_DATA__', () => json);
const destination = path.resolve(outputFile);
const temp = destination + '.tmp-' + process.pid;
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(temp, output);
fs.renameSync(temp, destination);
console.log(JSON.stringify({ ok: true, output: destination }));
