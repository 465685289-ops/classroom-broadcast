# 师行统一账号库 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将师行所有产品和教师工作台的注册、登录、找回密码统一到 `broadcast.db` 的唯一账号库，并安全移除工作台本地认证凭据。

**Architecture:** `classroom-broadcast` 提供唯一认证 API 和共享 Cookie；各静态产品直接调用它，教师工作台通过适配层调用它并只保留教师业务资料。老用户名继续兼容，新账号以验证邮箱为账号名。

**Tech Stack:** Node.js, Express, SQLite, React, TypeScript, Node test runner, Vite

---

### Task 1: 固化主账号 API 新契约

**Files:**
- Modify: `tests/registration-api.test.js`
- Create: `tests/unified-account-auth.test.js`
- Modify: `server.js`
- Modify: `db.js`

**Step 1: Write the failing tests**

新增测试证明：注册不需要自定义用户名且邮箱成为账号名；邮箱和旧用户名都可登录；找回密码只传邮箱即可完成发码、验证和重置；重复旧联系方式不能模糊重置。

**Step 2: Run tests to verify they fail**

Run: `node --test --test-concurrency=1 tests/registration-api.test.js tests/unified-account-auth.test.js`

Expected: FAIL，因为现有注册仍要求 `username`，找回密码仍要求用户名。

**Step 3: Implement the minimal API changes**

在 `server.js` 增加统一的账号查找辅助函数，将注册账号名固定为规范化邮箱；登录接受邮箱或旧用户名；找回密码由邮箱在服务端解析内部用户名。保持现有验证码频控、散列和一次性消费逻辑。

**Step 4: Run focused tests**

Run: `node --test --test-concurrency=1 tests/registration-api.test.js tests/unified-account-auth.test.js`

Expected: PASS.

**Step 5: Commit**

Run: `git add server.js db.js tests/registration-api.test.js tests/unified-account-auth.test.js && git commit -m "feat: 统一师行邮箱账号认证契约"`

### Task 2: 统一所有静态产品的账号表单

**Files:**
- Modify: `public/teacher.html`
- Modify: `public/comment.html`
- Modify: `public/zuowen.html`
- Modify: `public/english.html`
- Modify: `public/xiezuo.html`
- Modify: `public/roundtable/index.html`
- Modify: `public/edulab/pro.html`
- Modify: `public/edulab/teacher-workbench.js`
- Modify: `public/shixing/index.html`
- Modify: `tests/registration-pages.test.js`
- Modify: related page contract tests under `tests/`

**Step 1: Write failing page-contract tests**

断言所有注册入口只有邮箱、验证码、显示名称、密码；登录提示支持邮箱和旧用户名；师行首页提供统一账号入口。

**Step 2: Run tests to verify they fail**

Run: `node --test --test-concurrency=1 tests/registration-pages.test.js tests/platform-shell.test.js tests/english-page.test.js tests/xiezuo-page.test.js`

Expected: FAIL，页面仍存在注册用户名字段和旧登录文案。

**Step 3: Update each client**

逐页移除注册用户名输入及请求字段，显示名称单独提交；登录请求继续兼容使用 `username` 字段承载邮箱或旧用户名，避免破坏现有 API 消费者。

**Step 4: Run focused tests**

Run: `node --test --test-concurrency=1 tests/registration-pages.test.js tests/platform-shell.test.js tests/english-page.test.js tests/xiezuo-page.test.js`

Expected: PASS.

**Step 5: Commit**

Run: `git add public tests && git commit -m "feat: 统一各产品邮箱账号入口"`

### Task 3: 将教师工作台认证改为主账号适配层

**Files:**
- Create: `server/shixing-auth-client.mjs`
- Create: `tests/shixing-auth-client.test.mjs`
- Modify: `server/index.mjs`
- Modify: `src/api.ts`
- Modify: `src/auth/AuthPage.tsx`
- Modify: `tests/account-api.test.mjs`
- Modify: `tests/workbench-sso-exchange.test.mjs`

**Step 1: Write failing adapter tests**

使用本地假主服务验证：工作台发码、注册、登录和密码重置都调用主服务端点；注册/登录成功后按主账号 ID 创建工作台会话；错误状态与文案正确透传。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/shixing-auth-client.test.mjs tests/account-api.test.mjs tests/workbench-sso-exchange.test.mjs`

Expected: FAIL，因为工作台仍使用本地认证。

**Step 3: Implement the adapter**

新增主账号 HTTP 客户端；将工作台 `/api/auth/email-code`、`/api/auth/register`、`/api/auth/login`、`/api/auth/password/reset` 改为调用主服务。工作台仍返回自身业务会话，但不再生成或验证本地密码。

**Step 4: Update AuthPage**

保留注册、登录、找回密码完整界面；注册流程改为邮箱验证码、显示名称、密码及教师资料一次提交；登录支持邮箱和旧用户名。

**Step 5: Run focused tests and build**

Run: `node --test tests/shixing-auth-client.test.mjs tests/account-api.test.mjs tests/workbench-sso-exchange.test.mjs && npm run lint && npm run build`

Expected: PASS.

**Step 6: Commit**

Run: `git add server src tests && git commit -m "feat: 教师工作台接入统一账号库"`

### Task 4: 清除工作台本地密码并绑定 11 个既有账号

**Files:**
- Modify: `server/index.mjs`
- Modify: `tests/account-security.test.mjs`
- Create: `scripts/inspect-unified-account-migration.mjs`
- Create: `tests/unified-account-migration.test.mjs`

**Step 1: Write failing migration tests**

构造包含 11 类用户关系的状态，断言迁移后每个教师资料都有 `shixingUserId`，班级成员 ID 不变，且用户 JSON 不含任何 `password*` 字段。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/unified-account-migration.test.mjs tests/account-security.test.mjs`

Expected: FAIL，因为当前状态仍保存工作台密码字段。

**Step 3: Implement state version migration**

提升工作台状态版本，删除本地密码与本地邮箱验证码；账号绑定由部署前迁移脚本根据既有 `shixingUserId` 或唯一邮箱生成映射，遇到不唯一或无匹配必须停止而不是猜测。

**Step 4: Run migration tests**

Run: `node --test tests/unified-account-migration.test.mjs tests/account-security.test.mjs`

Expected: PASS.

**Step 5: Commit**

Run: `git add server scripts tests && git commit -m "refactor: 工作台仅保留教师业务资料"`

### Task 5: 两仓库全量验证

**Files:**
- Modify only if a test exposes a real regression.

**Step 1: Run classroom-broadcast full suite**

Run: `npm test`

Expected: all tests PASS.

**Step 2: Run workbench full suite**

Run: `npm test && npm run lint && npm run build`

Expected: all tests PASS and production build succeeds.

**Step 3: Verify clean diffs and secrets**

Run: `git diff --check && git status --short`

Expected: only intended source, tests and plan files; no credentials or production data.

### Task 6: 生产迁移与端到端验收（仅在用户明确要求上线后执行）

**Files:**
- Production: `/home/admin/classroom-broadcast/broadcast.db`
- Production: `/opt/student-growth-platform/data/app.sqlite`

**Step 1: Back up both databases and deployed files**

创建同一时间戳的只读备份，执行 SQLite 完整性检查并记录 SHA-256。

**Step 2: Run dry-run migration inspection**

Expected: 工作台 11 个账号全部有确定主账号映射，6 个班级保持不变，无歧义和无匹配项。

**Step 3: Deploy verified artifacts**

按两个仓库各自部署规则上传，重启 `classroom-broadcast.service` 与 `student-growth` PM2 进程。

**Step 4: Run production E2E**

逐项验证首页及各产品“发码—注册—登录—首个业务接口”；另验证旧用户名登录、邮箱找回密码、工作台已有班级和跨产品共享积分。

**Step 5: Report states separately**

分别报告已提交、已推送、已部署及生产验收结果，任何一步未完成都不得称为上线。

