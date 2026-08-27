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
  assert.match(screenHtml, />加扣分</);
  assert.match(screenHtml, />积分榜</);
  assert.match(screenHtml, />流水记录</);
  assert.match(screenHtml, /id="pointsScoreMode"/);
  assert.match(screenHtml, /id="pointsRankMode"/);
  assert.match(screenHtml, /id="pointsLedgerMode"/);
  assert.match(screenHtml, /id="pointsLedgerStudentFilter"/);
  assert.match(screenHtml, /id="pointsLedgerDirectionFilter"/);

  const idle = screenHtml.match(/<div class="screen-idle" id="screenIdle">([\s\S]*?)<div class="points-mode"/);
  assert.ok(idle, 'idle section should end before points modes');
  assert.doesNotMatch(idle[1], /pointsSeatGrid|student_name|学生积分/);
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
