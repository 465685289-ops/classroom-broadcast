const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'teacher.html'), 'utf8');

function inlineScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
}

test('class timetable editor renders five weekdays and twelve mobile-scrollable rows', () => {
  assert.match(page, /id="timetableClassSelect"/);
  assert.match(page, /class="timetable-scroll"/);
  assert.match(page, /id="classTimetableEditor"/);

  const start = page.indexOf('var CLASS_TIMETABLE_DAYS');
  const end = page.indexOf('function loadClassTimetable', start);
  assert.ok(start >= 0 && end > start, '缺少课表编辑器构建函数');
  const context = {
    result: '',
    esc(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  };
  vm.runInNewContext(page.slice(start, end) + `
    result = buildTimetableEditorHtml({ entries: {
      mon: ['语文', '<script>', '" onfocus="alert(1)'],
      fri: ['', '班会']
    }}, false);
  `, context);

  assert.match(context.result, /周一/);
  assert.match(context.result, /周五/);
  assert.equal((context.result.match(/<tr/g) || []).length, 13);
  assert.equal((context.result.match(/data-day="mon"/g) || []).length, 12);
  assert.equal((context.result.match(/data-day="fri"/g) || []).length, 12);
  assert.match(context.result, /&lt;script&gt;/);
  assert.match(context.result, /&quot; onfocus=&quot;alert\(1\)/);
  assert.match(context.result, /readonly/);
});

test('timetable uses the class API and keeps collaborator editing server-enforced', () => {
  assert.match(page, /fetch\(API \+ '\/api\/classes\/' \+ classId \+ '\/timetable'/);
  assert.match(page, /method:\s*'PUT'/);
  assert.match(page, /只有班级创建者可以维护课程表/);
  assert.match(page, /function\s+saveClassTimetable\s*\(/);
  assert.match(page, /function\s+clearClassTimetable\s*\(/);
  assert.match(page, /if\s*\(!currentTimetableOwner\)\s*return/);
});

test('teacher page keeps syntactically valid inline JavaScript after timetable controls', () => {
  inlineScripts(page).forEach((source, index) => {
    new vm.Script(source, { filename: `public/teacher.html#inline-${index}` });
  });
});
