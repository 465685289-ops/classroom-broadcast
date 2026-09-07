const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const page = fs.readFileSync(require('node:path').join(__dirname, '../public/english.html'), 'utf8');
function harness(responses, token = '') {
  const calls = [], elements = {};
  const context = vm.createContext({
    token, user: { username: 'Teacher' }, config: {}, pendingAction: null,
    localStorage: { removeItem() {} },
    $: id => elements[id] ||= { textContent: '' },
    updateAccount() {}, openAuth() { context.opened = true; },
    fetch: async (path, options) => {
      calls.push({ path, options: JSON.parse(JSON.stringify(options)) });
      const result = responses.shift();
      if (result instanceof Error) throw result;
      return { status: result.status, ok: result.status < 400, json: async () => result.body || {} };
    }
  });
  vm.runInContext(page.slice(page.indexOf('  function headers()'), page.indexOf('  function makeRequestId()')), context);
  return { context, calls, elements };
}
test('English boot probes cookie session without a local token, and guest probe is silent and once', async () => {
  assert.match(page, /loadPrivate\(true\)\.then\(handlePaymentReturn\)/);
  assert.match(page, /initial\?\{silent:true,noRecovery:!token\}/);
  const { context, calls } = harness([{ status: 401 }]);
  await assert.rejects(context.api('/api/profile', null, { silent: true, noRecovery: true }), { status: 401 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers['x-token'], undefined);
  assert.equal(context.opened, undefined);
});
test('expired local token recovers via cookie and retries identical body once', async () => {
  const { context, calls } = harness([{ status: 401 }, { status: 200, body: { username: 'Main' } }, { status: 200, body: { id: 'ok' } }], 'stale');
  const options = { method: 'POST', body: '{"request_id":"same","text":"draft"}' };
  assert.equal((await context.api('/api/english/grade', options)).id, 'ok');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].path, '/api/profile');
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(calls[2].options.headers['x-token'], undefined);
  assert.equal(calls[0].options.body, calls[2].options.body);
  assert.equal(context.user.username, 'Main');
});
test('failed recovery or rejected retry prompts login and never loops', async () => {
  for (const responses of [[{ status: 401 }, { status: 401 }], [{ status: 401 }, { status: 200 }, { status: 401 }]]) {
    const expected = responses.length;
    const { context, calls, elements } = harness(responses, 'expired');
    context.draft = 'unsaved text';
    await assert.rejects(context.api('/api/english/grade'), { status: 401 });
    assert.equal(calls.length, expected);
    assert.equal(context.opened, true);
    assert.match(elements.authError.textContent, /未提交内容已保留/);
    assert.equal(context.draft, 'unsaved text');
  }
});
test('network failures do not erase account or ask user to log in', async () => {
  for (const responses of [[new Error('offline')], [{ status: 401 }, new Error('offline')]]) {
    const { context } = harness(responses, 'existing');
    await assert.rejects(context.api('/api/english/config'), /offline/);
    assert.equal(context.user.username, 'Teacher');
    assert.equal(context.token, 'existing');
    assert.equal(context.opened, undefined);
  }
});
test('bad login credentials never trigger cookie recovery', async () => {
  const { context, calls } = harness([{ status: 401 }]);
  await assert.rejects(context.api('/api/login', { method: 'POST' }), { status: 401 });
  assert.equal(calls.length, 1);
});
