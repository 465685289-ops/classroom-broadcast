'use strict';
// AI 引擎层：评语生成(DeepSeek) / 作文批改(Qwen·MiniMax) / 学习助手 / 提示词构建。
const crypto = require('crypto');
const https = require('https');
// @WIRE
const {
  commentHost, deviceCookieOptions, encodeInviteCookie, essayHost, learningHost, parseCookieHeader, referralCookieOptions, roundtableHost
} = require('./http-utils');
const {
  DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_VISION_API_KEY, DEEPSEEK_VISION_MODEL, DEVICE_COOKIE_NAME, ESSAY_OCR_DAILY_LIMIT, GLM_API_KEY, GLM_API_PATH, GLM_OCR_MODEL, INVITE_COOKIE_MAX_AGE_MS, INVITE_COOKIE_NAME, INVITE_COOKIE_SECRET, LEARNING_MODEL, MINIMAX_API_KEYS, MINIMAX_MODEL, QWEN_API_KEY, QWEN_OCR_MODEL
} = require('./platform-config');

function normalizeCommentStudent(input) {
  const raw = input || {};
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(t => String(t || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const minLen = Math.min(Math.max(parseInt(raw.minLen || raw.min_len || 120, 10) || 120, 60), 500);
  const maxLen = Math.min(Math.max(parseInt(raw.maxLen || raw.max_len || 180, 10) || 180, minLen), 700);
  const concreteNote = String(
    raw.concreteNote || raw.concrete_note || raw.specificNote || raw.specific_note || raw.impression || raw.event || ''
  ).trim().slice(0, 500);
  return {
    name: String(raw.name || '').trim().slice(0, 30),
    gender: String(raw.gender || '未知').trim().slice(0, 10),
    schoolStage: String(raw.schoolStage || raw.school_stage || '小学').trim().slice(0, 10),
    performance: String(raw.performance || '良好').trim().slice(0, 30),
    style: String(raw.style || 'gentle').trim().slice(0, 30),
    styleLabel: String(raw.styleLabel || raw.style_label || '').trim().slice(0, 30),
    tags,
    concreteNote,
    minLen,
    maxLen
  };
}

function normalizeCommentRosterStudents(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 500).map((row, index) => {
    const student = normalizeCommentStudent(row);
    student.id = String(row && row.id || index + 1).slice(0, 64);
    student.comment = String(row && row.comment || '').slice(0, 3000);
    return student.name ? student : null;
  }).filter(Boolean);
}

function normalizeRosterName(value) {
  const name = String(value || '').trim().slice(0, 40);
  return name || ('花名册 ' + new Date().toLocaleDateString('zh-CN'));
}

function commentStyleLabel(style) {
  const labels = {
    gentle: '温柔鼓励型',
    serious: '严肃指正型',
    humorous: '幽默风趣型',
    elegant: '深沉文雅型',
    passionate: '激情澎湃型'
  };
  return labels[style] || style || '温柔鼓励型';
}

function commentStyleGuide(style) {
  const guides = {
    gentle: '语气温和，多给孩子信心，夸奖要落在具体表现上。',
    serious: '可以把问题说清楚，直接但不尖锐，像真正在帮学生改进。',
    humorous: '可以有一点轻松口吻，幽默要自然贴近学生，不要写成段子。',
    elegant: '句子可以更有文采和余味，但不要堆砌辞藻。',
    passionate: '可以多一点鼓励和期待，但要有真情实感，不要喊口号。'
  };
  return guides[style] || guides.gentle;
}

function deepseekChatCompletion(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.72
    });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY
      },
      timeout: 60000
    }, resp => {
      let raw = '';
      resp.on('data', chunk => raw += chunk);
      resp.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          return reject(new Error('DeepSeek 返回格式异常'));
        }
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          return reject(new Error(data.error && data.error.message || 'DeepSeek 请求失败'));
        }
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        resolve(String(content || '').trim());
      });
    });
    req.on('timeout', () => req.destroy(new Error('DeepSeek 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 作文学习：用 deepseek-v4-flash 直连，速度快；system+user 双角色，温度偏高更有文采
function learningGenerateAI(system, user, temperature = 1.3) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: LEARNING_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature,
      max_tokens: 3000
    });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY
      },
      timeout: 90000
    }, resp => {
      let raw = '';
      resp.on('data', chunk => raw += chunk);
      resp.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { return reject(new Error('DeepSeek 返回格式异常')); }
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          return reject(new Error(data.error && data.error.message || 'DeepSeek 请求失败'));
        }
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        resolve(String(content || '').trim());
      });
    });
    req.on('timeout', () => req.destroy(new Error('DeepSeek 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function deepseekChatStream(messages, opts, res) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      stream: true,
      temperature: opts && opts.temperature != null ? opts.temperature : 0.85,
      max_tokens: (opts && opts.max_tokens) || 800,
      reasoning_effort: 'none'
    });
    const upstream = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY
      },
      timeout: 120000
    }, up => {
      if (up.statusCode < 200 || up.statusCode >= 300) {
        let raw = '';
        up.on('data', c => raw += c);
        up.on('end', () => {
          let msg = 'DeepSeek 请求失败';
          try { const j = JSON.parse(raw); msg = (j.error && j.error.message) || msg; } catch (e) {}
          reject(new Error(msg));
        });
        return;
      }
      up.on('data', chunk => { res.write(chunk); });
      up.on('end', () => resolve());
      up.on('error', reject);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('DeepSeek 请求超时')));
    upstream.on('error', reject);
    upstream.write(body);
    upstream.end();
  });
}

async function generateAICommentForStudent(student) {
  const stage = student.schoolStage || '小学';
  const systemInstruction = [
    '你是一位文笔很好、带了多年班的班主任，正在给【' + stage + '】学生写期末评语。',
    '评语是写给学生本人看的，必须用第二人称“你”。',
    '语气像班主任对自己学生说话：亲切、真诚、有分量，有文采但不端着。'
  ].join('\n');
  const styleLabel = student.styleLabel || commentStyleLabel(student.style);
  const concreteLine = student.concreteNote
    ? '老师提供的具体事例或印象：' + student.concreteNote
    : '老师没有提供具体事例。此时要把标签写成可感知的日常画面，不要虚构具体事件、考试分数、家庭情况或老师没有提供的经历。';
  const userPrompt = [
    '学生信息：',
    '姓名：' + student.name,
    '性别：' + (student.gender || '未知'),
    '学段：' + stage,
    '整体水平：' + student.performance,
    '语气风格：' + styleLabel + '。' + commentStyleGuide(student.style),
    '特点标签：' + (student.tags.length ? student.tags.join('、') : '无特别标签'),
    concreteLine,
    '',
    '请写一段期末评语，严格遵守：',
    '【风格要求】',
    '1. 语言要生动、温暖，可以用比喻、修辞，展现文采。',
    '2. 每条评语里比喻不超过两个，贵精不贵多；不要堆满华丽词。',
    '3. 开头方式要多变，不要固定套用“你让我想到一个词”“你就像班里的XX”“你是一个有XX的孩子”这类句式。',
    '4. 结尾方式也要自然变化：可以深情展望，可以温和叮嘱，也可以轻松幽默收住，但不要每次都喊口号。',
    '',
    '【个性化要求】',
    '1. 必须紧扣这个学生的标签特点来写，让人一读就知道写的是这个孩子，而不是放在谁身上都行的套话。',
    '2. 如果老师填了具体事例或印象，务必把它融入评语，作为最亮的细节；围绕真事展开，比空洞夸奖更重要。',
    '3. 如果没有具体事例，就把标签写成可感知的日常画面，而不是简单把标签换成同义的漂亮词。',
    '4. 不要虚构没有提供的具体人物、奖项、分数、家庭情况或事件。',
    '',
    '【分寸把握】',
    '1. 优点要夸得有画面感，让学生读到觉得“老师真的看见我了”。',
    '2. 缺点要提得具体但不伤人，像真正关心这个学生的班主任。',
    '3. 评价要兼顾学生当前水平：优秀的学生可以提出更高期待，暂时落后的学生要让他看到可走的下一步。',
    '4. 字数控制在 ' + student.minLen + '-' + student.maxLen + ' 字之间，只输出评语正文，不要加“评语：”等前缀。'
  ].join('\n');
  return deepseekChatCompletion([
    { role: 'system', content: systemInstruction },
    { role: 'user', content: userPrompt }
  ]);
}

function commentRewriteGuide(mode) {
  const guides = {
    sincere: {
      key: 'sincere',
      label: '更真诚',
      instruction: '减少套话和泛泛夸奖，让语气更像班主任真心对这个学生说话。情感要更具体、更稳，不要煽情过度。'
    },
    concrete: {
      key: 'concrete',
      label: '更具体',
      instruction: '把标签和具体事例写得更有画面感，让学生读到觉得老师确实看见了他的日常表现。不要新增未提供的事件。'
    },
    shorter: {
      key: 'shorter',
      label: '更短一点',
      instruction: '压缩表达，删掉重复和空泛句子，保留最有分量的观察、提醒和鼓励。整体比原文短一些。'
    },
    literary: {
      key: 'literary',
      label: '更有文采',
      instruction: '语言更生动、有一点文采和余味，但比喻不超过两个，不要堆砌辞藻，不要写成作文腔。'
    },
    balanced: {
      key: 'balanced',
      label: '温和提不足',
      instruction: '在肯定优点的同时，更自然地补上一点具体不足和下一步建议。语气要温和，不伤人，不说教。'
    }
  };
  return guides[mode] || guides.sincere;
}

async function rewriteAICommentForStudent(student, currentComment, mode) {
  const stage = student.schoolStage || '小学';
  const guide = commentRewriteGuide(mode);
  const systemInstruction = [
    '你是一位文笔很好、带了多年班的班主任，正在帮老师二次修改一段期末评语。',
    '评语是写给【' + stage + '】学生本人看的，必须用第二人称“你”。',
    '你要保留原评语中的真实观察和老师态度，只按指定方向改得更好。'
  ].join('\n');
  const concreteLine = student.concreteNote
    ? '老师提供的具体事例或印象：' + student.concreteNote
    : '老师没有提供具体事例。不能虚构具体事件、考试分数、家庭情况或老师没有提供的经历。';
  const userPrompt = [
    '学生信息：',
    '姓名：' + student.name,
    '性别：' + (student.gender || '未知'),
    '学段：' + stage,
    '整体水平：' + student.performance,
    '语气风格：' + (student.styleLabel || commentStyleLabel(student.style)) + '。' + commentStyleGuide(student.style),
    '特点标签：' + (student.tags.length ? student.tags.join('、') : '无特别标签'),
    concreteLine,
    '',
    '原评语：',
    currentComment,
    '',
    '改写方向：' + guide.label,
    guide.instruction,
    '',
    '改写要求：',
    '1. 只改写这段评语，不要另起炉灶，不要改变学生事实和老师原本判断。',
    '2. 必须继续紧扣学生标签；如果有具体事例或印象，要把它保留下来或写得更自然。',
    '3. 语言亲切、真诚、有分量，可以有文采，但比喻不超过两个。',
    '4. 优点要有画面感，缺点要具体但不伤人。',
    '5. 字数尽量控制在 ' + student.minLen + '-' + student.maxLen + ' 字之间；如果改写方向是“更短一点”，可以适当低于下限。',
    '6. 只输出改写后的评语正文，不要加“评语：”“修改版：”等前缀。'
  ].join('\n');
  return deepseekChatCompletion([
    { role: 'system', content: systemInstruction },
    { role: 'user', content: userPrompt }
  ]);
}

// ---------- 作文批改 AI ----------
// 通用 OpenAI 兼容接口调用（qwen / MiniMax 都走这个）
function openAICompatChat(options) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens || 4096
    });
    const req = https.request({
      hostname: options.hostname,
      path: options.apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + options.apiKey
      },
      timeout: options.timeoutMs || 120000
    }, resp => {
      let raw = '';
      resp.on('data', chunk => raw += chunk);
      resp.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          return reject(new Error(options.label + ' 返回格式异常'));
        }
        if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
          return reject(new Error(options.label + ' 错误[' + data.base_resp.status_code + ']：' + (data.base_resp.status_msg || '')));
        }
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          return reject(new Error(data.error && data.error.message || options.label + ' 请求失败 HTTP ' + resp.statusCode));
        }
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (typeof content === 'string' && content.trim()) return resolve(content.trim());
        if (Array.isArray(content)) {
          const joined = content.map(c => c && c.text || '').join('').trim();
          if (joined) return resolve(joined);
        }
        reject(new Error(options.label + ' 响应无内容'));
      });
    });
    req.on('timeout', () => req.destroy(new Error(options.label + ' 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function qwenOcrImage(imageDataUrl) {
  return openAICompatChat({
    label: 'OCR',
    hostname: 'dashscope.aliyuncs.com',
    apiPath: '/compatible-mode/v1/chat/completions',
    apiKey: QWEN_API_KEY,
    model: QWEN_OCR_MODEL,
    temperature: 0.01,
    maxTokens: 4096,
    timeoutMs: 90000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text', text: 'OCR文字识别任务。请逐字逐句抄录图片中的所有手写或印刷文字。严格要求：\n1. 不遗漏任何文字，包括标题、正文、标点\n2. 保持原文段落格式，每段之间用空行分隔\n3. 严禁创作、改写、纠错或补全任何内容，原文写什么就抄什么\n4. 如有多列文字，按从左到右、从上到下顺序识别\n5. 只输出识别到的文字，不要任何解释说明、不要加引号、不要加markdown标记' }
      ]
    }]
  });
}

// 推理模型（如 MiniMax-M2.7）会在正文里输出 <think>…</think> 思考过程，批改结果必须剥掉
function stripThinkBlocks(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
}

// 批改：MiniMax 多 key 轮询，全部失败再 fallback 到 DeepSeek
async function gradeEssayAI(prompt) {
  let lastErr = null;
  for (let i = 0; i < MINIMAX_API_KEYS.length; i++) {
    try {
      const result = await openAICompatChat({
        label: 'MiniMax',
        hostname: 'api.minimaxi.com',
        apiPath: '/v1/chat/completions',
        apiKey: MINIMAX_API_KEYS[i],
        model: MINIMAX_MODEL,
        temperature: 0.7,
        maxTokens: 8000,
        timeoutMs: 150000,
        messages: [{ role: 'user', content: prompt }]
      });
      const cleaned = stripThinkBlocks(result);
      if (cleaned) return { result: cleaned, model: MINIMAX_MODEL };
      throw new Error('MiniMax 返回内容为空');
    } catch (e) {
      lastErr = e;
      console.log('[ESSAY] MiniMax key[' + i + '] 失败:', e.message);
    }
  }
  if (DEEPSEEK_API_KEY) {
    console.log('[ESSAY] MiniMax 全部失败，fallback 到 DeepSeek');
    const result = stripThinkBlocks(await deepseekChatCompletion([{ role: 'user', content: prompt }]));
    if (result) return { result, model: DEEPSEEK_MODEL };
  }
  throw lastErr || new Error('AI 批改服务暂不可用');
}

function essayAIConfigured() {
  return MINIMAX_API_KEYS.length > 0 || !!DEEPSEEK_API_KEY;
}

const ESSAY_GENRES = ['记叙文', '议论文', '说明文', '抒情散文'];
const ESSAY_GRADE_LEVELS = [
  '小学三年级', '小学四年级', '小学五年级', '小学六年级',
  '初一', '初二', '初三',
  '高一', '高二', '高三'
];
// '百分制' 为旧版兼容值，等同 '满分100分'
const ESSAY_SCORE_TYPES = ['满分100分', '满分60分', '满分50分', '满分40分', '满分30分', '等级制', '百分制'];

function essayTeacherStage(gradeLevel) {
  if (gradeLevel.indexOf('小学') === 0) return '小学';
  if (gradeLevel.indexOf('高') === 0) return '高中';
  return '初中';
}

function essayScoreRule(scoreType) {
  if (scoreType === '等级制') {
    return {
      instruction: '等级制，分为 A/B/C/D 四等（A为优秀），各维度和总分都给等级',
      detailLine: '【评分详情】立意:X等 内容:X等 结构:X等 语言:X等 卷面:X等 总评等级:X等'
    };
  }
  const m = String(scoreType).match(/\d+/);
  const full = m ? m[0] : '100';
  return {
    instruction: '满分 ' + full + ' 分制（考场作文分值），立意/内容/结构/语言/卷面各维度分值按比例分配，五项之和等于总分，总分不得超过 ' + full + ' 分',
    detailLine: '【评分详情】立意:XX分 内容:XX分 结构:XX分 语言:XX分 卷面:XX分 总分:XX分（满分' + full + '分）'
  };
}

// 八个固定评价维度（雷达图用），顺序固定
const ESSAY_DIMENSIONS = ['内容', '结构', '语言', '立意', '选材', '情感', '书写', '卷面'];

function buildEssayPrompt(text, genre, gradeLevel, scoreType, taskContext) {
  const stage = essayTeacherStage(gradeLevel);
  const m = String(scoreType).match(/\d+/);
  const full = (scoreType === '等级制') ? 100 : (m ? parseInt(m[0]) : 100);
  const isGrade = scoreType === '等级制';
  const totalRule = isGrade
    ? '等级制：display_total 给 A/B/C/D 等第（A为优秀），total_100 给对应的百分制数值（A≈92,B≈82,C≈72,D≈60 上下浮动），score_unit 填 "等"。'
    : '满分 ' + full + ' 分制：display_total 给本卷实际得分（不超过 ' + full + '），total_100 给换算到百分制的数值，score_unit 填 "/ ' + full + ' 分"。';
  const task = taskContext || {};
  const taskBlock = (task.title || task.material || task.requirements || (task.rubric && task.rubric.dimensions && task.rubric.dimensions.length))
    ? '\n【本次作文任务】\n题目：' + (task.title || '未填写') + '\n材料：' + (task.material || '无') + '\n写作要求：' + (task.requirements || '按年级通用要求')
      + '\n字数范围：' + (task.min_words || 0) + '-' + (task.max_words || 0)
      + '\n评分维度与权重：' + ((task.rubric && task.rubric.dimensions || []).map(d => d.name + ' ' + d.weight + '%').join('、') || '采用通用八维标准') + '\n'
    : '';
  return '你是一位资深' + stage + '语文教师，现在批改一篇' + gradeLevel + '学生写的' + genre + '。'
    + '评价标准必须符合' + gradeLevel + '学生的真实写作水平：不拔高、不放水，像真实的' + stage + '老师判卷一样。\n\n'
    + taskBlock
    + '【作文全文】\n' + text + '\n\n'
    + '【输出要求】只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块包裹。JSON 结构如下：\n'
    + '{\n'
    + '  "dimensions": [八个对象，name 依次为 内容、结构、语言、立意、选材、情感、书写、卷面，每个 score 为 0-100 的整数],\n'
    + '  "total_100": 0-100 的整数（综合得分，换算到百分制）,\n'
    + '  "display_total": "用于醒目展示的总分文字（见评分制说明）",\n'
    + '  "score_unit": "分值单位文字",\n'
    + '  "grade_label": "一句话等第，如 良·上 / 优 / 中等偏上",\n'
    + '  "annotations": [每个原文自然段一个对象 {"para":"该段原文（可截取前句）","comment":"针对该段的旁批，指出具体问题或亮点"}],\n'
    + '  "comments": {\n'
    + '    "strict": "严厉口吻的尾批总评，直指问题，3-5句",\n'
    + '    "warm": "温暖体察口吻的尾批总评，3-5句",\n'
    + '    "cheer": "鼓励成长口吻的尾批总评，3-5句"\n'
    + '  },\n'
    + '  "polish": [每个自然段一个对象 {"orig":"该段原文","polished":"保持学生原意、提升语言后的润色范文"}]\n'
    + '}\n\n'
    + '【评分制说明】' + totalRule + '\n'
    + '【注意】dimensions 必须正好 8 个且 name 完全按上述顺序；annotations 和 polish 的条数与作文自然段数一致；所有文本用中文；只输出 JSON。';
}

// 从模型输出里抠出 JSON 对象（容忍 ```json 围栏、<think> 残留、前后多余文字）
function extractEssayJson(raw) {
  let s = stripThinkBlocks(raw);
  s = s.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  // 从第一个 { 开始做括号配平，找到匹配的结尾 }
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}

// 规整结构化批改数据：补齐 8 维度、夹紧分数范围
function normalizeEssayData(data) {
  if (!data || typeof data !== 'object') return null;
  const clamp = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const dimMap = {};
  (Array.isArray(data.dimensions) ? data.dimensions : []).forEach(d => {
    if (d && d.name) dimMap[String(d.name).trim()] = clamp(d.score);
  });
  const dimensions = ESSAY_DIMENSIONS.map(name => ({ name, score: dimMap[name] != null ? dimMap[name] : (Number(data.total_100) ? clamp(data.total_100) : 0) }));
  return {
    structured: true,
    dimensions,
    total_100: clamp(data.total_100),
    display_total: String(data.display_total || data.total_100 || '').slice(0, 12),
    score_unit: String(data.score_unit || '').slice(0, 12),
    grade_label: String(data.grade_label || '').slice(0, 20),
    annotations: (Array.isArray(data.annotations) ? data.annotations : []).map(a => ({
      para: String(a && a.para || '').slice(0, 1000),
      comment: String(a && a.comment || '').slice(0, 1000)
    })),
    comments: {
      strict: String(data.comments && data.comments.strict || '').slice(0, 2000),
      warm: String(data.comments && data.comments.warm || '').slice(0, 2000),
      cheer: String(data.comments && data.comments.cheer || '').slice(0, 2000)
    },
    polish: (Array.isArray(data.polish) ? data.polish : []).map(p => ({
      orig: String(p && p.orig || '').slice(0, 2000),
      polished: String(p && p.polished || '').slice(0, 2000)
    }))
  };
}

// 把结构化数据转成旧版纯文本（批量批改 / Word 导出 / 历史展示沿用旧解析，保持兼容）
function essayDataToLegacyText(d) {
  let t = '';
  d.annotations.forEach((a, i) => { t += '第' + (i + 1) + '段旁批：' + a.comment + '\n'; });
  t += '\n尾批部分：\n';
  t += '【总评】' + (d.grade_label || '') + '\n';
  t += '【评分详情】' + d.dimensions.map(x => x.name + ':' + x.score).join(' ') + ' 总评:' + (d.display_total || d.total_100) + (d.score_unit || '') + '\n';
  t += '【教师评语】' + (d.comments.warm || d.comments.strict || '') + '\n';
  return t.trim();
}

const ENGLISH_TASK_TYPES = ['初中日常作文', '中考作文', '高中应用文', '读后续写'];
const ENGLISH_RUBRIC_PRESETS = Object.freeze({
  '初中日常作文': Object.freeze([
    { name: '任务完成', weight: 25 }, { name: '内容要点', weight: 25 },
    { name: '语言准确', weight: 20 }, { name: '词汇句式', weight: 15 },
    { name: '结构衔接', weight: 10 }, { name: '书写规范', weight: 5 }
  ]),
  '中考作文': Object.freeze([
    { name: '任务完成', weight: 25 }, { name: '内容要点', weight: 20 },
    { name: '语言准确', weight: 25 }, { name: '词汇句式', weight: 15 },
    { name: '结构衔接', weight: 10 }, { name: '书写规范', weight: 5 }
  ]),
  '高中应用文': Object.freeze([
    { name: '任务完成', weight: 30 }, { name: '内容完整', weight: 20 },
    { name: '语言质量', weight: 20 }, { name: '篇章组织', weight: 15 },
    { name: '文体得体', weight: 10 }, { name: '格式规范', weight: 5 }
  ]),
  '读后续写': Object.freeze([
    { name: '情节合理', weight: 25 }, { name: '原文衔接', weight: 20 },
    { name: '人物主题', weight: 15 }, { name: '语言表达', weight: 20 },
    { name: '篇章连贯', weight: 15 }, { name: '细节丰富', weight: 5 }
  ])
});

function englishRubricFor(taskType, assignment) {
  const custom = assignment && assignment.rubric && Array.isArray(assignment.rubric.dimensions)
    ? assignment.rubric.dimensions.filter(item => item && item.name)
    : [];
  const source = custom.length ? custom : (ENGLISH_RUBRIC_PRESETS[taskType] || ENGLISH_RUBRIC_PRESETS['中考作文']);
  const total = source.reduce((sum, item) => sum + (Number(item.weight) || 0), 0) || 100;
  return source.map(item => ({
    name: String(item.name || '').trim().slice(0, 30),
    weight: Math.round((Number(item.weight) || 0) * 10000 / total) / 100
  }));
}

function englishFullScore(scoreType) {
  const match = String(scoreType || '').match(/\d+/);
  return Math.max(1, Math.min(100, match ? Number(match[0]) : 20));
}

function buildEnglishEssayPrompt(text, taskType, gradeLevel, scoreType, assignment) {
  const rubric = englishRubricFor(taskType, assignment);
  const fullScore = englishFullScore(scoreType);
  const task = assignment || {};
  const wordCount = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const rubricText = rubric.map(item => item.name + ' ' + item.weight + '%').join('；');
  return [
    '你是一名有多年一线教学和阅卷经验的中国中学英语教师。请批改学生英语作文。',
    '你的任务是帮助教师判断和修改，而不是替学生代写。评分应符合学生学段，修改稿必须保留原意、原有水平和个人表达，不得改写成明显超出学生水平的范文。',
    '',
    '【学段与题型】' + gradeLevel + ' · ' + taskType,
    '【总分】' + fullScore + '分',
    '【作文题目】' + (task.title || '未填写'),
    '【题目材料】' + (task.material || '无'),
    '【写作要求】' + (task.requirements || '按该学段和题型的常规要求'),
    '【字数要求】' + (task.min_words || 0) + '-' + (task.max_words || 0) + '词；实写约' + wordCount + '词',
    '【评分维度】' + rubricText,
    '',
    '【学生原文】',
    text,
    '',
    '【评分规则】',
    '1. 先根据整篇表现判断档次，再在各维度内给分；维度 score 一律为0-100的质量分。',
    '2. 每个维度必须给出原文证据和中文理由；同一错误不能在多个维度重复扣分。',
    '3. 漏写要点、字数不足、格式错误等硬性问题放入 deductions；维度分中已经反映的问题不要二次扣除。',
    '4. 逐句问题分类限定为：语法、拼写、搭配、中式英语、衔接、标点格式、亮点。中文解释要让中国学生看得懂，英文建议要尽量小改。',
    '5. suggestion_en 只给局部修改；revised_version 才给完整修改稿，但必须保持学生原有水平。',
    '',
    '只输出一个合法 JSON 对象，不要 markdown，不要解释。结构：',
    JSON.stringify({
      band: '档次名称',
      dimensions: rubric.map(item => ({ name: item.name, weight: item.weight, score: 0, evidence: '原文证据', reason_zh: '中文评分理由' })),
      deductions: [{ type: '字数/漏点/格式', points: 0, evidence: '依据' }],
      annotations: [{ quote: '原句或短语', category: '语法', explanation_zh: '中文解释', suggestion_en: '英文修改建议', confidence: 0.9 }],
      strengths: ['具体优点'],
      overall_feedback_zh: '给学生的中文总评',
      next_steps: ['下一步练习建议'],
      revised_version: '保留学生水平的完整英文修改稿'
    })
  ].join('\n');
}

function normalizeEnglishEssayData(data, taskType, scoreType, assignment, originalText) {
  if (!data || typeof data !== 'object') return null;
  const clamp = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const rubric = englishRubricFor(taskType, assignment);
  const source = new Map((Array.isArray(data.dimensions) ? data.dimensions : []).map(item => [String(item && item.name || '').trim(), item || {}]));
  const dimensions = rubric.map(item => {
    const raw = source.get(item.name) || {};
    return {
      name: item.name,
      weight: item.weight,
      score: clamp(raw.score),
      evidence: String(raw.evidence || '').slice(0, 800),
      reason_zh: String(raw.reason_zh || raw.reason || '').slice(0, 1200)
    };
  });
  const total100 = clamp(dimensions.reduce((sum, item) => sum + item.score * item.weight / 100, 0));
  const fullScore = englishFullScore(scoreType);
  const actualScore = Math.max(0, Math.min(fullScore, Math.round(total100 * fullScore) / 100));
  const annotations = (Array.isArray(data.annotations) ? data.annotations : []).slice(0, 80).map(item => ({
    quote: String(item && item.quote || '').slice(0, 1000),
    category: String(item && item.category || '语言表达').slice(0, 20),
    explanation_zh: String(item && (item.explanation_zh || item.explanation) || '').slice(0, 1200),
    suggestion_en: String(item && (item.suggestion_en || item.suggestion) || '').slice(0, 1200),
    confidence: Math.max(0, Math.min(1, Number(item && item.confidence) || 0.7)),
    status: 'pending'
  })).filter(item => item.quote || item.explanation_zh || item.suggestion_en);
  return {
    structured: true,
    task_type: taskType,
    grade_level: String(assignment && assignment.grade_level || ''),
    full_score: fullScore,
    total_100: total100,
    actual_score: actualScore,
    display_total: actualScore + '/' + fullScore,
    band: String(data.band || '').slice(0, 30),
    word_count: String(originalText || '').trim().split(/\s+/).filter(Boolean).length,
    dimensions,
    deductions: (Array.isArray(data.deductions) ? data.deductions : []).slice(0, 12).map(item => ({
      type: String(item && item.type || '').slice(0, 30),
      points: Math.max(0, Number(item && item.points) || 0),
      evidence: String(item && item.evidence || '').slice(0, 800)
    })).filter(item => item.type),
    annotations,
    strengths: (Array.isArray(data.strengths) ? data.strengths : []).slice(0, 8).map(item => String(item || '').slice(0, 600)).filter(Boolean),
    overall_feedback_zh: String(data.overall_feedback_zh || '').slice(0, 3000),
    next_steps: (Array.isArray(data.next_steps) ? data.next_steps : []).slice(0, 6).map(item => String(item || '').slice(0, 600)).filter(Boolean),
    revised_version: String(data.revised_version || '').slice(0, 8000),
    teacher_review_required: true
  };
}

function englishDataToText(data) {
  return [
    '总分：' + data.display_total + (data.band ? ' · ' + data.band : ''),
    '维度：' + data.dimensions.map(item => item.name + ' ' + item.score).join('；'),
    '总评：' + data.overall_feedback_zh,
    '下一步：' + data.next_steps.join('；')
  ].join('\n');
}

// OCR 每用户每日限额（防滥用，内存计数，重启清零）
const essayOcrUsage = new Map();
function essayOcrAllowed(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const rec = essayOcrUsage.get(userId);
  if (!rec || rec.day !== today) {
    if (essayOcrUsage.size > 5000) essayOcrUsage.clear();
    essayOcrUsage.set(userId, { day: today, count: 1 });
    return true;
  }
  if (rec.count >= ESSAY_OCR_DAILY_LIMIT) return false;
  rec.count++;
  return true;
}

// ---------- 周测阅卷 exam ----------
// 试卷答题照 OCR：按题号组织抄录，保留"【题N】"锚点供后续逐题评分对位
function qwenOcrExamImage(imageDataUrl) {
  return openAICompatChat({
    label: 'EXAM-OCR',
    hostname: 'dashscope.aliyuncs.com',
    apiPath: '/compatible-mode/v1/chat/completions',
    apiKey: QWEN_API_KEY,
    model: QWEN_OCR_MODEL,
    temperature: 0.01,
    maxTokens: 6000,
    timeoutMs: 120000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text', text: '这是学生语文考试/周测的答题照片。请逐题抄录图中的学生手写作答内容，严格要求：\n1. 按图中可见的题号顺序输出，每题以"【题N】"单独一行开头（N 用图中实际题号，如【题1】【题三】照原样抄）\n2. 一题内有多空/多小问时，用"①②③"或"(1)(2)"保留小问结构，逐空抄录\n3. 只抄学生写的内容和题号，不要抄题目题干；看不清的字用□占位，不要猜\n4. 完全空白的题输出"【题N】（空白）"\n5. 严禁创作、改写、纠错或补全，原文写什么抄什么（错别字也照抄）\n6. 若照片里没有可识别的答题内容，只输出"（未识别到答题内容）"' }
      ]
    }]
  });
}

// 粘贴参考答案文本 → 让模型拆成结构化题目列表（人工可再校对）
function buildExamParsePrompt(text) {
  return '你是试卷录入助手。下面是一份语文测试的参考答案/评分标准文本（可能含题号、满分、答案、评分细则）。请把它拆成结构化题目列表。\n\n要求：\n1. 尽量保留原文题号（如"一、1""5.(1)""(三)"均可，保持原样）\n2. 每题提取：no（题号原样）、label（题型/内容简称，如"古诗文默写""文言文翻译"，原文没有就按答案内容概括）、score（满分数字，原文没写就填 0）、answer（参考答案，保留原意可精简）、rubric（评分标准/扣分说明，没有就空串）\n3. 只输出 JSON，不要解释、不要 markdown 代码块：\n{"questions":[{"no":"1","label":"古诗文名句默写","score":10,"answer":"…","rubric":"每空1分，错字该空不得分"}]}\n\n【原文】\n' + String(text || '').slice(0, 6000);
}

// 逐题评分提示词：OCR 文本 + 题目/参考答案/评分标准 → 严格 JSON
function buildExamGradePrompt(questions, ocrText, meta) {
  const metaBlock = meta && meta.studentName ? '学生：' + meta.studentName + '\n' : '';
  const lines = (Array.isArray(questions) ? questions : []).map(q => {
    const head = '题' + q.no + '（满分' + q.score + '分' + (q.label ? '，' + q.label : '') + '）';
    const answer = q.answer ? '参考答案：' + q.answer : '参考答案：（未提供，按学科常识判断要点）';
    const rubric = q.rubric ? '。评分标准：' + q.rubric : '';
    return head + '\n' + answer + rubric;
  });
  return '你是初中语文周测的阅卷老师。根据每题的满分、参考答案和评分标准，对学生答题内容（OCR 抄录）逐题评分。\n\n'
    + metaBlock
    + '【评分总则】\n'
    + '1. 只依据参考答案和评分标准给分；学生答案与参考答案意思相符、关键词正确即给分，不要求逐字一致。\n'
    + '2. 默写/填空类：按空给分，出现错别字（含别字、□）该空不得分；漏字、添字致意思错误该空不得分。\n'
    + '3. 简答/赏析/翻译类：按点给分，踩到要点即给分，多答一般不扣分（评分标准另有说明除外）；翻译题重点看关键实词虚词和句意通顺。\n'
    + '4. OCR 可能漏行、串行或把字认错：内容疑似不完整时按可见部分从宽评分，并在 comment 注明"疑似识别不全"；□ 按错字处理。\n'
    + '5. 每题得分是 0 到该题满分之间的数，允许 0.5；禁止超出满分。\n'
    + '6. 【学生答题内容】里没有以【题N】出现的题一律 0 分并计入 unanswered，严禁根据题目或参考答案推测学生作答、严禁凭空给分。\n\n'
    + '【题目与评分标准】\n' + lines.join('\n') + '\n\n'
    + '【学生答题内容】\n' + String(ocrText || '').slice(0, 12000) + '\n\n'
    + '【输出要求】只输出一个 JSON 对象，不要解释、不要 markdown 代码块：\n'
    + '{"scores":[{"no":"题号原样","score":8,"comment":"一句话给分/扣分依据"}],"unanswered":["未作答题号"],"ocr_issues":"若识别明显影响评分，一句话说明，否则空串"}';
}

// 周测评分/拆题：MiniMax 多 key 轮询，全部失败 fallback DeepSeek（低温，要严格 JSON）
async function gradeExamAI(prompt) {
  let lastErr = null;
  for (let i = 0; i < MINIMAX_API_KEYS.length; i++) {
    try {
      const result = await openAICompatChat({
        label: 'EXAM-Grade',
        hostname: 'api.minimaxi.com',
        apiPath: '/v1/chat/completions',
        apiKey: MINIMAX_API_KEYS[i],
        model: MINIMAX_MODEL,
        temperature: 0.12,
        maxTokens: 8000,
        timeoutMs: 150000,
        messages: [{ role: 'user', content: prompt }]
      });
      const cleaned = stripThinkBlocks(result);
      if (cleaned) return { result: cleaned, model: MINIMAX_MODEL };
      throw new Error('MiniMax 返回内容为空');
    } catch (e) {
      lastErr = e;
      console.log('[EXAM] MiniMax key[' + i + '] 失败:', e.message);
    }
  }
  if (DEEPSEEK_API_KEY) {
    console.log('[EXAM] MiniMax 全部失败，fallback 到 DeepSeek');
    const result = stripThinkBlocks(await deepseekChatCompletion([{ role: 'user', content: prompt }]));
    if (result) return { result, model: DEEPSEEK_MODEL };
  }
  throw lastErr || new Error('AI 评分服务暂不可用');
}

const examOcrUsage = new Map();
const EXAM_OCR_DAILY_LIMIT = 400;
function examOcrAllowed(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const rec = examOcrUsage.get(userId);
  if (!rec || rec.day !== today) {
    if (examOcrUsage.size > 5000) examOcrUsage.clear();
    examOcrUsage.set(userId, { day: today, count: 1 });
    return true;
  }
  if (rec.count >= EXAM_OCR_DAILY_LIMIT) return false;
  rec.count++;
  return true;
}

const examGradeUsage = new Map();
const EXAM_GRADE_DAILY_LIMIT = 150;
function examGradeAllowed(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const rec = examGradeUsage.get(userId);
  if (!rec || rec.day !== today) {
    if (examGradeUsage.size > 5000) examGradeUsage.clear();
    examGradeUsage.set(userId, { day: today, count: 1 });
    return true;
  }
  if (rec.count >= EXAM_GRADE_DAILY_LIMIT) return false;
  rec.count++;
  return true;
}

function extractExamJson(raw) {
  return extractEssayJson(raw);
}

function examAIConfigured() {
  return MINIMAX_API_KEYS.length > 0 || !!DEEPSEEK_API_KEY;
}

// ---------- 周测阅卷 GLM 视觉引擎（配置 glm_api_key 后优先，未配置回落 Qwen） ----------
const GLM_VISION_PROBE_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD06iiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//2Q==';
// 候选顺序：视觉原生模型优先。glm-5.3-flash 支持图片但"始终思考"，复杂识别任务会耗尽 max_tokens
// 且正文为空（实测 237s 无输出），且小探测它能通过、真实任务必败，故不进自动候选，只允许 glm_ocr_model 手动指定。
const GLM_VISION_CANDIDATES = ['glm-4.6v', 'glm-4.5v'];
let glmVisionModelCache = '';

function glmVisionReady() {
  return !!GLM_API_KEY;
}

// 探测可用的 GLM 视觉模型：显式配置 glm_ocr_model 优先，否则逐个试候选并缓存
async function glmVisionModel() {
  if (GLM_OCR_MODEL) return GLM_OCR_MODEL;
  if (glmVisionModelCache) return glmVisionModelCache;
  let lastErr = null;
  for (const model of GLM_VISION_CANDIDATES) {
    try {
      await openAICompatChat({
        label: 'GLM-探测', hostname: 'open.bigmodel.cn', apiPath: GLM_API_PATH,
        apiKey: GLM_API_KEY, model, temperature: 0.01, maxTokens: 1024, timeoutMs: 60000,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: GLM_VISION_PROBE_JPEG } }, { type: 'text', text: '图里是纯白方块，回复OK即可' }] }]
      });
      glmVisionModelCache = model;
      console.log('[EXAM] GLM 视觉模型探测成功:', model);
      return model;
    } catch (e) {
      lastErr = e;
      console.log('[EXAM] GLM 模型不可用:', model, '-', e.message);
    }
  }
  throw lastErr || new Error('GLM 没有可用视觉模型，请配置 glm_ocr_model');
}

async function glmVisionChat(imageDataUrl, promptText, maxTokens) {
  const model = await glmVisionModel();
  const result = await openAICompatChat({
    label: 'GLM-周测', hostname: 'open.bigmodel.cn', apiPath: GLM_API_PATH,
    apiKey: GLM_API_KEY, model, temperature: 0.05, maxTokens: maxTokens || 8000, timeoutMs: 180000,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: promptText }] }]
  });
  return { result: stripThinkBlocks(result), model };
}

// 结构化识别：姓名 + 逐题手写内容 + 0-1000 归一化批阅框（可传题目清单做题号锚定）
function buildExamOcrStructuredPrompt(questions) {
  const list = (Array.isArray(questions) ? questions : [])
    .map(q => '题' + q.no + (q.label ? '（' + q.label + '，' + (Number(q.score) || 0) + '分）' : ''))
    .join('；');
  return '你是阅卷助手。这是一张学生语文考试的答题照片（拍摄可能旋转，请按正确方向阅读）。请完成：\n'
    + '1. 识别学生手写在卷面（通常在标题旁或右上角）的姓名：只要姓名文字本身；识别不到就给空串。\n'
    + '2. 按卷面题号逐题抄录学生的手写作答内容：no 必须用照片里印刷的题号（不是按出现顺序编号）；只抄学生写的，不要抄题干印刷文字；一题内有多个空/小问用①②③分隔；看不清的字用□占位，不要猜；错别字照抄。\n'
    + '3. 给每道有作答内容的题一个矩形框 bbox：[左, 上, 右, 下]，用 0-1000 归一化坐标（相对整张图：0是左/上边缘，1000是右/下边缘），框需包住该题学生的全部手写内容。\n'
    + (list ? '4. 本卷的题目清单（题号以此为准）：' + list + '。照片里没有出现或没有作答的题不要输出。\n' : '4. 照片里没有作答的题不要输出。\n')
    + '只输出一个 JSON 对象，禁止解释、禁止 markdown 代码块：\n'
    + '{"name":"姓名或空串","answers":[{"no":"1","text":"学生作答","bbox":[10,80,900,160]}]}';
}

// DeepSeek 视觉专用精简提示词：实测该模型遇到长/复杂提示词会无限思考（15992 token 无正文），只有短提示词能出结果
function buildExamOcrCompactPrompt() {
  return '这是学生语文考试答题照片。请完成：1.识别卷面手写姓名（没有则空串）。2.按卷面印刷题号逐题抄录学生手写作答（只抄学生写的，不抄题干印刷文字；多空用①②③分隔；未作答的题不输出）。3.给每道有作答的题一个矩形框bbox:[左,上,右,下]，0-1000归一化坐标。只输出JSON：{"name":"…","answers":[{"no":"1","text":"…","bbox":[10,80,900,160]}]}';
}

// DeepSeek 视觉备用引擎（如 deepseek-v4-flash-vision-exp）：转正照片可用（实测 ~33s），横版会把思考当正文输出导致失败，靠前端转正重试兜底
async function deepseekVisionChat(imageDataUrl, promptText, maxTokens) {
  const result = await openAICompatChat({
    label: 'DS-周测', hostname: 'api.deepseek.com', apiPath: '/chat/completions',
    apiKey: DEEPSEEK_VISION_API_KEY, model: DEEPSEEK_VISION_MODEL, temperature: 0.05, maxTokens: maxTokens || 8000, timeoutMs: 180000,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: promptText }] }]
  });
  return { result: stripThinkBlocks(result), model: DEEPSEEK_VISION_MODEL };
}

function deepseekVisionReady() {
  return !!DEEPSEEK_VISION_API_KEY && !!DEEPSEEK_VISION_MODEL;
}

// 引擎选择：GLM → DeepSeek 视觉 → Qwen 依次尝试，谁成谁上；全挂才报错。
// 注意 DS 实验模型不稳定（同提示词时而 33s 出结果、时而思考耗尽无输出），只能当中间兜底，失败不能挡住 Qwen。
async function examVisionStructured(imageDataUrl, questions) {
  const prompt = buildExamOcrStructuredPrompt(questions);
  const errors = [];
  if (GLM_API_KEY) {
    try {
      const r = await glmVisionChat(imageDataUrl, prompt, 8000);
      return { raw: r.result, model: r.model, engine: 'glm' };
    } catch (e) {
      errors.push('glm: ' + e.message);
      console.log('[EXAM] GLM 识别失败:', e.message);
    }
  }
  if (deepseekVisionReady()) {
    try {
      const r = await deepseekVisionChat(imageDataUrl, buildExamOcrCompactPrompt(), 8000);
      return { raw: r.result, model: r.model, engine: 'ds' };
    } catch (e) {
      errors.push('ds: ' + e.message);
      console.log('[EXAM] DS 识别失败:', e.message);
    }
  }
  if (QWEN_API_KEY) {
    try {
      const result = await openAICompatChat({
        label: 'QWEN-周测', hostname: 'dashscope.aliyuncs.com', apiPath: '/compatible-mode/v1/chat/completions',
        apiKey: QWEN_API_KEY, model: QWEN_OCR_MODEL, temperature: 0.05, maxTokens: 6000, timeoutMs: 120000,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: prompt }] }]
      });
      return { raw: stripThinkBlocks(result), model: QWEN_OCR_MODEL, engine: 'qwen' };
    } catch (e) {
      errors.push('qwen: ' + e.message);
      console.log('[EXAM] Qwen 识别失败:', e.message);
    }
  }
  throw new Error('所有识别引擎均失败：' + errors.join('；'));
}

// 试卷 docx + 答案 docx 文本 → 按内容对齐拆题（答案题号常与卷面不一致，禁止按号硬配）
function buildExamParsePaperPrompt(paperText, answerText) {
  return '你是试卷录入助手。下面给出一份语文测试卷的【试卷原文】和【参考答案原文】。答案可能导出自题库，其题号与试卷卷面题号不一致（例如答案里的14题实际对应试卷的6题），必须按题目内容对应，严禁按题号硬配。\n\n'
    + '任务：按试卷卷面顺序提取所有需要学生作答的题目，并为每题匹配参考答案。\n\n'
    + '要求：\n'
    + '1. no 用试卷卷面题号原样（如 "1"、"6"、"10(1)"）\n'
    + '2. label 用题型简称（如"字词运用""古诗文默写""诗歌鉴赏""文言文翻译""作文"）\n'
    + '3. score 从试卷里该题的"（X分）"提取数字，没有就 0\n'
    + '4. answer 用参考答案中该题的答案本身（不要解析文字）；一题多空按①②③列出；多条示例答案保留最标准的一条\n'
    + '5. rubric 从答案的【X题详解】等解析中提炼给分点/扣分说明，一两句话；没有就空串\n'
    + '6. 作文等无唯一答案的题也要列出，answer 写题目要求要点，rubric 写评分要点\n'
    + '7. 只输出 JSON，禁止解释、禁止 markdown 代码块：\n'
    + '{"questions":[{"no":"1","label":"字词运用","score":2,"answer":"辈、燃","rubric":"每空1分，错字不得分"}]}\n\n'
    + '【试卷原文】\n' + String(paperText || '').slice(0, 14000) + '\n\n'
    + '【参考答案原文】\n' + String(answerText || '').slice(0, 10000);
}

// ---------- Middleware ----------
// limit 提高到 10mb：作文批改 OCR 要上传 base64 图片
module.exports = {
  normalizeCommentStudent,
  normalizeCommentRosterStudents,
  normalizeRosterName,
  commentStyleLabel,
  commentStyleGuide,
  deepseekChatCompletion,
  learningGenerateAI,
  deepseekChatStream,
  generateAICommentForStudent,
  commentRewriteGuide,
  rewriteAICommentForStudent,
  openAICompatChat,
  qwenOcrImage,
  stripThinkBlocks,
  gradeEssayAI,
  essayAIConfigured,
  ESSAY_GENRES,
  ESSAY_GRADE_LEVELS,
  ESSAY_SCORE_TYPES,
  essayTeacherStage,
  essayScoreRule,
  ESSAY_DIMENSIONS,
  buildEssayPrompt,
  extractEssayJson,
  normalizeEssayData,
  essayDataToLegacyText,
  ENGLISH_TASK_TYPES,
  ENGLISH_RUBRIC_PRESETS,
  englishRubricFor,
  englishFullScore,
  buildEnglishEssayPrompt,
  normalizeEnglishEssayData,
  englishDataToText,
  essayOcrUsage,
  essayOcrAllowed,
  qwenOcrExamImage,
  buildExamParsePrompt,
  buildExamGradePrompt,
  gradeExamAI,
  examOcrUsage,
  examOcrAllowed,
  examGradeUsage,
  examGradeAllowed,
  extractExamJson,
  examAIConfigured,
  glmVisionReady,
  glmVisionModel,
  deepseekVisionReady,
  deepseekVisionChat,
  buildExamOcrCompactPrompt,
  examVisionStructured,
  buildExamOcrStructuredPrompt,
  buildExamParsePaperPrompt,
};
