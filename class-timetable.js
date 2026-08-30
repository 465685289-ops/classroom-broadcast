'use strict';

const TIMETABLE_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri']);
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
  '晚自习3'
]);

function normalizeClassTimetable(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const source = input.entries && typeof input.entries === 'object' ? input.entries : {};
  const entries = {};

  TIMETABLE_DAYS.forEach(day => {
    const cells = Array.isArray(source[day]) ? source[day] : [];
    entries[day] = TIMETABLE_SLOTS.map((_, index) => String(cells[index] || '').trim().slice(0, 30));
  });

  return {
    version: 1,
    entries,
    updated_at: typeof input.updated_at === 'string' ? input.updated_at : null
  };
}

function emptyClassTimetable() {
  return normalizeClassTimetable();
}

function classTimetableHasEntries(value) {
  const timetable = normalizeClassTimetable(value);
  return TIMETABLE_DAYS.some(day => timetable.entries[day].some(Boolean));
}

module.exports = {
  TIMETABLE_DAYS,
  TIMETABLE_SLOTS,
  classTimetableHasEntries,
  emptyClassTimetable,
  normalizeClassTimetable
};
