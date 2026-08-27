# Essay Teaching Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the essay grader into a complete assignment, teacher review, student revision, class analytics, searchable history workflow while preserving existing grading and billing.

**Architecture:** Add normalized SQLite workflow tables and ownership-checked Express APIs, then extend the current Vue single-page application and add one token-based public revision page. Existing `essay_gradings` and endpoints remain backward compatible.

**Tech Stack:** Node.js, Express, better-sqlite3, Vue 3 CDN, node:test, Playwright/Chrome visual checks.

---

### Task 1: Contract tests

**Files:**
- Create: `tests/essay-teaching-workflow.test.js`
- Create: `tests/essay-workflow-page.test.js`

1. Add API tests for class/student/template/assignment CRUD, ownership, review finalization, public revision, history filtering and assignment report.
2. Add static/page tests for the four main workspaces, editable review controls, revision link, filters and responsive fixes.
3. Run `node --test tests/essay-teaching-workflow.test.js tests/essay-workflow-page.test.js` and confirm the tests fail because routes and UI do not exist.

### Task 2: SQLite workflow model

**Files:**
- Modify: `db.js`

1. Add the seven workflow tables and indexes.
2. Add mapping and CRUD helpers with user ownership filters.
3. Add filtered/paginated history and assignment aggregation helpers.
4. Run the API tests and confirm failures advance from missing schema/helpers to missing routes.

### Task 3: Express APIs and grading linkage

**Files:**
- Modify: `server.js`

1. Add authenticated class, student, rubric template and assignment routes.
2. Add submission/review/finalize/archive/copy routes.
3. Add token-based public revision GET/POST routes with validation.
4. Extend `/api/essay/grade` to accept assignment/submission/student/version context and update workflow state after grading.
5. Add filtered history and deterministic assignment report routes.
6. Run API tests and make them pass.

### Task 4: Teacher workspaces

**Files:**
- Modify: `public/zuowen.html`

1. Add accessible main navigation for workbench, classes/assignments, history and report.
2. Add assignment/rubric fields and template save/apply controls above single/batch grading.
3. Add class/student/assignment creation and status dashboard.
4. Replace read-only structured result with editable teacher review controls and finalization.
5. Add searchable history filters and edit/archive/copy actions.
6. Add assignment report UI.
7. Run page tests and inline-script compilation checks.

### Task 5: Student revision loop

**Files:**
- Create: `public/essay-revise.html`
- Modify: `server.js`
- Modify: `public/zuowen.html`

1. Build the token landing page with original draft, finalized feedback and revision editor.
2. Show revision status and side-by-side original/revised comparison in the teacher workspace.
3. Provide a second-grading action that uses the existing 50-point debit path.
4. Test invalid tokens, duplicate/empty submissions and successful revision submission.

### Task 6: Responsive and accessibility fixes

**Files:**
- Modify: `public/zuowen.html`
- Modify: `public/essay-revise.html`

1. Stop the fixed home/invite links from overlapping the mobile header.
2. Give form fields visible labels, use buttons for tabs, restore visible focus styles and improve footer contrast.
3. Reposition the camera button within the workbench on small screens.
4. Capture 1440px and 390px screenshots and verify no horizontal overflow.

### Task 7: Full verification and deployment

1. Run `node --test tests/*.test.js`.
2. Start a temporary server with an isolated SQLite file and smoke-test new routes.
3. Compile inline scripts and run browser screenshots for desktop/mobile.
4. Review `git diff --check` and scope the changed files.
5. Back up production files/database, deploy with the existing scripts, restart the service, and verify the live URL and public revision route without consuming points.

