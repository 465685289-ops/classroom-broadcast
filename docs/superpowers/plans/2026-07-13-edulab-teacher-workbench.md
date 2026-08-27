# 师行数学教师工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有数学课件生成单页升级为面向教师的完整工作台，并让课件管理操作使用真实后端数据。

**Architecture:** 保留 `edulab-product.js` 的生成、积分、支付与邀请流程，在现有课件表上增量增加元数据字段和用户隔离的管理接口。前端继续使用无构建步骤的 HTML/CSS/JavaScript，将样式和交互拆成独立文件，`pro.html` 作为教师平台入口，`lab.html` 作为互动工具子页。

**Tech Stack:** Node.js、better-sqlite3、原生 HTML/CSS/JavaScript、Cropper.js、KaTeX、Node test runner。

## Global Constraints

- 访客可查看完整平台并上传或填写题目，点击生成时才要求登录。
- 每次新生成消耗 75 师行积分；同题缓存不重复扣费。
- 保留共享账号、邮箱验证码注册、统一积分、充值与邀请流程。
- 不加入虚假学习数据、成绩预测或学生端功能。
- 所有课件管理接口必须按当前登录用户隔离。

---

### Task 1: 课件元数据模型与 API

**Files:**
- Create: `edulab-courseware.js`
- Modify: `edulab-product.js`
- Test: `tests/edulab-teacher-platform.test.js`

**Interfaces:**
- Produces: `normalizeCoursewarePatch(input)`、`normalizeTeachingPreferences(input)`、`deriveCoursewareTitle(problem, type)`。
- Produces API: `GET /edulab-api/history`、`PATCH /edulab-api/history/:id`、`DELETE /edulab-api/history/:id`。

- [ ] **Step 1: Write the failing tests**

```js
test('courseware metadata is bounded and normalized', () => {
  const result = normalizeCoursewarePatch({ title: '  二次函数  ', knowledge_points: ['函数', '函数'], favorite: true });
  assert.deepEqual(result, { title: '二次函数', knowledge_points: ['函数'], favorite: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/edulab-teacher-platform.test.js`
Expected: FAIL because `edulab-courseware.js` and the management routes do not exist.

- [ ] **Step 3: Implement the model and routes**

Add safe migrations for `title TEXT`, `knowledge_points TEXT`, `favorite INTEGER DEFAULT 0`, and `deleted_at TEXT`. Normalize patches, return stable IDs from history and generation, use user-scoped update/delete statements, and add `PATCH, DELETE` to CORS methods.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/edulab-teacher-platform.test.js`
Expected: PASS.

### Task 2: 教师工作台界面

**Files:**
- Create: `public/edulab/teacher-workbench.css`
- Create: `public/edulab/teacher-workbench.js`
- Modify: `public/edulab/pro.html`
- Test: `tests/edulab-teacher-platform.test.js`

**Interfaces:**
- Consumes: `/me`、`/history`、`/generate`、课件元数据管理 API、现有支付与统一账号 API。
- Produces: hash 路由 `#dashboard`、`#generator`、`#library`、`#knowledge`、`#account`。

- [ ] **Step 1: Add failing structural tests**

Assert that the page contains the six teacher navigation entries, real metric elements, upload and text input paths, the four-stage generation progress, searchable courseware management, knowledge cards, delayed authentication, mobile bottom navigation, and external workbench assets.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `node --test tests/edulab-teacher-platform.test.js`
Expected: FAIL because the existing generator is still a narrow single-purpose page.

- [ ] **Step 3: Build the new workbench**

Use a fixed desktop rail, compact top bar, metric strip, upload-first action panel, recent courseware list, guide rail and real empty states. Preserve crop, paste, login/register, recharge, preview, solution rendering and generation logic. Add metadata editing, favorite, delete, search and filters.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/edulab-teacher-platform.test.js tests/platform-shell.test.js tests/shixing-points-pages.test.js`
Expected: PASS.

### Task 3: 平台导航一致性与视觉 QA

**Files:**
- Modify: `public/edulab/lab.html`
- Modify: `design-qa.md`
- Create: `previews/edulab-teacher-platform-2026-07-13/`
- Test: `tests/edulab-teacher-platform.test.js`

**Interfaces:**
- Consumes: workbench hash routes.
- Produces: consistent links between workbench, generator, library, knowledge page and interactive lab.

- [ ] **Step 1: Add failing navigation assertions**

Check that lab links point to `pro.html#dashboard`, `pro.html#generator`, `pro.html#library` and `pro.html#knowledge`.

- [ ] **Step 2: Patch navigation and run the focused tests**

Run: `node --test tests/edulab-teacher-platform.test.js tests/edulab-math-lab.test.js`
Expected: PASS.

- [ ] **Step 3: Capture desktop and mobile states**

Capture dashboard, generator, library and a 390px mobile view. Verify no blank primary areas, no page-level horizontal overflow, visible primary action, keyboard labels, and no console errors.

- [ ] **Step 4: Record QA findings**

Append the viewport, state, screenshot paths, findings, interaction evidence and `final result: passed` only when no P0/P1/P2 issues remain.

### Task 4: Regression and production deployment

**Files:**
- Deploy: `edulab-product.js`, `edulab-courseware.js`, `public/edulab/pro.html`, `public/edulab/teacher-workbench.css`, `public/edulab/teacher-workbench.js`, `public/edulab/lab.html`

**Interfaces:**
- Produces: live teacher platform at `https://notice.yingyuzuowen.asia/edulab/pro.html`.

- [ ] **Step 1: Run all tests and static checks**

Run: `node --test tests/*.test.js`
Expected: all tests pass.

Run: `git diff --check`
Expected: no output.

- [ ] **Step 2: Back up production files and database**

Create a timestamped directory under `/home/admin/backups/` and copy each file plus the SQLite database before deployment.

- [ ] **Step 3: Upload files and restart only the math service**

Deploy the scoped files, restart `edulab-product`, and confirm both `edulab-product` and `classroom-broadcast` are active.

- [ ] **Step 4: Verify production**

Check HTTP 200 for the page and assets, compare local/server/live hashes, call `/edulab-api/me`, and inspect the production page at desktop and mobile widths.
