const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const screenHtml = fs.readFileSync(path.join(ROOT, 'public', 'screen.html'), 'utf8');

test('screen loads the optional points assets and keeps student data out of the idle page', () => {
  assert.match(screenHtml, /classroom-points-screen\.css/);
  assert.match(screenHtml, /classroom-points-queue\.js/);
  assert.match(screenHtml, /classroom-points-screen\.js/);
  assert.match(screenHtml, /id="pointsIdleActions"[^>]*hidden/);
  assert.match(screenHtml, /id="pointsScoreMode"/);
  assert.match(screenHtml, /id="pointsRankMode"/);
  assert.match(screenHtml, /id="pointsLedgerMode"/);
  assert.match(screenHtml, /id="pointsLedgerStudentFilter"/);
  assert.match(screenHtml, /id="pointsLedgerDirectionFilter"/);

  const idle = screenHtml.match(/<div class="screen-idle" id="screenIdle">([\s\S]*?)<div class="points-mode"/);
  assert.ok(idle, 'idle section should end before points modes');
  assert.doesNotMatch(idle[1], /pointsSeatGrid|student_name|学生积分/);
  assert.match(screenHtml, />座位积分</);
  assert.doesNotMatch(idle[1], />积分榜</);
  assert.doesNotMatch(idle[1], />流水记录</);
});

test('screen seat model follows teacher dimensions and leaves unassigned students outside the grid', () => {
  const { buildSeatGridModel } = require('../public/classroom-points-screen');
  assert.deepEqual(buildSeatGridModel([
    { id: 'a', seat_row: 1, seat_col: 2 },
    { id: 'b', seat_row: null, seat_col: null },
    { id: 'outside', seat_row: 3, seat_col: 1 }
  ], 2, 2), {
    cells: [null, 'a', null, null],
    unseated: ['b', 'outside']
  });
});

test('idle page keeps the points entry beside the top-right controls and bulletin list remains scrollable', () => {
  assert.match(screenHtml, /<div class="right-btns">[\s\S]*?id="pointsIdleActions"[\s\S]*?<\/div>/);
  assert.match(screenHtml, /\.bulletin-list\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(screenHtml, /\.bulletin-list::-webkit-scrollbar-thumb/);
});

test('idle page puts the timetable left of the bulletin board when both are visible', () => {
  assert.match(screenHtml, /\.idle-right\.has-timetable\s*\{\s*flex-direction:\s*row;/);
  assert.match(screenHtml, /\.timetable-board\s*\{\s*flex:\s*2\s+1\s+68%/);
  assert.match(screenHtml, /@media\(max-width:640px\)\{[\s\S]*?\.idle-right\.has-timetable\s*\{\s*flex-direction:\s*column;/);
});

test('seat selection puts current-cycle higher scorers first and keeps no-score students available', () => {
  const { rankSeatSelectionStudents } = require('../public/classroom-points-screen');
  assert.deepEqual(rankSeatSelectionStudents([
    { id: 'no-score', name: '周敏' },
    { id: 'second', name: '王华' },
    { id: 'first', name: '李明' },
  ], [
    { student_id: 'first', score: 18 },
    { student_id: 'second', score: 8 },
  ]).map((student) => student.id), ['first', 'second', 'no-score']);
});

test('screen selection exposes pointer-drag plus tap-to-place fallback controls', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'classroom-points-screen.js'), 'utf8');
  assert.match(screenHtml, /开启积分榜选座/);
  assert.match(source, /pointerdown/);
  assert.match(source, /data-seat-row/);
  assert.match(source, /seat-selection\/seats/);
  assert.match(source, /seat-selection\/start/);
});

test('mode controller restores the interrupted mode and restarts a 60 second timer', () => {
  const { createModeController, IDLE_TIMEOUT_MS } = require('../public/classroom-points-screen');
  assert.equal(IDLE_TIMEOUT_MS, 60000);
  let nextTimer = null;
  const modes = [];
  const controller = createModeController({
    timeoutMs: IDLE_TIMEOUT_MS,
    setTimer(callback) { nextTimer = callback; return 1; },
    clearTimer() { nextTimer = null; },
    onMode(mode) { modes.push(mode); }
  });

  controller.enter('score');
  assert.equal(controller.mode(), 'score');
  assert.equal(typeof nextTimer, 'function');
  controller.suspendForBroadcast();
  assert.equal(nextTimer, null);
  controller.resumeAfterBroadcast();
  assert.equal(controller.mode(), 'score');
  assert.equal(typeof nextTimer, 'function');
  nextTimer();
  assert.equal(controller.mode(), 'idle');
  assert.deepEqual(modes, ['score', 'idle']);
});

test('screen controller exposes binding, socket and broadcast lifecycle hooks', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'classroom-points-screen.js'), 'utf8');
  assert.match(source, /onBound/);
  assert.match(source, /onUnbound/);
  assert.match(source, /suspendForBroadcast/);
  assert.match(source, /resumeAfterBroadcast/);
  assert.match(source, /handleSocketEvent/);
  assert.match(source, /setLedgerFilter/);
  assert.match(screenHtml, /ClassroomPointsScreen\.onBound/);
  assert.match(screenHtml, /ClassroomPointsScreen\.suspendForBroadcast/);
  assert.match(screenHtml, /ClassroomPointsScreen\.resumeAfterBroadcast/);
  new Function(source);
});

test('broadcast preempts and stops any active score sound immediately', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'classroom-points-screen.js'), 'utf8');
  assert.match(source, /function stopScoreSound\(\)/);
  assert.match(source, /function suspendForBroadcast\(\)\s*\{\s*stopScoreSound\(\);/);
  assert.match(source, /suspendForBroadcast:\s*suspendForBroadcast/);
});

test('score modal opens on a single student tap with quick rules, custom delta and cycle scope', () => {
  const controller = require('../public/classroom-points-screen');
  for (const fn of ['openScoreModal', 'closeScoreModal', 'applyRuleForModalStudent', 'applyCustomForModalStudent']) {
    assert.equal(typeof controller[fn], 'function', '缺少 ' + fn);
  }

  assert.match(screenHtml, /id="pointsScoreModal"[^>]*hidden/);
  assert.match(screenHtml, /id="pointsModalName"/);
  assert.match(screenHtml, /id="pointsModalScore"/);
  assert.match(screenHtml, /id="pointsModalRules"/);
  assert.match(screenHtml, /id="pointsModalCustomDelta"/);
  assert.match(screenHtml, /id="pointsModalCustomReason"/);
  assert.match(screenHtml, /ClassroomPointsScreen\.applyCustomForModalStudent\(\)/);
  assert.match(screenHtml, /if\(event\.target===this\)ClassroomPointsScreen\.closeScoreModal\(\)/);
  assert.match(screenHtml, /class-score-period-settled/);
  assert.match(screenHtml, /data-points-scope="term"[^>]*>本周期</, '排行榜默认口径=本周期');
  assert.doesNotMatch(screenHtml, /data-points-scope="term"[^>]*>本学期</);

  const source = fs.readFileSync(path.join(ROOT, 'public', 'classroom-points-screen.js'), 'utf8');
  assert.match(source, /custom_delta/, '自定义分值应随入队载荷提交');
  assert.match(source, /custom_reason/);
  assert.doesNotMatch(source, /if \(!batchMode\) batchMode = false;/, '旧的批量分支残留应清理');
});
