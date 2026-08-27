'use strict';
// AI 引擎层：评语生成(DeepSeek) / 作文批改(Qwen·MiniMax) / 学习助手 / 提示词构建。
const crypto = require('crypto');
const https = require('https');
// @WIRE
const {
  commentHost, deviceCookieOptions, encodeInviteCookie, essayHost, learningHost, parseCookieHeader, referralCookieOptions, roundtableHost
} = require('./http-utils');
const {
  DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEVICE_COOKIE_NAME, ESSAY_OCR_DAILY_LIMIT, INVITE_COOKIE_MAX_AGE_MS, INVITE_COOKIE_NAME, INVITE_COOKIE_SECRET, LEARNING_MODEL, MINIMAX_API_KEYS, MINIMAX_MODEL, QWEN_API_KEY, QWEN_OCR_MODEL
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
      max_tokens: (opts && opts.max_tokens) || 800
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
};
