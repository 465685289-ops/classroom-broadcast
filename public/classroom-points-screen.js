(function(root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClassroomPointsScreen = api;
})(typeof window !== 'undefined' ? window : null, function(root) {
  'use strict';

  var IDLE_TIMEOUT_MS = 60000;

  function createModeController(options) {
    options = options || {};
    var timeoutMs = Number(options.timeoutMs) || IDLE_TIMEOUT_MS;
    var setTimer = options.setTimer || setTimeout;
    var clearTimer = options.clearTimer || clearTimeout;
    var onMode = options.onMode || function() {};
    var onResume = options.onResume || function() {};
    var currentMode = 'idle';
    var timer = null;
    var suspended = false;

    function cancelTimer() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    }

    function armTimer() {
      cancelTimer();
      if (currentMode === 'idle' || suspended) return;
      timer = setTimer(function() {
        timer = null;
        currentMode = 'idle';
        onMode(currentMode);
      }, timeoutMs);
    }

    function enter(mode) {
      var next = ['idle', 'score', 'rank', 'ledger'].indexOf(mode) >= 0 ? mode : 'idle';
      currentMode = next;
      onMode(currentMode);
      armTimer();
    }

    function touch() {
      armTimer();
    }

    function suspendForBroadcast() {
      suspended = true;
      cancelTimer();
    }

    function resumeAfterBroadcast() {
      suspended = false;
      onResume(currentMode);
      armTimer();
    }

    function reset() {
      suspended = false;
      enter('idle');
    }

    return {
      enter: enter,
      touch: touch,
      mode: function() { return currentMode; },
      suspendForBroadcast: suspendForBroadcast,
      resumeAfterBroadcast: resumeAfterBroadcast,
      reset: reset
    };
  }

  if (!root || !root.document) {
    return { IDLE_TIMEOUT_MS: IDLE_TIMEOUT_MS, createModeController: createModeController };
  }

  var document = root.document;
  var classInfo = null;
  var bindCode = '';
  var screenToken = '';
  var classroomState = null;
  var queue = null;
  var selectedStudentIds = [];
  var batchMode = false;
  var loadingState = false;
  var flushing = false;
  var activeScope = 'term';
  var ledgerStudentFilter = '';
  var ledgerDirectionFilter = '';
  var activeScoreOscillator = null;
  var activeScoreGain = null;

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function requestJson(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (options.body) headers['Content-Type'] = 'application/json';
    if (screenToken) headers['X-Screen-Token'] = screenToken;
    return root.fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function(response) {
      return response.text().then(function(text) {
        var body = {};
        try { body = JSON.parse(text); } catch (error) { body = { error: text || '请求失败' }; }
        if (!response.ok) {
          var failure = new Error(body.error || '请求失败');
          failure.status = response.status;
          throw failure;
        }
        return body;
      });
    });
  }

  function renderMode(mode) {
    var idle = byId('screenIdle');
    var mapping = {
      score: byId('pointsScoreMode'),
      rank: byId('pointsRankMode'),
      ledger: byId('pointsLedgerMode')
    };
    if (idle) idle.style.display = mode === 'idle' ? 'flex' : 'none';
    Object.keys(mapping).forEach(function(name) {
      var element = mapping[name];
      if (!element) return;
      element.hidden = name !== mode;
      element.style.display = name === mode ? 'flex' : 'none';
    });
    if (mode === 'score') renderScoreMode();
    if (mode === 'rank') renderRanking();
    if (mode === 'ledger') renderLedger();
  }

  var modeController = createModeController({
    timeoutMs: IDLE_TIMEOUT_MS,
    onMode: renderMode,
    onResume: renderMode
  });

  function managementEnabled() {
    return !!(classroomState && classroomState.management && classroomState.management.enabled);
  }

  function updateIdleActions() {
    var actions = byId('pointsIdleActions');
    if (!actions) return;
    actions.hidden = !managementEnabled();
    actions.style.display = managementEnabled() ? 'flex' : 'none';
    var daily = byId('pointsDailyStat');
    if (daily) {
      var count = classroomState && Number(classroomState.today_entry_count) || 0;
      daily.textContent = '今日积分变动：' + count + ' 次';
    }
  }

  function rankingMap() {
    var map = {};
    (classroomState && classroomState.leaderboard || []).forEach(function(item) {
      map[item.student_id] = item;
    });
    return map;
  }

  function studentById(id) {
    return (classroomState && classroomState.students || []).find(function(student) { return student.id === id; }) || null;
  }

  function renderSeatGrid() {
    var grid = byId('pointsSeatGrid');
    if (!grid) return;
    var students = classroomState && classroomState.students || [];
    var scores = rankingMap();
    if (!students.length) {
      grid.innerHTML = '<div class="points-empty">还没有学生名单<br><small>请老师先在教师端添加学生并安排座位</small></div>';
      return;
    }
    var html = '';
    students.forEach(function(student) {
      var score = scores[student.id] ? scores[student.id].score : 0;
      var selected = selectedStudentIds.indexOf(student.id) >= 0;
      var style = '';
      if (student.seat_row && student.seat_col) {
        style = ' style="grid-row:' + Number(student.seat_row) + ';grid-column:' + Number(student.seat_col) + '"';
      }
      html += '<button type="button" class="points-student-card' + (selected ? ' selected' : '') + '" data-student-id="' + escapeHtml(student.id) + '"' + style + '>';
      html += '<span class="points-student-name">' + escapeHtml(student.name) + '</span>';
      html += '<span class="points-student-score">' + (score > 0 ? '+' : '') + score + '</span>';
      html += '</button>';
    });
    grid.innerHTML = html;
    grid.querySelectorAll('[data-student-id]').forEach(function(button) {
      button.addEventListener('click', function() { selectStudent(button.getAttribute('data-student-id')); });
    });
  }

  function renderRulePanel() {
    var panel = byId('pointsRulePanel');
    if (!panel) return;
    var names = selectedStudentIds.map(function(id) {
      var student = studentById(id);
      return student ? student.name : '';
    }).filter(Boolean);
    if (!names.length) {
      panel.innerHTML = '<div class="points-rule-placeholder"><strong>点击学生开始登记</strong><span>可连续操作；60秒无操作后返回日常页</span></div>';
      return;
    }
    var html = '<div class="points-selected-summary"><span>已选择</span><strong>' + escapeHtml(names.join('、')) + '</strong></div>';
    html += '<div class="points-rule-list">';
    (classroomState.rules || []).forEach(function(rule) {
      html += '<button type="button" class="points-rule-button ' + (rule.delta > 0 ? 'positive' : 'negative') + '" data-rule-id="' + escapeHtml(rule.id) + '">';
      html += '<span>' + escapeHtml(rule.name) + '</span><b>' + (rule.delta > 0 ? '+' : '') + rule.delta + '</b></button>';
    });
    html += '</div>';
    panel.innerHTML = html;
    panel.querySelectorAll('[data-rule-id]').forEach(function(button) {
      button.addEventListener('click', function() { applyRule(button.getAttribute('data-rule-id')); });
    });
  }

  function pendingDisplayRows() {
    if (!queue) return [];
    return queue.all().map(function(item) {
      var rule = classroomState && classroomState.rules && classroomState.rules.find(function(row) { return row.id === item.rule_id; });
      return {
        id: 'local-' + item.client_operation_id,
        student_name: (item.student_ids || []).map(function(id) {
          var student = studentById(id);
          return student ? student.name : '';
        }).filter(Boolean).join('、'),
        rule_name_snapshot: rule ? rule.name : '积分登记',
        delta: rule ? rule.delta : 0,
        source_label: item.status === 'failed' ? '待处理' : '待同步',
        error: item.error || '',
        created_at: item.client_created_at
      };
    });
  }

  function renderRecent() {
    var list = byId('pointsRecentList');
    if (!list) return;
    var rows = pendingDisplayRows().concat(classroomState && classroomState.recent || []).slice(0, 8);
    if (!rows.length) {
      list.innerHTML = '<div class="points-empty compact">暂无积分流水</div>';
      return;
    }
    list.innerHTML = rows.map(function(row) {
      var delta = Number(row.delta) || 0;
      var time = row.created_at ? new Date(row.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      return '<div class="points-recent-item ' + (row.error ? 'failed' : '') + '">' +
        '<div><strong>' + escapeHtml(row.student_name || '学生') + '</strong><span>' + escapeHtml(row.rule_name_snapshot || '积分调整') + '</span></div>' +
        '<b class="' + (delta >= 0 ? 'positive' : 'negative') + '">' + (delta > 0 ? '+' : '') + delta + '</b>' +
        '<small>' + escapeHtml(row.source_label || '') + ' ' + time + (row.error ? ' · ' + escapeHtml(row.error) : '') + '</small>' +
        '</div>';
    }).join('');
  }

  function renderSyncStatus() {
    var status = byId('pointsSyncStatus');
    if (!status) return;
    var pendingCount = queue ? queue.pending().length : 0;
    var failedCount = queue ? queue.failed().length : 0;
    if (failedCount) {
      status.className = 'points-sync-status failed';
      status.textContent = '待处理 ' + failedCount + ' 条';
    } else if (pendingCount) {
      status.className = 'points-sync-status pending';
      status.textContent = '待同步 ' + pendingCount + ' 条';
    } else {
      status.className = 'points-sync-status';
      status.textContent = root.navigator.onLine ? '已同步' : '网络已断开';
    }
  }

  function renderScoreMode() {
    renderSeatGrid();
    renderRulePanel();
    renderRecent();
    renderSyncStatus();
    var batchButton = byId('pointsBatchToggle');
    if (batchButton) {
      batchButton.classList.toggle('active', batchMode);
      batchButton.textContent = batchMode ? '完成批量选择' : '批量登记';
    }
  }

  function renderRanking() {
    var list = byId('pointsRankingList');
    if (!list) return;
    var rows = classroomState && classroomState.leaderboard || [];
    if (!rows.length) {
      list.innerHTML = '<div class="points-empty">暂无积分数据</div>';
      return;
    }
    list.innerHTML = rows.map(function(row, index) {
      return '<div class="points-ranking-item"><span class="points-rank-number">' + (index + 1) + '</span>' +
        '<strong>' + escapeHtml(row.student_name) + '</strong><b>' + (row.score > 0 ? '+' : '') + row.score + '</b></div>';
    }).join('');
    document.querySelectorAll('[data-points-scope]').forEach(function(button) {
      button.classList.toggle('active', button.getAttribute('data-points-scope') === activeScope);
    });
  }

  function renderLedger() {
    var list = byId('pointsLedgerList');
    if (!list) return;
    var rows = classroomState && classroomState.recent || [];
    var studentSelect = byId('pointsLedgerStudentFilter');
    if (studentSelect) {
      studentSelect.innerHTML = '<option value="">全部学生</option>' + (classroomState && classroomState.students || []).map(function(student) {
        return '<option value="' + escapeHtml(student.id) + '">' + escapeHtml(student.name) + '</option>';
      }).join('');
      studentSelect.value = ledgerStudentFilter;
    }
    var directionSelect = byId('pointsLedgerDirectionFilter');
    if (directionSelect) directionSelect.value = ledgerDirectionFilter;
    rows = rows.filter(function(row) {
      if (ledgerStudentFilter && row.student_id !== ledgerStudentFilter) return false;
      var delta = Number(row.delta) || 0;
      if (ledgerDirectionFilter === 'positive' && delta <= 0) return false;
      if (ledgerDirectionFilter === 'negative' && delta >= 0) return false;
      return true;
    });
    if (!rows.length) {
      list.innerHTML = '<div class="points-empty">' + ((ledgerStudentFilter || ledgerDirectionFilter) ? '没有符合条件的积分流水' : '今天还没有积分流水') + '</div>';
      return;
    }
    list.innerHTML = rows.map(function(row) {
      var delta = Number(row.delta) || 0;
      var time = row.created_at ? new Date(row.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      return '<div class="points-ledger-item"><time>' + time + '</time><strong>' + escapeHtml(row.student_name) + '</strong>' +
        '<span>' + escapeHtml(row.rule_name_snapshot) + '</span><b class="' + (delta >= 0 ? 'positive' : 'negative') + '">' +
        (delta > 0 ? '+' : '') + delta + '</b><small>' + escapeHtml(row.source_label) + '</small></div>';
    }).join('');
  }

  function selectStudent(studentId) {
    modeController.touch();
    if (batchMode) {
      var index = selectedStudentIds.indexOf(studentId);
      if (index >= 0) selectedStudentIds.splice(index, 1);
      else selectedStudentIds.push(studentId);
    } else {
      selectedStudentIds = [studentId];
    }
    renderScoreMode();
  }

  function toggleBatchMode() {
    modeController.touch();
    batchMode = !batchMode;
    selectedStudentIds = [];
    renderScoreMode();
  }

  function optimisticScore(studentIds, rule) {
    var map = rankingMap();
    studentIds.forEach(function(studentId) {
      if (!map[studentId]) {
        var student = studentById(studentId);
        classroomState.leaderboard.push({ student_id: studentId, student_name: student ? student.name : '', score: 0, entry_count: 0 });
        map = rankingMap();
      }
      map[studentId].score += Number(rule.delta) || 0;
    });
  }

  function stopScoreSound() {
    var oscillator = activeScoreOscillator;
    var gain = activeScoreGain;
    activeScoreOscillator = null;
    activeScoreGain = null;
    if (oscillator) {
      try { oscillator.stop(); } catch (error) {}
      try { oscillator.disconnect(); } catch (error) {}
    }
    if (gain) {
      try { gain.disconnect(); } catch (error) {}
    }
  }

  function playScoreSound(delta) {
    if (!classroomState || !classroomState.management || !classroomState.management.sound_enabled) return;
    try {
      stopScoreSound();
      var AudioContext = root.AudioContext || root.webkitAudioContext;
      if (!AudioContext) return;
      var context = root.__classroomPointsAudioContext || new AudioContext();
      root.__classroomPointsAudioContext = context;
      var oscillator = context.createOscillator();
      var gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = Number(delta) >= 0 ? 660 : 330;
      gain.gain.setValueAtTime(.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.12, context.currentTime + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      activeScoreOscillator = oscillator;
      activeScoreGain = gain;
      oscillator.onended = function() {
        if (activeScoreOscillator !== oscillator) return;
        activeScoreOscillator = null;
        activeScoreGain = null;
        try { oscillator.disconnect(); } catch (error) {}
        try { gain.disconnect(); } catch (error) {}
      };
      oscillator.start();
      oscillator.stop(context.currentTime + .2);
    } catch (error) {}
  }

  function applyRule(ruleId) {
    if (!queue || !selectedStudentIds.length) return;
    modeController.touch();
    var rule = (classroomState.rules || []).find(function(item) { return item.id === ruleId; });
    if (!rule) return;
    var ids = selectedStudentIds.slice();
    queue.enqueue({ student_ids: ids, rule_id: ruleId });
    optimisticScore(ids, rule);
    playScoreSound(rule.delta);
    selectedStudentIds = [];
    if (!batchMode) batchMode = false;
    renderScoreMode();
    flushQueue();
  }

  function ensureScreenSession() {
    if (screenToken) return Promise.resolve(screenToken);
    return root.fetch('/api/screen/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bind_code: bindCode })
    }).then(function(response) {
      return response.json().then(function(body) {
        if (!response.ok) throw new Error(body.error || '教室端连接失败');
        screenToken = body.screen_token;
        return screenToken;
      });
    });
  }

  function loadState(scope) {
    if (loadingState || !classInfo) return Promise.resolve(classroomState);
    loadingState = true;
    var requestedScope = scope || (modeController.mode() === 'ledger' ? 'today' : activeScope || 'term');
    return ensureScreenSession()
      .then(function() { return requestJson('/api/screen/classroom-state?scope=' + encodeURIComponent(requestedScope)); })
      .then(function(state) {
        classroomState = state;
        updateIdleActions();
        renderMode(modeController.mode());
        return state;
      })
      .catch(function(error) {
        if (error.status === 401) screenToken = '';
        renderSyncStatus();
        return classroomState;
      })
      .finally(function() { loadingState = false; });
  }

  function flushQueue() {
    if (flushing || !queue || !root.navigator.onLine) {
      renderSyncStatus();
      return Promise.resolve();
    }
    var items = queue.pending();
    if (!items.length) {
      renderSyncStatus();
      return Promise.resolve();
    }
    flushing = true;
    renderSyncStatus();
    var chain = Promise.resolve();
    items.forEach(function(item) {
      chain = chain.then(function() {
        return ensureScreenSession()
          .then(function() {
            return requestJson('/api/screen/points/entries', { method: 'POST', body: item });
          })
          .then(function() { queue.markSynced(item.client_operation_id); })
          .catch(function(error) {
            if (!error.status || error.status >= 500) throw error;
            if (error.status === 401) {
              screenToken = '';
              throw error;
            }
            queue.markFailed(item.client_operation_id, error.message);
          });
      });
    });
    return chain.catch(function() {})
      .then(function() { return loadState(modeController.mode() === 'ledger' ? 'today' : activeScope); })
      .finally(function() {
        flushing = false;
        renderSyncStatus();
        renderRecent();
      });
  }

  function openMode(mode) {
    if (!managementEnabled()) return;
    selectedStudentIds = [];
    batchMode = false;
    if (mode === 'ledger') activeScope = 'today';
    else if (mode === 'rank' && activeScope === 'today') activeScope = 'term';
    modeController.enter(mode);
    loadState(mode === 'ledger' ? 'today' : activeScope);
  }

  function backToIdle() {
    selectedStudentIds = [];
    batchMode = false;
    modeController.enter('idle');
  }

  function setScope(scope) {
    activeScope = ['today', 'week', 'month', 'term'].indexOf(scope) >= 0 ? scope : 'term';
    modeController.touch();
    loadState(activeScope);
  }

  function setLedgerFilter(kind, value) {
    if (kind === 'student') ledgerStudentFilter = String(value || '');
    if (kind === 'direction') ledgerDirectionFilter = String(value || '');
    modeController.touch();
    renderLedger();
  }

  function undoLatest() {
    modeController.touch();
    var recent = classroomState && classroomState.recent || [];
    var reversed = {};
    recent.forEach(function(item) { if (item.reversal_of_id) reversed[item.reversal_of_id] = true; });
    var entry = recent.find(function(item) { return !item.reversal_of_id && !reversed[item.id]; });
    if (!entry) return;
    requestJson('/api/screen/points/entries/' + encodeURIComponent(entry.id) + '/reverse', {
      method: 'POST',
      body: { client_operation_id: 'screen-reverse-' + Date.now().toString(36) }
    }).then(function() { return loadState(activeScope); }).catch(function(error) {
      var status = byId('pointsSyncStatus');
      if (status) {
        status.className = 'points-sync-status failed';
        status.textContent = error.message;
      }
    });
  }

  function onBound(info, code) {
    classInfo = info;
    bindCode = String(code || '');
    screenToken = info && info.screen_token || '';
    selectedStudentIds = [];
    batchMode = false;
    activeScope = 'term';
    ledgerStudentFilter = '';
    ledgerDirectionFilter = '';
    queue = root.ClassroomPointsQueue.createClassroomPointsQueue({
      storage: root.localStorage,
      key: info.id
    });
    modeController.reset();
    return loadState('term').then(function() { return flushQueue(); });
  }

  function onUnbound() {
    stopScoreSound();
    classInfo = null;
    bindCode = '';
    screenToken = '';
    classroomState = null;
    queue = null;
    selectedStudentIds = [];
    ledgerStudentFilter = '';
    ledgerDirectionFilter = '';
    var actions = byId('pointsIdleActions');
    if (actions) actions.hidden = true;
    modeController.reset();
  }

  function handleSocketEvent() {
    if (!classInfo) return;
    loadState(modeController.mode() === 'ledger' ? 'today' : activeScope);
  }

  function suspendForBroadcast() {
    stopScoreSound();
    modeController.suspendForBroadcast();
  }

  root.addEventListener('online', function() { flushQueue(); });
  root.addEventListener('offline', renderSyncStatus);
  document.addEventListener('pointerdown', function(event) {
    if (event.target && event.target.closest && event.target.closest('.points-mode')) modeController.touch();
  });

  return {
    IDLE_TIMEOUT_MS: IDLE_TIMEOUT_MS,
    createModeController: createModeController,
    onBound: onBound,
    onUnbound: onUnbound,
    openMode: openMode,
    backToIdle: backToIdle,
    toggleBatchMode: toggleBatchMode,
    setScope: setScope,
    setLedgerFilter: setLedgerFilter,
    undoLatest: undoLatest,
    suspendForBroadcast: suspendForBroadcast,
    resumeAfterBroadcast: modeController.resumeAfterBroadcast,
    handleSocketEvent: handleSocketEvent,
    flushQueue: flushQueue
  };
});
