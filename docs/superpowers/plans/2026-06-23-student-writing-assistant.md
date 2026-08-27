# Student Writing Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the student-facing writing assistant at `xiezuo.yingyuzuowen.asia` without exposing AI keys or changing the behavior of the existing broadcast, comment, or essay-grading products. New accounts receive a 7-day trial; paid plans are a ¥9.90 half-year card and a ¥17.80 annual card.

**Architecture:** Reuse the existing user account and HttpOnly cookie session. Route only the exact `xiezuo.yingyuzuowen.asia` host to a new static page. Add an independent SQLite membership record and auditable daily-use log; only an active membership may use the server-side AI and OCR proxies. The administrator renews a named user by an arbitrary number of days from the existing admin page.

**Tech Stack:** Node.js, Express, better-sqlite3, Vue 3 static page, existing Qwen OCR and MiniMax/DeepSeek server-side clients, Node built-in test runner.

---

### Task 1: Membership date calculation

**Files:**
- Create: `learning-membership.js`
- Create: `tests/learning-membership.test.js`

- [ ] **Step 1: Write failing tests for membership renewal behavior**

```js
test('extends an active membership from its current expiry', () => {
  assert.equal(addMembershipDays('2026-08-01T00:00:00.000Z', 180, now), '2027-01-28T00:00:00.000Z');
});

test('starts an expired membership from the renewal time', () => {
  assert.equal(addMembershipDays('2026-01-01T00:00:00.000Z', 180, now), '2026-12-28T00:00:00.000Z');
});
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run: `node --test tests/learning-membership.test.js`

Expected: failure resolving `learning-membership.js`.

- [ ] **Step 3: Add the smallest pure helper**

```js
function addMembershipDays(currentExpiresAt, days, now = new Date()) {
  const current = Date.parse(currentExpiresAt || '');
  const start = Number.isFinite(current) && current > now.getTime() ? new Date(current) : new Date(now);
  start.setUTCDate(start.getUTCDate() + days);
  return start.toISOString();
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test tests/learning-membership.test.js`

Expected: two passing tests.

### Task 2: Isolated learning membership persistence and API

**Files:**
- Modify: `db.js`
- Modify: `server.js`
- Modify: `tests/learning-membership.test.js`

- [ ] **Step 1: Write failing tests for the reusable membership validation helper**

```js
test('reports an inactive membership when no future expiry exists', () => {
  assert.deepEqual(getMembershipStatus(null, now), { active: false, expiresAt: null });
});
```

- [ ] **Step 2: Run the test and confirm it fails because `getMembershipStatus` is absent**

Run: `node --test tests/learning-membership.test.js`

Expected: failure naming `getMembershipStatus`.

- [ ] **Step 3: Implement additive SQLite tables and server routes**

Create `learning_memberships` (one expiry per user) and `learning_usage` (server-only fairness audit). Add `GET /api/learning/config`, `POST /api/learning/generate`, `POST /api/learning/ocr`, `POST /api/learning/payments/package`, and `POST /api/admin/learning-membership`. Every learning endpoint must use `userAuth`; the admin endpoint must use `adminAuth`. Validate tool IDs and text/image limits before calling an AI provider. Return generic provider failures without key or upstream endpoint details.

- [ ] **Step 4: Run syntax and unit tests**

Run: `node --check server.js && node --check db.js && node --test tests/learning-membership.test.js`

Expected: all commands exit zero.

### Task 3: Student app and host isolation

**Files:**
- Create: `public/xiezuo.html`
- Modify: `server.js`

- [ ] **Step 1: Add a failing host-routing assertion to the test module**

```js
test('recognizes only the student assistant host', () => {
  assert.equal(isLearningHost('xiezuo.yingyuzuowen.asia'), true);
  assert.equal(isLearningHost('zuowen.yingyuzuowen.asia'), false);
});
```

- [ ] **Step 2: Run the test and verify it fails because `isLearningHost` is absent**

Run: `node --test tests/learning-membership.test.js`

Expected: failure naming `isLearningHost`.

- [ ] **Step 3: Implement the authenticated student page**

Provide login/register, membership-expired status, a 7-day new-user trial, privacy warning, seven learning tools, image OCR, saved local notes, and calls only to `/api/learning/*`. Provide a renewal page for the ¥9.90 half-year and ¥17.80 annual cards through the existing payment provider. Do not place a model key, payment key, or admin credential in the page. The root route must select `xiezuo.html` only for the exact new hostname.

- [ ] **Step 4: Run static verification**

Run: `node --check server.js && node --test tests/learning-membership.test.js`

Expected: all commands exit zero.

### Task 4: Existing admin dashboard and deployment instructions

**Files:**
- Modify: `public/dashboard.html`
- Modify: `部署说明-作文批改助手.md`
- Modify: `essay-config.example.json`

- [ ] **Step 1: Add a manual verification checklist to the deployment document**

Include DNS for `xiezuo`, a dedicated HTTPS Nginx server block, the new `learning_base_url` setting, SQLite backup, service restart, and tests for unauthenticated access, expired membership, active membership, and an existing product URL.

- [ ] **Step 2: Add admin membership renewal controls**

The dashboard must show student membership expiry and offer a “续费天数” action. It submits a positive integer day count plus an optional note to `/api/admin/learning-membership`; it must not expose or create cards or AI keys.

- [ ] **Step 3: Run final verification**

Run: `node --check server.js && node --check db.js && node --test tests/learning-membership.test.js`

Expected: all commands exit zero.

### Scope review

- The only new host is `xiezuo.yingyuzuowen.asia`.
- The existing `zuowen`, `comment`, `notice`, and root-host routes remain unchanged.
- Membership dates are independent from existing broadcast and essay plans.
- The server remains the sole holder of all AI keys.
