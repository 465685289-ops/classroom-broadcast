const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const screenPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'screen.html'), 'utf8');
const teacherPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'teacher.html'), 'utf8');

function sourceBetween(page, startMarker, endMarker) {
  const start = page.indexOf(startMarker);
  const end = page.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `缺少代码区段：${startMarker}`);
  return page.slice(start, end);
}

test('classroom fixed link restores the binding and successful binding preserves it in both places', () => {
  const source = sourceBetween(
    screenPage,
    '// ========== Persistent Screen Binding ==========',
    '// ========== Screen Runtime State =========='
  );
  const storage = new Map();
  const replacedUrls = [];
  const context = {
    window: {
      location: {
        origin: 'https://notice.yingyuzuowen.asia',
        pathname: '/screen.html',
        search: '',
        hash: '#bind=ABCD12'
      }
    },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    history: {
      replaceState(_state, _title, url) {
        replacedUrls.push(url);
      }
    },
    encodeURIComponent,
    decodeURIComponent
  };

  vm.runInNewContext(source, context);

  assert.equal(context.readSavedScreenBind(), 'ABCD12');
  assert.equal(context.persistScreenBind('xy_789'), 'XY_789');
  assert.equal(storage.get('screen_bind_code'), 'XY_789');
  assert.equal(replacedUrls.at(-1), 'https://notice.yingyuzuowen.asia/screen.html#bind=XY_789');
});

test('a temporary bind error never deletes the saved classroom binding', () => {
  const source = sourceBetween(
    screenPage,
    '// ========== Persistent Screen Binding ==========',
    '// ========== Screen Runtime State =========='
  );
  const storage = new Map([['screen_bind_code', 'ABCD12']]);
  const messages = [];
  const context = {
    window: {
      location: {
        origin: 'https://notice.yingyuzuowen.asia',
        pathname: '/screen.html',
        search: '',
        hash: '#bind=ABCD12'
      }
    },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    history: { replaceState() {} },
    showBindPage(message) { messages.push(message); },
    encodeURIComponent,
    decodeURIComponent
  };

  vm.runInNewContext(source, context);
  context.handleScreenBindError('网络暂时不可用');

  assert.equal(storage.get('screen_bind_code'), 'ABCD12');
  assert.equal(context.window.location.hash, '#bind=ABCD12');
  assert.deepEqual(messages, ['网络暂时不可用']);
  assert.match(screenPage, /socket\.on\('bind-error',[\s\S]*?handleScreenBindError\(msg\)/);
});

test('teacher class card exposes a one-click fixed classroom link with the exact class code', async () => {
  const source = sourceBetween(
    teacherPage,
    '// ========== Persistent Classroom Links ==========',
    '// ========== Teacher Runtime State =========='
  );
  const copied = [];
  const notices = [];
  const context = {
    window: { location: { origin: 'https://notice.yingyuzuowen.asia' }, isSecureContext: true },
    navigator: { clipboard: { writeText(value) { copied.push(value); return Promise.resolve(); } } },
    document: {
      createElement() {
        return {
          value: '',
          style: {},
          select() {},
          remove() {}
        };
      },
      body: { appendChild() {} },
      execCommand() { return true; }
    },
    toast(message, type) { notices.push([message, type]); },
    encodeURIComponent,
    Promise
  };

  vm.runInNewContext(source, context);

  assert.equal(
    context.fixedClassroomScreenUrl('ab_cd1'),
    'https://notice.yingyuzuowen.asia/screen.html#bind=AB_CD1'
  );
  await context.copyFixedClassroomLink('ab_cd1');
  assert.deepEqual(copied, ['https://notice.yingyuzuowen.asia/screen.html#bind=AB_CD1']);
  assert.deepEqual(notices, [['固定教室链接已复制', 'success']]);
  assert.match(teacherPage, /复制固定教室链接/);
  assert.match(teacherPage, /data-bind-code=/);
});
