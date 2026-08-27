#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const configFile = process.argv[2] || path.join(__dirname, '..', 'comment-config.json');
const targetModel = 'deepseek-v4-flash';

function atomicWritePreserving(file, content) {
  const stat = fs.statSync(file);
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, content, { mode: stat.mode & 0o777 });
  fs.chownSync(temp, stat.uid, stat.gid);
  fs.renameSync(temp, file);
}

const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const previous = String(config.deepseek_model || '');
config.deepseek_model = targetModel;

atomicWritePreserving(configFile, JSON.stringify(config, null, 2) + '\n');

const appDir = path.dirname(configFile);
const referenceFiles = [path.join(appDir, 'public', 'foucault', 'index.html')];
let referencesUpdated = 0;
referenceFiles.forEach(file => {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(
    '<option value="deepseek-chat">DeepSeek V3</option>',
    '<option value="deepseek-v4-flash">DeepSeek V4 Flash</option>'
  );
  if (after !== before) {
    atomicWritePreserving(file, after);
    referencesUpdated++;
  }
});

console.log(JSON.stringify({
  ok: true,
  changed: previous !== targetModel,
  model: targetModel,
  references_updated: referencesUpdated
}));
