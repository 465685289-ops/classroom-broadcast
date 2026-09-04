'use strict';

const dns = require('node:dns').promises;
const { isIP } = require('node:net');

const COMMON_MAIL_DOMAINS = new Set([
  'qq.com', '163.com', '126.com', 'yeah.net', '139.com',
  'foxmail.com', 'sina.com', 'sina.cn', 'sohu.com',
  'gmail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aliyun.com'
]);

const COMMON_DOMAIN_TYPOS = new Map([
  ['qq.con', 'qq.com'], ['qq.cmo', 'qq.com'], ['qq.cm', 'qq.com'], ['q.com', 'qq.com'],
  ['163.con', '163.com'], ['163.cmo', '163.com'], ['163.cm', '163.com'],
  ['126.con', '126.com'], ['126.cmo', '126.com'], ['126.cm', '126.com'],
  ['gmail.con', 'gmail.com'], ['gmail.cmo', 'gmail.com'], ['gmail.cm', 'gmail.com'],
  ['outlook.con', 'outlook.com'], ['outlook.cmo', 'outlook.com'],
  ['hotmail.con', 'hotmail.com'], ['hotmail.cmo', 'hotmail.com'],
  ['foxmail.con', 'foxmail.com'], ['icloud.con', 'icloud.com']
]);

function isPublicMailAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  const version = isIP(value);
  if (version === 4) {
    const octets = value.split('.').map(Number);
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (version === 6) {
    return !(
      value === '::' || value === '::1' ||
      value.startsWith('fc') || value.startsWith('fd') ||
      /^fe[89ab]/.test(value) || value.startsWith('2001:db8')
    );
  }
  return false;
}

function emailParts(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  return { local: value.slice(0, at), domain: value.slice(at + 1) };
}

async function defaultResolveAnyAddress(domain) {
  const answers = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
  const addresses = answers
    .flatMap(answer => answer.status === 'fulfilled' ? answer.value : [])
    .filter(isPublicMailAddress);
  if (addresses.length) return addresses;
  const rejected = answers.find(answer => answer.status === 'rejected');
  throw rejected ? rejected.reason : Object.assign(new Error('no address records'), { code: 'ENODATA' });
}

function createEmailDomainValidator({
  resolveMx = domain => dns.resolveMx(domain),
  resolveAnyAddress = defaultResolveAnyAddress,
  timeoutMs = 1000,
  cacheTtlMs = 24 * 60 * 60 * 1000,
  dnsCheckEnabled = true,
  now = () => Date.now()
} = {}) {
  const cache = new Map();

  async function lookup(domain) {
    try {
      const mx = await resolveMx(domain);
      if (Array.isArray(mx) && mx.some(record => ['.', ''].includes(String(record && record.exchange || '').trim()))) return false;
      if (Array.isArray(mx) && mx.some(record => String(record && record.exchange || '').trim())) return true;
    } catch (error) {
      if (!['ENODATA', 'ENOTFOUND', 'ENODOMAIN'].includes(error && error.code)) throw error;
    }

    try {
      const addresses = await resolveAnyAddress(domain);
      return Array.isArray(addresses) && addresses.length > 0;
    } catch (error) {
      if (['ENODATA', 'ENOTFOUND', 'ENODOMAIN'].includes(error && error.code)) return false;
      throw error;
    }
  }

  async function validate(email) {
    const parts = emailParts(email);
    if (!parts) return { ok: false, code: 'EMAIL_INVALID', message: '请输入有效邮箱地址。' };

    const correctedDomain = COMMON_DOMAIN_TYPOS.get(parts.domain);
    if (correctedDomain) {
      const suggestedEmail = parts.local + '@' + correctedDomain;
      return {
        ok: false,
        code: 'EMAIL_DOMAIN_TYPO',
        suggestedEmail,
        message: '检测到邮箱域名可能填写错误，您是否要填写的是 ' + suggestedEmail + '？'
      };
    }

    if (COMMON_MAIL_DOMAINS.has(parts.domain)) return { ok: true, checked: 'common' };
    if (!dnsCheckEnabled) return { ok: true, checked: 'disabled' };

    const cached = cache.get(parts.domain);
    if (cached && cached.expiresAt > now()) return cached.result;

    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const checked = lookup(parts.domain)
      .then(canReceive => ({ canReceive }))
      .catch(() => ({ temporaryFailure: true }));
    const outcome = await Promise.race([checked, timeout]);
    clearTimeout(timer);

    if (outcome.timedOut || outcome.temporaryFailure) return { ok: true, checked: 'timeout' };

    const result = outcome.canReceive
      ? { ok: true, checked: 'dns' }
      : {
          ok: false,
          code: 'EMAIL_DOMAIN_UNREACHABLE',
          message: '该邮箱域名似乎不存在或无法接收邮件，请检查后重试。'
        };
    cache.set(parts.domain, { result, expiresAt: now() + cacheTtlMs });
    return result;
  }

  return { validate };
}

module.exports = {
  COMMON_MAIL_DOMAINS,
  COMMON_DOMAIN_TYPOS,
  isPublicMailAddress,
  createEmailDomainValidator
};
