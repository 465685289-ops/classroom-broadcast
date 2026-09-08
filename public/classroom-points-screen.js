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

  function buildSeatGridModel(students, rows, cols) {
    var seatRows = Math.max(1, Math.min(30, Number(rows) || 8));
    var seatCols = Math.max(1, Math.min(30, Number(cols) || 6));
    var cells = new Array(seatRows * seatCols).fill(null);
    var unseated = [];
    (Array.isArray(students) ? students : []).forEach(function(student) {
      var row = Number(student && student.seat_row);
      var col = Number(student && student.seat_col);
      var valid = Number.isInteger(row) && Number.isInteger(col) && row >= 1 && col >= 1 && row <= seatRows && col <= seatCols;
      var index = valid ? (row - 1) * seatCols + col - 1 : -1;
      if (!valid || cells[index] !== null) unseated.push(student.id);
      else cells[index] = student.id;
    });
    return { cells: cells, unseated: unseated };
  }

  function rankSeatSelectionStudents(students, leaderboard) {
    var standings = {};
    (Array.isArray(leaderboard) ? leaderboard : []).forEach(function(item, index) {
      standings[item.student_id] = { rank: index, score: Number(item.score) || 0 };
    });
    return (Array.isArray(students) ? students : []).slice().sort(function(a, b) {
      var left = standings[a.id] || { rank: Number.MAX_SAFE_INTEGER, score: 0 };
      var right = standings[b.id] || { rank: Number.MAX_SAFE_INTEGER, score: 0 };
      if (left.rank !== right.rank) return left.rank - right.rank;
      if (left.score !== right.score) return right.score - left.score;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
  }

  if (!root || !root.document) {
    return {
      IDLE_TIMEOUT_MS: IDLE_TIMEOUT_MS,
      createModeController: createModeController,
      buildSeatGridModel: buildSeatGridModel,
      rankSeatSelectionStudents: rankSeatSelectionStudents,
      openScoreModal: openScoreModal,
      closeScoreModal: closeScoreModal,
      applyRuleForModalStudent: applyRuleForModalStudent,
      applyCustomForModalStudent: applyCustomForModalStudent
    };
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
  var seatSelectionStudentId = '';
  var seatSelectionSaving = false;

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

  function seatSelectionActive() {
    return !!(managementEnabled() && classroomState.management.seat_selection_active);
  }

  function updateIdleActions() {
    var actions = byId('pointsIdleActions');
    if (!actions) return;
    actions.hidden = !managementEnabled();
    actions.style.display = managementEnabled() ? 'inline-flex' : 'none';
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
    var unseated = byId('pointsUnseatedStudents');
    if (!grid) return;
    if (seatSelectionActive()) {
      renderSeatSelectionGrid(grid, unseated);
      return;
    }
    var students = classroomState && classroomState.students || [];
    var scores = rankingMap();
    if (!students.length) {
      grid.innerHTML = '<div class="points-empty">还没有学生名单<br><small>请老师先在教师端添加学生并安排座位</small></div>';
      if (unseated) unseated.innerHTML = '';
      return;
    }
    var management = classroomState && classroomState.management || {};
    var rows = Number(management.seat_rows) || 8;
    var cols = Number(management.seat_cols) || 6;
    var model = buildSeatGridModel(students, rows, cols);
    var studentMap = {};
    students.forEach(function(student) { studentMap[student.id] = student; });
    var html = '';
    model.cells.forEach(function(studentId, index) {
      if (!studentId) {
        html += '<div class="points-seat-empty" aria-label="空座位"><span>' + (Math.floor(index / cols) + 1) + '-' + (index % cols + 1) + '</span></div>';
        return;
      }
      var student = studentMap[studentId];
      var score = scores[student.id] ? scores[student.id].score : 0;
      var selected = selectedStudentIds.indexOf(student.id) >= 0;
      html += '<button type="button" class="points-student-card' + (selected ? ' selected' : '') + '" data-student-id="' + escapeHtml(student.id) + '">';
      html += '<span class="points-student-name">' + escapeHtml(student.name) + '</span>';
      html += '<span class="points-student-score">' + (score > 0 ? '+' : '') + score + '</span>';
      html += '</button>';
    });
    grid.style.setProperty('--points-seat-cols', cols);
    grid.setAttribute('aria-label', rows + ' 行 ' + cols + ' 列座位表');
    grid.innerHTML = html;
    grid.querySelectorAll('[data-student-id]').forEach(function(button) {
      button.addEventListener('click', function() { selectStudent(button.getAttribute('data-student-id')); });
    });
    if (unseated) {
      unseated.innerHTML = model.unseated.length ? '<span>待排座</span>' + model.unseated.map(function(studentId) {
        var student = studentMap[studentId];
        var score = scores[studentId] ? scores[studentId].score : 0;
        return '<button type="button" data-student-id="' + escapeHtml(studentId) + '"><strong>' + escapeHtml(student.name) + '</strong><small>' + (score > 0 ? '+' : '') + score + '</small></button>';
      }).join('') : '';
      unseated.querySelectorAll('[data-student-id]').forEach(function(button) {
        button.addEventListener('click', function() { selectStudent(button.getAttribute('data-student-id')); });
      });
    }
  }

  function renderSeatSelectionGrid(grid, unseated) {
    var students = classroomState && classroomState.students || [];
    var scores = rankingMap();
    var management = classroomState && classroomState.management || {};
    var rows = Number(management.seat_rows) || 8;
    var cols = Number(management.seat_cols) || 6;
    var model = buildSeatGridModel(students, rows, cols);
    var studentMap = {};
    students.forEach(function(student) { studentMap[student.id] = student; });
    var html = '';
    model.cells.forEach(function(studentId, index) {
      var row = Math.floor(index / cols) + 1;
      var col = index % cols + 1;
      if (!studentId) {
        html += '<button type="button" class="points-seat-empty selectable" data-seat-row="' + row + '" data-seat-col="' + col + '" aria-label="' + row + ' 排 ' + col + ' 列空座位"><span>' + row + '-' + col + '</span></button>';
        return;
      }
      var student = studentMap[studentId];
      var score = scores[studentId] ? scores[studentId].score : 0;
      html += '<div class="points-seat-picked" aria-label="' + row + ' 排 ' + col + ' 列 ' + escapeHtml(student.name) + '"><strong>' + escapeHtml(student.name) + '</strong><small>' + (score > 0 ? '+' : '') + score + '</small></div>';
    });
    grid.style.setProperty('--points-seat-cols', cols);
    grid.setAttribute('aria-label', rows + ' 行 ' + cols + ' 列选座表');
    grid.innerHTML = html;
    grid.querySelectorAll('[data-seat-row]').forEach(function(button) {
      button.addEventListener('click', function() {
        var row = Number(button.getAttribute('data-seat-row'));
        var col = Number(button.getAttribute('data-seat-col'));
        if (!seatSelectionStudentId) {
          var hint = byId('pointsSyncStatus');
          if (hint) {
            hint.className = 'points-sync-status pending';
            hint.textContent = '先点右侧姓名';
          }
          return;
        }
        assignSeatSelectionStudent(seatSelectionStudentId, row, col);
      });
    });
    if (unseated) unseated.innerHTML = '';
  }

  function renderRulePanel() {
    var panel = byId('pointsRulePanel');
    if (!panel) return;
    if (seatSelectionActive()) {
      renderSeatSelectionPanel(panel);
      return;
    }
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

  function renderSeatSelectionPanel(panel) {
    var students = classroomState && classroomState.students || [];
    var scores = rankingMap();
    var ordered = rankSeatSelectionStudents(students, classroomState && classroomState.leaderboard || []);
    var waiting = ordered.filter(function(student) { return student.seat_row === null || student.seat_col === null; });
    if (!waiting.some(function(student) { return student.id === seatSelectionStudentId; })) seatSelectionStudentId = '';
    var html = '<div class="points-selection-panel"><div class="points-selection-hint"><strong>积分榜选座</strong>按当前周期积分从高到低排队；<b>拖动</b>右侧姓名到空座位，也可以先点姓名再点座位。<br>待选 ' + waiting.length + ' 人 / 已入座 ' + (students.length - waiting.length) + ' 人</div>';
    html += '<div class="points-selection-list">';
    if (!waiting.length) html += '<div class="points-selection-empty">全部学生已选座。<br>可点击“完成选座”回到积分登记。</div>';
    waiting.forEach(function(student, index) {
      var score = scores[student.id] ? scores[student.id].score : 0;
      html += '<button type="button" class="points-selection-student' + (student.id === seatSelectionStudentId ? ' selected' : '') + '" data-selection-student-id="' + escapeHtml(student.id) + '">';
      html += '<span class="points-selection-rank">' + (index + 1) + '</span><strong>' + escapeHtml(student.name) + '</strong><b>' + (score > 0 ? '+' : '') + score + '</b></button>';
    });
    html += '</div></div>';
    panel.innerHTML = html;
    panel.querySelectorAll('[data-selection-student-id]').forEach(function(button) {
      var studentId = button.getAttribute('data-selection-student-id');
      button.addEventListener('click', function() {
        seatSelectionStudentId = studentId;
        renderRulePanel();
      });
      button.addEventListener('pointerdown', function(event) {
        beginSeatSelectionPointer(event, studentId);
      });
    });
  }

  function seatTargetAt(clientX, clientY) {
    var target = document.elementFromPoint(clientX, clientY);
    return target && target.closest ? target.closest('[data-seat-row][data-seat-col]') : null;
  }

  function markSeatDropTarget(target) {
    document.querySelectorAll('.points-seat-empty.drop-target').forEach(function(element) {
      element.classList.toggle('drop-target', element === target);
    });
  }

  function beginSeatSelectionPointer(event, studentId) {
    if (seatSelectionSaving || (event.pointerType === 'mouse' && event.button !== 0)) return;
    seatSelectionStudentId = studentId;
    var pointerId = event.pointerId;
    var target = null;
    var chip = event.currentTarget;
    var ghost = null;
    event.preventDefault();
    // 拖动时生成跟随指针的名字浮影（pointer 事件同时适配触摸屏黑板电脑）
    function ensureGhost(x, y) {
      if (ghost) return;
      ghost = chip.cloneNode(true);
      ghost.className = chip.className + ' seat-selection-ghost';
      ghost.style.width = chip.offsetWidth + 'px';
      ghost.style.left = x + 'px';
      ghost.style.top = y + 'px';
      document.body.appendChild(ghost);
      if (chip.classList) chip.classList.add('seat-selection-source');
    }
    function moveGhost(x, y) {
      if (!ghost) return;
      ghost.style.left = x + 'px';
      ghost.style.top = y + 'px';
    }
    function cleanup() {
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      ghost = null;
      if (chip && chip.classList) chip.classList.remove('seat-selection-source');
    }
    function move(moveEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      ensureGhost(moveEvent.clientX, moveEvent.clientY);
      moveGhost(moveEvent.clientX, moveEvent.clientY);
      target = seatTargetAt(moveEvent.clientX, moveEvent.clientY);
      markSeatDropTarget(target);
    }
    function finish(upEvent) {
      if (upEvent.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', cancel);
      var seat = seatTargetAt(upEvent.clientX, upEvent.clientY) || target;
      cleanup();
      markSeatDropTarget(null);
      if (seat) {
        assignSeatSelectionStudent(studentId, Number(seat.getAttribute('data-seat-row')), Number(seat.getAttribute('data-seat-col')));
      } else {
        renderRulePanel();
      }
    }
    function cancel(cancelEvent) {
      if (cancelEvent.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', cancel);
      cleanup();
      markSeatDropTarget(null);
      renderRulePanel();
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', cancel);
  }

  function assignSeatSelectionStudent(studentId, row, col) {
    if (!studentId || seatSelectionSaving) return;
    seatSelectionSaving = true;
    var status = byId('pointsSyncStatus');
    if (status) {
      status.className = 'points-sync-status pending';
      status.textContent = '正在入座';
    }
    requestJson('/api/screen/seat-selection/seats', {
      method: 'POST',
      body: { student_id: studentId, seat_row: row, seat_col: col }
    }).then(function(result) {
      var student = studentById(studentId);
      if (student && result.student) {
        student.seat_row = result.student.seat_row;
        student.seat_col = result.student.seat_col;
      }
      seatSelectionStudentId = '';
      renderScoreMode();
      return loadState(activeScope);
    }).catch(function(error) {
      if (status) {
        status.className = 'points-sync-status failed';
        status.textContent = error.message || '入座失败';
      }
    }).finally(function() {
      seatSelectionSaving = false;
    });
  }

  function startSeatSelection() {
    if (!managementEnabled() || seatSelectionActive()) return;
    if (!root.confirm('开启积分榜选座会清空当前座位表，积分记录不会删除。现在开始吗？')) return;
    activeScope = 'term';
    requestJson('/api/screen/seat-selection/start', { method: 'POST', body: {} })
      .then(function() {
        seatSelectionStudentId = '';
        return loadState('term');
      })
      .catch(function(error) {
        var status = byId('pointsSyncStatus');
        if (status) {
          status.className = 'points-sync-status failed';
          status.textContent = error.message || '开启选座失败';
        }
      });
  }

  function finishSeatSelection() {
    if (!seatSelectionActive()) return;
    requestJson('/api/screen/seat-selection/finish', { method: 'POST', body: {} })
      .then(function() {
        seatSelectionStudentId = '';
        return loadState(activeScope);
      })
      .catch(function(error) {
        var status = byId('pointsSyncStatus');
        if (status) {
          status.className = 'points-sync-status failed';
          status.textContent = error.message || '结束选座失败';
        }
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
    var selecting = seatSelectionActive();
    var mode = byId('pointsScoreMode');
    if (mode) mode.classList.toggle('is-seat-selection', selecting);
    var title = byId('pointsScoreTitle');
    var subtitle = byId('pointsScoreSubtitle');
    if (title) title.textContent = selecting ? '积分榜选座' : '班级加扣分';
    if (subtitle) subtitle.textContent = selecting ? '按当前周期积分依次选座；支持触摸拖动，也可点选姓名后点空座位' : '点座位上的名字直接加减分；多人一起登记用「批量登记」';
    var start = byId('pointsSeatSelectionStart');
    var finish = byId('pointsSeatSelectionFinish');
    var batchButton = byId('pointsBatchToggle');
    if (start) start.hidden = selecting;
    if (finish) finish.hidden = !selecting;
    if (batchButton) batchButton.hidden = selecting;
    document.querySelectorAll('#pointsScoreMode .points-toolbar > button[onclick*="openMode"], #pointsScoreMode .points-toolbar > button[onclick*="undoLatest"]').forEach(function(button) {
      button.hidden = selecting;
    });
    renderSeatGrid();
    renderRulePanel();
    if (!selecting) renderRecent();
    renderSyncStatus();
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
      renderScoreMode();
    } else {
      // 主路径：点座位上的名字直接弹快捷评分面板
      openScoreModal(studentId);
    }
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
    selectedStudentIds = [];
    submitEntries(ids, { student_ids: ids, rule_id: ruleId }, rule.delta);
  }

  function submitEntries(ids, payload, delta) {
    if (!queue || !ids.length) return;
    queue.enqueue(payload);
    optimisticScore(ids, { delta: delta });
    playScoreSound(delta);
    renderScoreMode();
    flushQueue();
  }

  // ---------- 点人名快捷评分面板：六项规则 + 自定义分值（事由可选） ----------
  var modalStudentId = null;

  function openScoreModal(studentId) {
    var student = studentById(studentId);
    if (!student) return;
    modeController.touch();
    modalStudentId = studentId;
    renderScoreModal();
    var overlay = byId('pointsScoreModal');
    if (overlay) overlay.hidden = false;
  }

  function closeScoreModal() {
    modalStudentId = null;
    var overlay = byId('pointsScoreModal');
    if (overlay) overlay.hidden = true;
  }

  function renderScoreModal() {
    var overlay = byId('pointsScoreModal');
    if (!overlay || !modalStudentId) return;
    var student = studentById(modalStudentId);
    var scoreItem = rankingMap()[modalStudentId];
    var currentScore = scoreItem ? scoreItem.score : 0;
    var nameEl = byId('pointsModalName');
    var scoreEl = byId('pointsModalScore');
    if (nameEl) nameEl.textContent = student ? student.name : '';
    if (scoreEl) {
      scoreEl.textContent = (currentScore > 0 ? '+' : '') + currentScore + ' 分';
      scoreEl.className = 'points-modal-score' + (currentScore < 0 ? ' negative' : '');
    }
    var rulesEl = byId('pointsModalRules');
    if (rulesEl) {
      rulesEl.innerHTML = (classroomState.rules || []).filter(function(rule) { return rule.active !== false; }).map(function(rule) {
        return '<button type="button" class="points-rule-button ' + (rule.delta > 0 ? 'positive' : 'negative') + '" data-rule-id="' + escapeHtml(rule.id) + '"><span>' + escapeHtml(rule.name) + '</span><b>' + (rule.delta > 0 ? '+' : '') + rule.delta + '</b></button>';
      }).join('');
      rulesEl.querySelectorAll('[data-rule-id]').forEach(function(button) {
        button.addEventListener('click', function() { applyRuleForModalStudent(button.getAttribute('data-rule-id')); });
      });
    }
    var deltaInput = byId('pointsModalCustomDelta');
    var reasonInput = byId('pointsModalCustomReason');
    if (deltaInput) deltaInput.value = '';
    if (reasonInput) reasonInput.value = '';
  }

  function applyRuleForModalStudent(ruleId) {
    if (!modalStudentId) return;
    modeController.touch();
    var rule = (classroomState.rules || []).find(function(item) { return item.id === ruleId; });
    if (!rule) return;
    var ids = [modalStudentId];
    closeScoreModal();
    submitEntries(ids, { student_ids: ids, rule_id: ruleId }, rule.delta);
  }

  function applyCustomForModalStudent() {
    if (!modalStudentId) return;
    modeController.touch();
    var deltaInput = byId('pointsModalCustomDelta');
    var delta = Number(deltaInput && deltaInput.value);
    if (!Number.isInteger(delta) || delta === 0 || delta < -100 || delta > 100) {
      var status = byId('pointsSyncStatus');
      if (status) {
        status.className = 'points-sync-status failed';
        status.textContent = '分值需为 -100~100 的非零整数';
      }
      return;
    }
    var reasonInput = byId('pointsModalCustomReason');
    var ids = [modalStudentId];
    var payload = { student_ids: ids, custom_delta: delta, custom_reason: String(reasonInput && reasonInput.value || '').trim().slice(0, 30) };
    closeScoreModal();
    submitEntries(ids, payload, delta);
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
        if (!managementEnabled() && modeController.mode() !== 'idle') modeController.reset();
        else renderMode(modeController.mode());
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
    seatSelectionStudentId = '';
    if (mode === 'score' && seatSelectionActive()) activeScope = 'term';
    if (mode === 'ledger') activeScope = 'today';
    else if (mode === 'rank' && activeScope === 'today') activeScope = 'term';
    modeController.enter(mode);
    loadState(mode === 'ledger' ? 'today' : activeScope);
  }

  function backToIdle() {
    selectedStudentIds = [];
    batchMode = false;
    seatSelectionStudentId = '';
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
    seatSelectionStudentId = '';
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
    seatSelectionStudentId = '';
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
    buildSeatGridModel: buildSeatGridModel,
    onBound: onBound,
    onUnbound: onUnbound,
    openMode: openMode,
    backToIdle: backToIdle,
    toggleBatchMode: toggleBatchMode,
    setScope: setScope,
    setLedgerFilter: setLedgerFilter,
    undoLatest: undoLatest,
    startSeatSelection: startSeatSelection,
    finishSeatSelection: finishSeatSelection,
    openScoreModal: openScoreModal,
    closeScoreModal: closeScoreModal,
    applyRuleForModalStudent: applyRuleForModalStudent,
    applyCustomForModalStudent: applyCustomForModalStudent,
    suspendForBroadcast: suspendForBroadcast,
    resumeAfterBroadcast: modeController.resumeAfterBroadcast,
    handleSocketEvent: handleSocketEvent,
    flushQueue: flushQueue
  };
});
