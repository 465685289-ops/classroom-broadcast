# 师行互动数学实验室实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将选中的“互动数学实验室”视觉方案落到现有师行数学平台，提供真实可用的函数编辑、参数探索、课堂步骤与全屏演示，同时保留现有拍题生成、题库、积分和登录流程。

**Architecture:** 新建独立但同属 `/edulab/` 的实验室页面；将表达式解析与采样拆为纯 JavaScript 核心，页面控制器只负责 DOM、Canvas 和响应式交互。现有 `pro.html` 不重写生成逻辑，只补统一导航壳，降低线上回归风险。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Canvas 2D、Font Awesome、Node.js `node:test`、现有 Express 静态文件服务。

## Global Constraints

- 保留师行米黄色品牌基调，桌面端使用深墨棕侧栏和铜金色主操作。
- 实验室核心功能不要求登录；跳转到 AI 生成时沿用现有“生成时再登录”流程。
- 不新增收费接口，不在浏览器本地伪扣积分。
- 不改变 `/edulab-api/generate` 的现有图片生成协议。
- 手机端不出现横向滚动，主操作按钮和函数编辑器必须可用。

---

### Task 1: 数学表达式核心

**Files:**
- Create: `public/edulab/math-lab-core.js`
- Create: `tests/edulab-math-lab.test.js`

**Interfaces:**
- Produces: `MathLabCore.compileExpression(expression)`、`sampleExpression(expression, parameterA, minX, maxX, sampleCount)`、`formatNumber(value)`。

- [ ] **Step 1: Write the failing test**

```js
test('math lab evaluates supported expressions without eval', () => {
  const core = require('../public/edulab/math-lab-core.js');
  assert.equal(core.compileExpression('2*a*x^2-1')({ x: 2, a: 0.5 }), 3);
  assert.ok(Math.abs(core.compileExpression('sin(x)')({ x: Math.PI / 2, a: 1 }) - 1) < 1e-9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/edulab-math-lab.test.js`

Expected: FAIL because `math-lab-core.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement a tokenizer and recursive-descent parser for numbers, `x`, `a`, `pi`, `e`, `+ - * / ^`, parentheses, and `sin cos tan sqrt abs ln log exp`. Do not use `eval` or `new Function`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/edulab-math-lab.test.js`

Expected: PASS.

### Task 2: 互动数学实验室界面

**Files:**
- Create: `public/edulab/lab.html`
- Create: `public/edulab/math-lab.js`
- Modify: `tests/edulab-math-lab.test.js`

**Interfaces:**
- Consumes: `window.MathLabCore`.
- Produces: Canvas 函数图像、函数显隐/编辑/添加/删除、参数 `a` 滑块、快捷模板、步骤切换、重置、全屏演示。

- [ ] **Step 1: Write the failing page contract tests**

```js
assert.match(page, /id="mathCanvas"/);
assert.match(page, /id="parameterA"/);
assert.match(page, /互动数学实验室/);
assert.match(page, /课堂讲解步骤/);
assert.match(page, /@media\s*\(max-width:\s*760px\)/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/edulab-math-lab.test.js`

Expected: FAIL because `lab.html` does not exist.

- [ ] **Step 3: Implement the selected visual target**

Build a 1440px desktop layout with a 180px navigation rail, a 240px function editor, a flexible graph canvas, and a 260px teaching-step panel. On small screens, turn the navigation into a horizontal strip and stack tools, graph and steps.

- [ ] **Step 4: Implement interactions**

Bind input changes, visibility toggles, add/remove controls, template buttons, parameter slider, canvas resize, step selection and fullscreen. Invalid expressions show an inline error and never stop other curves from rendering.

- [ ] **Step 5: Run tests**

Run: `node --test tests/edulab-math-lab.test.js tests/edulab-desktop-workbench.test.js tests/platform-shell.test.js`

Expected: PASS.

### Task 3: 统一数学平台导航壳

**Files:**
- Modify: `public/edulab/pro.html`
- Modify: `tests/edulab-math-lab.test.js`

**Interfaces:**
- Produces: 桌面深色侧栏、手机顶部导航、到 `lab.html` 的稳定入口；现有生成、题库、充值与登录函数保持不变。

- [ ] **Step 1: Write the failing navigation test**

```js
assert.match(generator, /class="math-platform-nav"/);
assert.match(generator, /href="lab\.html"[^>]*>[^<]*互动实验室/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/edulab-math-lab.test.js`

Expected: FAIL because the generator has no unified navigation.

- [ ] **Step 3: Add navigation without rewriting generator behavior**

Add the shared rail and responsive rules, update `setAccount` to mirror account name/points in the rail, and keep the original accessibility labels and auth dialog.

- [ ] **Step 4: Run targeted and full tests**

Run: `node --test tests/*.test.js`

Expected: all tests PASS.

### Task 4: 视觉验收与上线

**Files:**
- Create: `previews/edulab-interactive-lab-2026-07-13/01-desktop.png`
- Create: `previews/edulab-interactive-lab-2026-07-13/02-mobile.png`
- Modify: `design-qa.md`

**Interfaces:**
- Consumes: 选中的第 3 张生成设计图。
- Produces: 同视口视觉对照、通过的设计 QA、生产备份和线上验证结果。

- [ ] **Step 1: Capture desktop and mobile states**

Capture `lab.html` at 1440×1024 and 390×844 after exercising the parameter slider and one function edit.

- [ ] **Step 2: Compare against the selected target**

Check layout ratios, hierarchy, colors, spacing, line weights, graph readability, clipped content and mobile reflow. Record P0-P3 findings in `design-qa.md`.

- [ ] **Step 3: Fix blocking findings and rerun tests**

Run: `node --test tests/*.test.js && git diff --check`

Expected: tests PASS and no whitespace errors.

- [ ] **Step 4: Back up and deploy**

Back up changed production files, upload them to `/home/admin/classroom-broadcast/public/edulab/`, restart only if the server requires it, and verify live HTTP 200 plus exact content markers.

