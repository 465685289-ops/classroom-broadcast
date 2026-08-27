const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEARNING_SYS,
  buildLearningItems,
  buildPolishRetryUserPrompt,
  learningMinWordCountForGrade,
  learningToolPrompt,
  polishNeedsRetry,
  polishedBodyLength
} = require('../learning-tools');

const expectedTools = ['workbench', 'guide', 'review', 'polish', 'material', 'outline', 'opening', 'title', 'practice'];

test('defines an independent prompt for every student writing tool', () => {
  for (const tool of expectedTools) {
    assert.equal(typeof LEARNING_SYS[tool], 'string', tool + ' prompt missing');
    assert.ok(LEARNING_SYS[tool].length > 30, tool + ' prompt is too thin');
    assert.ok(learningToolPrompt(tool, '示例输入'), tool + ' should build a prompt');
  }
});

test('rejects unknown learning tools', () => {
  assert.equal(learningToolPrompt('unknown', '示例输入'), null);
});

test('polish prompts enforce the minimum length for the selected school stage', () => {
  const junior = learningToolPrompt('polish', '作文正文：今天我很开心。', { grade: '初二' });
  const senior = learningToolPrompt('polish', '作文正文：今天我很开心。', { grade: '高一' });

  assert.equal(learningMinWordCountForGrade('初二'), 600);
  assert.equal(learningMinWordCountForGrade('高一'), 800);
  assert.match(junior.system, /不少于 600 字/);
  assert.match(senior.system, /不少于 800 字/);
  assert.match(junior.system, /硬性要求/);
  assert.match(junior.system, /如果原文字数不足/);
});

test('counts only the upgraded body when checking polish length', () => {
  const body = '升格正文：春风吹过操场，我停下脚步。\n提升说明：主要补充了细节。';
  assert.equal(polishedBodyLength(body), 13);
  assert.equal(polishedBodyLength('没有标签时按全文统计'), 10);
});

test('builds a retry prompt when the polished essay is below the required length', () => {
  const retry = buildPolishRetryUserPrompt('原文：今天我很开心。', '升格正文：今天真开心。', 600);

  assert.match(retry, /当前升格正文不足 600 字/);
  assert.match(retry, /必须扩写到不少于 600 字/);
  assert.match(retry, /原文：今天我很开心。/);
  assert.match(retry, /升格正文：今天真开心。/);
});

test('detects when a polished essay still misses the stage minimum length', () => {
  assert.equal(polishNeedsRetry('升格正文：太短了。', '初二'), true);
  assert.equal(polishNeedsRetry('升格正文：' + '好'.repeat(600), '初二'), false);
  assert.equal(polishNeedsRetry('升格正文：' + '好'.repeat(799), '高一'), true);
  assert.equal(polishNeedsRetry('升格正文：' + '好'.repeat(800), '高一'), false);
});

test('parses structured result cards for every writing tool', () => {
  const samples = {
    workbench: '观察：整体内容完整，但中段略散。\n建议：下一段补一个动作细节。\n练习：把“我很感动”改成具体画面。',
    guide: '审题立意：题眼是“长大”。\n结构规划：先写事件，再写变化。\n素材方向：可写一次承担责任。\n开头示范：雨声敲在窗上，我忽然明白了责任。',
    review: '亮点：细节真实。\n问题与修改：原句“我很开心”可以改为“笑意从眼角溢出来”。\n总评与提升：继续补足心理变化。',
    polish: '升格正文：风从操场掠过，我握紧了手里的试卷。\n提升说明：主要强化了细节和首尾照应。',
    material: '类型：事例\n内容：苏轼被贬黄州，却在赤壁月色中写出旷达。\n用法：可用于逆境与乐观主题。\n===\n类型：金句\n内容：困境不是墙，而是通向更高处的台阶。\n用法：可放在结尾升华。',
    outline: '立意：成长是学会承担。\n第一段：写事件开端。\n第二段：写承担责任的过程。\n第三段：写感悟升华。',
    opening: '开头：风把试卷一角轻轻掀起，我听见心跳撞向胸口。\n===\n结尾：那张试卷仍在桌角，而我终于学会把风雨收进心里。',
    title: '标题：把春天种进心里\n类型：诗意型\n解析：用“春天”象征希望。\n===\n标题：那一次，我没有躲开\n类型：悬念型\n解析：制造故事张力。',
    practice: '练习题：写一段雨中的等待。\n示范：雨丝落在伞沿，像一排细小的钟声。\n评价标准：有感官细节，有情绪变化。'
  };

  for (const tool of expectedTools) {
    const items = buildLearningItems(tool, tool === 'material' ? '主题：逆境\n素材类型：事例' : '示例输入', samples[tool]);
    assert.ok(Array.isArray(items), tool + ' should return cards');
    assert.ok(items.length >= 1, tool + ' should have at least one card');
    assert.ok(items.every(it => it.tag && it.body), tool + ' cards need tag and body');
  }
});
