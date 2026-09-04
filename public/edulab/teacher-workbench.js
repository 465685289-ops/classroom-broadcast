'use strict';

const API = '/edulab-api';
const POINT_COST = 75;
const ROUTES = {
  dashboard: ['教师工作台', '把一道题变成能直接上课的互动课件'],
  generator: ['拍题生成', '核对题目、设置课堂偏好，再生成互动课件'],
  library: ['我的课件', '搜索、收藏和整理已经生成的课堂内容'],
  knowledge: ['题库与知识点', '用真实课件记录沉淀自己的教学资料'],
  account: ['数据与账户', '查看真实使用量、师行积分和充值套餐']
};

const state = {
  loggedIn: false,
  username: '',
  balance: null,
  items: [],
  route: 'dashboard',
  currentGenerationId: null,
  currentUrl: '',
  pendingGenerate: false,
  metaId: null,
  ocrReviewed: false,
  lastRecognizedText: '',
  pointCost: POINT_COST
};

let cropper = null;
let generationTimer = null;
let payPoll = null;
let codeTimer = null;

const $ = id => document.getElementById(id);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const show = (element, on) => { if (element) element.classList.toggle('hidden', !on); };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function safeUrl(value) {
  const url = String(value || '');
  return /^https:\/\/notice\.yingyuzuowen\.asia\/edulab\//.test(url) ? url : '#';
}

function toast(message) {
  const element = $('toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.remove('show'), 1800);
}

function showError(id, message, success) {
  const element = $(id);
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('show', !!message);
  element.classList.toggle('success', !!success);
}

function navigate(route) {
  const next = ROUTES[route] ? route : 'dashboard';
  if (location.hash !== '#' + next) history.pushState(null, '', '#' + next);
  applyRoute(next);
}

function applyRoute(route) {
  state.route = ROUTES[route] ? route : 'dashboard';
  $$('.app-view').forEach(view => view.classList.toggle('active', view.dataset.view === state.route));
  $$('[data-route]').forEach(control => control.classList.toggle('active', control.dataset.route === state.route));
  const copy = ROUTES[state.route];
  $('viewTitle').textContent = copy[0];
  $('viewSubtitle').textContent = copy[1];
  if (state.route === 'library') renderLibrary();
  if (state.route === 'knowledge') renderKnowledge();
  if (state.route === 'account' && state.loggedIn) loadPackages();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setAccount(loggedIn, username, balance) {
  state.loggedIn = !!loggedIn;
  state.username = loggedIn ? String(username || '') : '';
  state.balance = loggedIn && Number.isFinite(Number(balance)) ? Number(balance) : null;
  const name = state.loggedIn ? state.username : '教师访客';
  const avatar = state.loggedIn ? (state.username.slice(0, 1).toUpperCase() || '师') : '师';
  const points = state.loggedIn ? `师行积分 ${state.balance}` : '登录后同步积分';

  $('sideUser').textContent = name;
  $('sideAvatar').textContent = avatar;
  $('sidePoints').textContent = points;
  $('accountAvatar').textContent = avatar;
  $('accountName').textContent = state.loggedIn ? state.username : '尚未登录';
  $('topBalance').textContent = state.loggedIn ? state.balance : '—';
  $('topAuthText').textContent = state.loggedIn ? state.username : '登录 / 注册';
  $('acctInfo').innerHTML = state.loggedIn ? `${esc(state.username)}老师 · 师行积分 <b>${state.balance}</b>` : '生成时再登录';
  $('accountActions').innerHTML = state.loggedIn
    ? '<button class="secondary-button" type="button" data-action="logout"><i class="fa-solid fa-arrow-right-from-bracket"></i>退出登录</button>'
    : '<div class="hero-actions"><button class="primary-button" type="button" data-action="login">登录</button><button class="secondary-button" type="button" data-action="register">注册</button></div>';
  renderMetrics();
}

async function refreshMe() {
  try {
    const response = await fetch(API + '/me', { credentials: 'include' });
    const data = await response.json();
    if (data.logged_in) {
      setAccount(true, data.username, data.balance);
      closeAuth();
      await loadHistory();
      if (state.route === 'account') loadPackages();
      if (state.pendingGenerate) {
        state.pendingGenerate = false;
        generate();
      }
      return;
    }
  } catch (_) {}
  state.items = [];
  setAccount(false, '', null);
  renderAllData();
}

function renderMetrics() {
  const month = new Date().toISOString().slice(0, 7);
  const total = state.items.length;
  const favorites = state.items.filter(item => item.favorite).length;
  const monthCount = state.items.filter(item => String(item.created_at || '').slice(0, 7) === month).length;
  const values = state.loggedIn ? [state.balance, total, favorites, monthCount] : ['—', '—', '—', '—'];
  ['metricBalance', 'metricTotal', 'metricFavorites', 'metricMonth'].forEach((id, index) => { $(id).textContent = values[index]; });
  $('accountBalance').textContent = state.loggedIn ? state.balance : '—';
  $('accountTotal').textContent = state.loggedIn ? total : '—';
  $('accountFavorites').textContent = state.loggedIn ? favorites : '—';
  $('accountMonth').textContent = state.loggedIn ? monthCount : '—';
}

async function loadHistory() {
  if (!state.loggedIn) {
    state.items = [];
    renderAllData();
    return;
  }
  try {
    const response = await fetch(API + '/history', { credentials: 'include' });
    if (response.status === 401) {
      setAccount(false, '', null);
      state.items = [];
      renderAllData();
      return;
    }
    const data = await response.json();
    state.items = Array.isArray(data.items) ? data.items : [];
  } catch (_) {
    toast('课件记录加载失败，请稍后重试');
  }
  renderAllData();
}

function renderAllData() {
  renderMetrics();
  renderRecent();
  populateTypeFilter();
  renderLibrary();
  renderKnowledge();
}

function emptyState(title, description, actionLabel, action) {
  const actionHtml = actionLabel ? `<button class="primary-button" type="button" data-action="${esc(action)}">${esc(actionLabel)}</button>` : '';
  return `<div class="empty-state"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><h3>${esc(title)}</h3><p>${esc(description)}</p>${actionHtml}</div>`;
}

function coursewareRow(item) {
  const tags = (item.knowledge_points || []).slice(0, 2).map(tag => `<span class="tag">${esc(tag)}</span>`).join('');
  return `<article class="courseware-row" data-id="${Number(item.id)}">
    <span class="courseware-thumb"><i class="fa-solid fa-shapes" aria-hidden="true"></i></span>
    <div class="courseware-main"><strong>${esc(item.title || item.summary || '数学互动课件')}</strong><p>${esc(item.summary || item.problem || '')}</p><div class="courseware-meta"><span>${esc(item.at || '')}</span><span>${esc(item.type || '数学')}</span>${tags}</div></div>
    <div class="row-actions"><button class="icon-button ${item.favorite ? 'favorite' : ''}" type="button" data-action="favorite" data-id="${Number(item.id)}" title="${item.favorite ? '取消收藏' : '收藏'}"><i class="fa-${item.favorite ? 'solid' : 'regular'} fa-star"></i></button><a class="icon-button" href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener" title="打开课件"><i class="fa-solid fa-arrow-up-right-from-square"></i></a><button class="icon-button" type="button" data-action="copy" data-url="${esc(safeUrl(item.url))}" title="复制链接"><i class="fa-solid fa-link"></i></button></div>
  </article>`;
}

function renderRecent() {
  const container = $('recentCourseware');
  if (!state.loggedIn) {
    container.innerHTML = emptyState('登录后显示最近课件', '你仍可以先上传和填写题目，点击生成时再登录。', '先制作一份课件', 'generator');
    return;
  }
  if (!state.items.length) {
    container.innerHTML = emptyState('还没有生成记录', '从一道正在讲的题开始，第一份课件会自动保存到这里。', '上传题目', 'generator');
    return;
  }
  container.innerHTML = state.items.slice(0, 4).map(coursewareRow).join('');
}

function populateTypeFilter() {
  const select = $('libraryType');
  const current = select.value;
  const types = [...new Set(state.items.map(item => item.type).filter(Boolean))];
  select.innerHTML = '<option value="">全部题型</option>' + types.map(type => `<option value="${esc(type)}">${esc(type)}</option>`).join('');
  if (types.includes(current)) select.value = current;
}

function filterLibrary() {
  const query = $('librarySearch').value.trim().toLowerCase();
  const type = $('libraryType').value;
  const favoriteOnly = $('favoriteOnly').checked;
  return state.items.filter(item => {
    const haystack = [item.title, item.problem, item.summary, ...(item.knowledge_points || [])].join(' ').toLowerCase();
    return (!query || haystack.includes(query)) && (!type || item.type === type) && (!favoriteOnly || item.favorite);
  });
}

function libraryCard(item) {
  const tags = (item.knowledge_points || []).map(tag => `<span class="tag">${esc(tag)}</span>`).join('') || '<span class="tag">待整理知识点</span>';
  return `<article class="library-card" data-id="${Number(item.id)}"><div class="library-card-head"><span class="type-chip">${esc(item.type || '数学')}</span><button class="favorite-button ${item.favorite ? 'active' : ''}" type="button" data-action="favorite" data-id="${Number(item.id)}" aria-label="${item.favorite ? '取消收藏' : '收藏课件'}"><i class="fa-${item.favorite ? 'solid' : 'regular'} fa-star"></i></button></div><h3>${esc(item.title || '数学互动课件')}</h3><p>${esc(item.summary || item.problem || '')}</p><div class="tag-list">${tags}</div><div class="library-card-foot"><span>${esc(item.at || '')}</span><div class="library-actions"><a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener" title="打开"><i class="fa-solid fa-play"></i></a><button type="button" data-action="copy" data-url="${esc(safeUrl(item.url))}" title="复制链接"><i class="fa-solid fa-link"></i></button><button type="button" data-action="edit" data-id="${Number(item.id)}" title="编辑信息"><i class="fa-solid fa-pen"></i></button><button type="button" data-action="delete" data-id="${Number(item.id)}" title="删除"><i class="fa-regular fa-trash-can"></i></button></div></div></article>`;
}

function renderLibrary() {
  const container = $('libraryList');
  if (!state.loggedIn) {
    container.innerHTML = emptyState('登录后管理个人课件', '生成前不需要登录；只有查看个人记录、收藏和整理时需要账号。', '登录查看', 'login');
    return;
  }
  const items = filterLibrary();
  if (!state.items.length) {
    container.innerHTML = emptyState('题库还是空的', '生成第一份课件后，它会自动出现在这里。', '新建课件', 'generator');
    return;
  }
  if (!items.length) {
    container.innerHTML = emptyState('没有匹配的课件', '换一个关键词或取消筛选条件试试。', '清除筛选', 'clear-filters');
    return;
  }
  container.innerHTML = items.map(libraryCard).join('');
}

function renderKnowledge() {
  const container = $('knowledgeOverview');
  if (!state.loggedIn) {
    container.innerHTML = emptyState('登录后形成个人知识库', '给课件添加知识点标签，系统会按真实记录自动聚合。', '登录查看', 'login');
    return;
  }
  const counts = new Map();
  state.items.forEach(item => {
    const topics = (item.knowledge_points && item.knowledge_points.length) ? item.knowledge_points : [item.type || '未分类'];
    topics.forEach(topic => counts.set(topic, (counts.get(topic) || 0) + 1));
  });
  const topics = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!topics.length) {
    container.innerHTML = emptyState('还没有知识点记录', '生成课件并添加标签后，这里会显示真实的知识点分布。', '开始生成', 'generator');
    return;
  }
  container.innerHTML = topics.slice(0, 12).map(([topic, count]) => `<button class="knowledge-topic" type="button" data-action="topic" data-topic="${esc(topic)}"><span><strong>${esc(topic)}</strong><small>点击查看相关课件</small></span><b>${count}</b></button>`).join('');
}

async function updateCourseware(id, patch) {
  const response = await fetch(API + '/history/' + Number(id), {
    method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '保存失败');
  const index = state.items.findIndex(item => Number(item.id) === Number(id));
  if (index >= 0 && data.item) state.items[index] = data.item;
  renderAllData();
  return data.item;
}

async function toggleFavorite(id) {
  const item = state.items.find(record => Number(record.id) === Number(id));
  if (!item) return;
  try {
    await updateCourseware(id, { favorite: !item.favorite });
    toast(item.favorite ? '已收藏课件' : '已取消收藏');
  } catch (error) { toast(error.message); }
}

function openMeta(id) {
  const item = state.items.find(record => Number(record.id) === Number(id));
  if (!item) return toast('课件记录正在同步，请稍后再试');
  state.metaId = Number(id);
  $('metaName').value = item.title || '';
  $('metaTags').value = (item.knowledge_points || []).join('、');
  showError('metaError', '');
  show($('metaOverlay'), true);
  setTimeout(() => $('metaName').focus(), 30);
}

function closeMeta() {
  show($('metaOverlay'), false);
  state.metaId = null;
}

async function saveCoursewareMeta() {
  if (!state.metaId) return;
  const button = $('saveMetaButton');
  button.disabled = true;
  try {
    await updateCourseware(state.metaId, {
      title: $('metaName').value,
      knowledge_points: $('metaTags').value.split(/[，,、]/)
    });
    closeMeta();
    toast('课件信息已保存');
  } catch (error) { showError('metaError', error.message); }
  finally { button.disabled = false; }
}

async function deleteCourseware(id) {
  const item = state.items.find(record => Number(record.id) === Number(id));
  if (!item || !confirm(`确定删除“${item.title}”吗？删除后不会再出现在课件库中。`)) return;
  try {
    const response = await fetch(API + '/history/' + Number(id), { method: 'DELETE', credentials: 'include' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '删除失败');
    state.items = state.items.filter(record => Number(record.id) !== Number(id));
    renderAllData();
    toast('课件已删除');
  } catch (error) { toast(error.message); }
}

function openAuth(tab) {
  switchAuth(tab || 'login');
  show($('authOverlay'), true);
  setTimeout(() => $(tab === 'register' ? 'regName' : 'loginUser').focus(), 30);
}

function closeAuth() { show($('authOverlay'), false); }

function switchAuth(tab) {
  const register = tab === 'register';
  $('loginTab').classList.toggle('active', !register);
  $('registerTab').classList.toggle('active', register);
  show($('loginForm'), !register);
  show($('registerForm'), register);
  $('mathAuthTitle').textContent = register ? '注册师行' : '登录师行';
  showError('authError', '');
}

async function login() {
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  if (!username || !password) return showError('authError', '请输入邮箱（或旧用户名）和密码');
  $('btnLogin').disabled = true;
  try {
    const response = await fetch('/api/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '登录失败');
    await refreshMe();
  } catch (error) { showError('authError', error.message || '网络错误，请重试'); }
  finally { $('btnLogin').disabled = false; }
}

async function sendRegisterCode() {
  const email = $('regEmail').value.trim();
  if (!email) return showError('authError', '请先填写邮箱');
  const button = $('sendCodeBtn');
  button.disabled = true;
  button.textContent = '发送中…';
  try {
    const response = await fetch('/api/register/send-code', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const data = await response.json();
    if (!response.ok) {
      ShixingRegistrationEmail.showFailure({ data, input:$('regEmail'), message:$('authError') });
      throw Object.assign(new Error(data.error || '验证码发送失败'), { alreadyShown:true });
    }
    showError('authError', data.message || '验证码已发送，请查看邮箱', true);
    let seconds = 60;
    clearInterval(codeTimer);
    codeTimer = setInterval(() => {
      seconds -= 1;
      button.textContent = seconds > 0 ? `${seconds} 秒后重发` : '获取验证码';
      button.disabled = seconds > 0;
      if (seconds <= 0) clearInterval(codeTimer);
    }, 1000);
  } catch (error) {
    button.disabled = false;
    button.textContent = '获取验证码';
    if (!error.alreadyShown) showError('authError', error.message || '网络错误，请重试');
  }
}

async function register() {
  const displayName = $('regName').value.trim();
  const email = $('regEmail').value.trim();
  const code = $('regCode').value.trim();
  const password = $('regPass').value;
  if (!displayName || !email || !code || !password) return showError('authError', '请填写称呼、邮箱、验证码和密码');
  $('btnRegister').disabled = true;
  try {
    const response = await fetch('/api/register', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code, password, display_name: displayName }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '注册失败');
    await refreshMe();
  } catch (error) { showError('authError', error.message || '网络错误，请重试'); }
  finally { $('btnRegister').disabled = false; }
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'include' }); } catch (_) {}
  state.items = [];
  state.currentGenerationId = null;
  setAccount(false, '', null);
  renderAllData();
  navigate('dashboard');
}

function loadImage(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = event => {
    if (cropper) { cropper.destroy(); cropper = null; }
    if (state.lastRecognizedText && $('problemText').value.trim() === state.lastRecognizedText) $('problemText').value = '';
    state.lastRecognizedText = '';
    state.ocrReviewed = false;
    show($('ocrReview'), false);
    $('generateButtonText').textContent = `识别题目并生成（消耗 ${POINT_COST} 积分）`;
    $('cropImg').src = event.target.result;
    $('dropZone').style.display = 'none';
    $('cropWrap').classList.add('show');
    cropper = new Cropper($('cropImg'), { viewMode: 1, autoCropArea: 1, dragMode: 'crop', background: false, responsive: true, checkOrientation: true });
    navigate('generator');
  };
  reader.readAsDataURL(file);
}

function getCroppedImage() {
  if (!cropper) return null;
  const canvas = cropper.getCroppedCanvas({ maxWidth: 1600, maxHeight: 1600, imageSmoothingQuality: 'high' });
  return canvas ? canvas.toDataURL('image/jpeg', 0.9) : null;
}

function setGenerationStage(index) {
  const stages = ['stageOcr', 'stageSolve', 'stageVerify', 'stageBuild'];
  stages.forEach((id, stageIndex) => {
    $(id).classList.toggle('done', stageIndex < index);
    $(id).classList.toggle('active', stageIndex === index);
  });
}

function showLoading(mode) {
  $('resultEmpty').style.display = 'none';
  $('resultContent').classList.remove('show');
  $('loading').classList.add('show');
  setGenerationStage(mode === 'ocr' ? 0 : 1);
  $('loadingText').textContent = mode === 'ocr' ? '正在识别题目' : 'AI 正在制作互动课件';
  $('genProgress').textContent = mode === 'ocr' ? '识别完成后请先核对题目文字' : '通常需要 1—3 分钟，请不要关闭页面';
}

function hideLoading(showEmpty) {
  $('loading').classList.remove('show');
  if (showEmpty) $('resultEmpty').style.display = 'flex';
  clearInterval(generationTimer);
  generationTimer = null;
}

function startGenerationProgress() {
  const started = Date.now();
  showLoading('generate');
  clearInterval(generationTimer);
  const update = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    const stage = seconds < 58 ? 1 : seconds < 112 ? 2 : 3;
    setGenerationStage(stage);
    const labels = ['识别题目', '深度解答', '独立验算', '制作课件'];
    $('loadingText').textContent = labels[stage];
    $('genProgress').textContent = `已用时 ${seconds} 秒 · 正在完成第 ${stage + 1} 个阶段`;
  };
  update();
  generationTimer = setInterval(update, 1000);
}

async function recognizeProblem(image) {
  showLoading('ocr');
  $('btnGen').disabled = true;
  showError('errorMsg', '');
  try {
    const response = await fetch(API + '/ocr', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
        const data = await response.json();
        if (response.status === 401) {
          hideLoading(true);
          state.pendingGenerate = true;
          openAuth('login');
          return false;
    }
    if (!response.ok) throw new Error(data.error || '题目识别失败');
    $('problemText').value = String(data.problem || '').trim();
    state.lastRecognizedText = $('problemText').value;
    state.ocrReviewed = true;
    show($('ocrReview'), true);
    $('ocrReviewHint').textContent = '这是图片识别结果，可以直接修改';
    $('generateButtonText').textContent = `确认题目并生成（消耗 ${POINT_COST} 积分）`;
    hideLoading(true);
    $('problemText').focus();
    toast('题目已识别，请核对后再次点击生成');
    return true;
  } catch (error) {
    hideLoading(true);
    showError('errorMsg', error.message || '题目识别失败');
    return false;
  } finally { $('btnGen').disabled = false; }
}

function teachingPreferences() {
  return {
    grade: $('gradeSelect').value,
    detail: $('detailSelect').value,
    dynamic: $('dynamicOption').checked,
    questions: $('questionsOption').checked
  };
}

async function generate(force) {
  if (force && !confirm(`重新生成会再次消耗 ${POINT_COST} 积分，确定换一版吗？`)) return;
  showError('errorMsg', '');
  const problem = $('problemText').value.trim();
  const image = getCroppedImage();
  if (!problem && !image) return showError('errorMsg', '请上传题目图片或粘贴题目文字');
  if (!state.loggedIn) {
    state.pendingGenerate = true;
    openAuth('login');
    return;
  }
  if (!problem && image) {
    await recognizeProblem(image);
    return;
  }

  $('btnGen').disabled = true;
  startGenerationProgress();
  try {
    const response = await fetch(API + '/generate', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem, force: !!force, preferences: teachingPreferences() })
        });
        if (response.status === 401) {
          hideLoading(true);
          state.pendingGenerate = true;
          await refreshMe();
          openAuth('login');
          return;
        }
        if (response.status === 402) {
          hideLoading(true);
          navigate('account');
          await loadPackages();
          toast('积分不足，请先充值');
      return;
    }
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error('生成时间过长，请稍后重试或换一道题'); }
    if (!response.ok || data.error) throw new Error(data.error || '生成失败');
    state.currentGenerationId = Number(data.generation_id) || null;
    state.currentUrl = data.url || '';
    if (Number.isFinite(Number(data.balance))) setAccount(true, state.username, Number(data.balance));
    showResult(data, problem);
    await loadHistory();
    if (data.referral_reward && Number(data.referral_reward.invitee_reward_points) > 0) toast(`邀请奖励已到账 ${data.referral_reward.invitee_reward_points} 积分`);
  } catch (error) {
    hideLoading(true);
    showError('errorMsg', `${error.message || '生成失败'}。请稍后重试。`);
  } finally {
    clearInterval(generationTimer);
    generationTimer = null;
    $('btnGen').disabled = false;
  }
}

function renderInto(element, text) {
  element.textContent = text || '';
  element.innerHTML = element.innerHTML
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*[-—]{3,}\s*$/gm, '<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">');
  if (typeof renderMathInElement === 'function') {
    try {
      renderMathInElement(element, { delimiters: [
        { left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }
      ], throwOnError: false });
    } catch (_) {}
  }
}

function showResult(data, problem) {
  hideLoading(false);
  $('resultContent').classList.add('show');
  $('previewOpen').href = safeUrl(data.url);
  $('linkUrl').href = safeUrl(data.url);
  $('coursewareFrame').src = safeUrl(data.url);
  $('cachedNote').classList.toggle('show', !!data.cached);
  $('resultTitle').textContent = problem.replace(/\s+/g, ' ').slice(0, 42) || '互动数学课件';
  renderInto($('solutionContent'), data.solution || '');
  show($('solutionCard'), false);
}

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); toast('链接已复制'); }
  catch (_) { toast('复制失败，请手动复制'); }
  area.remove();
}

function copyLink(url) {
  if (!url || url === '#') return;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(() => toast('链接已复制')).catch(() => fallbackCopy(url));
  else fallbackCopy(url);
}

async function loadPackages() {
  const container = $('pkgList');
  if (!state.loggedIn) {
    container.innerHTML = '<div class="inline-empty">登录后查看充值套餐。首充赠积分，全平台通用。</div>';
    return;
  }
  container.innerHTML = '<div class="inline-empty">正在加载充值套餐…</div>';
  showError('rechargeError', '');
  try {
    const response = await fetch(API + '/pay/packages', { credentials: 'include' });
    const data = await response.json();
    if (!data.enabled || !Array.isArray(data.packages) || !data.packages.length) {
      container.innerHTML = '<div class="inline-empty">充值暂未开放，请稍后再试。</div>';
      return;
    }
    state.pointCost = Number(data.point_cost) || POINT_COST;
    container.innerHTML = data.packages.map(pkg => {
      const bonus = Number(pkg.first_bonus) > 0 ? `首充赠 ${pkg.first_bonus}，到账 ${pkg.first_award} 积分` : '师行五个平台通用';
      return `<button class="package-button" type="button" data-package="${esc(pkg.key)}"><strong>${esc(pkg.label)}</strong><small>${esc(bonus)}</small><b>¥${esc(pkg.amount)}</b></button>`;
    }).join('');
  } catch (_) { container.innerHTML = '<div class="inline-empty">套餐加载失败，请稍后重试。</div>'; }
}

async function buy(packageKey) {
  if (!state.loggedIn) return openAuth('login');
  $$('.package-button').forEach(button => { button.disabled = true; });
  try {
    const response = await fetch(API + '/pay/create', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ package_key: packageKey }) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || '创建订单失败');
    window.open(data.pay_url, '_blank', 'noopener');
    toast('已打开微信支付，支付后本页会自动更新');
    pollPay(data.out_trade_no);
  } catch (error) { showError('rechargeError', error.message || '下单失败'); }
  finally { $$('.package-button').forEach(button => { button.disabled = false; }); }
}

function pollPay(orderNumber) {
  let attempts = 0;
  clearInterval(payPoll);
  payPoll = setInterval(async () => {
    if (++attempts > 80) return clearInterval(payPoll);
    try {
      const response = await fetch(API + '/pay/status?out_trade_no=' + encodeURIComponent(orderNumber), { credentials: 'include' });
      const data = await response.json();
      if (Number.isFinite(Number(data.balance))) setAccount(true, state.username, Number(data.balance));
      if (data.status === 'paid') {
        clearInterval(payPoll);
        toast('充值成功，师行积分已到账');
        loadPackages();
      }
    } catch (_) {}
  }, 3000);
}

function handleAction(action, target) {
  if (action === 'generator') return navigate('generator');
  if (action === 'login') return openAuth('login');
  if (action === 'register') return openAuth('register');
  if (action === 'logout') return logout();
  if (action === 'clear-filters') {
    $('librarySearch').value = ''; $('libraryType').value = ''; $('favoriteOnly').checked = false; renderLibrary(); return;
  }
  if (action === 'favorite') return toggleFavorite(target.dataset.id);
  if (action === 'edit') return openMeta(target.dataset.id);
  if (action === 'delete') return deleteCourseware(target.dataset.id);
  if (action === 'copy') return copyLink(target.dataset.url);
  if (action === 'topic') {
    navigate('library'); $('librarySearch').value = target.dataset.topic || ''; renderLibrary();
  }
}

function bindEvents() {
  document.addEventListener('click', event => {
    const routeControl = event.target.closest('[data-route]');
    if (routeControl) { event.preventDefault(); navigate(routeControl.dataset.route); return; }
    const goControl = event.target.closest('[data-go]');
    if (goControl) { event.preventDefault(); navigate(goControl.dataset.go); return; }
    const actionControl = event.target.closest('[data-action]');
    if (actionControl) { event.preventDefault(); handleAction(actionControl.dataset.action, actionControl); return; }
    const packageControl = event.target.closest('[data-package]');
    if (packageControl) { event.preventDefault(); buy(packageControl.dataset.package); }
  });
  $$('[data-paste-problem]').forEach(button => button.addEventListener('click', () => { navigate('generator'); setTimeout(() => $('problemText').focus(), 100); }));
  window.addEventListener('hashchange', () => applyRoute(location.hash.slice(1)));
  $('topAuthButton').addEventListener('click', () => state.loggedIn ? navigate('account') : openAuth('login'));
  $('dropZone').addEventListener('click', () => $('fileInput').click());
  $('dropZone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('fileInput').click(); } });
  $('reselect').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => { const file = event.target.files[0]; if (file) loadImage(file); event.target.value = ''; });
  document.addEventListener('paste', event => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (const item of items) if (item.type.startsWith('image/')) { loadImage(item.getAsFile()); break; }
  });
  $('problemText').addEventListener('input', () => {
    if ($('problemText').value.trim() !== state.lastRecognizedText) show($('ocrReview'), false);
    $('generateButtonText').textContent = `生成课件（消耗 ${POINT_COST} 积分）`;
  });
  $('btnGen').addEventListener('click', () => generate(false));
  $('regenerateButton').addEventListener('click', () => generate(true));
  $('copyResultLink').addEventListener('click', () => copyLink(state.currentUrl));
  $('editResultMeta').addEventListener('click', () => openMeta(state.currentGenerationId));
  $('showSolutionButton').addEventListener('click', () => show($('solutionCard'), true));
  $('hideSolutionButton').addEventListener('click', () => show($('solutionCard'), false));
  ['librarySearch', 'libraryType', 'favoriteOnly'].forEach(id => $(id).addEventListener(id === 'librarySearch' ? 'input' : 'change', renderLibrary));
  $('closeAuthButton').addEventListener('click', closeAuth);
  $('loginTab').addEventListener('click', () => switchAuth('login'));
  $('registerTab').addEventListener('click', () => switchAuth('register'));
  $('btnLogin').addEventListener('click', login);
  $('sendCodeBtn').addEventListener('click', sendRegisterCode);
  $('btnRegister').addEventListener('click', register);
  $('closeMetaButton').addEventListener('click', closeMeta);
  $('saveMetaButton').addEventListener('click', saveCoursewareMeta);
  $('authOverlay').addEventListener('click', event => { if (event.target === $('authOverlay')) closeAuth(); });
  $('metaOverlay').addEventListener('click', event => { if (event.target === $('metaOverlay')) closeMeta(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeAuth(); closeMeta(); } });
}

function loadReferralContext() {
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref) {
    location.replace('https://shixing.yingyuzuowen.asia/invite/' + encodeURIComponent(ref.trim().toUpperCase()) + '?source=edulab');
    return;
  }
  fetch('/api/referral/context', { credentials: 'include' }).then(response => response.json()).then(data => {
    if (!data.valid) return;
    const element = $('mathInviteContext');
    element.innerHTML = `<strong>${esc(data.inviter_name)} 老师邀请你体验师行</strong><br>注册和首次有效使用后，双方都可获得师行积分。`;
    element.classList.add('show');
  }).catch(() => {});
}

function loadLabDraft() {
  if (new URLSearchParams(location.search).get('from') !== 'lab') return;
  try {
    const draft = JSON.parse(localStorage.getItem('edulab_lab_draft') || '{}');
    const functions = Array.isArray(draft.functions) ? draft.functions.filter(item => item && item.visible !== false && item.expression) : [];
    if (!functions.length) return;
    const lines = functions.map((item, index) => `f${index + 1}(x) = ${String(item.expression).trim()}`);
    $('problemText').value = [
      '请制作一份函数探究互动课件，帮助教师在课堂上演示函数关系和参数变化。',
      `当前参数：a = ${Number.isFinite(Number(draft.a)) ? Number(draft.a) : 1}`,
      '需要展示的函数：',
      ...lines,
      '课堂流程：先观察图像并提出问题，再拖动参数寻找规律，最后归纳结论并设计一道迁移问题。'
    ].join('\n');
    $('detailSelect').value = '探究';
    $('dynamicOption').checked = true;
    $('questionsOption').checked = true;
    toast('已带入互动实验室内容，请核对后生成课件');
  } catch (_) {
    toast('实验内容没有成功带入，请返回实验室重新生成');
  }
}

function initialRoute() {
  const params = new URLSearchParams(location.search);
  if (params.get('history') === '1') return 'library';
  if (params.get('paid')) return 'account';
  if (params.get('from') === 'lab') return 'generator';
  return ROUTES[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadReferralContext();
  applyRoute(initialRoute());
  loadLabDraft();
  refreshMe();
});
