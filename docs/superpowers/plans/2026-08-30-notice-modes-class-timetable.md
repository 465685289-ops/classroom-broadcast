# Notice Modes and Class Timetable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add silent text-only notices and a shared Monday-to-Friday class timetable that teachers maintain and classroom screens display with today highlighted.

**Architecture:** Keep notification creation in the broadcast core route, persisting the new mode through the existing notification `extra_json`. Add a pure timetable model plus an installer-style `timetable-routes.js`; persist normalized timetable data in the class `extra_json`, include it in screen binding, and push later changes through the existing class Socket.IO room.

**Tech Stack:** Node.js, Express, Socket.IO, better-sqlite3, native HTML/CSS/JavaScript, Node test runner.

**Spec:** `docs/plans/2026-08-30-notice-modes-class-timetable-design.md`

## Global Constraints

- Week range is fixed to Monday through Friday.
- Slots are fixed to morning reading, lessons 1-8, and evening studies 1-3.
- Text-only means fully silent: no arrival tone and no TTS request.
- Missing or invalid `broadcast_mode` defaults to `voice` for backward compatibility.
- Timetable is class-scoped and independent of rosters, class points, and teachers' personal timetables.
- Only the class owner can save or clear a timetable; collaborators can read it.
- No new runtime dependency and no database schema migration.
- Run the repository's serial `npm test` before completion.
- Do not deploy in this task.

---

### Task 1: Timetable domain model and SQLite persistence

**Files:**
- Create: `class-timetable.js`
- Modify: `db.js`
- Test: `tests/class-timetable.test.js`

**Interfaces:**
- Produces: `TIMETABLE_DAYS`, `TIMETABLE_SLOTS`, `emptyClassTimetable()`, `normalizeClassTimetable(value)`, and `classTimetableHasEntries(value)`.
- Produces: `dbStore.saveClassTimetable(classId, timetable)` returning the normalized saved timetable.
- Consumes later: API routes, socket binding, teacher editor, and screen renderer use the same normalized structure.

- [ ] **Step 1: Write the failing pure-model and persistence tests**

```js
test('class timetable normalizes fixed weekdays and twelve bounded slots', () => {
  const result = normalizeClassTimetable({ entries: {
    mon: [' 语文 ', '<script>alert(1)</script>'],
    sat: ['不应保存']
  }});
  assert.equal(Object.keys(result.entries).join(','), 'mon,tue,wed,thu,fri');
  assert.equal(result.entries.mon.length, 12);
  assert.equal(result.entries.mon[0], '语文');
  assert.equal(result.entries.mon[1].length <= 30, true);
  assert.equal(result.entries.sat, undefined);
});

test('class timetable persists through the classes extra_json field', () => {
  dbStore.saveClassTimetable('class-1', {
    entries: { mon: ['语文'], fri: ['', '班会'] },
    updated_at: NOW
  });
  const cls = dbStore.loadClasses().find(item => item.id === 'class-1');
  assert.equal(cls.timetable.entries.mon[0], '语文');
  assert.equal(cls.timetable.entries.fri[1], '班会');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test --test-concurrency=1 tests/class-timetable.test.js`

Expected: FAIL because `class-timetable.js` and `saveClassTimetable` do not exist.

- [ ] **Step 3: Implement the fixed timetable model**

```js
const TIMETABLE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const TIMETABLE_SLOTS = ['早读', '第1节', '第2节', '第3节', '第4节', '第5节',
  '第6节', '第7节', '第8节', '晚自习1', '晚自习2', '晚自习3'];

function normalizeClassTimetable(value = {}) {
  const source = value && typeof value === 'object' && value.entries && typeof value.entries === 'object'
    ? value.entries : {};
  const entries = {};
  TIMETABLE_DAYS.forEach(day => {
    const cells = Array.isArray(source[day]) ? source[day] : [];
    entries[day] = TIMETABLE_SLOTS.map((_, index) => String(cells[index] || '').trim().slice(0, 30));
  });
  return { version: 1, entries, updated_at: typeof value.updated_at === 'string' ? value.updated_at : null };
}
```

Implement `classTimetableHasEntries()` by checking the normalized cells. Keep HTML escaping at render time; normalization bounds data but does not silently rewrite legitimate punctuation.

- [ ] **Step 4: Persist only the timetable class extension**

In `upsertClassTx`, serialize `{ timetable: normalizeClassTimetable(cls.timetable) }` only when `cls.timetable` exists. Add `saveClassTimetable(classId, timetable)` as one SQLite update statement that reads the class, normalizes the timetable, updates only `extra_json`, and returns the saved value. Export it from `db.js`.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `node --test --test-concurrency=1 tests/class-timetable.test.js`

Expected: PASS with the fixed days, 12 cells per day, and a reloaded timetable.

- [ ] **Step 6: Commit the domain and persistence layer**

```bash
git add class-timetable.js db.js tests/class-timetable.test.js
git commit -m "feat: 保存班级周课表"
```

---

### Task 2: Timetable API, permissions, and socket delivery

**Files:**
- Create: `timetable-routes.js`
- Modify: `server.js`
- Test: `tests/class-timetable-api.test.js`
- Test: `tests/platform-shell.test.js`

**Interfaces:**
- Consumes: `normalizeClassTimetable()` and `dbStore.saveClassTimetable()` from Task 1.
- Produces: `installTimetableRoutes(app)` with `GET/PUT /api/classes/:classId/timetable`.
- Produces: Socket event `class-timetable-update` carrying only the normalized timetable.

- [ ] **Step 1: Write failing HTTP permission and persistence tests**

Create an owner, collaborator, outsider, active class, and expired class in a temporary SQLite database, then spawn `server.js`. Assert:

```js
const initial = await request('/api/classes/' + CLASS_ID + '/timetable', { token: MEMBER_TOKEN });
assert.equal(initial.status, 200);
assert.equal(initial.body.timetable.entries.mon.length, 12);

const denied = await request('/api/classes/' + CLASS_ID + '/timetable', {
  method: 'PUT', token: MEMBER_TOKEN, body: { entries: { mon: ['语文'] } }
});
assert.equal(denied.status, 403);

const saved = await request('/api/classes/' + CLASS_ID + '/timetable', {
  method: 'PUT', token: OWNER_TOKEN, body: { entries: { mon: ['语文'], sat: ['无效'] } }
});
assert.equal(saved.status, 200);
assert.equal(saved.body.timetable.entries.mon[0], '语文');
assert.equal(saved.body.timetable.entries.sat, undefined);

const outsider = await request('/api/classes/' + CLASS_ID + '/timetable', { token: OUTSIDER_TOKEN });
assert.equal(outsider.status, 404);
```

Add a source guard in `tests/platform-shell.test.js` asserting `server.js` imports and installs `installTimetableRoutes` once.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test --test-concurrency=1 tests/class-timetable-api.test.js tests/platform-shell.test.js`

Expected: FAIL with timetable endpoints returning 404 and no installer wiring.

- [ ] **Step 3: Implement installer-style timetable routes**

```js
function installTimetableRoutes(app) {
  app.get('/api/classes/:classId/timetable', userAuth, (req, res) => {
    const cls = visibleClass(req.params.classId, req.user.id);
    if (!cls) return res.status(404).json({ error: '班级不存在' });
    return res.json({ timetable: normalizeClassTimetable(cls.timetable), is_owner: cls.user_id === req.user.id });
  });

  app.put('/api/classes/:classId/timetable', userAuth, requireActivePlan, (req, res) => {
    const cls = visibleClass(req.params.classId, req.user.id);
    if (!cls) return res.status(404).json({ error: '班级不存在' });
    if (cls.user_id !== req.user.id) return res.status(403).json({ error: '只有班级创建者可以修改课程表' });
    const timetable = normalizeClassTimetable({ entries: req.body.entries, updated_at: new Date().toISOString() });
    cls.timetable = dbStore.saveClassTimetable(cls.id, timetable);
    state.io.to(`class:${cls.id}`).emit('class-timetable-update', cls.timetable);
    return res.json({ timetable: cls.timetable, is_owner: true });
  });
}
```

Use a local `visibleClass()` helper and the shared `state.store`. Accept the existing `requireActivePlan` through installer options because it currently belongs to broadcast core in `server.js`; do not duplicate plan logic.

- [ ] **Step 4: Wire the installer and initial screen payload**

Import and call `installTimetableRoutes(app, { requireActivePlan })` once in the shared route installation section. Extend `bind-success` with `timetable: normalizeClassTimetable(cls.timetable)` so a newly bound screen has data before any update event.

- [ ] **Step 5: Run focused API and shell tests and verify GREEN**

Run: `node --test --test-concurrency=1 tests/class-timetable-api.test.js tests/platform-shell.test.js`

Expected: PASS for owner write, collaborator read, outsider denial, normalization, and installer wiring.

- [ ] **Step 6: Commit the API and socket contract**

```bash
git add timetable-routes.js server.js tests/class-timetable-api.test.js tests/platform-shell.test.js
git commit -m "feat: 提供班级课表接口与实时同步"
```

---

### Task 3: Notification mode data contract

**Files:**
- Create: `broadcast-notification.js`
- Modify: `server.js`
- Modify: `db.js`
- Test: `tests/broadcast-notification.test.js`
- Test: `tests/broadcast-notification-api.test.js`

**Interfaces:**
- Produces: `normalizeBroadcastMode(value)` returning `text` only for the exact text mode and `voice` otherwise.
- Produces: notification responses and socket payloads with `broadcast_mode`.
- Consumes later: teacher history and classroom screen behavior.

- [ ] **Step 1: Write failing normalization and SQLite tests**

```js
assert.equal(normalizeBroadcastMode('text'), 'text');
assert.equal(normalizeBroadcastMode('voice'), 'voice');
assert.equal(normalizeBroadcastMode(undefined), 'voice');
assert.equal(normalizeBroadcastMode('anything'), 'voice');

dbStore.upsertNotification({ ...notice, broadcast_mode: 'text' });
assert.equal(dbStore.loadStore().notifications.find(row => row.id === notice.id).broadcast_mode, 'text');
```

- [ ] **Step 2: Run the model test and verify RED**

Run: `node --test --test-concurrency=1 tests/broadcast-notification.test.js`

Expected: FAIL because the module and persistence field do not exist.

- [ ] **Step 3: Implement mode normalization and persistence**

Create the pure normalizer. In `upsertNotification`, store `{ broadcast_mode: normalizeBroadcastMode(row.broadcast_mode) }` in `extra_json`. In `loadNotifications`, spread legacy extras first and assign normalized `broadcast_mode` last so malformed extra JSON cannot override core fields.

- [ ] **Step 4: Run the model test and verify GREEN**

Run: `node --test --test-concurrency=1 tests/broadcast-notification.test.js`

Expected: PASS for explicit text mode, voice default, and SQLite reload.

- [ ] **Step 5: Write the failing notification API compatibility test**

Spawn a temporary server and assert a posted text-only notice returns `broadcast_mode: 'text'`, a legacy request without the field returns `voice`, and history preserves both modes. Assert the text-only notification stores `repeat_count: 1` even if the caller submits 10.

- [ ] **Step 6: Run the API test and verify RED**

Run: `node --test --test-concurrency=1 tests/broadcast-notification-api.test.js`

Expected: FAIL because `/api/notify` ignores `broadcast_mode`.

- [ ] **Step 7: Extend the core notification route**

Read `broadcast_mode` from the body, normalize it, and force `repeat_count` to 1 for text mode. Include it on the persisted object and emitted payload. Leave `/api/resend/:id` unchanged apart from inheriting the stored field through object spread.

- [ ] **Step 8: Run the API test and verify GREEN**

Run: `node --test --test-concurrency=1 tests/broadcast-notification-api.test.js`

Expected: PASS for text, legacy voice, history, and resend-compatible persistence.

- [ ] **Step 9: Commit the notification contract**

```bash
git add broadcast-notification.js server.js db.js tests/broadcast-notification.test.js tests/broadcast-notification-api.test.js
git commit -m "feat: 支持静音文字通知模式"
```

---

### Task 4: Teacher controls for notice mode and class timetable

**Files:**
- Modify: `public/teacher.html`
- Test: `tests/class-timetable-teacher.test.js`
- Test: `tests/broadcast-notification-teacher.test.js`

**Interfaces:**
- Consumes: `GET/PUT /api/classes/:classId/timetable` and notification `broadcast_mode`.
- Produces: `setBroadcastMode(mode)`, `loadClassTimetable()`, `renderClassTimetable(payload)`, `saveClassTimetable()`, and `clearClassTimetable()` browser functions.

- [ ] **Step 1: Write failing teacher-page contract tests**

Assert the page contains two accessible mode buttons, submits `broadcast_mode`, disables `repeatCount` for text mode, displays mode labels in history, contains a timetable class selector, renders 12 rows and five weekdays, uses the timetable endpoints, escapes cell values, makes collaborators read-only, and wraps the table in a horizontal-scroll container.

- [ ] **Step 2: Run teacher-page tests and verify RED**

Run: `node --test --test-concurrency=1 tests/class-timetable-teacher.test.js tests/broadcast-notification-teacher.test.js`

Expected: FAIL because the controls and functions are absent.

- [ ] **Step 3: Add the notice-mode segmented control**

Add `文字＋语音` and `仅文字（静音）` buttons above repeat count. Store the current value in a hidden input or variable. `setBroadcastMode('text')` disables repeat count and updates helper copy; switching back restores it. Include `broadcast_mode` in `doSend()` and show `语音 × N 次` versus `仅文字` in history.

- [ ] **Step 4: Add the class timetable editor card**

Below “我的班级”, add a card with `timetableClassSelect`, an editor status, a horizontally scrollable table, and save/clear buttons. Build the header from fixed Monday-Friday labels and the 12 fixed slot labels. Use `textContent` or `esc()` for every loaded value. Preserve the selected class when `loadClasses()` refreshes and automatically load its timetable.

- [ ] **Step 5: Enforce owner-only editing in the browser**

Use the API's `is_owner` response to set every timetable input to `readOnly`, hide save/clear actions for collaborators, and display “由班级创建者维护”. Keep server authorization as the source of truth.

- [ ] **Step 6: Run teacher-page tests and syntax checks and verify GREEN**

Run: `node --test --test-concurrency=1 tests/class-timetable-teacher.test.js tests/broadcast-notification-teacher.test.js tests/classroom-points-teacher.test.js`

Expected: PASS with valid inline JavaScript and no regression in class management controls.

- [ ] **Step 7: Commit teacher controls**

```bash
git add public/teacher.html tests/class-timetable-teacher.test.js tests/broadcast-notification-teacher.test.js
git commit -m "feat: 教师端设置通知模式与班级课表"
```

---

### Task 5: Classroom screen timetable and silent notice behavior

**Files:**
- Modify: `public/screen.html`
- Test: `tests/class-timetable-screen.test.js`
- Test: `tests/classroom-screen.test.js`

**Interfaces:**
- Consumes: `bind-success.timetable`, `class-timetable-update`, and notification `broadcast_mode`.
- Produces: `renderClassTimetable(timetable, dayIndex?)` and a silent branch inside `displayNotification(data)`.

- [ ] **Step 1: Write failing screen tests for the weekly timetable**

Assert the page contains the timetable board, five weekday headers, 12 slot labels, a `today` class, a renderer that maps `Date#getDay()` values 1-5 to columns and maps weekends to no column, reads the initial bind timetable, and listens for `class-timetable-update`.

- [ ] **Step 2: Write the failing silent-notice behavior test**

Extract or evaluate the decision block around `displayNotification`. Verify `broadcast_mode: 'text'` does not call `playAlertSound()` or `speakText()`, does schedule `minimizeNotification()` after a bounded reading delay, and missing mode still calls both sound paths.

- [ ] **Step 3: Run screen tests and verify RED**

Run: `node --test --test-concurrency=1 tests/class-timetable-screen.test.js tests/classroom-screen.test.js`

Expected: FAIL because the timetable DOM, update listener, and silent branch do not exist.

- [ ] **Step 4: Add the responsive timetable board**

Wrap the right idle region in an `idle-right` column. Add a hidden timetable board above the existing bulletin board. Use compact projector-safe cells, a sticky slot column only where it does not interfere with the screen layout, and `overflow:hidden` on the classroom display. When the timetable has entries, show the board and apply a compact bulletin class; otherwise hide the board and let the bulletin fill the area.

- [ ] **Step 5: Render and highlight today**

Normalize defensively in the browser to five arrays of 12 cells, write values through `textContent`, and add `today` only for day indexes 1-5. Put a visible “今天” chip in the matching header. On bind success render `cls.timetable`; on `class-timetable-update` replace `currentClass.timetable` and rerender.

- [ ] **Step 6: Implement fully silent text notices**

Normalize the mode at display time with `data.broadcast_mode === 'text' ? 'text' : 'voice'`. Call `playAlertSound()` only for voice mode. For voice mode retain the existing 1800 ms start and `speakText()` callback. For text mode schedule `minimizeNotification()` after `Math.max(8000, Math.min(20000, data.content.length * 350))` without calling `/api/tts`. Change metadata to “仅文字” or “语音 × N 次”.

- [ ] **Step 7: Run screen tests and verify GREEN**

Run: `node --test --test-concurrency=1 tests/class-timetable-screen.test.js tests/classroom-screen.test.js tests/classroom-points-screen.test.js`

Expected: PASS for weekday/weekend highlighting, real-time updates, silent mode, legacy voice mode, and points idle-page isolation.

- [ ] **Step 8: Commit classroom screen behavior**

```bash
git add public/screen.html tests/class-timetable-screen.test.js tests/classroom-screen.test.js
git commit -m "feat: 大屏展示班级课表与静音通知"
```

---

### Task 6: Full regression and browser acceptance

**Files:**
- Modify if needed: `README.md`
- Modify: `docs/superpowers/plans/2026-08-30-notice-modes-class-timetable.md` (check completed boxes)

**Interfaces:**
- Verifies all interfaces produced by Tasks 1-5 together.

- [ ] **Step 1: Run source hygiene checks**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 2: Run the complete serial test suite**

Run: `npm test`

Expected: all tests pass with zero failures. If only the documented unified-referral email race fails, rerun once and report both results rather than hiding the first run.

- [ ] **Step 3: Start a local server with isolated test data**

Run the application against a temporary SQLite file and non-production port. Use a temporary paid teacher/class fixture; do not alter `broadcast.db`.

- [ ] **Step 4: Verify teacher desktop and mobile paths in a browser**

Check: mode switching disables repeat count; text-only request succeeds; class owner can edit and save all five days; the table remains usable at a phone viewport; collaborator inputs are read-only.

- [ ] **Step 5: Verify classroom screen paths in a browser**

Check: initial bind shows the saved timetable; today's column is visually distinct; saving from teacher page updates the screen without refresh; text-only notice shows with no audio request; voice notice still calls the existing TTS route; no-timetable class retains the full bulletin layout.

- [ ] **Step 6: Review repository state and commit any verification documentation**

Run: `git status --short --branch && git log --oneline -8`

If README user-facing feature bullets were updated, commit only those documentation changes:

```bash
git add README.md docs/superpowers/plans/2026-08-30-notice-modes-class-timetable.md
git commit -m "docs: 更新班级课表与通知模式说明"
```

- [ ] **Step 7: Report delivery boundary**

Report exact test counts, browser paths checked, commits created, and state “已开发，未上线”. Do not claim production availability.
