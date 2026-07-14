const crypto = require('crypto');

const SCORE_SOURCES = new Set(['screen', 'teacher']);

function boundedText(value, maxLength) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, maxLength);
}

function integerOrNull(value, name, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return number;
}

function normalizeStudentInput(input) {
  const name = boundedText(input && input.name, 30);
  if (!name) throw new Error('请输入学生姓名');
  return {
    name,
    student_no: boundedText(input && input.student_no, 30),
    seat_row: integerOrNull(input && input.seat_row, '座位行号', 1, 30),
    seat_col: integerOrNull(input && input.seat_col, '座位列号', 1, 30)
  };
}

function normalizeRuleInput(input) {
  const name = boundedText(input && input.name, 30);
  const delta = Number(input && input.delta);
  if (!name) throw new Error('请输入积分规则名称');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) {
    throw new Error('积分分值必须是 -100 到 100 之间的非零整数');
  }
  return {
    name,
    delta,
    active: input && input.active === false ? 0 : 1
  };
}

function normalizeScoreSource(source) {
  const value = boundedText(source, 20).toLowerCase();
  if (!SCORE_SOURCES.has(value)) throw new Error('积分来源无效');
  return value;
}

function buildScoreEntries(input) {
  const studentIds = Array.from(new Set((input && input.student_ids || []).map(id => boundedText(id, 80)).filter(Boolean)));
  if (!studentIds.length) throw new Error('请选择学生');
  const delta = Number(input && input.delta);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) {
    throw new Error('积分分值必须是 -100 到 100 之间的非零整数');
  }
  const source = normalizeScoreSource(input.source);
  const operationId = boundedText(input.client_operation_id, 120) || crypto.randomUUID();
  const batchId = studentIds.length > 1 ? operationId : (boundedText(input.batch_id, 120) || null);
  const createdAt = input.created_at || new Date().toISOString();
  const clientCreatedAt = input.client_created_at || createdAt;
  return studentIds.map(studentId => ({
    id: crypto.randomUUID(),
    client_operation_id: `${operationId}:${studentId}`,
    class_id: boundedText(input.class_id, 80),
    student_id: studentId,
    period_id: boundedText(input.period_id, 80),
    rule_id: boundedText(input.rule_id, 80) || null,
    rule_name_snapshot: boundedText(input.rule_name_snapshot, 60),
    delta,
    source,
    actor_user_id: boundedText(input.actor_user_id, 80) || null,
    batch_id: batchId,
    reversal_of_id: null,
    client_created_at: clientCreatedAt,
    created_at: createdAt
  }));
}

function buildReversalEntry(original, input) {
  if (!original) throw new Error('原积分记录不存在');
  if (original.reversal_of_id) throw new Error('撤销记录不能再次撤销');
  const operationId = boundedText(input && input.client_operation_id, 120) || crypto.randomUUID();
  const createdAt = input && input.created_at || new Date().toISOString();
  return {
    id: boundedText(input && input.id, 80) || crypto.randomUUID(),
    client_operation_id: operationId,
    class_id: original.class_id,
    student_id: original.student_id,
    period_id: original.period_id,
    rule_id: original.rule_id || null,
    rule_name_snapshot: `撤销：${boundedText(original.rule_name_snapshot, 55) || '积分调整'}`,
    delta: -Number(original.delta),
    source: normalizeScoreSource(input && input.source),
    actor_user_id: boundedText(input && input.actor_user_id, 80) || null,
    batch_id: null,
    reversal_of_id: original.id,
    client_created_at: input && input.client_created_at || createdAt,
    created_at: createdAt
  };
}

function localDateParts(now, timezoneOffsetMinutes) {
  const shifted = new Date(now.getTime() + timezoneOffsetMinutes * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
    day: shifted.getUTCDay()
  };
}

function utcForLocal(year, month, date, timezoneOffsetMinutes) {
  return new Date(Date.UTC(year, month, date) - timezoneOffsetMinutes * 60000);
}

function scoreScopeBounds(scope, nowValue, period, timezoneOffsetMinutes = 8 * 60) {
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('统计时间无效');
  const normalizedScope = boundedText(scope || 'term', 20).toLowerCase();
  if (normalizedScope === 'term') {
    return {
      from: period && period.starts_at || null,
      to: period && period.ends_at || null
    };
  }

  const parts = localDateParts(now, timezoneOffsetMinutes);
  let start;
  let end;
  if (normalizedScope === 'today') {
    start = utcForLocal(parts.year, parts.month, parts.date, timezoneOffsetMinutes);
    end = utcForLocal(parts.year, parts.month, parts.date + 1, timezoneOffsetMinutes);
  } else if (normalizedScope === 'week') {
    const daysFromMonday = (parts.day + 6) % 7;
    start = utcForLocal(parts.year, parts.month, parts.date - daysFromMonday, timezoneOffsetMinutes);
    end = utcForLocal(parts.year, parts.month, parts.date - daysFromMonday + 7, timezoneOffsetMinutes);
  } else if (normalizedScope === 'month') {
    start = utcForLocal(parts.year, parts.month, 1, timezoneOffsetMinutes);
    end = utcForLocal(parts.year, parts.month + 1, 1, timezoneOffsetMinutes);
  } else {
    throw new Error('统计范围无效');
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

function sourceLabel(source) {
  return source === 'screen' ? '教室端登记' : '教师端登记';
}

module.exports = {
  normalizeStudentInput,
  normalizeRuleInput,
  normalizeScoreSource,
  buildScoreEntries,
  buildReversalEntry,
  scoreScopeBounds,
  sourceLabel
};
