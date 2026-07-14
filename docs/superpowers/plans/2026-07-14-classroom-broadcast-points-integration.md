# 教室广播与班级积分一体化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有教室广播升级为按班级可选开启的统一班级大屏，让教室端和教师端共享学生、座位、积分规则、排行榜与不可变流水，同时保持仅广播班级完全不受影响。

**Architecture:** 在现有 `classes` 与 Socket.IO 班级房间之上增加独立的班级积分领域模型和 SQLite 表，教师端继续使用账号令牌，教室端绑定后换取班级范围的屏幕会话令牌。大屏以日常、积分登记、排行榜、流水四种模式运行，广播覆盖层保存并恢复原模式；教室端积分写入本地幂等队列，网络恢复后补传。

**Tech Stack:** Node.js、Express、Socket.IO、better-sqlite3、原生 HTML/CSS/JavaScript、Node test runner。

## Global Constraints

- 新班级和现有班级默认均为“仅广播”，未开启班级管理时完全隐藏积分入口。
- 班级管理按班级启用，不依据教师账号是否为班主任。
- 教室端不登录、不选择登记人、不输入操作码；流水只向用户显示“教室端登记”或“教师端登记”。
- 日常大屏不常驻展示座位表、学生姓名、具体积分或排行榜。
- 积分、排行榜和流水页面连续 60 秒无操作后返回日常页；有效操作重置计时。
- 广播具有最高显示与音频优先级，结束后恢复原模式并重置 60 秒计时。
- 积分反馈默认静音，只提供班级级别提示音开关。
- 每笔流水不可变；撤销通过一条反向流水完成，不删除或改写原记录。
- 离线记录必须可恢复、可补传，并通过 `client_operation_id` 防止重复计分。
- 班级积分包含在广播订阅中，不按登记次数消耗师行积分。
- 当前工作树含有其他未提交改动；每次提交只暂存本任务明确列出的文件。

---

### Task 1: 班级积分领域模型与 SQLite 持久化

**Files:**
- Create: `classroom-points.js`
- Create: `tests/classroom-points-store.test.js`
- Modify: `db.js:98-651`
- Modify: `db.js:3255-end`

**Interfaces:**
- Produces pure helpers: `normalizeStudentInput(input)`、`normalizeRuleInput(input)`、`buildScoreEntries(input)`、`buildReversalEntry(input)`、`scoreScopeBounds(scope, now, period)`。
- Produces store functions: `setClassManagement(classId, patch)`、`getClassManagement(classId)`、`createClassStudent(input)`、`listClassStudents(classId, options)`、`updateClassStudent(classId, studentId, patch)`、`saveClassScoreRule(input)`、`listClassScoreRules(classId, options)`、`ensureCurrentClassScorePeriod(classId, now)`、`appendClassScoreEntries(entries)`、`reverseClassScoreEntry(input)`、`listClassScoreLedger(filters)`、`getClassScoreLeaderboard(filters)`。
- Later tasks consume stable student IDs, immutable ledger rows and idempotent append results.

- [ ] **Step 1: Write failing domain and store tests**

Create `tests/classroom-points-store.test.js` with an isolated SQLite database. Cover default-disabled management, stable students and seats, rule snapshots, idempotent append, one-time reversal and scope aggregation:

```js
test('score entries are idempotent and reversal keeps an auditable pair', () => {
  const first = dbStore.appendClassScoreEntries([{
    id: 'entry-1', client_operation_id: 'screen-op-1', class_id: 'class-1',
    student_id: student.id, period_id: period.id, rule_id: rule.id,
    rule_name_snapshot: '课堂发言', delta: 2, source: 'screen',
    client_created_at: NOW, created_at: NOW
  }]);
  const duplicate = dbStore.appendClassScoreEntries([{ ...first[0] }]);
  assert.equal(first[0].id, duplicate[0].id);
  const reversed = dbStore.reverseClassScoreEntry({
    class_id: 'class-1', entry_id: first[0].id,
    client_operation_id: 'teacher-reverse-1', source: 'teacher', created_at: NOW
  });
  assert.equal(reversed.delta, -2);
  assert.equal(reversed.reversal_of_id, first[0].id);
  assert.throws(() => dbStore.reverseClassScoreEntry({
    class_id: 'class-1', entry_id: first[0].id,
    client_operation_id: 'teacher-reverse-2', source: 'teacher', created_at: NOW
  }), /已经撤销/);
});
```

- [ ] **Step 2: Run the store test and verify RED**

Run: `node --test tests/classroom-points-store.test.js`

Expected: FAIL because `classroom-points.js`, the new tables and store exports do not exist.

- [ ] **Step 3: Implement the pure domain helpers**

Create `classroom-points.js` with bounded names, integer deltas, stable source values, rule snapshot construction, batch IDs and date bounds. Reject zero deltas, unknown sources, empty student lists and reversals of reversal entries.

```js
function normalizeRuleInput(input) {
  const name = String(input && input.name || '').trim().slice(0, 30);
  const delta = Number(input && input.delta);
  if (!name) throw new Error('请输入积分规则名称');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) {
    throw new Error('积分分值必须是 -100 到 100 之间的非零整数');
  }
  return { name, delta, active: input.active === false ? 0 : 1 };
}
```

- [ ] **Step 4: Add safe schema migrations and store functions**

Extend `classes` with `management_enabled INTEGER DEFAULT 0`, `points_sound_enabled INTEGER DEFAULT 0` and `archived_at TEXT`. Create `class_students`, `class_score_rules`, `class_score_periods` and `class_score_ledger` exactly as named in the approved design. Add unique indexes for `client_operation_id` and `reversal_of_id`, plus class/period/student/date indexes. Implement writes with `better-sqlite3` transactions and return the existing row when a client operation is retried.

- [ ] **Step 5: Run the store test and full database-adjacent tests**

Run: `node --test tests/classroom-points-store.test.js tests/registration-email-codes.test.js tests/shixing-points.test.js tests/essay-teaching-workflow.test.js`

Expected: PASS with no SQLite migration or export regressions.

- [ ] **Step 6: Commit the persistence slice**

```bash
git add classroom-points.js db.js tests/classroom-points-store.test.js
git commit -m "feat: add classroom points ledger storage"
```

### Task 2: 教师与教室端 API、鉴权和实时事件

**Files:**
- Create: `tests/classroom-points-api.test.js`
- Modify: `server.js:286-350`
- Modify: `server.js:4167-4405`
- Modify: `server.js:5009-5075`

**Interfaces:**
- Produces teacher APIs under `/api/classes/:classId/management`, `/students`, `/score-rules`, `/score-periods`, `/points/entries`, `/points/ledger` and `/points/leaderboard`.
- Produces screen APIs: `POST /api/screen/session`, `GET /api/screen/classroom-state`, `POST /api/screen/points/entries`, `POST /api/screen/points/entries/:entryId/reverse`.
- Produces Socket.IO events: `class-management-update`, `class-roster-update`, `class-score-rules-update`, `class-score-entry` and `class-score-reversal`.

- [ ] **Step 1: Write failing HTTP integration tests**

Start `server.js` against a temporary SQLite file, create an active-plan teacher and class, then assert:

```js
test('management is opt-in per class and screen writes share the teacher ledger', async () => {
  const initial = await request('/api/classes/' + CLASS_ID + '/management');
  assert.equal(initial.body.management.enabled, false);
  await request('/api/classes/' + CLASS_ID + '/management', {
    method: 'PUT', body: { enabled: true, sound_enabled: false }
  });
  const session = await publicRequest('/api/screen/session', {
    method: 'POST', body: { bind_code: BIND_CODE }
  });
  const scored = await screenRequest(session.body.screen_token, '/api/screen/points/entries', {
    method: 'POST', body: {
      client_operation_id: 'screen-api-op-1', student_ids: [STUDENT_ID], rule_id: RULE_ID
    }
  });
  assert.equal(scored.body.entries[0].source_label, '教室端登记');
  const ledger = await request('/api/classes/' + CLASS_ID + '/points/ledger');
  assert.equal(ledger.body.items[0].source_label, '教室端登记');
});
```

Also test owner-only module toggling, collaborator access, inactive subscriptions, unknown screen tokens, duplicate client operations, batch scoring and one-time reversal.

- [ ] **Step 2: Run the API test and verify RED**

Run: `node --test tests/classroom-points-api.test.js`

Expected: FAIL with 404 for the new endpoints.

- [ ] **Step 3: Add class authorization and scoped screen sessions**

Use existing `isClassMember()` for teacher reads/writes and require the class owner for the management toggle. Add an in-memory screen session map with random 32-byte tokens, class scope and rolling expiry. `POST /api/screen/session` validates the existing bind code and returns only the bound class ID/name/grade, module flags and `screen_token`.

```js
function screenSessionAuth(req, res, next) {
  const token = String(req.get('X-Screen-Token') || '');
  const session = screenSessions.get(token);
  if (!session || session.expires_at <= Date.now()) {
    return res.status(401).json({ error: '教室端连接已失效，请重新绑定' });
  }
  req.screenClass = store.classes.find(c => c.id === session.class_id) || null;
  if (!req.screenClass) return res.status(404).json({ error: '班级不存在' });
  next();
}
```

- [ ] **Step 4: Implement teacher and screen routes**

Validate every student, rule, period and entry belongs to the requested class. Mutating routes require an active broadcast plan; read routes remain available after expiry. Resolve score rules on the server and copy their name/delta into each ledger row. Return `source_label` from a single response mapper rather than storing Chinese labels in SQLite.

- [ ] **Step 5: Emit real-time class events after successful persistence**

Emit to `class:<classId>` only after the database transaction succeeds. Include the new entry or reversal and invalidation hints; never emit before persistence.

- [ ] **Step 6: Run API and broadcast regressions**

Run: `node --test tests/classroom-points-api.test.js tests/unified-referral-hooks.test.js tests/registration-api.test.js`

Expected: PASS; existing broadcast referral activation still occurs only after a notification is persisted.

- [ ] **Step 7: Commit the API slice**

```bash
git add server.js tests/classroom-points-api.test.js
git commit -m "feat: expose classroom points APIs"
```

### Task 3: 可恢复的教室端离线队列

**Files:**
- Create: `public/classroom-points-queue.js`
- Create: `tests/classroom-points-queue.test.js`

**Interfaces:**
- Produces `createClassroomPointsQueue({ storage, key, now, randomId })`.
- Queue methods: `enqueue(payload)`、`pending()`、`markSynced(clientOperationId)`、`markFailed(clientOperationId, message)`、`clearFailure(clientOperationId)`.
- Screen controller in Task 4 consumes the queue and posts each item using its stable `client_operation_id`.

- [ ] **Step 1: Write failing queue tests**

```js
test('pending score survives reload and keeps the same idempotency key', () => {
  const storage = memoryStorage();
  const first = createClassroomPointsQueue({ storage, key: 'class-1', randomId: () => 'op-1' });
  first.enqueue({ student_ids: ['student-1'], rule_id: 'rule-1' });
  const restored = createClassroomPointsQueue({ storage, key: 'class-1', randomId: () => 'op-2' });
  assert.deepEqual(restored.pending()[0].client_operation_id, 'op-1');
  restored.markSynced('op-1');
  assert.equal(first.pending().length, 0);
});
```

Test malformed storage recovery, ordering, persisted failure messages and retry without changing IDs.

- [ ] **Step 2: Run the queue test and verify RED**

Run: `node --test tests/classroom-points-queue.test.js`

Expected: FAIL because the queue module does not exist.

- [ ] **Step 3: Implement the UMD queue module**

Export through `module.exports` in Node and `window.ClassroomPointsQueue` in the browser. Persist one JSON array per class; clone returned objects so UI mutation cannot corrupt stored entries. Keep the module free of network and DOM dependencies.

- [ ] **Step 4: Run queue tests and commit**

Run: `node --test tests/classroom-points-queue.test.js`

Expected: PASS.

```bash
git add public/classroom-points-queue.js tests/classroom-points-queue.test.js
git commit -m "feat: add offline classroom score queue"
```

### Task 4: 教室大屏多模式界面与广播抢占

**Files:**
- Create: `public/classroom-points-screen.css`
- Create: `public/classroom-points-screen.js`
- Create: `tests/classroom-points-screen.test.js`
- Modify: `public/screen.html:45-155`
- Modify: `public/screen.html:257-350`
- Modify: `public/screen.html:658-710`
- Modify: `public/screen.html:770-920`

**Interfaces:**
- Consumes screen session/state/entry/reversal APIs and `window.ClassroomPointsQueue`.
- Produces browser controller `window.ClassroomPointsScreen` with `onBound(classInfo, bindCode)`、`onUnbound()`、`suspendForBroadcast()`、`resumeAfterBroadcast()`、`handleSocketEvent(type, payload)`.
- Existing notification functions call suspend before showing the overlay and resume after hiding it.

- [ ] **Step 1: Write failing state and structure tests**

Assert the page loads both new assets; the idle page has hidden-by-default actions for `加扣分`, `积分榜`, `流水记录`; mode containers exist; no seat map lives inside `screenIdle`; and the controller uses `IDLE_TIMEOUT_MS = 60000`.

Add a pure controller test with a fake clock:

```js
test('broadcast restores scoring mode and restarts the 60 second timer', () => {
  const controller = createModeController({ timeoutMs: 60000, setTimer, clearTimer, onMode });
  controller.enter('score');
  controller.suspendForBroadcast();
  controller.resumeAfterBroadcast();
  assert.equal(controller.mode(), 'score');
  advance(59999);
  assert.equal(controller.mode(), 'score');
  advance(1);
  assert.equal(controller.mode(), 'idle');
});
```

- [ ] **Step 2: Run screen tests and verify RED**

Run: `node --test tests/classroom-points-screen.test.js tests/classroom-screen.test.js`

Expected: FAIL because the new assets, modes and controller do not exist.

- [ ] **Step 3: Build the quiet idle entry and four modes**

Keep the current clock/announcement layout unchanged for broadcast-only classes. When `management.enabled` is true, reveal the three idle actions and update the lightweight daily count. Render the seat map only inside the score mode. Render full-screen ranking and ledger views only after their buttons are pressed.

- [ ] **Step 4: Implement single, batch, recent and reversal interactions**

Clicking a student opens the configured rule panel. A rule click immediately enqueues and attempts to sync entries; batch mode applies one rule to multiple selected students. Show optimistic results as “待同步” until the API confirms. “撤销上一笔” reverses only the latest eligible confirmed entry.

- [ ] **Step 5: Connect timers, broadcast overlay and Socket.IO**

Any score/ranking/ledger interaction calls `touch()`. Before `showNotification()` changes the overlay, call `suspendForBroadcast()`; after `hideNotification()` completes, call `resumeAfterBroadcast()`. Socket score events refresh totals/recent rows without reopening a closed mode.

- [ ] **Step 6: Implement reconnect flushing and visible failures**

On successful socket reconnect or browser `online`, recreate the screen session if needed and flush pending operations sequentially. Keep rejected operations in the queue with the server error and show a persistent “待处理 N 条” state instead of silently discarding them.

- [ ] **Step 7: Run screen and syntax regressions**

Run: `node --test tests/classroom-points-screen.test.js tests/classroom-points-queue.test.js tests/classroom-screen.test.js`

Expected: PASS, including valid inline JavaScript in the original screen page.

- [ ] **Step 8: Commit the screen slice**

```bash
git add public/screen.html public/classroom-points-screen.css public/classroom-points-screen.js tests/classroom-points-screen.test.js
git commit -m "feat: add points modes to classroom screen"
```

### Task 5: 教师端积分管理与按班级启用

**Files:**
- Create: `public/classroom-points-teacher.css`
- Create: `public/classroom-points-teacher.js`
- Create: `tests/classroom-points-teacher.test.js`
- Modify: `public/teacher.html:528-735`
- Modify: `public/teacher.html:1327-1415`
- Modify: `public/teacher.html:1635-1660`

**Interfaces:**
- Consumes teacher management, student, rule, period, score, ledger and leaderboard APIs from Task 2.
- Produces `window.ClassroomPointsTeacher` with `boot(options)`、`openClass(classId)`、`refreshClass(classId)` and `handleSocketEvent(type, payload)`.
- Reuses the existing login token, visible class list, toast and tab switching behavior.

- [ ] **Step 1: Write failing teacher-page tests**

Assert the teacher page loads the new assets, contains an `积分管理` top tab, exposes class-level “开启班级管理” only to owners, and contains real containers for quick scoring, students/seats, rules, periods, ranking and ledger. Assert the page copy states that the feature is included in the broadcast subscription and does not consume师行积分.

- [ ] **Step 2: Run teacher tests and verify RED**

Run: `node --test tests/classroom-points-teacher.test.js`

Expected: FAIL because the teacher integration does not exist.

- [ ] **Step 3: Add the teacher tab and class-level opt-in**

Add `积分管理` to the existing top tab bar. In each owner class card, show an enable/disable control; collaborator cards display the current state without the toggle. Enabling initializes default rules and the current period through the API, then refreshes the class and notifies the bound screen.

- [ ] **Step 4: Build quick scoring, configuration and reporting**

Use one selected-class control across quick scoring, students/seats, rules, ranking and ledger. Support student add/edit/archive and seat row/column, rule add/edit/disable, period creation, teacher-side single/batch scoring, filters and reversal. Hide the whole workbench when the selected class is broadcast-only.

- [ ] **Step 5: Connect real-time refresh and subscription errors**

Use the existing teacher Socket.IO connection. Refresh only the currently selected class on score/config events. On 403 plan expiry, keep all history visible, disable mutations and route the user to the existing subscription section.

- [ ] **Step 6: Run teacher and platform regressions**

Run: `node --test tests/classroom-points-teacher.test.js tests/platform-shell.test.js tests/classroom-points-api.test.js`

Expected: PASS; classroom broadcast remains subscription-gated and does not debit shared AI points.

- [ ] **Step 7: Commit the teacher slice**

```bash
git add public/teacher.html public/classroom-points-teacher.css public/classroom-points-teacher.js tests/classroom-points-teacher.test.js
git commit -m "feat: add teacher classroom points workspace"
```

### Task 6: 兼容性、视觉验收与完整回归

**Files:**
- Modify: `tests/classroom-screen.test.js`
- Modify: `design-qa.md`
- Create: `previews/classroom-points-2026-07-14/01-broadcast-only-idle.png`
- Create: `previews/classroom-points-2026-07-14/02-management-idle.png`
- Create: `previews/classroom-points-2026-07-14/03-score-mode.png`
- Create: `previews/classroom-points-2026-07-14/04-teacher-points.png`

**Interfaces:**
- Consumes all previous tasks.
- Produces evidence for broadcast-only compatibility, management opt-in, 60-second state behavior, projector layouts and full automated regression.

- [ ] **Step 1: Add final compatibility assertions**

Extend static tests so broadcast-only classes do not reveal points controls, no shared AI-points debit route is referenced, existing bind/reconnect/fullscreen/history behavior remains present, and the new assets parse as valid JavaScript.

- [ ] **Step 2: Run the complete automated suite**

Run: `node --test tests/*.test.js`

Expected: all tests PASS with zero failures.

Run: `node --check server.js && node --check classroom-points.js && node --check public/classroom-points-queue.js && node --check public/classroom-points-screen.js && node --check public/classroom-points-teacher.js`

Expected: exit 0 and no syntax errors.

- [ ] **Step 3: Capture required desktop states**

Run the app against an isolated SQLite file. Capture broadcast-only idle, management-enabled idle, score mode and teacher points workspace at 1280×720 and verify the score mode at 1024×768 and 1920×1080. Confirm the daily idle contains no student names, scores or ranking.

- [ ] **Step 4: Exercise behavior manually**

Verify one screen entry, one teacher entry, batch entry, reversal, period filters, broadcast interruption/restoration, 60-second return, offline queue persistence, reconnect flush and duplicate request idempotency. Record exact observations and screenshot paths in `design-qa.md`.

- [ ] **Step 5: Check the scoped diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the files listed in this plan are staged for this feature. Existing unrelated modified/untracked files remain untouched.

- [ ] **Step 6: Commit verification artifacts**

```bash
git add tests/classroom-screen.test.js design-qa.md previews/classroom-points-2026-07-14
git commit -m "test: verify classroom points integration"
```

### Task 7: Production backup, deployment and live smoke test

**Files:**
- Deploy: `classroom-points.js`
- Deploy: `db.js`
- Deploy: `server.js`
- Deploy: `public/screen.html`
- Deploy: `public/teacher.html`
- Deploy: `public/classroom-points-queue.js`
- Deploy: `public/classroom-points-screen.css`
- Deploy: `public/classroom-points-screen.js`
- Deploy: `public/classroom-points-teacher.css`
- Deploy: `public/classroom-points-teacher.js`

**Interfaces:**
- Produces the live optional class-management module at `https://notice.yingyuzuowen.asia/screen.html` and `https://notice.yingyuzuowen.asia/teacher.html`.

- [ ] **Step 1: Re-run the release gate immediately before deployment**

Run: `node --test tests/*.test.js && git diff --check`

Expected: all tests PASS and no whitespace errors.

- [ ] **Step 2: Discover and record the active production process**

Run: `ssh notice.yingyuzuowen.asia 'cd /home/admin/classroom-broadcast && pwd && (pm2 list || systemctl status classroom-broadcast --no-pager)'`

Expected: `/home/admin/classroom-broadcast` and one identifiable running classroom-broadcast process. Use only the process manager reported by this command in the restart step.

- [ ] **Step 3: Back up every changed production file and SQLite database**

Create `/home/admin/backups/classroom-points-<UTC timestamp>/`, then copy the ten deployed files plus the SQLite database, `-wal` and `-shm` files when present. Confirm the backup directory contains non-empty copies before upload.

- [ ] **Step 4: Upload the scoped files and restart one service**

Use `rsync -avR` from the repository root for the exact deploy list. Restart only the active classroom-broadcast process discovered in Step 2; do not restart the independent math service.

- [ ] **Step 5: Verify production without changing a real class**

Check HTTP 200 and content markers for `screen.html`, `teacher.html` and all five new assets. Confirm the service log shows successful SQLite migration and no startup exception. Call authenticated read-only APIs with a test account or temporary test class; do not add points to a real student.

- [ ] **Step 6: Inspect live desktop states and finish only on evidence**

Open the live broadcast-only screen and teacher class list. Verify existing broadcast behavior, hidden points entry for a broadcast-only class, successful opt-in on a temporary class, screen entry visibility, and no console errors. Record live URLs, hashes, process status and smoke-test results before declaring deployment complete.
