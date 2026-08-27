(function () {
  'use strict';

  const core = window.MathLabCore;
  if (!core) return;

  const $ = id => document.getElementById(id);
  const colors = ['#3978d4', '#e45c4f', '#143f6c', '#a57427', '#6f8d46', '#9b5ca4'];
  const defaults = [
    { expression: 'x^2', color: colors[0], visible: true },
    { expression: '2*a*x^2-1', color: colors[1], visible: true },
    { expression: 'sin(x)', color: colors[2], visible: true }
  ];
  const templates = {
    quadratic: [
      { expression: 'x^2', color: colors[0], visible: true },
      { expression: '2*a*x^2-1', color: colors[1], visible: true },
      { expression: '-x^2+4', color: colors[2], visible: true }
    ],
    exponential: [
      { expression: 'exp(x)', color: colors[0], visible: true },
      { expression: 'exp(a*x)', color: colors[1], visible: true },
      { expression: 'exp(-x)', color: colors[2], visible: true }
    ],
    trigonometric: [
      { expression: 'sin(x)', color: colors[0], visible: true },
      { expression: 'cos(x)', color: colors[1], visible: true },
      { expression: 'sin(a*x)', color: colors[2], visible: true }
    ]
  };
  const sampleExperiments = [
    { name: '二次函数与参数 a 的影响', template: 'quadratic' },
    { name: '三角函数的平移与伸缩', template: 'trigonometric' },
    { name: '指数函数图像比较', template: 'exponential' },
    { name: '函数交点与零点观察', template: 'quadratic' }
  ];

  const state = {
    functions: defaults.map(item => ({ ...item })),
    a: 1,
    activeStep: 0,
    grid: true,
    view: { xMin: -10, xMax: 10, yMin: -5, yMax: 9 }
  };

  const canvas = $('mathCanvas');
  const graphCard = $('graphCard');
  const cursorReadout = $('cursorReadout');
  let drawQueued = false;
  let toastTimer = null;
  let drag = null;

  function toast(message) {
    const element = $('toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 1800);
  }

  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(draw);
  }

  function renderFunctions() {
    const list = $('functionList');
    list.innerHTML = '';
    state.functions.forEach((fn, index) => {
      const row = document.createElement('div');
      row.className = 'function-row';

      const top = document.createElement('div');
      top.className = 'function-top';
      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = fn.color;
      const name = document.createElement('span');
      name.className = 'function-name';
      name.textContent = 'f' + (index + 1) + '(x)';
      const actions = document.createElement('span');
      actions.className = 'row-actions';

      const visibility = document.createElement('button');
      visibility.type = 'button';
      visibility.className = 'icon-action';
      visibility.setAttribute('aria-label', fn.visible ? '隐藏函数' : '显示函数');
      visibility.setAttribute('aria-pressed', fn.visible ? 'true' : 'false');
      visibility.innerHTML = '<i class="fa-regular ' + (fn.visible ? 'fa-eye' : 'fa-eye-slash') + '" aria-hidden="true"></i>';
      visibility.addEventListener('click', () => {
        fn.visible = !fn.visible;
        renderFunctions();
        queueDraw();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-action';
      remove.setAttribute('aria-label', '删除函数');
      remove.innerHTML = '<i class="fa-regular fa-trash-can" aria-hidden="true"></i>';
      remove.addEventListener('click', () => {
        state.functions.splice(index, 1);
        renderFunctions();
        queueDraw();
      });
      actions.append(visibility, remove);
      top.append(dot, name, actions);

      const input = document.createElement('input');
      input.className = 'function-expression';
      input.value = fn.expression;
      input.setAttribute('aria-label', '函数 ' + (index + 1) + ' 表达式');
      const error = document.createElement('div');
      error.className = 'function-error';
      input.addEventListener('input', () => {
        fn.expression = input.value.trim();
        try {
          core.compileExpression(fn.expression);
          error.textContent = '';
        } catch (problem) {
          error.textContent = problem.message;
        }
        queueDraw();
      });

      row.append(top, input, error);
      list.appendChild(row);
    });
    $('functionCount').textContent = state.functions.length + ' / 6';
    $('addFunction').disabled = state.functions.length >= 6;
  }

  function setFunctions(functions) {
    state.functions = functions.map((item, index) => ({
      expression: item.expression,
      color: item.color || colors[index % colors.length],
      visible: item.visible !== false
    })).slice(0, 6);
    renderFunctions();
    queueDraw();
  }

  function resetView() {
    state.view = { xMin: -10, xMax: 10, yMin: -5, yMax: 9 };
    queueDraw();
  }

  function zoom(factor, centerX, centerY) {
    const view = state.view;
    const cx = Number.isFinite(centerX) ? centerX : (view.xMin + view.xMax) / 2;
    const cy = Number.isFinite(centerY) ? centerY : (view.yMin + view.yMax) / 2;
    const halfX = (view.xMax - view.xMin) * factor / 2;
    const halfY = (view.yMax - view.yMin) * factor / 2;
    view.xMin = cx - halfX;
    view.xMax = cx + halfX;
    view.yMin = cy - halfY;
    view.yMax = cy + halfY;
    queueDraw();
  }

  function niceStep(span, targetLines) {
    const rough = span / targetLines;
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const unit = rough / power;
    if (unit <= 1) return power;
    if (unit <= 2) return 2 * power;
    if (unit <= 5) return 5 * power;
    return 10 * power;
  }

  function draw() {
    drawQueued = false;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width));
    const height = Math.max(300, Math.round(rect.height));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fffdf9';
    ctx.fillRect(0, 0, width, height);

    const view = state.view;
    const sx = x => (x - view.xMin) / (view.xMax - view.xMin) * width;
    const sy = y => height - (y - view.yMin) / (view.yMax - view.yMin) * height;
    const xStep = niceStep(view.xMax - view.xMin, Math.max(8, width / 72));
    const yStep = niceStep(view.yMax - view.yMin, Math.max(6, height / 64));

    if (state.grid) {
      ctx.strokeStyle = '#e8e0d4';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = Math.ceil(view.xMin / xStep) * xStep; x <= view.xMax; x += xStep) {
        ctx.moveTo(Math.round(sx(x)) + .5, 0);
        ctx.lineTo(Math.round(sx(x)) + .5, height);
      }
      for (let y = Math.ceil(view.yMin / yStep) * yStep; y <= view.yMax; y += yStep) {
        ctx.moveTo(0, Math.round(sy(y)) + .5);
        ctx.lineTo(width, Math.round(sy(y)) + .5);
      }
      ctx.stroke();
    }

    const axisX = sx(0);
    const axisY = sy(0);
    ctx.strokeStyle = '#594d3e';
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    if (axisX >= 0 && axisX <= width) { ctx.moveTo(axisX, 0); ctx.lineTo(axisX, height); }
    if (axisY >= 0 && axisY <= height) { ctx.moveTo(0, axisY); ctx.lineTo(width, axisY); }
    ctx.stroke();

    ctx.fillStyle = '#625747';
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    ctx.textAlign = 'center';
    for (let x = Math.ceil(view.xMin / xStep) * xStep; x <= view.xMax; x += xStep) {
      if (Math.abs(x) < xStep / 10 || axisY < 10 || axisY > height - 8) continue;
      ctx.fillText(core.formatNumber(x), sx(x), Math.min(height - 4, Math.max(13, axisY + 15)));
    }
    ctx.textAlign = 'right';
    for (let y = Math.ceil(view.yMin / yStep) * yStep; y <= view.yMax; y += yStep) {
      if (Math.abs(y) < yStep / 10 || axisX < 20 || axisX > width - 5) continue;
      ctx.fillText(core.formatNumber(y), Math.max(18, axisX - 7), sy(y) + 4);
    }
    ctx.font = 'italic 16px Georgia,serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#2d261d';
    if (axisY >= 0 && axisY <= height) ctx.fillText('x', width - 17, Math.max(18, axisY - 8));
    if (axisX >= 0 && axisX <= width) ctx.fillText('y', axisX + 9, 18);

    state.functions.forEach((fn, index) => {
      if (!fn.visible || !fn.expression) return;
      let points;
      try {
        points = core.sampleExpression(fn.expression, state.a, view.xMin, view.xMax, Math.max(500, Math.round(width * 1.3)));
      } catch (_) {
        return;
      }
      ctx.strokeStyle = fn.color;
      ctx.lineWidth = 2.3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let previous = null;
      let lastVisible = null;
      const roots = [];
      points.forEach(point => {
        if (point.y === null) { previous = null; return; }
        const px = sx(point.x);
        const py = sy(point.y);
        if (py < -height * 2 || py > height * 3) { previous = null; return; }
        if (!previous || Math.abs(py - previous.py) > height * .7) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        if (previous && previous.y * point.y < 0 && roots.length < 4) roots.push((previous.x + point.x) / 2);
        previous = { ...point, py };
        if (px > width * .63 && py > 28 && py < height - 25) lastVisible = { px, py };
      });
      ctx.stroke();

      ctx.fillStyle = fn.color;
      roots.forEach(root => {
        const px = sx(root), py = sy(0);
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
      });
      if (lastVisible) {
        ctx.font = 'italic 13px Georgia,serif';
        ctx.textAlign = 'left';
        ctx.fillText('f' + (index + 1) + '(x)', Math.min(width - 46, lastVisible.px + 7), lastVisible.py - 7);
      }
    });
  }

  function pointerToMath(event) {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const view = state.view;
    return {
      x: view.xMin + px / rect.width * (view.xMax - view.xMin),
      y: view.yMax - py / rect.height * (view.yMax - view.yMin),
      px,
      py
    };
  }

  function serializeState() {
    return {
      functions: state.functions.map(fn => ({ expression: fn.expression, color: fn.color, visible: fn.visible })),
      a: state.a,
      view: state.view
    };
  }

  function applyState(saved) {
    if (!saved || !Array.isArray(saved.functions) || !saved.functions.length) return;
    setFunctions(saved.functions);
    state.a = Math.max(-3, Math.min(3, Number(saved.a) || 0));
    $('parameterA').value = state.a;
    $('parameterValue').value = state.a.toFixed(1);
    if (saved.view && ['xMin', 'xMax', 'yMin', 'yMax'].every(key => Number.isFinite(Number(saved.view[key])))) {
      state.view = Object.fromEntries(Object.entries(saved.view).map(([key, value]) => [key, Number(value)]));
    }
    queueDraw();
  }

  function closeGuide() {
    $('guideOverlay').hidden = true;
  }

  function openGuide() {
    $('guideOverlay').hidden = false;
    try { localStorage.setItem('edulab_lab_guide_seen_v2', '1'); } catch (_) {}
    setTimeout(() => $('guideClose').focus(), 0);
  }

  function startGuidedExample() {
    setFunctions(templates.quadratic);
    state.a = 1;
    $('parameterA').value = 1;
    $('parameterValue').value = '1.0';
    resetView();
    closeGuide();
    const parameterBar = document.querySelector('.parameter-bar');
    parameterBar.classList.remove('guide-pulse');
    requestAnimationFrame(() => parameterBar.classList.add('guide-pulse'));
    setTimeout(() => parameterBar.classList.remove('guide-pulse'), 2600);
    parameterBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('示例已载入：拖动参数 a，观察红色曲线变化');
  }

  function savedExperiments() {
    try { return JSON.parse(localStorage.getItem('edulab_lab_experiments') || '[]'); }
    catch (_) { return []; }
  }

  function renderRecent() {
    const list = $('recentList');
    const saved = savedExperiments();
    list.innerHTML = '';
    if (!saved.length) {
      sampleExperiments.forEach(item => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'recent-card';
        card.innerHTML = '<strong>' + item.name + '</strong><small>示例实验 · 点击载入</small>';
        card.addEventListener('click', () => {
          setFunctions(templates[item.template]);
          toast('已载入“' + item.name + '”');
        });
        list.appendChild(card);
      });
      return;
    }
    saved.slice(0, 4).forEach(item => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'recent-card';
      const title = document.createElement('strong');
      title.textContent = item.name;
      const meta = document.createElement('small');
      meta.textContent = item.at + ' · 点击继续编辑';
      card.append(title, meta);
      card.addEventListener('click', () => applyState(item.state));
      list.appendChild(card);
    });
  }

  function saveExperiment() {
    const experiments = savedExperiments();
    const first = state.functions.find(fn => fn.expression);
    const entry = {
      name: (first ? first.expression : '新实验') + ' 的课堂探究',
      at: new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      state: serializeState()
    };
    experiments.unshift(entry);
    localStorage.setItem('edulab_lab_experiments', JSON.stringify(experiments.slice(0, 12)));
    renderRecent();
    toast('实验已保存在本机');
  }

  function encodeShare(data) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeShare(text) {
    const value = text.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(value))));
  }

  function bindEvents() {
    $('addFunction').addEventListener('click', () => {
      if (state.functions.length >= 6) return;
      state.functions.push({ expression: state.functions.length % 2 ? 'cos(x)' : 'a*x', color: colors[state.functions.length], visible: true });
      renderFunctions(); queueDraw();
    });
    $('clearBtn').addEventListener('click', () => { setFunctions([]); toast('画布已清空'); });
    document.querySelectorAll('[data-template]').forEach(button => button.addEventListener('click', () => {
      setFunctions(templates[button.dataset.template]);
      toast('已载入函数模板');
    }));

    const updateParameter = value => {
      state.a = Math.max(-3, Math.min(3, Number(value) || 0));
      $('parameterA').value = state.a;
      $('parameterValue').value = state.a.toFixed(1);
      queueDraw();
    };
    $('parameterA').addEventListener('input', event => updateParameter(event.target.value));
    $('parameterValue').addEventListener('input', event => updateParameter(event.target.value));
    $('resetParameter').addEventListener('click', () => updateParameter(1));
    $('zoomIn').addEventListener('click', () => zoom(.78));
    $('zoomOut').addEventListener('click', () => zoom(1.28));
    $('fitGraph').addEventListener('click', resetView);
    $('undoView').addEventListener('click', resetView);
    $('coordinateBtn').addEventListener('click', () => {
      state.grid = !state.grid;
      $('coordinateBtn').classList.toggle('active', state.grid);
      toast(state.grid ? '已显示网格' : '已隐藏网格');
      queueDraw();
    });

    canvas.addEventListener('pointermove', event => {
      const point = pointerToMath(event);
      cursorReadout.textContent = 'x=' + core.formatNumber(point.x) + '　y=' + core.formatNumber(point.y);
      cursorReadout.style.left = point.px + 'px';
      cursorReadout.style.top = point.py + 'px';
      cursorReadout.style.display = 'block';
      if (!drag) return;
      const rect = canvas.getBoundingClientRect();
      const dx = (event.clientX - drag.clientX) / rect.width * (drag.view.xMax - drag.view.xMin);
      const dy = (event.clientY - drag.clientY) / rect.height * (drag.view.yMax - drag.view.yMin);
      state.view = {
        xMin: drag.view.xMin - dx, xMax: drag.view.xMax - dx,
        yMin: drag.view.yMin + dy, yMax: drag.view.yMax + dy
      };
      queueDraw();
    });
    canvas.addEventListener('pointerleave', () => { cursorReadout.style.display = 'none'; drag = null; });
    canvas.addEventListener('pointerdown', event => {
      drag = { clientX: event.clientX, clientY: event.clientY, view: { ...state.view } };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointerup', event => { drag = null; canvas.releasePointerCapture(event.pointerId); });
    canvas.addEventListener('wheel', event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const point = pointerToMath(event);
      const delta = Math.max(-80, Math.min(80, event.deltaY));
      zoom(Math.exp(delta * .0015), point.x, point.y);
    }, { passive: false });

    document.querySelectorAll('[data-step]').forEach(card => card.addEventListener('click', () => {
      state.activeStep = Number(card.dataset.step);
      document.querySelectorAll('[data-step]').forEach(item => item.classList.toggle('active', item === card));
    }));
    $('fullscreenBtn').addEventListener('click', () => {
      if (graphCard.requestFullscreen) graphCard.requestFullscreen();
      else toast('当前浏览器不支持全屏');
    });
    $('saveBtn').addEventListener('click', saveExperiment);
    $('shareBtn').addEventListener('click', async () => {
      const url = new URL(location.href);
      url.searchParams.set('state', encodeShare(serializeState()));
      try { await navigator.clipboard.writeText(url.toString()); toast('分享链接已复制'); }
      catch (_) { history.replaceState(null, '', url); toast('链接已更新，可从地址栏复制'); }
    });
    $('guideBtn').addEventListener('click', openGuide);
    $('quickStartButton').addEventListener('click', startGuidedExample);
    $('guideStart').addEventListener('click', startGuidedExample);
    $('guideClose').addEventListener('click', closeGuide);
    $('guideLater').addEventListener('click', closeGuide);
    $('guideOverlay').addEventListener('click', event => { if (event.target === $('guideOverlay')) closeGuide(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeGuide(); });
    $('allRecent').addEventListener('click', () => toast('目前保留最近 12 个本机实验'));
    $('generateLesson').addEventListener('click', () => {
      localStorage.setItem('edulab_lab_draft', JSON.stringify(serializeState()));
      location.href = 'pro.html?from=lab#generator';
    });
    window.addEventListener('resize', queueDraw);
    document.addEventListener('fullscreenchange', queueDraw);
  }

  function restoreSharedState() {
    const encoded = new URLSearchParams(location.search).get('state');
    if (!encoded) return;
    try { applyState(decodeShare(encoded)); toast('已载入分享的数学实验'); }
    catch (_) { toast('分享链接内容无效'); }
  }

  function loadAccount() {
    fetch('/edulab-api/me', { credentials: 'include' }).then(response => response.json()).then(data => {
      if (!data.logged_in) return;
      $('sideUser').textContent = data.username + '老师';
      $('sideAvatar').textContent = String(data.username || '师').slice(0, 1).toUpperCase();
      $('sidePoints').textContent = '师行积分 ' + data.balance;
    }).catch(() => {});
  }

  renderFunctions();
  renderRecent();
  bindEvents();
  restoreSharedState();
  loadAccount();
  try {
    if (!localStorage.getItem('edulab_lab_guide_seen_v2')) setTimeout(openGuide, 500);
  } catch (_) {}
  queueDraw();
})();
