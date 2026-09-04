const assert = require('node:assert/strict');
const test = require('node:test');

const { createEmailDomainValidator, isPublicMailAddress } = require('../email-domain-validator');

test('suggests a common corrected domain without a DNS lookup', async () => {
  let lookups = 0;
  const validator = createEmailDomainValidator({
    resolveMx: async () => { lookups += 1; return []; },
    resolveAnyAddress: async () => { lookups += 1; return []; }
  });

  const result = await validator.validate('870763093@qq.con');

  assert.deepEqual(result, {
    ok: false,
    code: 'EMAIL_DOMAIN_TYPO',
    suggestedEmail: '870763093@qq.com',
    message: '检测到邮箱域名可能填写错误，您是否要填写的是 870763093@qq.com？'
  });
  assert.equal(lookups, 0);
});

test('lets common mailbox domains pass immediately', async () => {
  let lookups = 0;
  const validator = createEmailDomainValidator({
    resolveMx: async () => { lookups += 1; return []; },
    resolveAnyAddress: async () => { lookups += 1; return []; }
  });

  assert.deepEqual(await validator.validate('teacher@qq.com'), { ok: true, checked: 'common' });
  assert.equal(lookups, 0);
});

test('accepts an unfamiliar domain that has MX records', async () => {
  const validator = createEmailDomainValidator({
    resolveMx: async () => [{ exchange: 'mail.school.example', priority: 10 }],
    resolveAnyAddress: async () => { throw new Error('should not fall back to address records'); }
  });

  assert.deepEqual(await validator.validate('teacher@school.example'), { ok: true, checked: 'dns' });
});

test('accepts RFC-compatible address fallback when a domain has no MX record', async () => {
  const noData = Object.assign(new Error('no MX'), { code: 'ENODATA' });
  const validator = createEmailDomainValidator({
    resolveMx: async () => { throw noData; },
    resolveAnyAddress: async () => ['93.184.216.34']
  });

  assert.deepEqual(await validator.validate('teacher@legacy-mail.example'), { ok: true, checked: 'dns' });
});

test('rejects an unfamiliar domain that cannot receive mail', async () => {
  const notFound = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  const validator = createEmailDomainValidator({
    resolveMx: async () => { throw notFound; },
    resolveAnyAddress: async () => { throw notFound; }
  });

  assert.deepEqual(await validator.validate('teacher@missing.invalid'), {
    ok: false,
    code: 'EMAIL_DOMAIN_UNREACHABLE',
    message: '该邮箱域名似乎不存在或无法接收邮件，请检查后重试。'
  });
});

test('rejects an RFC null-MX domain without falling back to address records', async () => {
  let addressLookups = 0;
  const validator = createEmailDomainValidator({
    resolveMx: async () => [{ exchange: '.', priority: 0 }],
    resolveAnyAddress: async () => { addressLookups += 1; return ['203.0.113.10']; }
  });

  assert.deepEqual(await validator.validate('teacher@no-mail.example'), {
    ok: false,
    code: 'EMAIL_DOMAIN_UNREACHABLE',
    message: '该邮箱域名似乎不存在或无法接收邮件，请检查后重试。'
  });
  assert.equal(addressLookups, 0);
});

test('ignores reserved wildcard addresses returned for a missing domain', () => {
  assert.equal(isPublicMailAddress('198.18.0.88'), false);
  assert.equal(isPublicMailAddress('203.0.113.10'), false);
  assert.equal(isPublicMailAddress('93.184.216.34'), true);
});

test('fails open when DNS validation exceeds the one-second budget', async () => {
  const validator = createEmailDomainValidator({
    timeoutMs: 20,
    resolveMx: () => new Promise(() => {}),
    resolveAnyAddress: async () => []
  });

  const startedAt = Date.now();
  const result = await validator.validate('teacher@slow-mail.example');

  assert.deepEqual(result, { ok: true, checked: 'timeout' });
  assert.ok(Date.now() - startedAt < 200);
});
