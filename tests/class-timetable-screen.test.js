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

test('weekly timetable renders only teacher-confirmed periods, highlights today, and escapes course names', () => {
  const source = page.match(/var SCREEN_TIMETABLE_DAYS[\s\S]*?(?=function\s+renderClassTimetable)/);
  assert.ok(source, '缺少教室端课表渲染函数');

  const context = {};
  vm.runInNewContext(`${source[0]};
    monday = buildScreenTimetableHtml({ structure: { configured: true, morning_reading: false, regular_count: 6, evening_study_count: 0 }, entries: { mon: ['晨读', '<script>', '数学'], fri: ['', '班会'] } }, 1);
    highSchool = buildScreenTimetableHtml({ structure: { configured: true, morning_reading: true, regular_count: 8, evening_study_count: 3 }, entries: { mon: ['语文'] } }, 1);
    nineAndFour = buildScreenTimetableHtml({ structure: { configured: true, morning_reading: true, regular_count: 9, evening_study_count: 4 }, entries: { mon: ['', '', '', '', '', '', '', '', '', '晚自习1', '', '', '第9节课程', '晚自习4'] } }, 1);
    unconfigured = buildScreenTimetableHtml({ structure: { configured: false, morning_reading: true, regular_count: 8, evening_study_count: 3 }, entries: { mon: ['不应展示'] } }, 1);
    saturday = buildScreenTimetableHtml({ entries: { mon: ['语文'] } }, 6);
    empty = buildScreenTimetableHtml({}, 1);`, context);

  assert.equal(context.monday.hasEntries, true);
  assert.equal((context.monday.html.match(/<tr/g) || []).length, 7, '小学应为表头加 6 节正课');
  assert.equal((context.monday.html.match(/class="today"/g) || []).length, 7, '当天表头和 6 个格子都应高亮');
  assert.doesNotMatch(context.monday.html, /早读|晚自习|第7节/);
  assert.equal((context.highSchool.html.match(/<tr/g) || []).length, 13, '中学完整结构仍为 12 个时段');
  assert.equal((context.nineAndFour.html.match(/<tr/g) || []).length, 15, '9 节正课和 4 节晚自习应展示 14 个时段');
  assert.match(context.nineAndFour.html, /第9节/);
  assert.match(context.nineAndFour.html, /晚自习4/);
  assert.match(context.nineAndFour.html, /第9节课程/);
  assert.equal(context.unconfigured.hasEntries, false, '新班级未确认节次时不应展示课程表');
  assert.match(context.monday.html, /周一/);
  assert.match(context.monday.html, /周五/);
  assert.match(context.monday.html, /今天/);
  assert.match(context.monday.html, /&lt;script&gt;/);
  assert.doesNotMatch(context.monday.html, /<script>/);
  // 2026-09 规格：周末也算教学日，周六上课时当日列正常高亮
  assert.equal((context.saturday.html.match(/class="today"/g) || []).length, 13, '未带结构的存量课表继续兼容 12 节');
  assert.match(context.saturday.html, /周六<span class="today-chip">今天<\/span>/);
  assert.equal(context.empty.hasEntries, false);
});

test('weekly timetable loads after binding and follows live teacher updates', () => {
  assert.match(page, /socket\.on\('bind-success',[\s\S]*?renderClassTimetable\(cls\.timetable\)/);
  assert.match(page, /socket\.on\('class-timetable-update',[\s\S]*?renderClassTimetable\(timetable\)/);
});

test('teacher visibility toggle hides the timetable board on the classroom screen', () => {
  const helpers = page.match(/var SCREEN_TIMETABLE_DAYS[\s\S]*?(?=function\s+renderClassTimetable)/);
  const render = page.match(/function\s+renderClassTimetable\s*\([\s\S]*?\n\}/);
  assert.ok(helpers && render, '缺少教室端课表渲染函数');

  const elements = {};
  function element(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        hidden: false,
        innerHTML: '',
        classList: {
          classes: new Set(),
          add(name) { this.classes.add(name); },
          remove(name) { this.classes.delete(name); },
          contains(name) { return this.classes.has(name); },
        },
      };
    }
    return elements[id];
  }
  const context = { document: { getElementById: element } };
  vm.runInNewContext(`${helpers[0]}${render[0]};
    show = renderClassTimetable({ entries: { mon: ['语文'] }, visible: true }, 1);
    hide = renderClassTimetable({ entries: { mon: ['语文'] }, visible: false }, 1);`, context);

  assert.equal(elements.classTimetableBoard.hidden, true, '教师关闭后大屏不展示课表');
  assert.equal(elements.screenTimetableGrid.innerHTML, '');
  assert.equal(elements.idleRight.classList.contains('has-timetable'), false);

  context.document.getElementById = element;
  vm.runInNewContext('renderClassTimetable({ entries: { mon: ["语文"] }, visible: true }, 1)', context);
  assert.equal(elements.classTimetableBoard.hidden, false, '重新开启后课表恢复展示');
  assert.match(elements.screenTimetableGrid.innerHTML, /语文/);
  assert.equal(elements.idleRight.classList.contains('has-timetable'), true);
});
