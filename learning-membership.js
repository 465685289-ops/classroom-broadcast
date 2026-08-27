function addMembershipDays(currentExpiresAt, days, now = new Date()) {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error('续费天数必须是正整数');
  }
  const current = Date.parse(currentExpiresAt || '');
  const start = Number.isFinite(current) && current > now.getTime() ? new Date(current) : new Date(now);
  start.setUTCDate(start.getUTCDate() + days);
  return start.toISOString();
}

function getMembershipStatus(membership, now = new Date()) {
  const expiresAt = membership && membership.expires_at ? membership.expires_at : null;
  const expiresMs = Date.parse(expiresAt || '');
  return { active: Number.isFinite(expiresMs) && expiresMs > now.getTime(), expiresAt };
}

function isLearningHost(host) {
  return String(host || '').split(':')[0].toLowerCase() === 'xiezuo.yingyuzuowen.asia';
}

module.exports = { addMembershipDays, getMembershipStatus, isLearningHost };
