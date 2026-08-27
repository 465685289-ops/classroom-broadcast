# 师行通用积分与 DeepSeek V4 切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为期末评语、思想圆桌和数学课件建立共享积分钱包、首充奖励和统一扣费，并切换到 `deepseek-v4-flash`。

**Architecture:** 新建一个接收 SQLite 连接的 `shixing-points.js`，让主服务和数学独立服务共用同一套迁移、余额、扣费与支付入账事务。旧三套流水只用于一次性余额迁移和旧订单兼容，之后三个产品统一读写共享积分流水。

**Tech Stack:** Node.js、better-sqlite3、Express、原生 HTTP 服务、静态 HTML/JavaScript。

## Global Constraints

- 评语 25 积分/次，圆桌 50 积分/话题，数学课件 75 积分/次。
- 9.9 元购买 5000 积分，首充赠 5000；19.9 元购买 10000 积分，首充赠 12000。
- 首充资格按整个师行账号终身一次。
- 旧余额按 25/50/75 等价迁入且不得重复。
- 广播和作文会员逻辑不变。
- 活跃产品不再使用 `deepseek-chat`。

---

### Task 1: 共享积分核心

**Files:**
- Create: `shixing-points.js`
- Create: `tests/shixing-points.test.js`

**Interfaces:**
- Produces: `createShixingPoints(db)`、`POINT_COSTS`、`POINT_PACKAGES`。
- Produces methods: `getBalance(user)`、`debit(row)`、`adjust(row)`、`addPayment(row)`、`hasPaidTopup(userId)`、`listLedger(userId, limit)`。

- [ ] **Step 1:** 写失败测试，覆盖旧余额迁移与迁移幂等。
- [ ] **Step 2:** 运行 `node --test tests/shixing-points.test.js`，确认因模块缺失而失败。
- [ ] **Step 3:** 实现共享表、迁移事务、25/50/75 扣费和余额不足保护。
- [ ] **Step 4:** 增加首充全局唯一、两个套餐、重复回调幂等测试并运行到失败。
- [ ] **Step 5:** 实现首充标记和支付入账事务，运行测试到通过。

### Task 2: 主服务评语与圆桌接入

**Files:**
- Modify: `db.js`
- Modify: `server.js`
- Test: `tests/shixing-points-integration.test.js`

**Interfaces:**
- Consumes: Task 1 的共享积分 API。
- Produces: 评语配置/生成/改写与圆桌配置/开始话题均返回共享 `balance` 和 `point_cost`；两个充值入口提供同一套餐。

- [ ] **Step 1:** 写失败的静态与数据库集成测试，断言主服务使用共享积分及新套餐。
- [ ] **Step 2:** 修改 `db.js`，让评语生成、改写、圆桌话题、邀请奖励、卡密和旧订单进入共享积分。
- [ ] **Step 3:** 修改 `server.js` 的套餐、支付回调、余额字段、扣费门槛和模型默认值。
- [ ] **Step 4:** 运行 Task 1/2 测试到通过。

### Task 3: 数学独立服务接入

**Files:**
- Modify: `edulab-product.js`
- Modify: `public/edulab/solver.html`
- Test: `tests/shixing-points-pages.test.js`

**Interfaces:**
- Consumes: Task 1 的共享积分 API。
- Produces: 数学 `/me`、`/generate`、`/pay/*` 使用共享余额，成功生成扣 75 分，缓存不扣分。

- [ ] **Step 1:** 写失败测试，断言数学服务共享钱包、75 分扣费和 V4 模型。
- [ ] **Step 2:** 替换数学次数表读写和旧套餐，保留旧订单回调兼容。
- [ ] **Step 3:** 将数学解题与课件模型改为 `deepseek-v4-flash`。
- [ ] **Step 4:** 运行页面与服务测试到通过。

### Task 4: 三端界面与配置

**Files:**
- Modify: `public/comment.html`
- Modify: `public/roundtable/index.html`
- Modify: `public/edulab/pro.html`
- Modify: `.env.example`
- Modify: `comment-config.example.json`
- Create: `scripts/update-deepseek-model.js`
- Create: `scripts/migrate-shixing-points.js`

**Interfaces:**
- Produces: 三端显示共享积分、25/50/75 消耗、首充赠送和同一套餐；配置脚本只更新模型字段；迁移脚本批量迁移全部用户。

- [ ] **Step 1:** 扩充失败页面测试，覆盖所有新文案和模型名。
- [ ] **Step 2:** 修改三端余额、套餐、支付成功与余额不足文案。
- [ ] **Step 3:** 编写模型配置更新与批量迁移脚本。
- [ ] **Step 4:** 运行相关测试与 `node --check` 到通过。

### Task 5: 部署与线上验证

**Files:**
- Deploy: `shixing-points.js`, `db.js`, `server.js`, `edulab-product.js`, three HTML pages, two scripts and model config.

**Interfaces:**
- Produces: 线上共享积分钱包和 V4 模型。

- [ ] **Step 1:** 备份 `broadcast.db`、主服务、数学服务、三端页面和配置文件。
- [ ] **Step 2:** 上传代码，运行模型配置更新与批量积分迁移。
- [ ] **Step 3:** 重启主服务和数学进程，确认无启动错误。
- [ ] **Step 4:** 验证三端配置/套餐/余额接口、服务日志、数据库迁移统计和线上文件哈希。
