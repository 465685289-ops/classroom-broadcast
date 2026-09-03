# 班级广播首次开通引导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让首次使用班级广播的班主任在跨手机与教室电脑的场景中完成建班、绑定大屏和首条语音通知，并让进度可靠恢复。

**Architecture:** SQLite 新增一张只保存首次开通里程碑的用户级表；`classroom-onboarding-routes.js` 以 installer 模式只读暴露当前用户的引导状态。现有创建班级、教室端绑定和通知持久化三个成功节点幂等写入里程碑，教师端根据 API 状态渲染非阻塞三步清单并利用既有 Socket 在线更新自动刷新。

**Tech Stack:** Node.js、Express、Socket.IO、better-sqlite3、原生 HTML/CSS/JavaScript、node:test。

**Spec:** `docs/plans/2026-08-31-classroom-first-use-onboarding-design.md`

## Global Constraints

- 只服务班主任首次开通教室大屏；不改变协作老师、积分、课程表或付费规则。
- 进度保存在 SQLite，不依赖 localStorage；固定教室链接继续使用 `#bind=` 哈希。
- 默认测试通知必须为“文字＋语音”、播报 1 遍；通知失败不能清空输入内容或标记完成。
- 新 API 域使用 installer 模式；共享运行态只由 `state.js` 访问，禁止模块回环。
- 不能提交密钥、真实用户数据、SQLite 运行数据或备份文件。
- 所有测试使用 `npm test` 串行执行；上线另行授权后执行文件式发布与公网验收。

---

## File structure

- Create: `classroom-onboarding-routes.js` — 受登录保护的首次开通状态读取接口。
- Modify: `db.js` — `classroom_onboarding` schema 和幂等读取/写入 helper。
- Modify: `server.js` — 安装路由，并在建班、绑定成功、通知持久化后记录里程碑。
- Modify: `public/teacher.html` — 三步卡片、移动端样式、状态拉取及操作入口。
- Create: `tests/classroom-onboarding-store.test.js` — SQLite helper 的状态与幂等性测试。
- Create: `tests/classroom-onboarding-api.test.js` — 路由授权、目标班隔离和状态响应测试。
- Create: `tests/classroom-onboarding-teacher.test.js` — 页面默认语音、引导动作、失败保护和内联脚本测试。

### Task 1: Persist first-use milestones in SQLite

**Files:**

- Modify: `db.js:ensureSchema`, `db.js:module.exports`
- Create: `tests/classroom-onboarding-store.test.js`

**Interfaces:**

- Produces: `getClassroomOnboarding(userId)` returning `null` or `{ user_id, version, first_class_id, screen_connected_at, first_notification_id, first_notification_at, updated_at }`.
- Produces: `rememberOnboardingClass(userId, classId, at)`, `markOnboardingScreenConnected(userId, classId, at)`, and `markOnboardingFirstNotification(userId, classId, notificationId, at)`.
- Rule: each marker must preserve the earliest non-null value; a mismatched class ID must not advance screen or notification milestones.

- [ ] **Step 1: Write the failing store tests**

```js
test('first-use milestones are user-scoped, ordered and idempotent', () => {
  dbStore.rememberOnboardingClass('owner-a', 'class-a', '2026-08-31T00:00:00.000Z');
  dbStore.rememberOnboardingClass('owner-a', 'class-b', '2026-08-31T00:01:00.000Z');
  dbStore.markOnboardingScreenConnected('owner-a', 'class-b', '2026-08-31T00:02:00.000Z');
  dbStore.markOnboardingScreenConnected('owner-a', 'class-a', '2026-08-31T00:03:00.000Z');
  dbStore.markOnboardingFirstNotification('owner-a', 'class-a', 19, '2026-08-31T00:04:00.000Z');
  assert.deepEqual(dbStore.getClassroomOnboarding('owner-a'), {
    user_id: 'owner-a', version: 1, first_class_id: 'class-a',
    screen_connected_at: '2026-08-31T00:03:00.000Z',
    first_notification_id: 19, first_notification_at: '2026-08-31T00:04:00.000Z',
    updated_at: '2026-08-31T00:04:00.000Z'
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test tests/classroom-onboarding-store.test.js`
Expected: failure because the helpers and schema do not exist.

- [ ] **Step 3: Add the schema and minimal helper implementations**

```sql
CREATE TABLE IF NOT EXISTS classroom_onboarding (
  user_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  first_class_id TEXT,
  screen_connected_at TEXT,
  first_notification_id INTEGER,
  first_notification_at TEXT,
  updated_at TEXT NOT NULL
);
```

Use parameterized SQLite statements. `rememberOnboardingClass` inserts an empty row when absent and only sets `first_class_id` when it is null. The two later helpers update only when `first_class_id = classId` and their target milestone is null. Export all four helpers from `db.js`.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `node --test tests/classroom-onboarding-store.test.js`
Expected: all subtests pass.

- [ ] **Step 5: Commit the persisted-state slice**

```bash
git add db.js tests/classroom-onboarding-store.test.js
git commit -m "feat: 保存班级广播首次开通进度"
```

### Task 2: Expose and update authenticated onboarding state

**Files:**

- Create: `classroom-onboarding-routes.js`
- Modify: `server.js:route installer imports and installation`, `server.js:POST /api/classes`, `server.js:POST /api/notify`, `server.js:bind-screen socket handler`
- Create: `tests/classroom-onboarding-api.test.js`

**Interfaces:**

- Produces: `GET /api/classroom-onboarding` protected by `userAuth`.
- Response shape:

```json
{
  "classroom": { "id": "class-a", "name": "八年级一班", "grade": "junior", "bind_code": "ABC123", "online": 1 },
  "steps": { "class_created": true, "screen_connected": true, "first_notice_sent": false },
  "next_step": "send_test_notice",
  "completed": false
}
```

- Consumes: Task 1 helpers; `state.store`, `state.io`, and `middleware.userAuth`.

- [ ] **Step 1: Write failing API and lifecycle tests**

```js
test('anonymous users cannot read onboarding and an owner sees only the first owned class', async () => {
  const anonymous = await request.get('/api/classroom-onboarding');
  assert.equal(anonymous.status, 401);
  const owner = await request.get('/api/classroom-onboarding').set('X-Token', ownerToken);
  assert.deepEqual(owner.body.steps, { class_created: true, screen_connected: false, first_notice_sent: false });
  assert.equal(owner.body.classroom.id, ownerClassId);
});

test('creating, binding and sending a notice advance only the owning teacher onboarding', async () => {
  // Create class as owner, bind its screen socket, then POST /api/notify as owner.
  // Assert the three milestones advance in that order and a collaborator remains unchanged.
});
```

- [ ] **Step 2: Run the focused API test and confirm it fails**

Run: `node --test tests/classroom-onboarding-api.test.js`
Expected: failure because the route and lifecycle markers do not exist.

- [ ] **Step 3: Implement installer route and lifecycle markers**

`classroom-onboarding-routes.js` must follow the timetable installer pattern. It derives `online` by counting sockets whose `classId` equals the saved class ID. It returns no class data when the user has never created a class. For an existing owner with classes but no marker row, it finds that owner’s earliest notification: if one exists, it calls the Task 1 helpers with that notification’s class ID and `created_at` for both screen-connected and first-notice milestones; otherwise it records the oldest owned class as the current target. It never selects or exposes a collaborative class.

After successful `dbStore.upsertClass(cls)`, call `rememberOnboardingClass(req.user.id, cls.id, cls.created_at)`. In the existing `bind-screen` success handler, call `markOnboardingScreenConnected(cls.user_id, cls.id, now)`. In `POST /api/notify`, call `markOnboardingFirstNotification(req.user.id, cls.id, notification.id, notification.created_at)` only after `dbStore.upsertNotification(notification)` succeeds. Wrap marker writes in `try/catch` that logs a non-sensitive error and never changes the successful class, bind, or notification response.

Install with:

```js
installClassroomOnboardingRoutes(app);
```

after static middleware and alongside existing route installers.

- [ ] **Step 4: Run focused API tests and existing broadcast tests**

Run: `node --test tests/classroom-onboarding-api.test.js tests/broadcast-mode-api.test.js tests/classroom-screen.test.js`
Expected: all tests pass; anonymous onboarding remains denied and current binding/notification behavior remains intact.

- [ ] **Step 5: Commit the API and lifecycle slice**

```bash
git add classroom-onboarding-routes.js server.js tests/classroom-onboarding-api.test.js
git commit -m "feat: 提供班级广播首次开通状态"
```

### Task 3: Render the non-blocking three-step teacher guide

**Files:**

- Modify: `public/teacher.html:publish tab markup, styles, enterApp, loadClasses, addClass, doSend, socket online update`
- Create: `tests/classroom-onboarding-teacher.test.js`

**Interfaces:**

- Consumes: `GET /api/classroom-onboarding` response from Task 2 and existing `copyFixedClassroomLink(bindCode)`.
- Produces: `loadClassroomOnboarding()`, `renderClassroomOnboarding(data)`, `goToOnboardingClassSetup()`, `prepareOnboardingScreenSetup()`, and `prepareOnboardingTestNotice()` in `teacher.html`.
- UI element IDs: `classroomOnboardingCard`, `classroomOnboardingSteps`, `classroomOnboardingStatus`, and `classroomOnboardingActions`.

- [ ] **Step 1: Write failing page behavior tests**

```js
test('teacher onboarding prepares one voiced test notice without forcing an immediate send', () => {
  // Execute the extracted helper with a fake document.
  context.prepareOnboardingTestNotice();
  assert.equal(values.classSelect, 'class-a');
  assert.equal(values.content, '测试通知：班级广播已连接成功。');
  assert.equal(values.broadcastMode, 'voice');
  assert.equal(values.repeatCount, '1');
  assert.equal(context.sentRequests.length, 0);
});

test('teacher onboarding keeps the completed state when the screen is currently offline', () => {
  const view = context.classroomOnboardingView({
    classroom: { id: 'class-a', online: 0 },
    steps: { class_created: true, screen_connected: true, first_notice_sent: true },
    completed: true
  });
  assert.equal(view.title, '教室大屏已开通');
  assert.match(view.status, /当前大屏离线/);
});
```

- [ ] **Step 2: Run the focused page test and confirm it fails**

Run: `node --test tests/classroom-onboarding-teacher.test.js`
Expected: failure because the onboarding helpers and markup do not exist.

- [ ] **Step 3: Add markup, styles and actions**

Insert the card at the top of the existing immediate-notification publish section so it appears before the disabled send form. Use the following visible copy:

```text
先把第一块教室大屏开通
建立我的第一个班级
连接教室大屏
发送一条测试通知
教室大屏已连接
教室大屏已开通
下一步可设置课程表、邀请科任老师协作。
```

The class action must switch to `manage`, scroll the existing `newClassName` field into view and focus it. The screen action must call the existing fixed-link copy helper and also render a same-origin `screen.html#bind=...` link for “我正在教室电脑上设置”. The test-notice action must switch to `publish`, set the target class, set text, set `broadcastMode` to `voice`, set `repeatCount` to `1`, invoke `setBroadcastMode('voice')`, and call `updatePreview()`; it must not call `doSend()`.

`loadClassroomOnboarding()` uses `headers()` and updates only the card. Call it after `enterApp()` data loading, after `loadClasses()` succeeds, after a successful `doSend()`, and after the existing `online-update` class refresh. A failed guide-state fetch hides the card rather than blocking class creation or notification publishing. On a 401 response, use the existing `logout()` path.

Use `sessionStorage` only for a “暂时收起” presentation preference. It must not change server progress. At 390px width, buttons stack or wrap within the card; no page-level horizontal overflow is allowed.

- [ ] **Step 4: Run focused page tests and existing teacher page tests**

Run: `node --test tests/classroom-onboarding-teacher.test.js tests/classroom-screen.test.js tests/class-timetable-teacher.test.js`
Expected: all tests pass and every inline script still compiles.

- [ ] **Step 5: Commit the teacher guide slice**

```bash
git add public/teacher.html tests/classroom-onboarding-teacher.test.js
git commit -m "feat: 引导班主任开通教室大屏"
```

### Task 4: Verify the whole first-use journey and release readiness

**Files:**

- Modify: any source/test file only if the verification exposes a real defect.
- Modify: `docs/plans/2026-08-31-classroom-first-use-onboarding-design.md` only to record a changed accepted requirement; do not mark deployment complete before it happens.

**Interfaces:**

- Consumes: completed Tasks 1–3.
- Produces: fresh automated and browser evidence for the complete first-use path.

- [ ] **Step 1: Run the full regression suite**

Run: `npm test`
Expected: zero failures. If `unified-referral-api` alone shows its known email race, rerun the same command once before calling it a regression.

- [ ] **Step 2: Run local browser acceptance with disposable SQLite data**

Start the app with a temporary `SQLITE_FILE`, seed one disposable trial teacher, then verify:

```text
register/login or seeded login → no classes shows Step 1
create 八年级一班 → Step 1 completes and the new class is selected
open screen.html#bind=<code> in a second tab → Step 2 completes after online update
click test notice → voice mode and count 1 are prefilled, nothing is sent yet
send → Step 3 completes; reload teacher page → compact completion card remains
```

Inspect both desktop and 390px viewport. Confirm the classroom screen is not left bound to a real production class. Record any Wake Lock permission denial separately; it is not a guide failure unless it breaks binding or layout.

- [ ] **Step 3: Review security and data boundaries**

Check that `GET /api/classroom-onboarding` returns `401` anonymously, a collaborator cannot receive the owner’s onboarding row, and no bind code is written to analytics, logs, or a query string. Confirm the only browser-persisted guide value is a harmless collapsed-card preference.

- [ ] **Step 4: Commit verification fixes only when needed**

```bash
git status --short
git add <only-the-verified-fix-files>
git commit -m "fix: 修正首次开通引导验收问题"
```

- [ ] **Step 5: Hand off release status precisely**

Report separately: local implementation status, merge/push status, and production deployment status. Do not deploy until the user explicitly asks to push and deploy. When authorized, back up changed source and SQLite on the server, upload exact files, restart `classroom-broadcast.service`, compare hashes, run `PRAGMA quick_check`, and verify all public domains plus anonymous API denial.

## Self-review

- Spec coverage: Task 1 stores cross-device state; Task 2 derives authenticated state and records all three lifecycle milestones; Task 3 implements the three-step card, voiced one-time test and non-blocking errors; Task 4 covers regression, mobile, browser flow, authorization and release boundaries.
- Placeholder scan: no deferred implementation markers are used; API names, status fields, visible copy and test commands are explicit.
- Type consistency: all later tasks use the Task 1 marker names and the Task 2 `classroom/steps/next_step/completed` response shape; the teacher helper names in Task 3 are the only frontend call sites introduced by the plan.

## Execution handoff

The design and execution plan live at:

- `docs/plans/2026-08-31-classroom-first-use-onboarding-design.md`
- `docs/superpowers/plans/2026-08-31-classroom-first-use-onboarding.md`

Execute inline in this session using the task order above. Before editing implementation code, create an isolated worktree and follow the plan task by task with a red-green test cycle.
