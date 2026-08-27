# Unified Admin Console Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the split dashboard/admin experience with one secure, resilient admin console covering overview, users, finance, products, referrals, support, and system audit.

**Architecture:** Keep the existing Express + SQLite backend and static HTML frontend. Add a short-lived HttpOnly admin session cookie while retaining header-token compatibility for operational scripts, consolidate read APIs for the new console, and redirect the old dashboard URL. Store administrator mutations in a SQLite audit table and load each UI section independently so one failed endpoint does not block the whole console.

**Tech Stack:** Node.js, Express, better-sqlite3, vanilla HTML/CSS/JavaScript, node:test.

---

### Task 1: Lock the unified console contract

**Files:**
- Create: `tests/unified-admin-console.test.js`
- Modify: none

1. Add failing static tests for one canonical admin page, seven sections, no password in localStorage, dashboard redirect, one copy of each mutation route, and valid inline JavaScript.
2. Add failing API tests for admin login cookie, session authentication, logout, and invalid passwords.
3. Run `node --test tests/unified-admin-console.test.js` and confirm the expected failures.

### Task 2: Add secure administrator sessions and audit logging

**Files:**
- Modify: `server.js`
- Modify: `db.js`
- Test: `tests/unified-admin-console.test.js`

1. Add an HttpOnly, SameSite=Strict admin session cookie with a 12-hour in-memory token lifetime.
2. Add `/api/admin/login`, `/api/admin/logout`, and `/api/admin/session`.
3. Keep `X-Token: ADMIN_PASS` compatibility for scripts, but never store or return the password.
4. Add `admin_audit_logs` and write entries for points, membership, account activation, password reset, and referral review.
5. Run the focused tests to green.

### Task 3: Consolidate backend reads and clean drift

**Files:**
- Modify: `server.js`
- Modify: `db.js`
- Test: `tests/unified-admin-console.test.js`

1. Redirect `/dashboard.html` to `/admin.html#overview`.
2. Remove duplicate activation and password-reset routes.
3. Replace legacy referral statistics in the dashboard payload with unified referral statistics.
4. Add paginated user search, order listing, all-product metrics, user detail, and audit-log endpoints.
5. Include roundtable, math, shared points, and unified referral metrics.
6. Run focused API/static tests to green.

### Task 4: Build the single admin interface

**Files:**
- Replace: `public/admin.html`
- Retain as redirect target only: `public/dashboard.html`
- Test: `tests/unified-admin-console.test.js`

1. Build a warm-beige responsive shell matching the current 师行 design.
2. Add navigation for 概览、用户、财务、产品、邀请、客服、系统.
3. Reuse the dashboard charts and existing management actions inside section panels.
4. Use proper forms/modals for mutations with explicit summaries and required notes instead of prompt-driven operations.
5. Load sections independently and show per-section error/empty/loading states.
6. Label broadcast plans as 半年会员.
7. Run script compilation and focused tests.

### Task 5: Verify, deploy, and smoke test

**Files:**
- Modify only if verification finds defects.

1. Run `node --check server.js`, `node --check db.js`, inline-script compilation, and `node --test tests/*.test.js`.
2. Back up the production database and current admin/server files.
3. Deploy changed files, restart both services if required, and verify service health.
4. Verify `/dashboard.html` redirects, `/admin.html` loads, login/session/logout work, and read-only sections return data.
5. Check logs for new warnings or errors.
