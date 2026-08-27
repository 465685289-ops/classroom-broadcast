const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'comment.html'), 'utf8');

test('keeps roster student ids as strings after a server reload', () => {
  assert.match(page, /id:\s*String\(row && row\.id \|\| \(Date\.now\(\) \+ idx \+ Math\.random\(\)\)\)/);
  assert.match(page, /id:\s*String\(Date\.now\(\) \+ idx\)/);
  assert.match(page, /function studentIdArg\(id\)\s*{\s*return escAttr\(JSON\.stringify\(String\(id\)\)\);\s*}/);
});

test('passes string ids through every student-card action', () => {
  const studentActions = [
    'removeStudentTag',
    'rewriteComment',
    'removeStudent',
    'updateStudent',
    'updateStudentDraft',
    'openTagModal',
    'copyComment',
    'generateOne'
  ];

  for (const action of studentActions) {
    assert.match(
      page,
      new RegExp(action + "\\(' \\+ studentIdArg\\(s\\.id\\)"),
      action + ' should receive the canonical string student id'
    );
  }

  const modalTagHandlers = page.match(/toggleTag\(' \+ studentIdArg\(activeTagStudentId\)/g) || [];
  assert.equal(modalTagHandlers.length, 2, 'both tag lists should pass the active string student id');
});
