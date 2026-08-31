const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'teacher.html'), 'utf8');

function element() {
  return {
    hidden: true,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    className: '',
    scrollIntoView() {}
  };
}

function onboardingRuntime() {
  const elements = {
    classroomOnboardingCard: element(),
    classroomOnboardingTitle: element(),
    classroomOnboardingStatus: element(),
    classroomOnboardingSteps: element(),
    classroomOnboardingActions: element(),
    classSelect: element(),
    content: element(),
    repeatCount: element()
  };
  const context = {
    elements,
    API: '',
    esc(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    document: {
      getElementById(id) { return elements[id] || element(); }
    },
    switchTab(name) { context.tab = name; },
    switchPublishSection(name) { context.section = name; },
    setBroadcastMode(mode) { context.mode = mode; },
    updatePreview() { context.previewUpdated = true; },
    toast(message, type) { context.toast = { message, type }; },
    fetch() { throw new Error('rendering onboarding must not send a request'); },
    headers() { return {}; }
  };
  const start = page.indexOf('var classroomOnboardingState');
  const end = page.indexOf('// ========== Avatar System ==========', start);
  assert.ok(start >= 0 && end > start, '缺少首次开通引导运行时函数');
  vm.runInNewContext(page.slice(start, end), context);
  return context;
}

test('teacher page exposes the non-blocking three-step classroom onboarding card', () => {
  assert.match(page, /id="classroomOnboardingCard"/);
  assert.match(page, /先把第一块教室大屏开通/);
  assert.match(page, /建立我的第一个班级/);
  assert.match(page, /连接教室大屏/);
  assert.match(page, /发送一条测试通知/);
  assert.match(page, /fetch\(API \+ '\/api\/classroom-onboarding'/);
});

test('onboarding renders progress and prepares one voice test notice without sending it', () => {
  const context = onboardingRuntime();
  context.renderClassroomOnboarding({
    classroom: { id: 'class-1', name: '<八年级一班>', grade: 'junior', bind_code: 'CLS123', online: 0 },
    steps: { class_created: true, screen_connected: true, first_notice_sent: false },
    next_step: 'send_test_notice',
    completed: false
  });

  assert.equal(context.elements.classroomOnboardingCard.hidden, false);
  assert.equal(context.elements.classroomOnboardingTitle.textContent, '先把第一块教室大屏开通');
  assert.match(context.elements.classroomOnboardingSteps.innerHTML, /已完成/);
  assert.match(context.elements.classroomOnboardingSteps.innerHTML, /&lt;八年级一班&gt;/);
  assert.match(context.elements.classroomOnboardingActions.innerHTML, /发送测试通知/);

  context.prepareOnboardingTestNotice();
  assert.equal(context.tab, 'publish');
  assert.equal(context.section, 'send');
  assert.equal(context.elements.classSelect.value, 'class-1');
  assert.equal(context.elements.content.value, '测试通知：班级广播已连接成功。');
  assert.equal(context.elements.repeatCount.value, '1');
  assert.equal(context.mode, 'voice');
  assert.equal(context.previewUpdated, true);
});

test('completed onboarding stays as a compact next-step card', () => {
  const context = onboardingRuntime();
  context.renderClassroomOnboarding({
    classroom: { id: 'class-1', name: '八年级一班', grade: 'junior', bind_code: 'CLS123', online: 1 },
    steps: { class_created: true, screen_connected: true, first_notice_sent: true },
    next_step: 'complete',
    completed: true
  });

  assert.equal(context.elements.classroomOnboardingTitle.textContent, '教室大屏已开通');
  assert.match(context.elements.classroomOnboardingStatus.textContent, /下一步可设置课程表、邀请科任老师协作。/);
  assert.match(context.elements.classroomOnboardingCard.className, /complete/);
});
