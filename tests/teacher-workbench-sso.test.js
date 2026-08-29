const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const teacherPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'teacher.html'), 'utf8');

test('teacher page exchanges the active workbench session instead of falling back to its own login', () => {
  assert.match(teacherPage, /sessionStorage\.getItem\(['"]sgp_token['"]\)/);
  assert.match(
    teacherPage,
    /fetch\(API \+ '\/api\/sso\/from-workbench',[\s\S]*?Authorization:\s*'Bearer '\s*\+\s*workbenchToken/,
  );
  assert.doesNotMatch(
    teacherPage,
    /fetch\(API \+ '\/api\/sso\/from-workbench',\s*\{\s*method:\s*'POST',\s*headers:\s*\{\s*'Content-Type':\s*'application\/json'\s*\}\s*\}\)/,
  );
});
