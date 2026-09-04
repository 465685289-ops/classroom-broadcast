const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'screen.html'), 'utf8');

test('classroom idle screen has a weekly timetable beside the bulletin board', () => {
  assert.match(page, /id="idleRight"/);
  assert.match(page, /id="classTimetableBoard"/);
  assert.match(page, /id="screenTimetableGrid"/);
  assert.match(page, /class="idle-right"/);
});

test('weekly timetable renders 12 school periods, highlights only today, and escapes course names', () => {
  const source = page.match(/var SCREEN_TIMETABLE_DAYS[\s\S]*?(?=function\s+renderClassTimetable)/);
  assert.ok(source, '缺少教室端课表渲染函数');

  const context = {};
  vm.runInNewContext(`${source[0]};
    monday = buildScreenTimetableHtml({ entries: { mon: ['语文', '<script>'], fri: ['班会'] } }, 1);
    saturday = buildScreenTimetableHtml({ entries: { mon: ['语文'] } }, 6);
    empty = buildScreenTimetableHtml({}, 1);`, context);

  assert.equal(context.monday.hasEntries, true);
  assert.equal((context.monday.html.match(/<tr/g) || []).length, 13, '应为表头加 12 个时段');
  assert.equal((context.monday.html.match(/class="today"/g) || []).length, 13, '当天表头和 12 个格子都应高亮');
  assert.match(context.monday.html, /周一/);
  assert.match(context.monday.html, /周五/);
  assert.match(context.monday.html, /今天/);
  assert.match(context.monday.html, /&lt;script&gt;/);
  assert.doesNotMatch(context.monday.html, /<script>/);
  // 2026-09 规格：周末也算教学日，周六上课时当日列正常高亮
  assert.equal((context.saturday.html.match(/class="today"/g) || []).length, 13, '周六教学日应全列高亮');
  assert.match(context.saturday.html, /周六<span class="today-chip">今天<\/span>/);
  assert.equal(context.empty.hasEntries, false);
});

test('weekly timetable loads after binding and follows live teacher updates', () => {
  assert.match(page, /socket\.on\('bind-success',[\s\S]*?renderClassTimetable\(cls\.timetable\)/);
  assert.match(page, /socket\.on\('class-timetable-update',[\s\S]*?renderClassTimetable\(timetable\)/);
});
