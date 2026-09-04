const assert = require('node:assert/strict');
const test = require('node:test');

const { showFailure } = require('../public/registration-email-helper');

function fakeElement(ownerDocument) {
  return {
    ownerDocument,
    children: [],
    textContent: '',
    value: '',
    style: {},
    listeners: {},
    appendChild(child) { this.children.push(child); },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    dispatchEvent(event) { this.dispatched = event.type; },
    focus() { this.focused = true; }
  };
}

test('shows explicit correction controls and never resends automatically', () => {
  const ownerDocument = {
    createElement() { return fakeElement(ownerDocument); },
    defaultView: { Event: class Event { constructor(type) { this.type = type; } } }
  };
  const input = fakeElement(ownerDocument);
  input.value = '870763093@qq.con';
  const message = fakeElement(ownerDocument);
  let retries = 0;

  showFailure({
    data: {
      error: '检测到邮箱域名可能填写错误',
      suggested_email: '870763093@qq.com'
    },
    input,
    message,
    onRetry: () => { retries += 1; }
  });

  assert.equal(message.children.length, 1);
  assert.equal(message.children[0].children.length, 2);
  assert.equal(message.children[0].children[0].textContent, '改为 qq.com');
  assert.equal(message.children[0].children[1].textContent, '返回修改');
  assert.equal(retries, 0);

  message.children[0].children[0].listeners.click();
  assert.equal(input.value, '870763093@qq.com');
  assert.equal(input.dispatched, 'input');
  assert.equal(retries, 0);
});
