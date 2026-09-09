'use strict';

const TIMETABLE_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const TIMETABLE_SLOTS = Object.freeze([
  '早读',
  '第1节',
  '第2节',
  '第3节',
  '第4节',
  '第5节',
  '第6节',
  '第7节',
  '第8节',
  '晚自习1',
  '晚自习2',
  '晚自习3',
  // 为避免把存量「晚自习1—3」挪位，第9节与晚自习4追加到尾部。
  '第9节',
  '晚自习4'
]);

const REGULAR_SLOT_INDICES = Object.freeze([null, 1, 2, 3, 4, 5, 6, 7, 8, 12]);
const EVENING_STUDY_SLOT_INDICES = Object.freeze([null, 9, 10, 11, 13]);

const DEFAULT_TIMETABLE_STRUCTURE = Object.freeze({
  configured: true,
  morning_reading: true,
  regular_count: 8,
  evening_study_count: 3
});

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function normalizeClassTimetableStructure(value, configuredFallback = true) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    configured: typeof input.configured === 'boolean' ? input.configured : configuredFallback,
    morning_reading: typeof input.morning_reading === 'boolean'
      ? input.morning_reading
      : DEFAULT_TIMETABLE_STRUCTURE.morning_reading,
    regular_count: boundedInteger(
      input.regular_count,
      DEFAULT_TIMETABLE_STRUCTURE.regular_count,
      1,
      9
    ),
    evening_study_count: boundedInteger(
      input.evening_study_count,
      DEFAULT_TIMETABLE_STRUCTURE.evening_study_count,
      0,
      4
    )
  };
}

function validateClassTimetableStructure(value) {
  const input = value && typeof value === 'object' ? value : {};
  if (typeof input.morning_reading !== 'boolean') throw new Error('早读设置必须为开启或关闭');
  if (!Number.isInteger(input.regular_count) || input.regular_count < 1 || input.regular_count > 9) {
    throw new Error('正课节数必须是 1 到 9 的整数');
  }
  if (!Number.isInteger(input.evening_study_count)
    || input.evening_study_count < 0
    || input.evening_study_count > 4) {
    throw new Error('晚自习节数必须是 0 到 4 的整数');
  }
  return {
    configured: true,
    morning_reading: input.morning_reading,
    regular_count: input.regular_count,
    evening_study_count: input.evening_study_count
  };
}

function activeClassTimetableSlots(value) {
  const structure = normalizeClassTimetableStructure(value, true);
  if (!structure.configured) return [];
  const slots = [];
  if (structure.morning_reading) slots.push({ index: 0, label: TIMETABLE_SLOTS[0] });
  for (let period = 1; period <= structure.regular_count; period += 1) {
    const index = REGULAR_SLOT_INDICES[period];
    slots.push({ index, label: TIMETABLE_SLOTS[index] });
  }
  for (let study = 1; study <= structure.evening_study_count; study += 1) {
    const index = EVENING_STUDY_SLOT_INDICES[study];
    slots.push({ index, label: TIMETABLE_SLOTS[index] });
  }
  return slots;
}

function normalizeClassTimetable(value) {
  const input = value && typeof value === 'object' ? value : {};
  const source = input.entries && typeof input.entries === 'object' ? input.entries : {};
  const entries = {};

  TIMETABLE_DAYS.forEach(day => {
    const cells = Array.isArray(source[day]) ? source[day] : [];
    entries[day] = TIMETABLE_SLOTS.map((_, index) => String(cells[index] || '').trim().slice(0, 30));
  });

  return {
    version: 2,
    entries,
    // 没有 structure 的都是存量课表，继续按原 12 节兼容显示。
    structure: normalizeClassTimetableStructure(input.structure, true),
    visible: input.visible !== false,
    updated_at: typeof input.updated_at === 'string' ? input.updated_at : null
  };
}

function emptyClassTimetable() {
  return normalizeClassTimetable({
    version: 2,
    structure: { ...DEFAULT_TIMETABLE_STRUCTURE, configured: false }
  });
}

function classTimetableHasEntries(value) {
  const timetable = normalizeClassTimetable(value);
  return TIMETABLE_DAYS.some(day => timetable.entries[day].some(Boolean));
}

module.exports = {
  DEFAULT_TIMETABLE_STRUCTURE,
  TIMETABLE_DAYS,
  TIMETABLE_SLOTS,
  activeClassTimetableSlots,
  classTimetableHasEntries,
  emptyClassTimetable,
  normalizeClassTimetable,
  normalizeClassTimetableStructure,
  validateClassTimetableStructure
};
