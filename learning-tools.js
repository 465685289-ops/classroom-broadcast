// 作文学习助手：工具 prompt 与结构化结果解析。
// 保持纯函数，便于测试，避免测试时启动主服务或触碰数据库。

const LEARNING_SYS = {
  workbench: '你是一位陪学生边写边改的语文老师。请只根据学生当前写下的作文内容，给出写作工作台式反馈，严格按下面三行结构输出：\n观察：（用一两句话判断当前作文最明显的状态，例如主题是否清楚、材料是否具体、结构是否完整）\n建议：（给 2-3 条下一步最该改的具体建议，优先指出能立刻提升分数的地方）\n练习：（布置一个很小的当场修改任务，例如重写一句、补一个动作细节、加一处心理描写）\n不要替学生整篇代写，不要编造原文没有的情节。',
  guide: '你是一位带过多届毕业班、深谙考场作文的语文特级教师。请针对学生给的题目、文体和结构偏好，给出能直接照着写的写作思路，严格按下面四行结构输出：\n审题立意：（点出题眼，给出 2-3 个可写角度，并明确最推荐、最容易写出真情实感的那一个）\n结构规划：（按学生所选结构，逐段说明每段写什么、详略如何安排）\n素材方向：（给 3 个贴合主题、初中生真正用得上的具体素材或生活片段）\n开头示范：（写一段约 80 字、可直接参考的开头，要有画面感、善用比喻或排比）\n语言亲切具体，像老师当面讲，不要空话套话。',
  review: '你是一位严格又耐心的考场作文阅卷老师。请对学生作文做具体诊断，严格按下面三行结构输出：\n亮点：（用一两句话肯定它最好的地方）\n问题与修改：（指出 3 处最该改的地方，每一处都先引用原文片段，再给出修改后的示范句）\n总评与提升：（给一句鼓励性的总评，外加一条明确、可立刻执行的提升建议）\n只针对学生原文，绝不编造原文没有的内容。',
  polish: '你是一位文笔出众的语文老师。请在保留学生原意、真实事例和篇章主干的前提下，把这篇作文升格为语言更准确生动、结构更清晰、细节更饱满的版本，严格按下面两行结构输出：\n升格正文：（给出升格后的正文）\n提升说明：（用一句话说明主要做了哪些提升）\n可以锤炼词句、增强首尾与过渡，但不得改变中心思想和真实经历，也不要编造重大情节。',
  material: '你是一位文学功底深厚的语文名师，写出的素材常被当作范文片段。请看学生给的信息：\n如果给的是“人物 + 主题”，就输出一张人物素材卡，严格按三行输出：\n类型：人物素材\n内容：（约 150 字、可直接借鉴的高分人物素材，必须聚焦画面细节，至少用一组排比句式，紧扣主题）\n用法：（一句话说明这段素材适合论证什么主题）\n如果给的是“主题 + 素材类型”，就提供三则角度不同、初中生用得上的优质素材；三则之间用单独一行的 === 分隔；每则严格按三行输出：\n类型：（如 名言/事例/金句/分论点）\n内容：（可直接引用的素材原文，要有文采、有感染力）\n用法：（一句话说明怎么用进作文）',
  outline: '你是一位作文结构指导老师。请针对题目给出一种最稳妥、适合学生直接展开的写作提纲，严格按下面结构输出：\n立意：（一句话点明中心方向）\n第一段：（写什么，如何开头）\n第二段：（写什么，详略如何安排）\n第三段：（写什么，如何承接或转折）\n结尾：（如何收束并升华）\n条理清楚，让初中生能照着把内容填进去。',
  opening: '你是一位现代散文大家。请针对学生给的话题，用指定风格写一组首尾呼应的开头和结尾，开头约 100 字，结尾约 80 字。严格按下面格式输出，开头与结尾之间用单独一行的 === 分隔：\n开头：（开头内容）\n===\n结尾：（结尾内容）\n严禁陈词滥调，意象力求新鲜，首尾在意象或语句上彼此呼应。',
  title: '你是一位考场作文阅卷组长，最懂什么标题能瞬间抓住眼球。请把学生给的普通题目升格成三个高分标题，分别走不同路子：一个偏诗意，一个偏新颖，一个偏巧思。三个标题之间用单独一行的 === 分隔；每个标题严格按三行输出：\n标题：（标题本身，不要带引号或序号）\n类型：（两到四字的手法类型，如 比喻型/诗意型/悬念型/事理型）\n解析：（一句话点明手法与妙处）',
  practice: '你是一位亲切的微写作训练教练。请根据学生给的训练模式和主题，严格按下面三行结构输出：\n练习题：（出一道简短的微写作小题，并用一句话说明要求）\n示范：（给出一段优秀示范）\n评价标准：（用两三句话点出这类描写最关键的小技巧）\n语言适合初中生，篇幅精简。'
};

const TOOL_FALLBACK_TAG = {
  workbench: '写作建议',
  guide: '写作思路',
  review: '作文诊断',
  polish: '润色升格',
  material: '素材',
  outline: '结构提纲',
  opening: '开头结尾',
  title: '升格标题',
  practice: '微写作'
};

function cleanLearningText(t) {
  return String(t || '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/[#*`]/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/^\s*={2,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLearningBlocks(raw) {
  return String(raw || '').split(/\n\s*={2,}\s*\n/).map(b => b.trim()).filter(Boolean);
}

function parseKVBlock(block) {
  const o = {};
  const order = [];
  let lastKey = null;
  block.split('\n').forEach(line => {
    const m = line.match(/^\s*([^：:\n]{2,14})\s*[：:]\s*(.*)$/);
    if (m) {
      lastKey = m[1].trim();
      if (!Object.prototype.hasOwnProperty.call(o, lastKey)) order.push(lastKey);
      o[lastKey] = m[2].trim();
    } else if (lastKey && line.trim()) {
      o[lastKey] += '\n' + line.trim();
    }
  });
  Object.keys(o).forEach(k => { o[k] = cleanLearningText(o[k]); });
  return { values: o, order };
}

function blockToCards(block, fallbackTag) {
  const { values, order } = parseKVBlock(block);
  if (!order.length) {
    const body = cleanLearningText(block);
    return body ? [{ tag: fallbackTag, title: '', body }] : [];
  }
  if (values['标题']) {
    return [{ tag: values['类型'] || fallbackTag, title: values['标题'], body: values['解析'] || '' }];
  }
  if (values['内容']) {
    return [{ tag: values['类型'] || fallbackTag, title: '', body: values['内容'], foot: values['用法'] || '' }];
  }
  return order
    .filter(key => !['类型', '标题', '内容', '用法', '解析'].includes(key))
    .map(key => ({ tag: key, title: '', body: values[key] }))
    .filter(it => it.body);
}

function buildLearningItems(tool, input, raw) {
  const fallbackTag = TOOL_FALLBACK_TAG[tool] || '学习建议';
  const items = splitLearningBlocks(raw).flatMap(block => blockToCards(block, fallbackTag));
  return items.length ? items : null;
}

function learningMinWordCountForGrade(grade) {
  return /^高/.test(String(grade || '').trim()) ? 800 : 600;
}

function polishLengthRule(grade) {
  const minWordCount = learningMinWordCountForGrade(grade);
  return [
    '润色升格的硬性要求：',
    '1. 升格正文必须不少于 ' + minWordCount + ' 字，字数只统计“升格正文”部分，不统计“提升说明”。',
    '2. 如果原文字数不足，也要在不改变中心思想和真实经历的前提下，通过补足环境、动作、心理、对话、过渡和首尾照应扩展到最低字数。',
    '3. 不要为了凑字重复同一句意思，不要写成提纲，不要用“略”等方式省略正文。'
  ].join('\n');
}

function polishedBodyLength(raw) {
  const text = cleanLearningText(raw);
  const match = text.match(/升格正文\s*[：:]\s*([\s\S]*?)(?:\n\s*提升说明\s*[：:]|$)/);
  const body = match ? match[1] : text;
  return body.replace(/\s/g, '').length;
}

function polishNeedsRetry(raw, grade) {
  return polishedBodyLength(raw) < learningMinWordCountForGrade(grade);
}

function buildPolishRetryUserPrompt(input, firstResult, minWordCount) {
  return [
    '当前升格正文不足 ' + minWordCount + ' 字，未达到本学段最低字数要求。',
    '请基于原文和上一次结果重新输出，升格正文必须扩写到不少于 ' + minWordCount + ' 字。',
    '扩写只能补充与原文一致、可自然推断的环境、动作、心理、对话、过渡和首尾照应；不得改变中心思想和真实经历，不得编造重大情节。',
    '',
    '原始输入：',
    input,
    '',
    '上一次结果：',
    firstResult
  ].join('\n');
}

function learningToolPrompt(tool, input, options = {}) {
  const sys = LEARNING_SYS[tool];
  if (!sys) return null;
  const stageRule = tool === 'polish' ? '\n\n' + polishLengthRule(options.grade) : '';
  return {
    system: sys + stageRule + '\n\n请直接输出纯文本，不要使用任何 Markdown 标记（不要出现 #、*、>、` 等符号），用中文标签加冒号组织内容。',
    user: input
  };
}

module.exports = {
  LEARNING_SYS,
  buildPolishRetryUserPrompt,
  buildLearningItems,
  cleanLearningText,
  learningMinWordCountForGrade,
  learningToolPrompt,
  polishNeedsRetry,
  polishedBodyLength
};
