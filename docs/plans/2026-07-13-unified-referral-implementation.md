# 师行统一邀请体系 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将评语、作文、思想圆桌、数学课件和教室广播统一为一条邀请链接、一条全平台邀请关系，并实现激活与首次付费两阶段奖励。

**Architecture:** 新增可被主服务和数学独立服务共同加载的 `unified-referrals.js` 数据域模块，负责关系、事件、幂等、迁移、积分奖励和风控状态。`server.js` 负责注册归因、广播会员奖励、消息通知和 HTTP API；`edulab-product.js` 在数学生成与支付成功后调用同一数据域模块。前端统一进入 `/invite/:code`，各产品原邀请链接继续兼容。

**Tech Stack:** Node.js、Express、better-sqlite3、原生 HTML/CSS/JavaScript、Node test runner。

---

### Task 1: 全局邀请数据域与旧关系迁移

**Files:**
- Create: `unified-referrals.js`
- Create: `tests/unified-referrals.test.js`

**Step 1: Write the failing tests**

- 测试一个受邀用户只能绑定一个邀请人。
- 测试激活奖励只发一次，邀请人与受邀人各加 500 积分。
- 测试首次付费奖励只发一次，积分订单给邀请人 1500 积分，广播订单返回 30 天奖励。
- 测试超过同设备 2 人或邀请人当月 10 人后进入 `pending`，不丢失事件。
- 测试旧评语、作文、广播关系按最早时间合并，冲突被记录，已奖励状态不重复发奖。

**Step 2: Run test to verify it fails**

Run: `node --test tests/unified-referrals.test.js`

Expected: FAIL because `unified-referrals.js` does not exist.

**Step 3: Implement minimal domain module**

- 建立 `global_referrals`、`referral_events`、`referral_clicks` 表和唯一索引。
- 提供 `bindReferral`、`activateReferral`、`rewardFirstPurchase`、`reversePurchaseReward`、`getReferralCenter`、`getAdminStats`、`migrateLegacyReferrals`。
- 积分奖励写入共享 `shixing_point_ledger`。
- 所有奖励操作使用 SQLite 事务和唯一约束保证幂等。

**Step 4: Run tests to verify they pass**

Run: `node --test tests/unified-referrals.test.js`

Expected: PASS.

### Task 2: 注册归因与统一邀请接口

**Files:**
- Modify: `db.js`
- Modify: `server.js`
- Create: `tests/unified-referral-api.test.js`

**Step 1: Write the failing API tests**

- `GET /invite/:code` 对有效邀请码设置 7 天签名父域 Cookie 并返回统一邀请页。
- `POST /api/register` 接收 Cookie 或请求体邀请码，并在注册事务中绑定全局关系。
- 无效、自邀、重复绑定和老账号返回明确状态。
- `GET /api/referral` 返回唯一链接、好友状态、奖励统计和当月额度。
- 旧 `/api/comment|essay|broadcast/referral` 接口返回统一关系或兼容跳转信息。

**Step 2: Run tests to verify expected failures**

Run: `node --test tests/unified-referral-api.test.js`

Expected: FAIL on missing routes and unified binding.

**Step 3: Implement registration attribution**

- 在邀请码落地页设置签名 Cookie `shixing_ref`，Domain 为 `.yingyuzuowen.asia`，SameSite=Lax，Max-Age=7天。
- 注册接口优先读取请求体 `ref`，其次读取签名 Cookie。
- 新账号写入后立即绑定；关系写入失败时回滚账号创建。
- 增加统一邀请中心和管理员统计 API。

**Step 4: Run API and registration regression tests**

Run: `node --test tests/unified-referral-api.test.js tests/registration-api.test.js`

Expected: PASS.

### Task 3: 五产品首次有效使用钩子

**Files:**
- Modify: `server.js`
- Modify: `edulab-product.js`
- Modify: `db.js`
- Modify: `tests/shixing-points-integration.test.js`
- Modify: `tests/platform-shell.test.js`

**Step 1: Write failing integration tests**

- 评语成功生成后触发统一激活。
- 作文成功批改后触发统一激活，包括旧会员免扣积分批改。
- 圆桌成功创建话题后触发统一激活。
- 数学课件成功生成并扣费后触发统一激活。
- 广播通知成功持久化后触发统一激活。
- 五种入口共享同一激活事件，后续产品不得重复发奖。

**Step 2: Run tests to verify failures**

Run: `node --test tests/shixing-points-integration.test.js tests/platform-shell.test.js`

Expected: FAIL because product hooks do not call unified activation.

**Step 3: Add minimal hooks**

- 在业务结果与账本成功提交后调用 `activateReferral`。
- 主服务生成邀请奖励到账消息。
- 数学独立服务返回 `referral_reward`，前端显示受邀人到账提示。

**Step 4: Run targeted tests**

Run: `node --test tests/unified-referrals.test.js tests/shixing-points-integration.test.js tests/platform-shell.test.js`

Expected: PASS.

### Task 4: 统一首次付费与退款冲正

**Files:**
- Modify: `server.js`
- Modify: `edulab-product.js`
- Modify: `unified-referrals.js`
- Modify: `tests/unified-referrals.test.js`

**Step 1: Write failing tests**

- 任意积分产品的第一笔真实支付触发一次 1500 积分奖励。
- 广播会员为第一笔支付时触发一次 30 天会员奖励。
- 后续跨产品支付不重复发奖。
- 重复支付回调不重复发奖。
- 退款生成反向流水且幂等。

**Step 2: Verify red**

Run: `node --test tests/unified-referrals.test.js`

Expected: FAIL on first-purchase/reversal scenarios.

**Step 3: Implement payment hooks**

- 主支付回调不再按 `source_product` 查旧产品关系，统一查全局关系。
- 数学支付回调调用同一首次付费函数。
- 广播奖励由主服务按事件结果延长 30 天并记录可冲正状态。
- 保留旧奖励流水，仅停止新旧系统重复发奖。

**Step 4: Verify green**

Run: `node --test tests/unified-referrals.test.js tests/shixing-points-integration.test.js`

Expected: PASS.

### Task 5: 统一邀请落地页与邀请中心

**Files:**
- Create: `public/shixing/invite.html`
- Modify: `public/shixing/index.html`
- Modify: `public/comment.html`
- Modify: `public/zuowen.html`
- Modify: `public/roundtable/index.html`
- Modify: `public/edulab/pro.html`
- Modify: `public/teacher.html`
- Create: `tests/unified-referral-pages.test.js`

**Step 1: Write failing page tests**

- 统一页面展示邀请人、1625积分、3天广播、双方各500积分和五产品入口。
- 五个平台“邀请有礼”都使用同一 `/api/referral` 与统一链接。
- 注册表单在存在邀请凭证时展示邀请来源和双方奖励。
- 旧产品链接仍能保存邀请码并跳向统一页。

**Step 2: Verify red**

Run: `node --test tests/unified-referral-pages.test.js`

Expected: FAIL because unified page and controls are missing.

**Step 3: Implement pages**

- 建立米黄色师行风格邀请落地页。
- 各子产品入口改为统一邀请中心，不再展示不同奖励规则。
- 继续保持“先体验，生成时注册”。
- 增加待注册、待首次使用、已激活、已付费、审核中状态列表。

**Step 4: Verify page scripts**

Run: `node --test tests/unified-referral-pages.test.js tests/shixing-points-pages.test.js tests/platform-shell.test.js`

Expected: PASS.

### Task 6: 管理后台、迁移报告与上线验证

**Files:**
- Modify: `public/admin.html`
- Modify: `public/dashboard.html`
- Create: `scripts/referral-migration-report.js`
- Create: `tests/unified-referral-migration.test.js`

**Step 1: Write failing tests**

- 迁移报告只读输出合并数、冲突数、已激活数、已付费数。
- 管理 API 返回漏斗、奖励成本和审核列表。
- 管理员可批准或拒绝待审核事件，操作幂等。

**Step 2: Verify red**

Run: `node --test tests/unified-referral-migration.test.js`

Expected: FAIL on missing report and review API.

**Step 3: Implement reporting and review UI**

- 增加只读迁移脚本和后台摘要卡片。
- 增加待审核列表、通过、拒绝操作。
- 禁止直接删除已发放事件。

**Step 4: Full verification**

Run: `node --check server.js && node --check db.js && node --check unified-referrals.js && node --check edulab-product.js && node --test tests/*.test.js`

Expected: all checks pass, zero failed tests.

### Task 7: Production migration and deployment

**Files:**
- Deploy only verified runtime files and migration script.

**Step 1: Back up production**

- Create a SQLite online backup and a tar archive of every replaced file.

**Step 2: Run the read-only migration report**

- Save the report in production backups.
- Stop if the report contains unresolved structural errors.

**Step 3: Deploy and migrate**

- Upload to a temporary directory.
- Install files atomically with correct ownership.
- Restart `classroom-broadcast` and `edulab-product`.

**Step 4: Production verification**

- Confirm service health, HTTP 200s, schema indexes and local/remote checksums.
- Test one complete invitation flow with non-production test accounts only if credentials are available; otherwise validate read-only routes and document that live payment remains callback-tested rather than charged.
