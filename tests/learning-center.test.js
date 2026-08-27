const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 用临时数据库加载真实的 db.js
const TMP_DB = path.join(os.tmpdir(), 'xiezuo-center-test-' + Date.now() + '.db');
process.env.SQLITE_FILE = TMP_DB;
const dbStore = require('../db.js');

test.after(() => { for (const f of [TMP_DB, TMP_DB + '-shm', TMP_DB + '-wal']) { try { fs.unlinkSync(f); } catch (e) {} } });

const U = { id: 'stu-1', created_at: new Date().toISOString() };

test('金句本：新增、去重、按类型筛选、删除', () => {
  const a = dbStore.addLearningSaved(U.id, { type: 'material', title: '坚持', content: '锲而不舍，金石可镂。' });
  assert.ok(a && a.id);
  const dup = dbStore.addLearningSaved(U.id, { type: 'material', title: '坚持', content: '锲而不舍，金石可镂。' });
  assert.strictEqual(dup.id, a.id, '相同内容应去重，返回同一条');
  dbStore.addLearningSaved(U.id, { type: 'opening', title: '开头', content: '风起于青萍之末。' });
  assert.strictEqual(dbStore.countLearningSaved(U.id), 2);
  assert.strictEqual(dbStore.listLearningSaved(U.id, 'material').length, 1);
  assert.strictEqual(dbStore.listLearningSaved(U.id, 'all').length, 2);
  assert.strictEqual(dbStore.deleteLearningSaved(U.id, a.id), true);
  assert.strictEqual(dbStore.deleteLearningSaved(U.id, a.id), false, '重复删除返回 false');
  assert.strictEqual(dbStore.countLearningSaved(U.id), 1);
});

test('生成记录：写入、倒序列出、上限 100 条', () => {
  for (let i = 0; i < 105; i++) {
    dbStore.insertLearningHistory(U.id, { tool_key: 'guide', title: '题目' + i, input: 'in' + i, result: 'out' + i });
  }
  assert.strictEqual(dbStore.countLearningHistory(U.id), 100, '每位用户最多保留 100 条');
  const list = dbStore.listLearningHistory(U.id, 5);
  assert.strictEqual(list.length, 5);
  assert.strictEqual(list[0].result, 'out104', '最新的排在最前');
});

test('打卡：当天幂等 + 连续天数统计', () => {
  const first = dbStore.recordLearningCheckin(U.id);
  assert.strictEqual(first, true, '首次打卡返回 true');
  const again = dbStore.recordLearningCheckin(U.id);
  assert.strictEqual(again, false, '当天重复打卡返回 false');
  assert.strictEqual(dbStore.hasCheckedInToday(U.id), true);
  assert.strictEqual(dbStore.countLearningCheckins(U.id), 1);
  assert.ok(dbStore.learningCheckinStreak(U.id) >= 1);
});

test('成长体系：等级与成就由真实数据计算', () => {
  const g = dbStore.getLearningGrowth(U);
  assert.ok(g.level >= 1);
  assert.ok(g.exp > 0, '已有生成/打卡/收藏，经验应大于 0');
  assert.strictEqual(g.stats.generations, 100);
  assert.strictEqual(g.checkedInToday, true);
  const a4 = g.achievements.find(a => a.id === 'a4'); // 文思泉涌：生成≥5
  assert.strictEqual(a4.unlocked, true);
  const a3 = g.achievements.find(a => a.id === 'a3'); // 素材达人：收藏≥10
  assert.strictEqual(a3.unlocked, false);
});
