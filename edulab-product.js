// edulab-product.js — 产品版后端（独立服务，与 classroom-broadcast/server.js 完全隔离）
// 复用 broadcast.db 的 users 表做登录鉴权(shixing_auth token)，并与评语、思想圆桌共用师行积分。
// 流程：鉴权 → 查积分 → OCR → 解题 → LLM出课件HTML → 部署 → 扣积分。
// 全程不碰 Hermes、不跑 shell。 PM2: edulab-product
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createShixingPoints, POINT_COSTS, POINT_PACKAGES } = require('./shixing-points');
const { createUnifiedReferrals } = require('./unified-referrals');
const {
  buildTeachingRequirement,
  createGenerationFinalizer,
  deriveCoursewareTitle,
  normalizeCoursewarePatch,
  normalizeTeachingPreferences,
  parseKnowledgePoints
} = require('./edulab-courseware');

const PORT = 8910;
const HOST = '127.0.0.1';
const BCAST = '/home/admin/classroom-broadcast';
const DB_PATH = path.join(BCAST, 'broadcast.db');
const PUBLIC_EDULAB = path.join(BCAST, 'public', 'edulab');
const BASE_URL = 'https://notice.yingyuzuowen.asia/edulab';
const SIGNUP_CREDITS = 10;

// ---- 配置/密钥（复用服务器已有的）----
function readJSON(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch(e){ return {}; } }
const proxyCfg = readJSON(path.join(BCAST, '..', 'edulab-ai-proxy.json')); // /home/admin/edulab-ai-proxy.json
const commentCfg = readJSON(path.join(BCAST, 'comment-config.json'));
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || proxyCfg.dashscope_api_key || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || commentCfg.deepseek_api_key || '';
const GEN_MODEL = process.env.EDULAB_GEN_MODEL || 'deepseek-v4-flash';
const SOLVE_MODEL = process.env.EDULAB_SOLVE_MODEL || 'deepseek-v4-pro';

// ---- 微信支付（复用 classroom-broadcast 的 YunGouOS 商户配置，自己下单/回调）----
const payCfg = readJSON(path.join(BCAST, 'payment-config.json'));
const YUNGOU_MCH_ID = payCfg.yungou_mch_id || '';
const YUNGOU_PAY_KEY = payCfg.yungou_pay_key || '';
const YUNGOU_APP_ID = payCfg.yungou_app_id || '';
const YUNGOU_API_HOST = 'api.pay.yungouos.com';
const PUBLIC_BASE = (payCfg.public_base_url || 'https://notice.yingyuzuowen.asia').replace(/\/+$/,'');
const PACKAGES = POINT_PACKAGES;
function payConfigured(){ return !!(YUNGOU_MCH_ID && YUNGOU_PAY_KEY); }

// ---- DB（WAL 下可与 server.js 并发，自建表不碰现有表）----
const db = new Database(DB_PATH, { timeout: 8000 });
db.pragma('busy_timeout = 8000');
db.exec(`
CREATE TABLE IF NOT EXISTS edulab_credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  credits INTEGER NOT NULL,
  reason TEXT,
  out_trade_no TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edulab_credit_user ON edulab_credit_ledger(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edulab_signup ON edulab_credit_ledger(user_id) WHERE reason='signup';
CREATE UNIQUE INDEX IF NOT EXISTS idx_edulab_topup ON edulab_credit_ledger(out_trade_no) WHERE out_trade_no IS NOT NULL;
CREATE TABLE IF NOT EXISTS edulab_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT, problem_type TEXT, problem_text TEXT, problem_hash TEXT, solution TEXT, url TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_edulab_gen_user ON edulab_generations(user_id, id DESC);
CREATE TABLE IF NOT EXISTS edulab_payments (
  out_trade_no TEXT PRIMARY KEY,
  user_id TEXT, package TEXT, credits INTEGER, amount TEXT,
  status TEXT, provider_payno TEXT, created_at TEXT, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS edulab_edits (
  user_id TEXT, edit_key TEXT, n INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, edit_key)
);
`);
// 老库补列（已存在则忽略）
[
  'problem_hash TEXT',
  'solution TEXT',
  'title TEXT',
  'knowledge_points TEXT',
  'favorite INTEGER DEFAULT 0',
  'deleted_at TEXT'
].forEach(c=>{ try{ db.exec('ALTER TABLE edulab_generations ADD COLUMN '+c); }catch(e){} });
const pointStore = createShixingPoints(db);
const referrals = createUnifiedReferrals(db, pointStore);

const qUserByToken = db.prepare('SELECT id, username, token_expires FROM users WHERE token = ?');
const qBalance = db.prepare('SELECT COALESCE(SUM(credits),0) AS bal FROM edulab_credit_ledger WHERE user_id = ?');
const insSignup = db.prepare("INSERT OR IGNORE INTO edulab_credit_ledger (user_id, credits, reason, created_at) VALUES (?, ?, 'signup', ?)");
const insLedger = db.prepare('INSERT INTO edulab_credit_ledger (user_id, credits, reason, out_trade_no, created_at) VALUES (?, ?, ?, ?, ?)');
const insGen = db.prepare('INSERT INTO edulab_generations (user_id, problem_type, problem_text, problem_hash, solution, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const finalizeGeneration = createGenerationFinalizer(db, pointStore, insGen);
const qCachedGen = db.prepare('SELECT id, url, solution FROM edulab_generations WHERE user_id = ? AND problem_hash = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1');
const qHistory = db.prepare('SELECT id, problem_type, problem_text, title, knowledge_points, favorite, url, created_at FROM edulab_generations WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 200');
const qGenerationByUser = db.prepare('SELECT id, problem_type, problem_text, title, knowledge_points, favorite, url, created_at FROM edulab_generations WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
const updateGenerationMeta = db.prepare('UPDATE edulab_generations SET title = ?, knowledge_points = ?, favorite = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
const deleteGeneration = db.prepare('UPDATE edulab_generations SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
function hashProblem(t){ return crypto.createHash('md5').update(String(t||'').replace(/\s+/g,' ').trim()).digest('hex'); }
const insTopup = db.prepare("INSERT OR IGNORE INTO edulab_credit_ledger (user_id, credits, reason, out_trade_no, created_at) VALUES (?, ?, 'topup', ?, ?)");
const insPay = db.prepare('INSERT INTO edulab_payments (out_trade_no, user_id, package, credits, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const EDIT_LIMIT = 5; // 每道题（每用户）自然语言改图次数上限
const qEditN = db.prepare('SELECT n FROM edulab_edits WHERE user_id = ? AND edit_key = ?');
const bumpEditN = db.prepare('INSERT INTO edulab_edits (user_id, edit_key, n) VALUES (?, ?, 1) ON CONFLICT(user_id, edit_key) DO UPDATE SET n = n + 1');
function editCount(uid, key){ const r = qEditN.get(uid, key); return r ? (r.n|0) : 0; }
const getPay = db.prepare('SELECT * FROM edulab_payments WHERE out_trade_no = ?');
const setPayStatus = db.prepare('UPDATE edulab_payments SET status = ? WHERE out_trade_no = ?');
const setPayPaid = db.prepare("UPDATE edulab_payments SET status = 'paid', provider_payno = ?, paid_at = ? WHERE out_trade_no = ?");

function nowISO(){ return new Date().toISOString(); }
function balance(uid){ return pointStore.getBalance(uid); }
function ensureSignup(uid){ insSignup.run(uid, SIGNUP_CREDITS, nowISO()); }
function coursewareItem(row){
  if(!row) return null;
  const problem = String(row.problem_text || '').replace(/\s+/g, ' ').trim();
  const title = String(row.title || '').trim() || deriveCoursewareTitle(problem, row.problem_type);
  return {
    id:Number(row.id),
    title,
    type:String(row.problem_type || '数学'),
    problem:problem.slice(0, 500),
    summary:problem.slice(0, 92),
    knowledge_points:parseKnowledgePoints(row.knowledge_points),
    favorite:!!row.favorite,
    url:String(row.url || ''),
    created_at:String(row.created_at || ''),
    at:String(row.created_at || '').slice(0, 10)
  };
}

function parseCookies(h){ const o={}; (h||'').split(';').forEach(p=>{const i=p.indexOf('='); if(i>0)o[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());}); return o; }
function authUser(req){
  const cookies = parseCookies(req.headers.cookie);
  let token = cookies['shixing_auth'] || '';
  if(!token){ const a=req.headers.authorization||''; if(a.startsWith('Bearer ')) token=a.slice(7).trim(); }
  if(!token) return null;
  const u = qUserByToken.get(token);
  if(!u) return null;
  if(u.token_expires && Date.parse(u.token_expires) <= Date.now()) return null;
  return u;
}
function deviceHash(req){
  const id = String(parseCookies(req.headers.cookie).shixing_device || '');
  return id ? crypto.createHash('sha256').update(id).digest('hex') : '';
}

// ---- AI 调用 ----
async function callAI(url, key, body){
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`}, body: JSON.stringify(body) });
  const j = await r.json();
  if(j.error) throw new Error(j.error.message || 'AI 调用失败');
  const content = j?.choices?.[0]?.message?.content;
  if(typeof content !== 'string' || !content.trim()) throw new Error('AI 返回正文为空，请重试');
  return content.trim();
}
async function ocrImage(dataUrl){
  return callAI('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', DASHSCOPE_KEY, {
    model:'qwen-vl-max', temperature:0.1, max_tokens:1000,
    messages:[{role:'user',content:[{type:'image_url',image_url:{url:dataUrl}},{type:'text',text:'请完整识别图中的数学题目，只输出题目内容。'}]}]
  });
}
async function solve(problem){
  const draft = await callAI('https://api.deepseek.com/chat/completions', DEEPSEEK_KEY, {
    model:SOLVE_MODEL,
    max_tokens:18000,
    reasoning_effort:'high',
    thinking:{type:'enabled'},
    messages:[
      {role:'system',content:'你是一名严谨的中学数学解题专家。先在内部完整推理并验算，再输出可直接给老师使用的最终解答。每个小问都必须作答；每个候选点、函数值、充要条件和参数边界都要代回原条件核验，不能用未经验证的例子支撑结论。公式用 $$...$$，证明可用 ∵∴，步骤清晰并给出最终答案。只输出最终解答，不展示思维链。'},
      {role:'user',content:problem}
    ]
  });
  return await verifySolution(problem, draft);
}

async function verifySolution(problem, draft){
  return callAI('https://api.deepseek.com/chat/completions', DEEPSEEK_KEY, {
    model:SOLVE_MODEL,
    max_tokens:18000,
    reasoning_effort:'high',
    thinking:{type:'enabled'},
    messages:[
      {role:'system',content:'你是数学答案复核员。请独立重做题目，再逐项审查草稿中的代入、计算、必要性、充分性、定义域、排除条件和最终结论。发现任何问题必须直接修正。最终只输出一份完整、自洽、可直接用于教学的修正版解答，不写“草稿正确/错误”、不展示思维链。'},
      {role:'user',content:`【原题】\n${problem}\n\n【待复核草稿】\n${draft}`}
    ]
  });
}

const COURSEWARE_SYSTEM = `你是数学交互课件生成器。根据【题目】和【已验证解答】，产出一个单页、自包含的交互式 HTML 教学课件，能直接在手机浏览器打开。
硬性要求：
1. 只输出 HTML 代码本身，从 <!DOCTYPE html> 开始，结尾 </html>。不要任何说明文字，不要 markdown 代码围栏。
2. 几何图形/函数图像一律用 Canvas 2D 自己画（禁止用 Three.js 等外部库）。立体图形用斜二测/等距投影画，支持鼠标拖拽旋转、移动端单指旋转+双指捏合缩放（touchstart 用 {passive:false}+preventDefault）。Canvas 的 getElementById 必须在事件绑定之前执行。把题目里的关键点、长度、角度标注到图上。
3. 公式用 KaTeX，从 bootcdn 加载：head 里 <link rel=stylesheet href="https://cdn.bootcdn.net/ajax/libs/KaTeX/0.16.9/katex.min.css">，body 末尾 <script src="https://cdn.bootcdn.net/ajax/libs/KaTeX/0.16.9/katex.min.js"></script> 和 contrib/auto-render.min.js；用 $$...$$（独立公式）和 \\(...\\)（行内），初始化时调用 renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\\\(',right:'\\\\)',display:false}],throwOnError:false})；切换步骤后要重新调用一次。
4. 布局：一块 Canvas 画图区 + 分步解题区（上一步/下一步按钮 + 键盘←→翻页 + 步数计数），最后一步给完整答案汇总。证明推理用 ∵ ∴。
5. 数学必须严格等于【已验证解答】里的结论，不要自己另算出不同答案。
6. 移动端优先，字体 -apple-system,'PingFang SC',sans-serif；**统一用师行暖米黄文人风配色**：页面底 #f5f0eb，卡片 #fffef9，正文墨色 #2c2416，标题/按钮强调 #7c5722（标题可用 Songti SC 衬线），边框 #e0d8cc；画布底 #fbf8f1、网格 #e7ddcc、坐标轴 #6b5e4a；曲线/线用墨蓝 #2b4a6f 或赭石 #b5651d，关键点用翠绿 #1d9e75，辅助线 #b8a888。禁止用蓝/青/品红等冷亮色。`;

async function genCourseware(problem, solution){
  return callAI('https://api.deepseek.com/chat/completions', DEEPSEEK_KEY, {
    model: GEN_MODEL, temperature:0.2, max_tokens:8000,
    messages:[
      {role:'system',content:COURSEWARE_SYSTEM},
      {role:'user',content:`【题目】\n${problem}\n\n【已验证解答】\n${solution}`}
    ]
  });
}

// ---- 立体几何：LLM 只产数据，注入经过验证的 Three.js 模板（3D 渲染不靠 LLM）----
let LESSON_TPL = '';
try { LESSON_TPL = fs.readFileSync('/home/admin/edulab-gen/edu-solid-geometry/template/lesson.html', 'utf8'); } catch(e){ console.log('lesson.html 模板未找到，立体几何将回退到出 HTML'); }
function isSolid3D(p){
  return /正方体|长方体|棱锥|棱柱|四面体|三棱锥|四棱锥|三棱柱|多面体|棱台|二面角|线面角|面面角|异面直线|侧棱|底面|空间直角/.test(p);
}
// 曲面体：Three.js 多面体模板画不出圆面，排除掉走单次出 HTML（能画圆弧）
function isCurvedSolid(p){
  return /圆台|圆柱|圆锥|球|旋转体|曲面/.test(p);
}
const LESSON_SYSTEM = `你是立体几何交互课件的【数据】生成器。根据题目和已验证解答，输出一份 JSON（lesson-data），它会被注入一个用 Three.js 渲染的固定模板。你只产数据，不写任何渲染/HTML/JS 代码。

只输出 JSON 本身（从 { 到 }），不要解释、不要 markdown 围栏。结构：
{
 "lesson":{"language":"zh-CN","meta":"顶部小标签","title":"题面","answerLabel":"答案文字说明","answerValue":"$LaTeX$"},
 "steps":[ {"title":"步骤标题","content":"<p>HTML段落，行内$..$，独立$$..$$，证明用∵∴</p>","highlight":["要可见的元素key"],"cameraPos":{"x":5,"y":4,"z":5}} ],
 "model":{
   "target":[x,y,z],"initialCamera":[x,y,z],
   "points":{ "A":[x,y,z], ... },         // Three.js 坐标，y 轴朝上(竖直方向)；几何体居中、跨度约 ±2~3
   "spheres":["A","B",...],               // 画小球+标签的顶点
   "edges":[ {"a":"A","b":"B"}, {"a":"D","b":"A","dashed":true} ],  // 始终可见的骨架棱
   "elements":{ "Line_BE":{"type":"line","a":"B","b":"E","color":"emphasis","depthTest":false},
                "Plane_PAC":{"type":"plane","pts":["P","A","C"]},
                "Normal":{"type":"arrow","origin":"O","dir":[0,1,0],"length":1.5,"color":"normal"},
                "Len_AB":{"type":"measure","a":"A","b":"B","label":"2"} },
   "conditions":[ {"text":"$AB=2$","show":["Len_AB"]}, {"text":"$PA\\\\perp$面$ABCD$","show":["Plane_PAC","Line_BE"]}, {"text":"$F$ 为 $BC$ 中点","show":["F"]} ]
 }
}
规则：
- 坐标必须与已验证解答一致、几何正确；y 是竖直方向（高度），把解答里的"高/竖直"映射到 three 的 y。
- conditions：把题面的每条【已知条件】列出来做成"点击高亮"。text 是条件文字(可含$LaTeX$)，show 是点击它时要亮起的【元素 key 或顶点名】列表(必须是 elements 里的 key 或 points 里的点名)。让学生点一条条件、就在图上看见对应的棱/面/点。条件与图形对不上就别硬列。
- 骨架 edges 要把几何体的棱都连上（正方体12条、四棱锥8条等）。
- 每个 step 的 highlight 是"该步应可见的可切换元素 key 的完整集合"；骨架和顶点小球始终可见不用列。
- 题面给出长度的棱，加一个 measure 元素，并把它放进第一步 highlight。
- 颜色名只能用：frame/aux/emphasis/normal/plane/point。
- 步骤要跟解答的推理一一对应（建系→关键点/向量→法向量/关系→求解）。

【动点拖拽——题目有"棱上动点"就接上】题目若出现"P 为棱 AB 上的动点 / 点 P 在线段 AB 上移动"这类【沿某条线段滑动】的动点，在 model 里加 draggable，让学生拖着 P 滑、实时看几何量变化：
"draggable":{
  "point":"P",                 // 动点名，必须同时出现在 points 和 spheres 里（给个初始位置即可）
  "along":["A","B"],           // P 只能在线段 AB 上滑，两端点必须在 points 里
  "t":0.5,                     // 初始位置参数 0~1（题目设定位；"中点"填0.5，"靠A三分之一"填0.33）
  "standardLabel":"P 为中点",   // 可选，初始位置文字说明
  "dependent":[{"name":"Q","kind":"midpoint","of":["P","C"]}],  // 可选，随 P 一起动的点（仅支持中点；Q 也要放进 points+spheres）
  "readouts":[                 // 实时数值面板，type 只能是这三种：
    {"label":"PC 长","type":"length","pts":["P","C"]},
    {"label":"四面体P-ABC体积","type":"volume_tetra","pts":["P","A","B","C"]},
    {"label":"PA与面BCD所成角正弦","type":"line_plane_angle_sin","line":["P","A"],"plane":["B","C","D"]}
  ]
}
draggable 规则：① 动点【只能在一条线段上滑】，不能在曲面/圆/任意面自由动——做不到就别加 draggable，出静态可旋转图即可；② point、along两端、dependent、readouts 引用的所有点都必须在 points 里；③ readouts 的 type 仅限 length/volume_tetra/line_plane_angle_sin；④ 不用你算 mathPoints，系统自动反推。

示例（四面体 P-ABC，P 为棱 AB 上动点，看体积变化）：
{"lesson":{"language":"zh-CN","meta":"交互解题 · 棱上动点","title":"三棱锥 P 在棱上移动时体积变化","answerLabel":"探索","answerValue":"拖动 P 观察"},"steps":[{"title":"建立模型","content":"<p>$P$ 在棱 $AB$ 上移动，拖动滑块改变其位置。</p>","highlight":[],"cameraPos":{"x":5,"y":4,"z":5}}],"model":{"target":[1,1,1],"initialCamera":[5,4,5],"points":{"A":[0,0,0],"B":[2,0,0],"C":[1,0,2],"D":[1,3,1],"P":[1,0,0]},"spheres":["A","B","C","D","P"],"edges":[{"a":"A","b":"B"},{"a":"B","b":"C"},{"a":"C","b":"A"},{"a":"A","b":"D"},{"a":"B","b":"D"},{"a":"C","b":"D"}],"elements":{},"draggable":{"point":"P","along":["A","B"],"t":0.5,"standardLabel":"P 为 AB 中点","readouts":[{"label":"四面体P-ACD体积","type":"volume_tetra","pts":["P","A","C","D"]},{"label":"PC 长","type":"length","pts":["P","C"]}]}}}

示例（正方体棱长2求体对角线）：
{"lesson":{"language":"zh-CN","meta":"交互解题 · 体对角线","title":"正方体ABCD-A₁B₁C₁D₁棱长为2，求体对角线AC₁的长","answerLabel":"体对角线长","answerValue":"$2\\\\sqrt{3}$"},"steps":[{"title":"建立坐标系","content":"<p>设 $A$ 为原点，三条棱沿坐标轴，棱长 $2$。</p>","highlight":["Len_AB"],"cameraPos":{"x":6,"y":5,"z":6}},{"title":"求体对角线","content":"<p>$AC_1=\\\\sqrt{2^2+2^2+2^2}=2\\\\sqrt{3}$</p>","highlight":["Diag"],"cameraPos":{"x":4,"y":4,"z":4}}],"model":{"target":[1,1,1],"initialCamera":[6,5,6],"points":{"A":[0,0,0],"B":[2,0,0],"C":[2,0,2],"D":[0,0,2],"A1":[0,2,0],"B1":[2,2,0],"C1":[2,2,2],"D1":[0,2,2]},"spheres":["A","B","C","D","A1","B1","C1","D1"],"edges":[{"a":"A","b":"B"},{"a":"B","b":"C"},{"a":"C","b":"D"},{"a":"D","b":"A"},{"a":"A1","b":"B1"},{"a":"B1","b":"C1"},{"a":"C1","b":"D1"},{"a":"D1","b":"A1"},{"a":"A","b":"A1"},{"a":"B","b":"B1"},{"a":"C","b":"C1"},{"a":"D","b":"D1"}],"elements":{"Diag":{"type":"line","a":"A","b":"C1","color":"emphasis","depthTest":false},"Len_AB":{"type":"measure","a":"A","b":"B","label":"2"}}}}`;

// ---- 自然语言改图：把"当前 lesson-data + 用户命令"交给模型，产出改好的 lesson-data ----
const EDIT_SYSTEM = `你是立体几何交互课件的【改图】助手。给你一份当前的 lesson-data JSON 和老师的一句修改要求，你输出【改好后的完整 lesson-data JSON】。只按要求改，跟要求无关的部分原样保留。

能做的修改：
- 改颜色：把某条线/某个面/某个元素的 color 改成 frame/aux/emphasis/normal/plane/point 之一（"标红"用 normal，"标蓝/强调"用 emphasis）。
- 画出/标出：往 elements 里新增 line{type,a,b,color,depthTest:false} / plane{type,pts:[3-4点]} / measure{type,a,b,label} / arrow{type,origin,dir,length,color} 来"画出某线段""标出某面""标出某长度""画法向量"。新增的元素 key 自起名，并把它加进相关 step 的 highlight 里（这样它会显示）。
- 隐藏/删除：从 elements 里删掉某个 key，或把它从各 step 的 highlight 移除。
- 换视角：改 model.initialCamera / model.target（"俯视"=相机在正上方大 y；"正视"=大 z；"侧视"=大 x）。
- 新增已知条件高亮：往 model.conditions 加 {text,show:[元素key或点名]}。

铁律：
- line/measure 的 a/b、plane 的 pts、condition 的 show 里的点名，只能是 model.points 里已存在的点。
- 颜色名只能用 frame/aux/emphasis/normal/plane/point。
- 不要改 model.points / solids / edges 的几何坐标，也不要改 lesson.title（除非要求明确要移动点/改题）。
- 输出完整 lesson-data JSON（从 { 到 }），不要解释、不要 markdown 围栏。`;

async function genEditData(currentData, command){
  const payload = { lesson: currentData.lesson, steps: currentData.steps, model: currentData.model };
  const raw = await callAI('https://api.deepseek.com/chat/completions', DEEPSEEK_KEY, {
    model: GEN_MODEL, temperature:0.2, max_tokens:6000,
    messages:[{role:'system',content:EDIT_SYSTEM},{role:'user',content:`【当前课件数据】\n${JSON.stringify(payload)}\n\n【修改要求】\n${command}\n\n只输出改好后的完整 lesson-data JSON。`}]
  });
  let t = raw.trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if(i<0 || j<0) throw new Error('未得到 JSON');
  const data = JSON.parse(t.slice(i, j+1));
  if(!data.lesson || !Array.isArray(data.steps) || !data.steps.length || !data.model || !data.model.points) throw new Error('JSON 结构不完整');
  // 改图新增的元素自动设为可见（加进每一步 highlight），否则"画出X"加了却不显示，令人困惑
  const oldKeys = new Set(Object.keys((currentData.model && currentData.model.elements) || {}));
  const newKeys = Object.keys((data.model.elements) || {}).filter(k => !oldKeys.has(k));
  if(newKeys.length){
    data.steps.forEach(st => { st.highlight = Array.from(new Set([...(Array.isArray(st.highlight)?st.highlight:[]), ...newKeys])); });
  }
  attachDraggable(data);   // 若有动点，重新校验并按最新 points 反推 mathPoints
  attachConditions(data);  // 清洗条件
  return data;
}

async function genLessonData(problem, solution){
  const raw = await callAI('https://api.deepseek.com/chat/completions', DEEPSEEK_KEY, {
    model: GEN_MODEL, temperature:0.2, max_tokens:6000,
    messages:[{role:'system',content:LESSON_SYSTEM},{role:'user',content:`【题目】\n${problem}\n\n【已验证解答】\n${solution}\n\n只输出 lesson-data JSON。`}]
  });
  let t = raw.trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if(i<0 || j<0) throw new Error('未得到 JSON');
  const data = JSON.parse(t.slice(i, j+1));
  if(!data.lesson || !Array.isArray(data.steps) || !data.steps.length || !data.model || !data.model.points) throw new Error('JSON 结构不完整');
  attachDraggable(data);
  attachConditions(data);
  return data;
}
function buildLessonHTML(data){
  const json = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
  return LESSON_TPL.replace('__LESSON_DATA__', () => json);
}

// 动点拖拽：校验 draggable，并从最终 points(渲染坐标 y竖直) 自动反推 mathPoints(数学坐标 z竖直，[x,y,z]->[x,z,y])。
// 模型只给 draggable 规格、不碰坐标；坏的 draggable 直接剥掉降级成静态可旋转图。
function attachDraggable(data){
  const m = data.model; const dg = m && m.draggable;
  if(!dg) return;
  const names = new Set(Object.keys(m.points || {}));
  let ok = dg && typeof dg.point==='string' && names.has(dg.point)
    && Array.isArray(dg.along) && dg.along.length===2 && dg.along.every(n=>names.has(n));
  if(ok && dg.dependent!==undefined) ok = Array.isArray(dg.dependent)
    && dg.dependent.every(d=>d && typeof d.name==='string' && d.kind==='midpoint' && Array.isArray(d.of) && d.of.length===2 && d.of.every(n=>names.has(n)));
  if(ok && Array.isArray(dg.dependent)) dg.dependent.forEach(d=>names.add(d.name));
  const RTYPES = new Set(['length','volume_tetra','line_plane_angle_sin']);
  if(ok && dg.readouts!==undefined) ok = Array.isArray(dg.readouts) && dg.readouts.every(r=>{
    if(!r || !RTYPES.has(r.type)) return false;
    const refs = [...(r.pts||[]), ...(r.line||[]), ...(r.plane||[])];
    return refs.length>0 && refs.every(n=>names.has(n));
  });
  if(!ok){ delete m.draggable; return; }
  // 反推 mathPoints（所有点都给，避免 readout/along 引用到 undefined）
  m.mathPoints = {};
  for(const k in m.points){ const p = m.points[k]; if(Array.isArray(p) && p.length>=3) m.mathPoints[k] = [p[0], p[2], p[1]]; }
  (dg.dependent||[]).forEach(d=>{ const a=m.mathPoints[d.of[0]], b=m.mathPoints[d.of[1]]; if(a&&b) m.mathPoints[d.name]=[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2]; });
}

// 已知条件点击高亮：清洗 conditions，show 里只保留真实存在的元素 key 或点名；坏的整条丢掉
function attachConditions(data){
  const m = data.model;
  if(!Array.isArray(m.conditions) || !m.conditions.length){ delete m.conditions; return; }
  const elemKeys = new Set(Object.keys(m.elements || {}));
  const ptKeys = new Set(Object.keys(m.points || {}));
  const cleaned = [];
  m.conditions.forEach(c=>{
    if(!c || typeof c.text!=='string' || !c.text.trim()) return;
    const show = (Array.isArray(c.show) ? c.show : []).filter(k=>elemKeys.has(k) || ptKeys.has(k));
    if(show.length) cleaned.push({ text:c.text.trim(), show });
  });
  if(cleaned.length) m.conditions = cleaned; else delete m.conditions;
}

// ---- 曲面体（圆台/圆锥/圆柱/球）：同样产 lesson-data，但带 solids 字段，注入同一个 Three.js 模板 ----
// 旋转体的"体"由模板按尺寸建模（一定正确、可旋转），LLM 只负责算尺寸和点坐标。
const CURVED_SOLID_SYSTEM = `你是立体几何交互课件的【数据】生成器，专门处理含【旋转体】（圆台/圆锥/圆柱/球）的题目。根据题目和已验证解答，输出一份 JSON（lesson-data），注入一个用 Three.js 渲染的固定模板。你只产数据，不写任何渲染/HTML/JS 代码。

【坐标约定 —— 必须严格遵守，否则前功尽弃】
- 直接用你解题时的【自然坐标系】：z 轴竖直向上（= 高度方向），x、y 是水平面。**不要做任何轴变换/轴交换**，点的坐标必须和你解答里写的一模一样。
- 旋转体底面圆心放在原点 O=[0,0,0]，底面在 z=0 平面；上底面圆心 O₁=[0,0,h]，h 为高（z=h）。
- 所有点写成 (x,y,z)，z 就是高度：下底面/底面圆上的点 z=0；上底面圆上的点 z=h。
- 圆台：下底半径 bottomR、上底半径 topR、高 height，必须与题目/解答一致。
- 圆锥：type 用 "cone"，给 bottomR 和 height（顶点在 [0,0,h]）。
- 圆柱：type 用 "cylinder"，给 radius 和 height。
- 球：type 用 "sphere"，给 center 和 radius。
- 所有命名点必须落在体的表面、底面圆周或轴线上，且与已验证解答严格一致。底面圆内接正方形/多边形的顶点要算准（落在半径为 bottomR 的圆周上、z=0）。
- target / initialCamera / cameraPos 也都用这个 z 竖直坐标系给（系统会自动换算到渲染坐标，你不用管）。

只输出 JSON 本身（从 { 到 }），不要解释、不要 markdown 围栏。结构：
{
 "lesson":{"language":"zh-CN","meta":"顶部小标签","title":"题面","answerLabel":"答案文字说明","answerValue":"$LaTeX$"},
 "steps":[ {"title":"步骤标题","content":"<p>HTML段落，行内$..$，独立$$..$$，证明用∵∴</p>","highlight":["要可见的元素key"],"cameraPos":{"x":5,"y":4,"z":5}} ],
 "model":{
   "target":[x,y,z],"initialCamera":[x,y,z],
   "solids":[ {"type":"frustum","base":[0,0,0],"bottomR":2,"topR":1,"height":2} ],  // 旋转体，可多个；type: frustum/cone/cylinder/sphere
   "points":{ "A":[x,y,z], ... },         // 落在体上的命名点，z 轴为高度（自然坐标）
   "spheres":["A","B",...],               // 画小球+标签的顶点
   "edges":[ {"a":"A","b":"B"}, {"a":"D","b":"A","dashed":true} ],  // 始终可见的辅助连线/骨架（圆弧不用连，模板会画圆圈）
   "elements":{ "Line_AF":{"type":"line","a":"A","b":"F","color":"emphasis","depthTest":false},
                "Plane_ABE":{"type":"plane","pts":["A","B","E"]},
                "Len_AB":{"type":"measure","a":"A","b":"B","label":"2"} },
   "conditions":[ {"text":"$AB=OO_1=2$","show":["Len_AB"]}, {"text":"面$ABE\\\\perp$面$ABCD$","show":["Plane_ABE"]}, {"text":"$F$ 为 $BC$ 中点","show":["F"]} ]
 }
}
规则：
- conditions：把题面每条【已知条件】做成"点击高亮"。text 为条件文字(可含$LaTeX$)，show 是点它时亮起的【元素 key 或顶点名】(必须真实存在于 elements/points)。对不上就别列。
- solids 的尺寸（半径/高）必须与题目一致；体的圆周由模板自动画，edges 里不要试图用线段去逼近圆。
- edges 只连"题目里真实存在的线段/棱"（如内接正方形的边、母线、A 到 F 的连线）。
- 每个 step 的 highlight 是"该步应可见的可切换元素 key 的完整集合"；solids、骨架、顶点小球始终可见不用列。
- 题面给出长度的线段，加一个 measure 元素，并放进第一步 highlight。
- 颜色名只能用：frame/aux/emphasis/normal/plane/point。
- measure 和 line 的 a/b 只能是【points 里已定义的点名】，绝不能是平面/元素的 key。"点到平面距离""线面角"这类不要用 measure 表示；要展示平面就用 plane 元素，距离/角度写进步骤文字即可。
- elements/edges 里引用的每个点，都必须在 points 里出现过。
- 步骤要跟解答的推理一一对应。

【动点拖拽——有"线段上动点"就接上】题目若有"P 为母线/棱 AB 上动点 / 点 P 在线段 AB 上移动"，在 model 里加：
"draggable":{"point":"P","along":["A","B"],"t":0.5,"standardLabel":"说明","dependent":[{"name":"Q","kind":"midpoint","of":["P","C"]}],"readouts":[{"label":"PC长","type":"length","pts":["P","C"]},{"label":"四面体P-ABC体积","type":"volume_tetra","pts":["P","A","B","C"]},{"label":"PA与面BCD所成角正弦","type":"line_plane_angle_sin","line":["P","A"],"plane":["B","C","D"]}]}
规则：动点只能沿一条线段滑（不能在圆/曲面自由动，做不到就别加）；point/along两端/dependent/readouts 的点都要在 points 里；readout type 仅 length/volume_tetra/line_plane_angle_sin；mathPoints 系统自动反推、不用你给（坐标仍用 z 竖直自然坐标）。

示例（圆台：下底圆 O 内接正方形 ABCD，AB=OO₁=2，下底半径 R=√2，上底半径 r=1，高 h=2；E 在上底圆。注意 z 是高度、点坐标与解答一致、不做轴变换）：
{"lesson":{"language":"zh-CN","meta":"交互解题 · 圆台","title":"圆台体积","answerLabel":"体积","answerValue":"$\\\\dfrac{2\\\\pi(3+\\\\sqrt2)}{3}$"},"steps":[{"title":"看清结构","content":"<p>下底半径 $R=\\\\sqrt2$，上底半径 $r=1$，高 $h=2$；$ABCD$ 为下底内接正方形。</p>","highlight":["Len_OO1"],"cameraPos":{"x":6,"y":6,"z":5}},{"title":"求体积","content":"<p>$V=\\\\dfrac{\\\\pi h}{3}(R^2+Rr+r^2)=\\\\dfrac{2\\\\pi(3+\\\\sqrt2)}{3}$</p>","highlight":[],"cameraPos":{"x":5,"y":5,"z":4}}],"model":{"target":[0,0,1],"initialCamera":[6,6,5],"solids":[{"type":"frustum","base":[0,0,0],"bottomR":1.4142,"topR":1,"height":2}],"points":{"O":[0,0,0],"O1":[0,0,2],"A":[1,-1,0],"B":[1,1,0],"C":[-1,1,0],"D":[-1,-1,0],"E":[1,0,2],"F":[0,1,0]},"spheres":["O","O1","A","B","C","D","E","F"],"edges":[{"a":"A","b":"B"},{"a":"B","b":"C"},{"a":"C","b":"D"},{"a":"D","b":"A"},{"a":"O","b":"O1","dashed":true}],"elements":{"Len_OO1":{"type":"measure","a":"O","b":"O1","label":"2"}}}}`;

async function genCurvedSolidData(problem, solution){
  const raw = await callAI('https://api.deepseek.com/chat/completions', DEEPSEEK_KEY, {
    model: GEN_MODEL, temperature:0.2, max_tokens:6000,
    messages:[{role:'system',content:CURVED_SOLID_SYSTEM},{role:'user',content:`【题目】\n${problem}\n\n【已验证解答】\n${solution}\n\n只输出 lesson-data JSON，model.solids 必须给出旋转体。`}]
  });
  let t = raw.trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if(i<0 || j<0) throw new Error('未得到 JSON');
  const data = JSON.parse(t.slice(i, j+1));
  if(!data.lesson || !Array.isArray(data.steps) || !data.steps.length || !data.model || !data.model.points) throw new Error('JSON 结构不完整');
  if(!Array.isArray(data.model.solids) || !data.model.solids.length) throw new Error('缺少 solids 旋转体');
  // 模型用自然坐标（z 竖直），模板是 y 竖直 —— 统一把 (x,y,z) -> (x,z,y)，免去模型自己换轴出错
  const sw = p => (Array.isArray(p) && p.length>=3) ? [p[0], p[2], p[1]] : p;
  const m = data.model;
  for(const k in m.points) m.points[k] = sw(m.points[k]);
  (m.solids||[]).forEach(s => { if(s.base) s.base = sw(s.base); if(s.center) s.center = sw(s.center); });
  if(m.target) m.target = sw(m.target);
  if(m.initialCamera) m.initialCamera = sw(m.initialCamera);
  data.steps.forEach(st => { const c = st.cameraPos; if(c && c.y!=null && c.z!=null){ st.cameraPos = { x:c.x, y:c.z, z:c.y }; } });
  attachDraggable(data); // points 此时已是渲染坐标，反推 mathPoints
  attachConditions(data);
  return data;
}

// ---- 解析几何：LLM 产 board-data JSON，注入 board.html（Canvas 2D 圆锥曲线引擎）----
let BOARD_TPL = '';
try { BOARD_TPL = fs.readFileSync('/home/admin/edulab-gen/edu-analytic-geometry/template/board.html', 'utf8'); } catch(e){ console.log('board.html 模板未找到，解析几何将回退到出 HTML'); }
function isAnalytic(p){
  return /椭圆|双曲线|抛物线|圆锥曲线|离心率|准线|渐近线|焦点|焦距/.test(p);
}
const ANALYTIC_SYSTEM = `你是解析几何交互课件的【数据】生成器。根据题目和已验证解答，输出一份 JSON（board-data），它会被注入一个用 Canvas 2D 渲染圆锥曲线的固定模板。你只产数据，不写任何渲染/HTML/JS 代码。

只输出 JSON（从 { 到 }），不要解释、不要 markdown 围栏。结构：
{
 "lesson":{"language":"zh-CN","title":"标题","problem":"<p>题面HTML，行内$..$，块$$..$$</p>","answerLabel":"答案说明","answer":"$LaTeX$"},
 "steps":[ {"title":"步骤标题","content":"<p>HTML，公式$..$/$$..$$，证明用∵∴</p>"} ],
 "board":{
   "view":{"xRange":[-3.6,3.6],"yRange":[-2.6,2.6]},   // 数学坐标视窗，含住曲线和关键点
   "conics":[ {"name":"C","kind":"ellipse","a":2,"b":1.732,"center":[0,0],"color":"curve","label":"C: x²/4+y²/3=1"} ],
   "points":{ "F1":{"xy":[-1,0],"color":"point","label":"F₁(-1,0)","emphasis":true} }
 }
}
conics 各类型必填：
- ellipse: a(x半轴) b(y半轴) center
- hyperbola: a(实半轴) b(虚半轴) center orient("x"或"y"); 可加 "asymptotes":true 画渐近线
- parabola: p center(顶点) axis("x"或"y")  // (y-cy)²=2p(x-cx) 或 (x-cx)²=2p(y-cy)
- circle: r center
points 值用 {"xy":[x,y],"color":"point","label":"标签","emphasis":true}；emphasis 画大点(定点/焦点用)。

【动态滑块——能动就做成可拖动，这是本课件的核心价值】只要题中存在一个由【单一参数】决定的动点或动直线，就要做成可拖动的动态图，让学生拖滑块、看图形实时变化。触发场景不限于"求范围/最值/定值"，**同样包括"判断/求证/下列结论正确的有"这类只要有动点的题**：
- 动点 M 用参数表示（如抛物线上 $M(2m^2,4m)$、圆锥曲线上的点）→ param 就是那个参数，M 用 point_on_conic 挂到曲线上随之滑动。
- 过定点的动直线（倾斜角/斜率可变）、动点 P 在某线段上 → 同理。
只有当全图完全静止（只求方程/某个固定点/固定值，没有任何会动的量）时，才出静态 view+conics+points。
在 board 里加：
- "param":{name,label,min,max,step,value,standard,unit,ticks:[..]} —— 唯一可变量(抛物线/曲线上动点的参数；动直线的倾斜角θ 或斜率k 或 x=my+c 的 m；形状参数题则是离心率 e)。表达式里用 "@param" 引用。
- "derived":[..] 随 param 变化、按顺序构造的图元。可用 type：
  line_through_angle{name,point,angle:"@param"}、line_through_slope{name,point,slope}、line_x_eq_my_c{name,m,c}、line_through_points{name,a,b}、point_on_conic{name,conic,t}（t 即曲线参数，抛物线 $y^2=2px$ 上点为 $(t^2/(2p),t)$，即 t 是该点纵坐标）、intersect_line_conic{name:[A,B],line,conic,colors:["ptA","ptB"]}、midpoint{name,a,b}、foot_perp{name,point,line}（point 在 line 上的垂足，可用来作准线上的射影 N）、vector{name,from,to}、segment{name,a,b}、polygon{pts:[..],color,stroke}（画三角形等）、tangent_at{name,conic,point}
- "readouts":[{id,label,type,...,highlight}] 实时数值。type：coord{of}、slope{of}、distance{a,b}、length{of}、dot{a,b=向量名}、slope_product{a,b=线名}、area_triangle{pts}、expr{expr,digits}、status{expr,op,rhs,okText,badText}。目标量加 "highlight":true。
- 收尾（按题型，可选）：求范围/最值→rangeBar{of:readoutId,min,max,label}；定值→constant{of:readoutId,label}；求离心率等形状参数范围→answerBand{min,max,lo,hi,label}(此时 param 就是 e，conic 的 a/b 写成含 e 的表达式字符串如 "b":"sqrt(e*e-1)")。**判断/多选/求证题没有单一目标量时，不加收尾控件，只保留可拖动图 + readouts 即可。**
规则：
- 曲线参数、点坐标、范围数值必须与已验证解答一致、数学正确。
- view 要把曲线和所有点框进去；关键点(焦点/顶点/给定点/交点)都放进 points。
- 颜色名：curve(主曲线) point line ptA/ptB(交点) vecA/vecB(向量) given(给定点) fixed(定点) asymptote locus。
- steps 跟解答一一对应。
- 只求方程/焦点/某个固定值、没有"变化的量"时 → 只产 view+conics+points(静态)。**拿不准 derived 怎么写就出静态，别编错。**但只要有动点(哪怕是判断题)，就优先把动点用 param 挂上去做成可拖。

示例A（静态·椭圆求焦点）：
{"lesson":{"language":"zh-CN","title":"椭圆标准方程与焦点","problem":"<p>椭圆 $\\\\frac{x^2}{4}+\\\\frac{y^2}{3}=1$，求焦点坐标。</p>","answerLabel":"焦点","answer":"$(\\\\pm1,0)$"},"steps":[{"title":"求半焦距 c","content":"<p>$c=\\\\sqrt{a^2-b^2}=1$</p>"},{"title":"写出焦点","content":"<p>∵焦点在 $x$ 轴，∴$F_1(-1,0),F_2(1,0)$</p>"}],"board":{"view":{"xRange":[-3.5,3.5],"yRange":[-2.5,2.5]},"conics":[{"name":"C","kind":"ellipse","a":2,"b":1.732,"center":[0,0],"color":"curve","label":"C"}],"points":{"F1":{"xy":[-1,0],"color":"point","label":"F₁(-1,0)","emphasis":true},"F2":{"xy":[1,0],"color":"point","label":"F₂(1,0)","emphasis":true}}}}

示例B（动态·椭圆动直线求向量积范围，带滑块）：
{"lesson":{"language":"zh-CN","title":"椭圆与动直线向量积范围","problem":"<p>椭圆 $\\\\frac{x^2}{4}+\\\\frac{y^2}{3}=1$，$M(-1,0)$，过右焦点 $F(1,0)$ 的直线 $l$ 交椭圆于 $A,B$，求 $\\\\vec{MA}\\\\cdot\\\\vec{MB}$ 的取值范围。</p>","answerLabel":"数量积范围","answer":"$[-3,\\\\frac{7}{4}]$"},"steps":[{"title":"求椭圆方程","content":"<p>由条件得 $\\\\frac{x^2}{4}+\\\\frac{y^2}{3}=1$。</p>"},{"title":"联立韦达","content":"<p>设 $l:x=my+1$ 代入。</p>"},{"title":"化简求范围","content":"<p>$\\\\vec{MA}\\\\cdot\\\\vec{MB}=\\\\frac{7-9m^2}{3m^2+4}\\\\in[-3,\\\\frac{7}{4}]$</p>"}],"board":{"view":{"xRange":[-3.6,3.6],"yRange":[-2.6,2.6]},"conics":[{"name":"C","kind":"ellipse","a":2,"b":1.732,"center":[0,0],"color":"curve","label":"C"}],"points":{"M":{"xy":[-1,0],"color":"vecA","label":"M(-1,0)","emphasis":true},"F":{"xy":[1,0],"color":"point","label":"F(1,0)","emphasis":true}},"param":{"name":"θ","label":"直线倾斜角 $\\\\theta$","min":0,"max":180,"step":0.5,"value":45,"unit":"°","standard":45,"ticks":["0°","90°","180°"]},"derived":[{"type":"line_through_angle","name":"l","point":"F","angle":"@param","color":"line"},{"type":"intersect_line_conic","name":["A","B"],"line":"l","conic":"C","colors":["ptA","ptB"]},{"type":"vector","name":"vMA","from":"M","to":"A","color":"vecA"},{"type":"vector","name":"vMB","from":"M","to":"B","color":"vecB"}],"readouts":[{"id":"A","label":"交点A","type":"coord","of":"A"},{"id":"B","label":"交点B","type":"coord","of":"B"},{"id":"dot","label":"$\\\\vec{MA}\\\\cdot\\\\vec{MB}$","type":"dot","a":"vMA","b":"vMB","highlight":true}],"rangeBar":{"of":"dot","min":-3,"max":1.75,"label":"$[-3,\\\\frac{7}{4}]$"}}}

示例C（动态·抛物线动点判断题，多选无收尾控件——拖 M 看 △MNF 随之变化）：
{"lesson":{"language":"zh-CN","title":"抛物线动点与射影","problem":"<p>抛物线 $y^2=8x$ 焦点 $F$，$M$ 为线上异于顶点的点，$M$ 在准线上射影为 $N$，判断各结论。</p>","answerLabel":"M 沿抛物线移动","answer":"拖动滑块观察 △MNF"},"steps":[{"title":"基本元素","content":"<p>$y^2=8x$，$p=4$，$F(2,0)$，准线 $x=-2$。</p>"},{"title":"参数化动点","content":"<p>设 $M(2m^2,4m)$，则 $N(-2,4m)$，拖动滑块即改变 $m$。</p>"}],"board":{"view":{"xRange":[-4,12],"yRange":[-8,8]},"conics":[{"name":"C","kind":"parabola","p":4,"center":[0,0],"axis":"x","color":"curve","label":"y²=8x"}],"points":{"F":{"xy":[2,0],"color":"fixed","label":"F(2,0)","emphasis":true}},"param":{"name":"yM","label":"动点 M 的纵坐标","min":-8,"max":8,"step":0.1,"value":4,"standard":4,"ticks":["-8","0","8"]},"derived":[{"type":"point_on_conic","name":"M","conic":"C","t":"@param","color":"given","emphasis":true,"label":"M"},{"type":"line_x_eq_my_c","name":"dir","m":0,"c":-2,"color":"asymptote","dashed":true,"label":"准线 x=-2"},{"type":"foot_perp","name":"N","point":"M","line":"dir","color":"point","label":"N"},{"type":"polygon","pts":["M","N","F"],"color":"area","stroke":"line"}],"readouts":[{"id":"M","label":"动点 M","type":"coord","of":"M"},{"id":"N","label":"射影 N","type":"coord","of":"N"},{"id":"area","label":"$S_{\\\\triangle MNF}$","type":"area_triangle","pts":["M","N","F"],"highlight":true}]}}`;

async function genBoardData(problem, solution){
  const raw = await callAI('https://api.deepseek.com/chat/completions', DEEPSEEK_KEY, {
    model: GEN_MODEL, temperature:0.2, max_tokens:6000,
    messages:[{role:'system',content:ANALYTIC_SYSTEM},{role:'user',content:`【题目】\n${problem}\n\n【已验证解答】\n${solution}\n\n只输出 board-data JSON。`}]
  });
  let t = raw.trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if(i<0 || j<0) throw new Error('未得到 JSON');
  const data = JSON.parse(t.slice(i, j+1));
  if(!data.lesson || !Array.isArray(data.steps) || !data.steps.length || !data.board || !Array.isArray(data.board.conics) || !data.board.conics.length) throw new Error('JSON 结构不完整');
  // 动态字段结构校验：不合法就剥掉，降级成静态图（绝不出半坏的动态板）
  const bd = data.board;
  if(bd.param){
    const DTYPES = new Set(['line_through_angle','line_through_slope','line_x_eq_my_c','line_through_points','line_through_point_dir','point_on_conic','intersect_line_conic','intersect_line_line','midpoint','point_reflect','foot_perp','reflect','tangent_at','vector','segment','polygon']);
    const p = bd.param;
    let ok = p && typeof p.name==='string' && isFinite(p.min) && isFinite(p.max) && isFinite(p.value);
    if(ok && bd.derived!==undefined) ok = Array.isArray(bd.derived) && bd.derived.every(d=>d && typeof d.type==='string' && DTYPES.has(d.type));
    if(ok && bd.readouts!==undefined) ok = Array.isArray(bd.readouts) && bd.readouts.every(r=>r && typeof r.type==='string');
    if(!ok) ['param','scalars','derived','readouts','rangeBar','constant','answerBand','trace'].forEach(k=>delete bd[k]);
  }
  return data;
}
function buildBoardHTML(data){
  const json = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
  return BOARD_TPL.replace('__LESSON_DATA__', () => json);
}

// ---- 函数题：LLM 产 func-data JSON，注入通用函数绘图模板 func.html ----
let FUNC_TPL = '';
try { FUNC_TPL = fs.readFileSync(path.join(BCAST, 'templates', 'edulab', 'func.html'), 'utf8'); }
catch(e){ try { FUNC_TPL = fs.readFileSync('/home/admin/edulab-gen/edu-function/template/func.html', 'utf8'); } catch(_){ console.log('func.html 模板未找到，函数题将回退到出 HTML'); } }
function isFunction(p){
  return /函数|导数|f\(x\)|f（x）|零点|单调性|单调区间|极值|极大值|极小值|切线|恒成立|对数|指数函数|ln|e\^/.test(p);
}
const FUNC_SYSTEM = `你是函数题交互课件的【数据】生成器。根据题目和已验证解答，输出一份 JSON（func-data），注入一个用 Canvas 2D 画函数曲线的固定模板。你只产数据，不写渲染代码。

只输出 JSON（从 { 到 }），不要解释、不要 markdown 围栏。结构：
{
 "lesson":{"language":"zh-CN","title":"标题","problem":"<p>题面HTML，公式$..$/$$..$$</p>","answerLabel":"答案说明","answer":"$LaTeX$"},
 "steps":[ {"title":"步骤标题","content":"<p>HTML，公式$..$，证明用∵∴</p>"} ],
 "board":{
   "xRange":[-1,6],                 // 必填：横轴范围，要含住定义域和关键特征
   "yRange":[-4,4],                 // 可选：省略则自动
   "param":{"name":"a","label":"参数 $a$","min":-5,"max":5,"step":0.1,"value":1,"standard":1,"ticks":["-5","0","5"]}, // 可选：含参/讨论题才加
   "functions":[ {"expr":"ln(x+1)+a*x*exp(-x)","color":"curve","label":"f(x)"} ],  // 可多条；expr 用变量 x 和参数名
   "markZeros":true, "markExtrema":true,    // 自动标第一条曲线的零点/极值（可选）
   "points":[ {"x":0,"y":0,"label":"A","color":"point"} ],   // 可选：显式点，y 省略=取 f(x)
   "vlines":[ {"x":-1,"label":"x=-1"} ],     // 可选：竖虚线（定义域边界/竖直渐近线）
   "hlines":[ {"y":0} ],                     // 可选：横虚线
   "readouts":[ {"id":"zc","label":"零点个数","type":"zeros_count","domain":[-1,null],"highlight":true} ] // 可选：实时数值
 }
}
表达式语法：变量用 x，参数用其名字(如 a)；函数 ln(自然对数) lg(常用对数) exp(指数e^) sqrt sin cos tan abs；幂用 ^；常数 pi e。只写右边表达式，别写 "y=" 或等号。
readouts type：zeros_count{domain:[lo,hi]}（域内零点数）、extrema_count、expr{expr,digits}、param。目标量加 "highlight":true。
规则：
- 表达式、定义域、关键点必须与已验证解答一致。
- 含参数讨论/求参数范围/零点个数随参数变 的题 → 加 param 滑块 + 相应 readouts（如 zeros_count），让学生拖动观察。否则静态。
- 定义域有边界(如 ln(x+1) 要 x>-1) → 加 vlines 标边界，xRange 从边界稍内开始。
- steps 跟解答一一对应。

示例（含参零点个数，带滑块）：
{"lesson":{"language":"zh-CN","title":"含参函数零点个数","problem":"<p>已知 $f(x)=\\\\ln(x+1)+a\\\\,x\\\\,e^{-x}$，讨论零点个数。</p>","answerLabel":"零点个数","answer":"随 $a$ 变化"},"steps":[{"title":"定义域","content":"<p>需 $x+1>0$，即 $x>-1$。</p>"},{"title":"观察","content":"<p>拖动滑块改变 $a$，看零点个数变化。</p>"}],"board":{"xRange":[-1,6],"param":{"name":"a","label":"参数 $a$","min":-5,"max":5,"step":0.1,"value":1,"standard":1,"ticks":["-5","0","5"]},"functions":[{"expr":"ln(x+1)+a*x*exp(-x)","color":"curve","label":"f(x)"}],"markZeros":true,"markExtrema":true,"vlines":[{"x":-1,"label":"x=-1"}],"hlines":[{"y":0}],"readouts":[{"id":"zc","label":"零点个数","type":"zeros_count","domain":[-1,null],"highlight":true},{"id":"a","label":"当前 a","type":"param"}]}}`;

async function genFuncData(problem, solution){
  const raw = await callAI('https://api.deepseek.com/chat/completions', DEEPSEEK_KEY, {
    model: GEN_MODEL, temperature:0.2, max_tokens:6000,
    messages:[{role:'system',content:FUNC_SYSTEM},{role:'user',content:`【题目】\n${problem}\n\n【已验证解答】\n${solution}\n\n只输出 func-data JSON。`}]
  });
  let t = raw.trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if(i<0 || j<0) throw new Error('未得到 JSON');
  const data = JSON.parse(t.slice(i, j+1));
  if(!data.lesson || !Array.isArray(data.steps) || !data.steps.length || !data.board || !Array.isArray(data.board.functions) || !data.board.functions.length || !Array.isArray(data.board.xRange)) throw new Error('JSON 结构不完整');
  // 表达式安全字符校验：含危险 token 直接判失败（回退出 HTML）
  for(const fn of data.board.functions){ if(typeof fn.expr!=='string' || /[;{}\[\]`]|=>|function|while|for|new\s|import|window|document/.test(fn.expr)) throw new Error('表达式非法'); }
  return data;
}
function buildFuncHTML(data){
  const json = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
  return FUNC_TPL.replace('__LESSON_DATA__', () => json);
}

function slugifyType(problem){
  const m = [['正方体','cube'],['长方体','box'],['棱锥','pyramid'],['棱柱','prism'],['椭圆','ellipse'],['双曲线','hyperbola'],['抛物线','parabola'],['函数','function'],['圆','circle'],['三角','triangle'],['向量','vector']];
  for(const [kw,s] of m) if(problem.includes(kw)) return s;
  return 'math';
}
function tsName(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function extractHTML(s){ const i=s.indexOf('<!DOCTYPE'); const j=s.lastIndexOf('</html>'); return (i>=0&&j>=0)? s.slice(i, j+7) : s; }

// ---- 支付（YunGouOS，与 server.js 同算法）----
function yungouSign(params, key){
  const parts = Object.keys(params).sort().map(k=>k+'='+params[k]);
  parts.push('key='+key);
  return crypto.createHash('md5').update(parts.join('&')).digest('hex').toUpperCase();
}
function safeEqual(a,b){ const aa=Buffer.from(String(a||''),'utf8'),bb=Buffer.from(String(b||''),'utf8'); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function yungouRequest(apiPath, params){
  return new Promise((resolve,reject)=>{
    const body = new URLSearchParams(params).toString();
    const req = https.request({ hostname:YUNGOU_API_HOST, path:apiPath, method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)} }, resp=>{
      let raw=''; resp.on('data',c=>raw+=c); resp.on('end',()=>{ try{ resolve(JSON.parse(raw)); }catch(e){ reject(new Error('云狗返回异常: '+raw.slice(0,120))); } });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}
function extractPayUrl(d){ if(!d) return ''; if(typeof d==='string') return d; return d.pay_url||d.payUrl||d.url||d.cashier_url||d.cashierUrl||d.code_url||d.codeUrl||d.mweb_url||''; }
function readFirst(o,ks){ for(const k of ks){ const v=o[k]; if(v!==undefined&&v!==null&&String(v)!=='') return String(v); } return ''; }
function yuanToCents(v){ return Math.round(parseFloat(v||'0')*100); }
function orderNo(){ return 'ED'+Date.now()+crypto.randomBytes(4).toString('hex').toUpperCase(); }
function normalizeNotify(raw){ return {
  code:readFirst(raw,['code']), orderNo:readFirst(raw,['orderNo','order_no']),
  outTradeNo:readFirst(raw,['outTradeNo','out_trade_no']), payNo:readFirst(raw,['payNo','pay_no']),
  money:readFirst(raw,['money','total_fee','totalFee']), mchId:readFirst(raw,['mchId','mch_id']) }; }
function checkNotifySign(raw, n, sign){
  const p={ code:n.code, orderNo:n.orderNo, outTradeNo:n.outTradeNo, payNo:n.payNo, money:n.money, mchId:n.mchId };
  if(safeEqual(yungouSign(p, YUNGOU_PAY_KEY), sign)) return true;
  const rp={}; Object.keys(raw).sort().forEach(k=>{ if(k!=='sign'&&k!=='signType'&&k!=='sign_type') rp[k]=raw[k]; });
  return safeEqual(yungouSign(rp, YUNGOU_PAY_KEY), sign);
}

function send(res, code, obj){ res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); }
function sendText(res, code, txt){ res.writeHead(code, {'Content-Type':'text/plain'}); res.end(txt); }

const server = http.createServer(async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin', 'https://notice.yingyuzuowen.asia');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if(req.method==='OPTIONS'){ res.writeHead(204); res.end(); return; }
  const route = req.url.split('?')[0].replace(/\/+$/,'');

  if(route.endsWith('/me') && req.method==='GET'){
    const u = authUser(req);
    if(!u) return send(res, 200, { logged_in:false });
    ensureSignup(u.id);
    return send(res, 200, { logged_in:true, username:u.username, balance: balance(u.id) });
  }

  // 我的题库：本用户解过的题
  if(route.endsWith('/history') && req.method==='GET'){
    const u = authUser(req);
    if(!u) return send(res, 401, { error:'请先登录' });
    const items = qHistory.all(u.id).map(coursewareItem);
    return send(res, 200, { items });
  }

  const historyMatch = route.match(/\/history\/(\d+)$/);
  if(historyMatch && req.method==='PATCH'){
    const u = authUser(req);
    if(!u) return send(res, 401, { error:'请先登录' });
    const id = Number(historyMatch[1]);
    const current = qGenerationByUser.get(id, u.id);
    if(!current) return send(res, 404, { error:'课件不存在或已删除' });
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      try{
        const patch = normalizeCoursewarePatch(JSON.parse(body||'{}'));
        if(!Object.keys(patch).length) return send(res, 400, { error:'没有可更新的内容' });
        const title = Object.prototype.hasOwnProperty.call(patch,'title') ? patch.title : String(current.title||'');
        const knowledge = Object.prototype.hasOwnProperty.call(patch,'knowledge_points') ? patch.knowledge_points : parseKnowledgePoints(current.knowledge_points);
        const favorite = Object.prototype.hasOwnProperty.call(patch,'favorite') ? patch.favorite : !!current.favorite;
        const result = updateGenerationMeta.run(title, JSON.stringify(knowledge), favorite?1:0, id, u.id);
        if(!result.changes) return send(res, 404, { error:'课件不存在或已删除' });
        return send(res, 200, { ok:true, item:coursewareItem(qGenerationByUser.get(id,u.id)) });
      }catch(err){ return send(res, 400, { error:'课件信息格式不正确' }); }
    });
    return;
  }

  if(historyMatch && req.method==='DELETE'){
    const u = authUser(req);
    if(!u) return send(res, 401, { error:'请先登录' });
    const id = Number(historyMatch[1]);
    const result = deleteGeneration.run(nowISO(), id, u.id);
    if(!result.changes) return send(res, 404, { error:'课件不存在或已删除' });
    return send(res, 200, { ok:true });
  }

  // 生成前先识别题目，供教师核对；识别本身不扣积分。
  if(route.endsWith('/ocr') && req.method==='POST'){
    const u = authUser(req);
    if(!u) return send(res, 401, { error:'请先登录后识别题目' });
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',async()=>{
      try{
        const image = String(JSON.parse(body||'{}').image||'');
        if(!image.startsWith('data:image/')) return send(res, 400, { error:'请先上传题目图片' });
        if(image.length > 9_000_000) return send(res, 413, { error:'图片过大，请裁剪后重试' });
        const problem = (await ocrImage(image)).trim();
        if(!problem) return send(res, 502, { error:'没有识别到题目，请重新裁剪' });
        return send(res, 200, { problem });
      }catch(err){ return send(res, 502, { error:err.message||'题目识别失败' }); }
    });
    return;
  }

  if(route.endsWith('/generate') && req.method==='POST'){
    const u = authUser(req);
    if(!u) return send(res, 401, { error:'请先登录（用作文批改的同一账号）' });
    ensureSignup(u.id);
    if(balance(u.id) < POINT_COSTS.edulab) return send(res, 402, { error:`师行积分不足，本次需要 ${POINT_COSTS.edulab} 积分`, balance:balance(u.id) });
    let body=''; req.on('data',c=>body+=c); req.on('end', async ()=>{
      try {
        const p = JSON.parse(body||'{}');
        let problem = (p.problem||'').toString().trim();
        if(!problem && p.image) problem = (await ocrImage(p.image)).trim();
        if(!problem) return send(res, 400, { error:'缺少题目（图片或文字）' });
        const preferences = normalizeTeachingPreferences(p.preferences);
        const coursewareProblem = `${problem}\n\n【教师课件要求】${buildTeachingRequirement(preferences)}`;
        // 同题缓存：本用户出过同一道题 → 直接调出上次那份，不重算、不扣次、图一致（除非 force 重新生成）
        const phash = hashProblem(problem);
        if(!p.force){
          const cached = qCachedGen.get(u.id, phash);
          if(cached && cached.url) return send(res, 200, { generation_id:Number(cached.id), url:cached.url, solution:cached.solution||'', balance:balance(u.id), cached:true });
        }
        const solution = await solve(problem);
        let html;
        if(isCurvedSolid(problem) && LESSON_TPL){
          // 圆台/圆锥/圆柱/球 → 真 3D 模板（带旋转体建模），失败再退回出 HTML
          try { const d = await genCurvedSolidData(coursewareProblem, solution); d.editKey = phash; html = buildLessonHTML(d); }
          catch(e){ html = extractHTML(await genCourseware(coursewareProblem, solution)); }
        } else if(isSolid3D(problem) && LESSON_TPL){
          try { const d = await genLessonData(coursewareProblem, solution); d.editKey = phash; html = buildLessonHTML(d); }
          catch(e){ html = extractHTML(await genCourseware(coursewareProblem, solution)); } // 数据生成失败 → 回退出 HTML
        } else if(isAnalytic(problem) && BOARD_TPL){
          try { html = buildBoardHTML(await genBoardData(coursewareProblem, solution)); }
          catch(e){ html = extractHTML(await genCourseware(coursewareProblem, solution)); }
        } else if(isFunction(problem) && FUNC_TPL){
          try { html = buildFuncHTML(await genFuncData(coursewareProblem, solution)); }
          catch(e){ html = extractHTML(await genCourseware(coursewareProblem, solution)); }
        } else {
          html = extractHTML(await genCourseware(coursewareProblem, solution));
        }
        if(!/<canvas|<script|lesson-data/i.test(html)) throw new Error('生成的课件不完整，请重试');
        const fname = `${slugifyType(problem)}_${tsName()}.html`;
        const fpath = path.join(PUBLIC_EDULAB, fname);
        fs.writeFileSync(fpath, html, 'utf8');
        fs.chmodSync(fpath, 0o644); // nginx 可读
        // 扣费与生成记录写入同一事务：任何一步失败都会回滚积分。
        const generatedAt = nowISO();
        let completed;
        try {
          completed = finalizeGeneration({
            user:u,
            type:slugifyType(problem),
            problem,
            problemHash:phash,
            solution,
            url:`${BASE_URL}/${fname}`,
            createdAt:generatedAt
          });
        } catch(e) {
          try { fs.unlinkSync(fpath); } catch(_) {}
          if(e.code === 'SHIXING_POINTS_EXHAUSTED') return send(res, 402, { error:`师行积分不足，本次需要 ${POINT_COSTS.edulab} 积分`, balance:e.balance });
          throw e;
        }
        let referralReward = null;
        try {
          referralReward = referrals.activateReferral({
            invitee_user_id:u.id,
            product:'edulab',
            source_record_id:'edulab:' + completed.generationId,
            device_hash:deviceHash(req),
            created_at:generatedAt
          });
        } catch(e) {
          console.error(`[edulab] referral activation failed for generation ${completed.generationId}: ${e.message || e}`);
        }
        return send(res, 200, {
          generation_id:completed.generationId,
          url:`${BASE_URL}/${fname}`,
          solution,
          balance:completed.balance,
          referral_reward:referralReward && !referralReward.duplicate ? {
            status:referralReward.status,
            invitee_reward_points:referralReward.invitee_reward_points,
            risk_reason:referralReward.risk_reason || ''
          } : null
        });
      } catch(err){ return send(res, 502, { error: err.message || '生成失败' }); }
    });
    return;
  }

  // ---- 自然语言改图（仅立体几何课件）：每题每用户限 EDIT_LIMIT 次，不扣课件次数 ----
  if(route.endsWith('/edit') && req.method==='POST'){
    const u = authUser(req);
    if(!u) return send(res, 401, { error:'请先登录' });
    let body=''; req.on('data',c=>body+=c); req.on('end', async ()=>{
      try {
        const p = JSON.parse(body||'{}');
        const editKey = String(p.edit_key||'').trim();
        const command = String(p.command||'').trim();
        const data = p.data;
        if(!editKey) return send(res, 400, { error:'这份课件不支持改图' });
        if(!command) return send(res, 400, { error:'请输入要改什么' });
        if(!data || !data.model || !data.model.points) return send(res, 400, { error:'课件数据缺失' });
        if(!LESSON_TPL) return send(res, 503, { error:'模板不可用' });
        const used = editCount(u.id, editKey);
        if(used >= EDIT_LIMIT) return send(res, 429, { error:`这道题已改 ${EDIT_LIMIT} 次（每题上限），再改请重新生成一版` });
        let nd;
        try { nd = await genEditData(data, command); }
        catch(e){ return send(res, 502, { error:'没改成，换个说法再试试' }); }
        nd.editKey = editKey;
        const html = buildLessonHTML(nd);
        if(!/<canvas|lesson-data/i.test(html)) return send(res, 502, { error:'没改成，换个说法再试试' });
        const fname = `edit_${tsName()}.html`;
        fs.writeFileSync(path.join(PUBLIC_EDULAB, fname), html, 'utf8');
        fs.chmodSync(path.join(PUBLIC_EDULAB, fname), 0o644);
        bumpEditN.run(u.id, editKey);
        return send(res, 200, { url:`${BASE_URL}/${fname}`, remaining: EDIT_LIMIT - (used+1) });
      } catch(err){ return send(res, 502, { error:'改图失败：'+(err.message||'') }); }
    });
    return;
  }

  // ---- 改图剩余次数（课件页加载时查询，用于显示"改图剩余 N 次"）----
  if(route.endsWith('/edit-status') && req.method==='GET'){
    const u = authUser(req);
    const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
    const used = (u && key) ? editCount(u.id, key) : 0;
    return send(res, 200, { limit: EDIT_LIMIT, remaining: Math.max(0, EDIT_LIMIT - used), loggedIn: !!u });
  }

  // ---- 充值套餐列表 ----
  if(route.endsWith('/pay/packages') && req.method==='GET'){
    const u = authUser(req);
    const first = !!u && !pointStore.hasPaidTopup(u.id);
    return send(res, 200, { enabled: payConfigured(), point_cost:POINT_COSTS.edulab, first_topup_available:first, packages: Object.values(PACKAGES).map(p=>({key:p.key,label:p.label,points:p.points,credits:p.points,amount:p.amount,first_bonus:first?p.first_bonus:0,first_award:first?p.points+p.first_bonus:p.points})) });
  }

  // ---- 创建充值订单 ----
  if(route.endsWith('/pay/create') && req.method==='POST'){
    const u = authUser(req);
    if(!u) return send(res, 401, { error:'请先登录' });
    if(!payConfigured()) return send(res, 503, { error:'微信支付暂未配置' });
    let body=''; req.on('data',c=>body+=c); req.on('end', async ()=>{
      try {
        const pkg = PACKAGES[(JSON.parse(body||'{}').package_key)||''];
        if(!pkg) return send(res, 400, { error:'套餐不存在' });
        const otn = orderNo();
        insPay.run(otn, u.id, pkg.key, pkg.points, pkg.amount, 'created', nowISO());
        const required = { out_trade_no:otn, total_fee:pkg.amount, mch_id:YUNGOU_MCH_ID, body:'师行积分'+pkg.points };
        const params = { ...required, sign:yungouSign(required, YUNGOU_PAY_KEY), attach:u.id,
          notify_url: PUBLIC_BASE+'/edulab-api/pay/notify',
          return_url: PUBLIC_BASE+'/edulab/pro.html?paid='+encodeURIComponent(otn), auto:'0' };
        if(YUNGOU_APP_ID) params.app_id = YUNGOU_APP_ID;
        const result = await yungouRequest('/api/pay/wxpay/cashierPay', params);
        if(!result || result.code !== 0){ setPayStatus.run('create_failed', otn); return send(res, 502, { error:(result&&(result.msg||result.message))||'创建订单失败' }); }
        const payUrl = extractPayUrl(result.data);
        if(!payUrl){ setPayStatus.run('create_failed', otn); return send(res, 502, { error:'支付链接为空' }); }
        setPayStatus.run('pending', otn);
        return send(res, 200, { ok:true, out_trade_no:otn, amount:pkg.amount, credits:pkg.points, points:pkg.points, pay_url:payUrl });
      } catch(e){ return send(res, 502, { error:'创建订单失败：'+e.message }); }
    });
    return;
  }

  // ---- 查询订单状态（前端轮询）----
  if(route.endsWith('/pay/status') && req.method==='GET'){
    const u = authUser(req);
    if(!u) return send(res, 401, { error:'请先登录' });
    const otn = new URL(req.url,'http://x').searchParams.get('out_trade_no')||'';
    const p = getPay.get(otn);
    return send(res, 200, { status: p?p.status:'unknown', balance: balance(u.id) });
  }

  // ---- 支付回调（云狗服务器调用，无登录；out_trade_no 唯一索引保证不重复入账）----
  if(route.endsWith('/pay/notify')){
    let body=''; req.on('data',c=>body+=c); req.on('end', ()=>{
      try {
        const q = Object.fromEntries(new URL(req.url,'http://x').searchParams);
        const form = Object.fromEntries(new URLSearchParams(body));
        const raw = { ...q, ...form };
        const sign = readFirst(raw, ['sign']);
        const n = normalizeNotify(raw);
        if(!sign || !n.outTradeNo) return sendText(res, 400, 'fail');
        if(!checkNotifySign(raw, n, sign)) return sendText(res, 400, 'fail');
        if(n.mchId && n.mchId !== YUNGOU_MCH_ID) return sendText(res, 400, 'fail');
        const pay = getPay.get(n.outTradeNo);
        if(!pay) return sendText(res, 404, 'fail');
        if(yuanToCents(n.money) !== yuanToCents(pay.amount)) return sendText(res, 400, 'fail');
        if(pay.status !== 'paid'){
          if(POINT_PACKAGES[pay.package]) {
            pointStore.addPayment({ user_id:pay.user_id, package_key:pay.package, out_trade_no:pay.out_trade_no, product:'edulab', created_at:nowISO() });
          } else {
            pointStore.addLegacyPayment({ user_id:pay.user_id, product:'edulab', credits:pay.credits, package_key:pay.package, out_trade_no:pay.out_trade_no, created_at:nowISO() });
          }
          referrals.rewardFirstPurchase({
            invitee_user_id:pay.user_id,
            purchase_type:'points',
            source_product:'edulab',
            source_record_id:pay.out_trade_no,
            created_at:nowISO()
          });
          setPayPaid.run(n.payNo||'', nowISO(), pay.out_trade_no);
        }
        return sendText(res, 200, 'success');
      } catch(e){ return sendText(res, 500, 'fail'); }
    });
    return;
  }

  send(res, 404, { error:'未知接口' });
});
server.listen(PORT, HOST, ()=>{
  console.log(`edulab-product on http://${HOST}:${PORT} (dashscope:${DASHSCOPE_KEY?'✓':'✗'}, deepseek:${DEEPSEEK_KEY?'✓':'✗'}, pay:${payConfigured()?'✓':'✗'}, solve:${SOLVE_MODEL}, generate:${GEN_MODEL})`);
});
