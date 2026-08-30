const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'teacher.html'), 'utf8');

function functionSource(name) {
  const start = page.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, '缺少函数 ' + name);
  const next = page.indexOf('\nfunction ', start + 10);
  return page.slice(start, next === -1 ? page.length : next);
}

test('teacher can switch between voice and fully silent text notices', () => {
  assert.match(page, /id="broadcastMode"[^>]+value="voice"/);
  assert.match(page, /data-broadcast-mode="voice"[^>]*>文字＋语音</);
  assert.match(page, /data-broadcast-mode="text"[^>]*>仅文字（静音）</);

  const elements = {
    broadcastMode: { value: 'voice' },
    repeatCount: { disabled: false },
    broadcastModeHint: { textContent: '' }
  };
  const buttons = ['voice', 'text'].map(mode => ({
    dataset: { broadcastMode: mode },
    active: false,
    classList: {
      toggle(name, enabled) {
        if (name === 'active') this.owner.active = enabled;
      },
      owner: null
    }
  }));
  buttons.forEach(button => { button.classList.owner = button; });
  const context = {
    document: {
      getElementById(id) { return elements[id]; },
      querySelectorAll() { return buttons; }
    }
  };
  vm.runInNewContext(functionSource('setBroadcastMode') + '; setBroadcastMode("text");', context);
  assert.equal(elements.broadcastMode.value, 'text');
  assert.equal(elements.repeatCount.disabled, true);
  assert.match(elements.broadcastModeHint.textContent, /不播放提示音和语音/);
  assert.equal(buttons[1].active, true);

  vm.runInNewContext(functionSource('setBroadcastMode') + '; setBroadcastMode("voice");', context);
  assert.equal(elements.broadcastMode.value, 'voice');
  assert.equal(elements.repeatCount.disabled, false);
  assert.match(elements.broadcastModeHint.textContent, /播报次数/);
  assert.equal(buttons[0].active, true);
});

test('teacher submits the selected mode and history explains how each notice was delivered', () => {
  const sendBlock = functionSource('doSend');
  assert.match(sendBlock, /broadcast_mode:\s*document\.getElementById\('broadcastMode'\)\.value/);

  const context = { labels: [] };
  vm.runInNewContext(
    functionSource('notificationModeLabel') +
    '; labels.push(notificationModeLabel({ broadcast_mode:"text", repeat_count:9 }));' +
    'labels.push(notificationModeLabel({ repeat_count:3 }));',
    context
  );
  assert.deepEqual(context.labels, ['仅文字', '语音 × 3 次']);
  assert.match(page, /notificationModeLabel\(n\)/);
});
