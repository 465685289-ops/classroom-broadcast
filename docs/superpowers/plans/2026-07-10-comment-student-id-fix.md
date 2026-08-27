# 评语系统学生按钮失效修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让服务器花名册重新载入后的所有学生卡按钮恢复正常。

**Architecture:** 在 `public/comment.html` 的数据入口统一把学生 ID 规范为字符串，并在渲染内联事件时统一生成安全的字符串参数。用静态页面测试锁定这一契约，避免数字字符串再次被隐式转换成数字。

**Tech Stack:** 原生 HTML/JavaScript、Node.js 内置测试运行器、Express 静态部署。

## Global Constraints

- 不修改数据库结构和现有花名册数据。
- 不改变评语生成、扣费或登录接口。
- 只修复学生 ID 类型与按钮传参。

---

### Task 1: 增加花名册重载回归测试

**Files:**
- Create: `tests/comment-page.test.js`
- Test: `tests/comment-page.test.js`

**Interfaces:**
- Consumes: `public/comment.html` 中的 `normalizeStudent`、`studentIdArg` 和学生卡事件模板。
- Produces: 对字符串 ID 契约和全部学生卡事件传参的回归保护。

- [ ] **Step 1: Write the failing test**

测试应读取 `public/comment.html`，断言学生 ID 被 `String(...)` 规范化，并断言标签、编辑、删除、复制、生成和改写事件使用 `studentIdArg(s.id)`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/comment-page.test.js`

Expected: FAIL，因为旧页面没有 `studentIdArg`，且保留服务器返回的字符串 ID 后仍以数字形式传参。

### Task 2: 统一学生 ID 类型与事件参数

**Files:**
- Modify: `public/comment.html:621-631`
- Modify: `public/comment.html:1349-1375`

**Interfaces:**
- Consumes: 学生对象的 `id`。
- Produces: `studentIdArg(id) -> HTML-safe JavaScript string literal`。

- [ ] **Step 1: Implement the minimal fix**

在 `normalizeStudent` 中将 ID 统一为字符串；新增 `studentIdArg`；所有学生卡内联事件均通过该函数传递 ID。

- [ ] **Step 2: Run targeted test**

Run: `node --test tests/comment-page.test.js`

Expected: PASS。

### Task 3: 验证并部署

**Files:**
- Deploy: `public/comment.html`

**Interfaces:**
- Consumes: 通过测试的静态页面。
- Produces: 线上可用的评语系统。

- [ ] **Step 1: Run related tests and syntax checks**

Run: `node --check server.js && node --check db.js && node --test tests/comment-page.test.js tests/registration-pages.test.js`

Expected: 全部通过。

- [ ] **Step 2: Back up and deploy**

备份线上 `public/comment.html`，上传修复文件；静态页面无需重启服务。

- [ ] **Step 3: Verify live artifact**

下载线上页面并比较 SHA-256，确认修复内容存在；检查 `/api/comment/generate` 未登录仍返回 401，证明路由正常。
