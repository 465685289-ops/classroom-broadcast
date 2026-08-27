const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'xiezuo.html'), 'utf8');

test('keeps the writing workbench visible before a student signs in', () => {
  assert.match(page, /class="workspace"/);
  assert.doesNotMatch(page, /<section v-if="!user" class="card"><h2>学生登录/);
});

test('opens authentication only when a guest starts an AI action', () => {
  assert.match(page, /function requireAuth\(action\)/);
  assert.match(page, /if\(!requireAuth\('generate'\)\)return/);
  assert.match(page, /if\(!requireAuth\('ocr'\)\)return/);
});

test('submits the writing workbench as its own learning tool', () => {
  assert.match(page, /run\('workbench'\)/);
  assert.doesNotMatch(page, /toolKey==='workbench'\)\{apiTool='review'/);
  assert.match(page, /JSON\.stringify\(\{tool:apiTool,input,grade:grade\.value\}\)/);
});

test('shows a real usage guide target for the guide button', () => {
  assert.match(page, /id="usage-guide"/);
  assert.match(page, /使用指南/);
  assert.match(page, /document\.getElementById\('usage-guide'\)/);
});

test('shows tool-specific usage guidance for every writing section', () => {
  assert.match(page, /const toolGuides=/);
  for (const key of ['workbench', 'guide', 'review', 'material', 'outline', 'opening', 'title', 'practice']) {
    assert.match(page, new RegExp(key + ':\\{title:'));
  }
  assert.match(page, /activeGuide=computed/);
  assert.match(page, /activeGuide\.title/);
  assert.match(page, /v-for="\(step,i\) in activeGuide\.steps"/);
  assert.match(page, /guideStepIcon\(i\)/);
  assert.match(page, /icons:\[/);
  const guideTemplate = page.slice(page.indexOf('id="usage-guide"'), page.indexOf('<section v-if="user&&growth"'));
  assert.doesNotMatch(guideTemplate, /fa-regular fa-circle-check/);
});

test('keeps the dynamic usage guide as the first visible right rail card', () => {
  const guideIndex = page.indexOf('id="usage-guide"');
  const growthIndex = page.indexOf('class="rail-card"><h2 class="rail-title">成长体系');
  const progressIndex = page.indexOf('class="rail-card"><h2 class="rail-title">写作进度');
  const tipIndex = page.indexOf('class="rail-card"><h2 class="rail-title">写作小贴士');
  assert.ok(guideIndex > 0, 'usage guide card should exist');
  assert.ok(guideIndex < growthIndex, 'usage guide should appear before growth card');
  assert.ok(guideIndex < progressIndex, 'usage guide should appear before progress card');
  assert.ok(guideIndex < tipIndex, 'usage guide should appear before writing tips');
  assert.match(page, /\.right-rail\{[^}]*position:sticky/);
  assert.match(page, /\.feature-icon\{[^}]*display:grid/);
  assert.match(page, /\.feature-text\{[^}]*display:block/);
  assert.doesNotMatch(page, /\.feature-row span\{display:block/);
});

test('keeps the right rail visible on medium desktop widths', () => {
  assert.doesNotMatch(page, /@media\(max-width:1120px\)\{\.app-shell\{grid-template-columns:185px minmax\(0,1fr\)\}\.right-rail\{display:none\}/);
  assert.match(page, /@media\(max-width:980px\)/);
  assert.match(page, /\.right-rail\{display:none\}/);
});

test('uses grade-aware and customizable word goals', () => {
  assert.match(page, /customWordGoal=ref/);
  assert.match(page, /wordGoal=computed/);
  assert.match(page, /高一|高二|高三/);
  assert.match(page, /800/);
  assert.match(page, /字数目标/);
  assert.doesNotMatch(page, /字数目标<br><b>600\+<\/b>/);
});

test('sends writing prompt requirements with workbench text', () => {
  assert.match(page, /workbench:\{text:'',requirement:''\}/);
  assert.match(page, /v-model="forms\.workbench\.requirement"/);
  assert.match(page, /作文题目 \/ 写作要求/);
  assert.match(page, /'作文题目和写作要求：'\+requirement/);
});

test('adds a guided 21 or 30 day summer writing plan without bypassing auth', () => {
  assert.match(page, /暑假写作计划/);
  assert.match(page, /每天 10 分钟/);
  assert.match(page, /\[21,30\]/);
  assert.match(page, /const summerSchedule=/);
  assert.match(page, /todaySummerTask=computed/);
  assert.match(page, /function startTodayTask\(\)/);
  assert.match(page, /localStorage\.setItem\('xz_summer_plan'/);
  assert.match(page, /if\(!requireAuth\('generate'\)\)return/);
});

test('shows a weekly learning report based on real generation history', () => {
  assert.match(page, /centerTab==='report'/);
  assert.match(page, /本周成长报告/);
  assert.match(page, /weekHistory=computed/);
  assert.match(page, /weeklyReportText=computed/);
  assert.match(page, /copy\(weeklyReportText\)/);
  assert.match(page, /await loadHistory\(\)/);
});

test('keeps mobile writing tools discoverable and icon actions accessible', () => {
  assert.match(page, /左右滑动，查看全部 8 个学习工具/);
  assert.match(page, /scroll-snap-type:x proximity/);
  assert.match(page, /aria-label="打开金句本"/);
  assert.match(page, /aria-label="打开个人中心"/);
  assert.match(page, /aria-label="查看使用指南"/);
  assert.match(page, /:aria-current="tool===item\.key\?'page':undefined"/);
  assert.match(page, /scrollIntoView\(\{behavior:'smooth',block:'nearest',inline:'center'\}\)/);
});
