'use strict';

const GRADE_OPTIONS = new Set(['七年级', '八年级', '九年级', '高中', '通用']);
const DETAIL_OPTIONS = new Set(['精讲', '探究', '复习']);

function cleanLine(value, maxLength) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeKnowledgePoints(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[，,、]/);
  const result = [];
  for (const item of source) {
    const tag = cleanLine(item, 24);
    if (!tag || result.includes(tag)) continue;
    result.push(tag);
    if (result.length >= 8) break;
  }
  return result;
}

function normalizeCoursewarePatch(input) {
  const source = input && typeof input === 'object' ? input : {};
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(source, 'title')) patch.title = cleanLine(source.title, 80);
  if (Object.prototype.hasOwnProperty.call(source, 'knowledge_points')) {
    patch.knowledge_points = normalizeKnowledgePoints(source.knowledge_points);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'favorite')) patch.favorite = source.favorite === true;
  return patch;
}

function normalizeTeachingPreferences(input) {
  const source = input && typeof input === 'object' ? input : {};
  const grade = cleanLine(source.grade, 12);
  const detail = cleanLine(source.detail, 12);
  return {
    grade: GRADE_OPTIONS.has(grade) ? grade : '通用',
    detail: DETAIL_OPTIONS.has(detail) ? detail : '精讲',
    dynamic: source.dynamic !== false,
    questions: source.questions !== false
  };
}

function buildTeachingRequirement(input) {
  const prefs = normalizeTeachingPreferences(input);
  const requirements = [
    `适用年级：${prefs.grade}`,
    `讲解方式：${prefs.detail}`,
    prefs.dynamic ? '优先把可变化的图形或参数做成可拖动演示' : '不强求动态演示，优先保证板书与步骤清楚',
    prefs.questions ? '课件中加入课堂提问和一道迁移练习' : '不额外加入课堂提问'
  ];
  return requirements.join('；');
}

function deriveCoursewareTitle(problem, type) {
  const normalized = cleanLine(problem, 160).replace(/[。！？；，,、：:]+$/g, '');
  if (normalized) return normalized.slice(0, 36);
  return cleanLine(type, 20) || '数学互动课件';
}

function parseKnowledgePoints(value) {
  if (Array.isArray(value)) return normalizeKnowledgePoints(value);
  try { return normalizeKnowledgePoints(JSON.parse(value || '[]')); }
  catch (_) { return normalizeKnowledgePoints(value); }
}

function createGenerationFinalizer(db, pointStore, insertGeneration) {
  if (!db || typeof db.transaction !== 'function') throw new Error('缺少数据库事务');
  if (!pointStore || typeof pointStore.debit !== 'function') throw new Error('缺少积分账本');
  if (!insertGeneration || typeof insertGeneration.run !== 'function') throw new Error('缺少生成记录写入器');
  const finalize = db.transaction(input => {
    const source = input && typeof input === 'object' ? input : {};
    const user = source.user && typeof source.user === 'object' ? source.user : {};
    const debit = pointStore.debit({
      user_id: user.id,
      username: user.username,
      product: 'edulab',
      reason: 'generation',
      note: String(source.problem || '').slice(0, 100),
      created_at: source.createdAt
    });
    const generated = insertGeneration.run(
      user.id,
      source.type,
      String(source.problem || '').slice(0, 500),
      source.problemHash,
      source.solution,
      source.url,
      source.createdAt
    );
    return {
      generationId: Number(generated.lastInsertRowid),
      balance: Number(debit.balance)
    };
  });
  return input => finalize(input);
}

module.exports = {
  buildTeachingRequirement,
  createGenerationFinalizer,
  deriveCoursewareTitle,
  normalizeCoursewarePatch,
  normalizeKnowledgePoints,
  normalizeTeachingPreferences,
  parseKnowledgePoints
};
