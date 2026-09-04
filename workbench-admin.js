'use strict';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function latestIso(...values) {
  return values.filter(value => value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function masterEmails(user) {
  return new Set([
    user.username,
    user.registration_email,
    user.contact_type === 'email' ? user.contact_value : ''
  ].map(normalizeEmail).filter(Boolean));
}

function mergeWorkbenchProfiles(masterUsers, workbenchUsers) {
  const merged = new Map(masterUsers.map(user => [String(user.id), {
    ...user,
    workbench: null,
    last_login_at: user.last_login_at || null
  }]));
  const mastersByEmail = new Map();
  for (const user of masterUsers) {
    for (const email of masterEmails(user)) {
      if (!mastersByEmail.has(email)) mastersByEmail.set(email, new Set());
      mastersByEmail.get(email).add(String(user.id));
    }
  }

  for (const profile of workbenchUsers || []) {
    const linkedId = String(profile.shixingUserId || '').replace(/^shixing:/, '');
    let masterId = linkedId && merged.has(linkedId) ? linkedId : '';
    if (!masterId) {
      const candidates = mastersByEmail.get(normalizeEmail(profile.email));
      if (candidates && candidates.size === 1) masterId = [...candidates][0];
    }
    if (!masterId) continue;
    const current = merged.get(masterId);
    current.workbench = profile;
    current.last_login_at = latestIso(current.last_login_at, profile.lastLoginAt);
  }
  return merged;
}

async function fetchWorkbenchAdminSummary({ baseUrl, secret, fetchImpl = fetch, timeoutMs = 4000 }) {
  if (!baseUrl || !secret) throw new Error('工作台管理数据服务未配置');
  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/internal/admin-summary`, {
    headers: { 'X-Workbench-Points-Secret': secret },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `工作台管理数据请求失败：${response.status}`);
  return data;
}

module.exports = { fetchWorkbenchAdminSummary, mergeWorkbenchProfiles };
