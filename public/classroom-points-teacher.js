(function(root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClassroomPointsTeacher = api;
})(typeof window !== 'undefined' ? window : null, function(root) {
  'use strict';

  var options = {};
  var classes = [];
  var selectedClassId = '';
  var managementState = null;
  var leaderboard = [];
  var currentLeaderboard = [];
  var ledger = [];
  var selectedStudentIds = [];
  var rankingScope = 'term';
  var ledgerScope = 'term';
  var selectedPeriodId = '';
  var booted = false;
  var loading = false;

  function byId(id) { return root && root.document ? root.document.getElementById(id) : null; }
  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function classById(id) { return classes.find(function(item) { return item.id === id; }) || null; }
  function currentClass() { return classById(selectedClassId); }
  function token() { return options.getToken ? options.getToken() : ''; }
  function notify(message, type) {
    if (options.toast) options.toast(message, type);
  }
  function isPlanActive() { return options.isPlanActive ? !!options.isPlanActive() : true; }
  function mutationId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }
  function formatDate(value) {
    if (!value) return '-';
    var date = new Date(value);
    return isNaN(date.getTime()) ? '-' : date.toLocaleDateString('zh-CN');
  }
  function formatTime(value) {
    if (!value) return '-';
    var date = new Date(value);
    return isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function routeToSubscription() {
    if (typeof root.switchTab === 'function') root.switchTab('profile');
    if (typeof root.switchProfileSection === 'function') root.switchProfileSection('plan');
  }

  function request(path, requestOptions) {
    requestOptions = requestOptions || {};
    var headers = Object.assign({ 'X-Token': token() }, requestOptions.headers || {});
    if (requestOptions.body !== undefined) headers['Content-Type'] = 'application/json';
    return root.fetch(path, {
      method: requestOptions.method || 'GET',
      headers: headers,
      body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body)
    }).then(function(response) {
      return response.text().then(function(text) {
        var data = {};
        try { data = JSON.parse(text); } catch (error) { data = { error: text || '请求失败' }; }
        if (!response.ok) {
          var failure = new Error(data.error || '请求失败');
          failure.status = response.status;
          if (response.status === 403 && /到期|续费|套餐|使用期限/.test(failure.message)) {
            notify(failure.message, 'error');
            routeToSubscription();
          }
          throw failure;
        }
        return data;
      });
    });
  }

  function renderClassSelector() {
    var select = byId('pointsTeacherClassSelect');
    if (!select) return;
    var previous = selectedClassId || select.value;
    select.innerHTML = '<option value="">选择要管理的班级</option>' + classes.map(function(item) {
      var suffix = item.management_enabled ? ' · 已开启班级管理' : ' · 仅广播';
      return '<option value="' + esc(item.id) + '">' + esc(item.name + suffix) + '</option>';
    }).join('');
    if (classById(previous)) {
      selectedClassId = previous;
      select.value = previous;
    } else if (classes.length) {
      selectedClassId = classes[0].id;
      select.value = selectedClassId;
    } else {
      selectedClassId = '';
    }
    var empty = byId('pointsTeacherNoClasses');
    if (empty) empty.hidden = classes.length > 0;
  }

  function setBusy(busy) {
    loading = busy;
    var shell = byId('pointsTeacherShell');
    if (shell) shell.classList.toggle('is-loading', busy);
  }

  function renderEnablePanel() {
    var panel = byId('pointsTeacherEnablePanel');
    var workspace = byId('pointsTeacherWorkspace');
    if (!panel || !workspace) return;
    var cls = currentClass();
    if (!cls) {
      panel.innerHTML = '<div class="ctp-empty-state"><strong>先选择一个班级</strong><span>班级管理是按班级单独开启的。</span></div>';
      workspace.hidden = true;
      return;
    }
    var enabled = !!(managementState && managementState.management && managementState.management.enabled);
    var ownerAction = '';
    if (cls.is_owner) {
      ownerAction = '<button class="ctp-primary" type="button" onclick="ClassroomPointsTeacher.toggleManagement(' + (!enabled) + ')">' +
        (enabled ? '关闭班级管理' : '开启班级管理') + '</button>';
    } else {
      ownerAction = '<span class="ctp-role-note">你是协作老师，开启或关闭由班级创建者操作</span>';
    }
    panel.innerHTML = '<div class="ctp-enable-copy"><span class="ctp-status-dot ' + (enabled ? 'on' : '') + '"></span><div><strong>' + esc(cls.name) +
      (enabled ? '已开启班级管理' : '目前仅使用广播') + '</strong><p>' + (enabled
        ? '教室端与教师端可以共同加扣分，全部操作都会进入不可改写的流水。'
        : '开启后才会出现学生、座位、积分规则和排行榜；不需要的班级不受影响。') +
      '</p><small>包含在班级广播订阅中，不消耗师行积分。</small></div></div><div class="ctp-enable-actions">' + ownerAction + '</div>';
    workspace.hidden = !enabled;
    if (enabled) {
      var sound = byId('pointsTeacherSoundToggle');
      if (sound) {
        sound.checked = !!managementState.management.sound_enabled;
        sound.disabled = !cls.is_owner || !isPlanActive();
      }
      var newPeriod = byId('pointsTeacherNewPeriod');
      if (newPeriod) newPeriod.hidden = !cls.is_owner;
    }
  }

  function renderQuickScore() {
    var container = byId('pointsTeacherQuickScore');
    if (!container || !managementState) return;
    var students = managementState.students || [];
    var rules = managementState.rules || [];
    if (!students.length) {
      container.innerHTML = '<div class="ctp-empty-state compact"><strong>先添加学生名单</strong><span>添加后即可在这里单人或批量登记。</span></div>';
      return;
    }
    var scoreMap = {};
    currentLeaderboard.forEach(function(row) { scoreMap[row.student_id] = row.score; });
    var studentHtml = students.map(function(student) {
      var selected = selectedStudentIds.indexOf(student.id) >= 0;
      var score = Number(scoreMap[student.id]) || 0;
      return '<button type="button" class="ctp-student-chip ' + (selected ? 'selected' : '') + '" onclick="ClassroomPointsTeacher.selectStudent(\'' + esc(student.id) + '\')">' +
        '<strong>' + esc(student.name) + '</strong><small>' + (score > 0 ? '+' : '') + score + '</small></button>';
    }).join('');
    var ruleHtml = rules.map(function(rule) {
      return '<button type="button" class="ctp-score-rule ' + (rule.delta > 0 ? 'positive' : 'negative') + '" ' +
        (selectedStudentIds.length && isPlanActive() ? '' : 'disabled') + ' onclick="ClassroomPointsTeacher.applyRule(\'' + esc(rule.id) + '\')">' +
        '<span>' + esc(rule.name) + '</span><b>' + (rule.delta > 0 ? '+' : '') + rule.delta + '</b></button>';
    }).join('');
    container.innerHTML = '<div class="ctp-quick-hint"><span>' + (selectedStudentIds.length ? '已选 ' + selectedStudentIds.length + ' 人' : '点击学生，可连续选择多人') +
      '</span>' + (selectedStudentIds.length ? '<button type="button" onclick="ClassroomPointsTeacher.clearSelection()">清空选择</button>' : '') + '</div>' +
      '<div class="ctp-student-chips">' + studentHtml + '</div><div class="ctp-rule-strip">' + (ruleHtml || '<span class="ctp-muted">请先添加积分规则</span>') + '</div>';
  }

  function renderStudents() {
    var container = byId('pointsTeacherStudents');
    if (!container || !managementState) return;
    var students = managementState.students || [];
    if (!students.length) {
      container.innerHTML = '<div class="ctp-empty-line">还没有学生。先在上方填写姓名，座位可稍后补。</div>';
      return;
    }
    container.innerHTML = students.map(function(student) {
      var seat = student.seat_row && student.seat_col ? student.seat_row + ' 排 ' + student.seat_col + ' 列' : '未排座位';
      return '<div class="ctp-row"><div><strong>' + esc(student.name) + '</strong><small>' + esc(student.student_no || '无学号') + ' · ' + seat + '</small></div>' +
        '<div class="ctp-row-actions"><button type="button" onclick="ClassroomPointsTeacher.editStudent(\'' + esc(student.id) + '\')">编辑</button>' +
        '<button class="danger" type="button" onclick="ClassroomPointsTeacher.archiveStudent(\'' + esc(student.id) + '\')">移出</button></div></div>';
    }).join('');
  }

  function renderRules() {
    var container = byId('pointsTeacherRules');
    if (!container || !managementState) return;
    var rules = managementState.rules || [];
    container.innerHTML = rules.length ? rules.map(function(rule) {
      return '<div class="ctp-row"><div><strong>' + esc(rule.name) + '</strong><small>' + (rule.delta > 0 ? '加分规则' : '扣分规则') + '</small></div>' +
        '<b class="ctp-rule-value ' + (rule.delta > 0 ? 'positive' : 'negative') + '">' + (rule.delta > 0 ? '+' : '') + rule.delta + '</b>' +
        '<div class="ctp-row-actions"><button type="button" onclick="ClassroomPointsTeacher.editRule(\'' + esc(rule.id) + '\')">编辑</button>' +
        '<button class="danger" type="button" onclick="ClassroomPointsTeacher.disableRule(\'' + esc(rule.id) + '\')">停用</button></div></div>';
    }).join('') : '<div class="ctp-empty-line">暂无积分规则。</div>';
  }

  function renderPeriods() {
    var container = byId('pointsTeacherPeriods');
    if (!container || !managementState) return;
    var periods = managementState.periods || [];
    container.innerHTML = periods.map(function(period) {
      return '<button type="button" class="ctp-period ' + (period.status === 'current' ? 'current ' : '') + (period.id === selectedPeriodId ? 'selected' : '') + '" onclick="ClassroomPointsTeacher.setPeriod(\'' + esc(period.id) + '\')"><div><strong>' + esc(period.name) + '</strong><small>' +
        formatDate(period.starts_at) + ' 起' + (period.ends_at ? ' · ' + formatDate(period.ends_at) + ' 结束' : '') + '</small></div><span>' +
        (period.status === 'current' ? '当前学期' : '查看历史') + '</span></button>';
    }).join('') || '<div class="ctp-empty-line">系统会自动建立当前学期。</div>';
  }

  function renderRanking() {
    var container = byId('pointsTeacherRanking');
    if (!container) return;
    container.innerHTML = leaderboard.length ? leaderboard.map(function(row, index) {
      return '<div class="ctp-rank-row"><span>' + (index + 1) + '</span><strong>' + esc(row.student_name) + '</strong><b>' +
        (row.score > 0 ? '+' : '') + row.score + '</b><small>' + row.entry_count + ' 次变动</small></div>';
    }).join('') : '<div class="ctp-empty-line">该范围内暂无积分数据。</div>';
    root.document.querySelectorAll('[data-ctp-rank-scope]').forEach(function(button) {
      button.classList.toggle('active', button.getAttribute('data-ctp-rank-scope') === rankingScope);
    });
  }

  function renderLedgerFilters() {
    var studentSelect = byId('pointsTeacherLedgerStudent');
    if (!studentSelect || !managementState) return;
    var value = studentSelect.value;
    studentSelect.innerHTML = '<option value="">全部学生</option>' + (managementState.students || []).map(function(student) {
      return '<option value="' + esc(student.id) + '">' + esc(student.name) + '</option>';
    }).join('');
    studentSelect.value = value;
  }

  function renderLedger() {
    var container = byId('pointsTeacherLedger');
    if (!container) return;
    var reversed = {};
    ledger.forEach(function(item) { if (item.reversal_of_id) reversed[item.reversal_of_id] = true; });
    container.innerHTML = ledger.length ? ledger.map(function(row) {
      var canReverse = !row.reversal_of_id && !reversed[row.id] && isPlanActive();
      return '<div class="ctp-ledger-row"><time>' + formatTime(row.created_at) + '</time><strong>' + esc(row.student_name || '学生') + '</strong>' +
        '<span>' + esc(row.rule_name_snapshot || '积分调整') + '</span><b class="' + (row.delta >= 0 ? 'positive' : 'negative') + '">' +
        (row.delta > 0 ? '+' : '') + row.delta + '</b><small>' + esc(row.source_label || '') + '</small>' +
        '<div>' + (canReverse ? '<button type="button" onclick="ClassroomPointsTeacher.reverseEntry(\'' + esc(row.id) + '\')">撤销</button>' : '') + '</div></div>';
    }).join('') : '<div class="ctp-empty-line">该范围内暂无流水。</div>';
  }

  function renderAll() {
    renderEnablePanel();
    if (!managementState || !managementState.management || !managementState.management.enabled) return;
    renderQuickScore();
    renderStudents();
    renderRules();
    renderPeriods();
    renderRanking();
    renderLedgerFilters();
    renderLedger();
    var periodName = byId('pointsTeacherCurrentPeriod');
    if (periodName) {
      var selectedPeriod = (managementState.periods || []).find(function(period) { return period.id === selectedPeriodId; });
      periodName.textContent = selectedPeriod ? (selectedPeriod.status === 'current' ? selectedPeriod.name : '历史 · ' + selectedPeriod.name) : '当前学期';
    }
  }

  function refreshClass(classId) {
    var id = classId || selectedClassId;
    if (!id || loading) return Promise.resolve();
    selectedClassId = id;
    setBusy(true);
    return request('/api/classes/' + encodeURIComponent(id) + '/management')
      .then(function(state) {
            managementState = state;
            if (!state.management.enabled) {
              leaderboard = [];
              currentLeaderboard = [];
              ledger = [];
              return null;
            }
            var periods = state.periods || [];
            var currentPeriod = state.current_period || periods.find(function(period) { return period.status === 'current'; });
            if (!selectedPeriodId || !periods.some(function(period) { return period.id === selectedPeriodId; })) {
              selectedPeriodId = currentPeriod ? currentPeriod.id : '';
            }
            var student = byId('pointsTeacherLedgerStudent');
        var source = byId('pointsTeacherLedgerSource');
        var direction = byId('pointsTeacherLedgerDirection');
            var params = new URLSearchParams({ scope: ledgerScope, limit: '200', period_id: selectedPeriodId });
        if (student && student.value) params.set('student_id', student.value);
        if (source && source.value) params.set('source', source.value);
        if (direction && direction.value) params.set('direction', direction.value);
            var rankingPath = '/api/classes/' + encodeURIComponent(id) + '/points/leaderboard?scope=' + encodeURIComponent(rankingScope) + '&period_id=' + encodeURIComponent(selectedPeriodId);
            var requests = [request(rankingPath), request('/api/classes/' + encodeURIComponent(id) + '/points/ledger?' + params.toString())];
            if (currentPeriod && currentPeriod.id !== selectedPeriodId) {
              requests.push(request('/api/classes/' + encodeURIComponent(id) + '/points/leaderboard?scope=term&period_id=' + encodeURIComponent(currentPeriod.id)));
            }
            return Promise.all(requests).then(function(results) {
              leaderboard = results[0].items || [];
              ledger = results[1].items || [];
              currentLeaderboard = results[2] ? (results[2].items || []) : leaderboard;
            });
      })
      .then(function() { renderAll(); })
      .catch(function(error) { notify(error.message || '积分管理加载失败', 'error'); })
      .finally(function() { setBusy(false); });
  }

  function openClass(classId) {
    var select = byId('pointsTeacherClassSelect');
    selectedClassId = classId || (select && select.value) || '';
    selectedStudentIds = [];
    rankingScope = 'term';
    ledgerScope = 'term';
    selectedPeriodId = '';
    if (select) select.value = selectedClassId;
    if (!selectedClassId) {
      managementState = null;
      renderEnablePanel();
      return Promise.resolve();
    }
    return refreshClass(selectedClassId);
  }

  function setClasses(nextClasses) {
    classes = Array.isArray(nextClasses) ? nextClasses.slice() : [];
    renderClassSelector();
    if (selectedClassId && managementState) renderEnablePanel();
    var pointsTab = byId('tab-points');
    if (selectedClassId && pointsTab && root.getComputedStyle(pointsTab).display !== 'none') {
      refreshClass(selectedClassId);
    }
  }

  function toggleFromClassList(classId, enabled) {
    selectedClassId = classId;
    return toggleManagement(enabled).then(function() {
      if (typeof root.switchTab === 'function') root.switchTab('points');
      var select = byId('pointsTeacherClassSelect');
      if (select) select.value = classId;
    });
  }

  function toggleManagement(enabled) {
    var cls = currentClass();
    if (!cls || !cls.is_owner) return Promise.resolve();
    if (!isPlanActive()) {
      notify('请续费后开启班级管理', 'error');
      routeToSubscription();
      return Promise.resolve();
    }
    var action = enabled ? '开启' : '关闭';
    if (!root.confirm(action + '「' + cls.name + '」的班级管理？')) return Promise.resolve();
    return request('/api/classes/' + encodeURIComponent(cls.id) + '/management', {
      method: 'PUT',
      body: { enabled: !!enabled, sound_enabled: !!cls.points_sound_enabled }
    }).then(function(state) {
      managementState = state;
      cls.management_enabled = state.management.enabled;
      cls.points_sound_enabled = state.management.sound_enabled;
      notify(action + '成功', 'success');
      if (options.reloadClasses) options.reloadClasses();
      return refreshClass(cls.id);
    }).catch(function(error) { notify(error.message || action + '失败', 'error'); });
  }

  function toggleSound(enabled) {
    var cls = currentClass();
    if (!cls || !cls.is_owner) return;
    request('/api/classes/' + encodeURIComponent(cls.id) + '/management', {
      method: 'PUT', body: { enabled: true, sound_enabled: !!enabled }
    }).then(function(state) {
      managementState = state;
      notify(enabled ? '教室端积分提示音已开启' : '教室端积分提示音已关闭', 'success');
      renderAll();
    }).catch(function(error) { notify(error.message, 'error'); });
  }

  function selectStudent(studentId) {
    var index = selectedStudentIds.indexOf(studentId);
    if (index >= 0) selectedStudentIds.splice(index, 1);
    else selectedStudentIds.push(studentId);
    renderQuickScore();
  }
  function clearSelection() { selectedStudentIds = []; renderQuickScore(); }

  function applyRule(ruleId) {
    if (!selectedClassId || !selectedStudentIds.length || !isPlanActive()) return;
    var ids = selectedStudentIds.slice();
    request('/api/classes/' + encodeURIComponent(selectedClassId) + '/points/entries', {
      method: 'POST',
      body: { client_operation_id: mutationId('teacher-score'), student_ids: ids, rule_id: ruleId }
    }).then(function() {
      selectedStudentIds = [];
      notify(ids.length > 1 ? '已为 ' + ids.length + ' 名学生登记' : '积分已登记', 'success');
      return refreshClass(selectedClassId);
    }).catch(function(error) { notify(error.message, 'error'); });
  }

  function addStudent() {
    var name = byId('pointsTeacherStudentName').value.trim();
    if (!name) return notify('请输入学生姓名', 'error');
    var body = {
      name: name,
      student_no: byId('pointsTeacherStudentNo').value.trim(),
      seat_row: byId('pointsTeacherSeatRow').value || null,
      seat_col: byId('pointsTeacherSeatCol').value || null
    };
    request('/api/classes/' + encodeURIComponent(selectedClassId) + '/students', { method: 'POST', body: body })
      .then(function() {
        ['pointsTeacherStudentName','pointsTeacherStudentNo','pointsTeacherSeatRow','pointsTeacherSeatCol'].forEach(function(id) { byId(id).value = ''; });
        notify('学生已添加', 'success');
        return refreshClass(selectedClassId);
      }).catch(function(error) { notify(error.message, 'error'); });
  }

  function editStudent(studentId) {
    var student = (managementState.students || []).find(function(item) { return item.id === studentId; });
    if (!student) return;
    var name = root.prompt('学生姓名', student.name);
    if (name === null) return;
    var studentNo = root.prompt('学号（可留空）', student.student_no || '');
    if (studentNo === null) return;
    var row = root.prompt('座位排数（可留空）', student.seat_row || '');
    if (row === null) return;
    var col = root.prompt('座位列数（可留空）', student.seat_col || '');
    if (col === null) return;
    request('/api/classes/' + encodeURIComponent(selectedClassId) + '/students/' + encodeURIComponent(studentId), {
      method: 'PATCH', body: { name: name, student_no: studentNo, seat_row: row || null, seat_col: col || null }
    }).then(function() { notify('学生信息已更新', 'success'); return refreshClass(selectedClassId); })
      .catch(function(error) { notify(error.message, 'error'); });
  }

  function archiveStudent(studentId) {
    var student = (managementState.students || []).find(function(item) { return item.id === studentId; });
    if (!student || !root.confirm('将「' + student.name + '」移出当前名单？历史流水会保留。')) return;
    request('/api/classes/' + encodeURIComponent(selectedClassId) + '/students/' + encodeURIComponent(studentId), {
      method: 'PATCH', body: { archived: true }
    }).then(function() { notify('已移出名单，历史流水仍保留', 'success'); return refreshClass(selectedClassId); })
      .catch(function(error) { notify(error.message, 'error'); });
  }

  function addRule() {
    var name = byId('pointsTeacherRuleName').value.trim();
    var delta = Number(byId('pointsTeacherRuleDelta').value);
    if (!name || !Number.isInteger(delta) || delta === 0) return notify('请填写规则名称和非零整数分值', 'error');
    request('/api/classes/' + encodeURIComponent(selectedClassId) + '/score-rules', { method: 'POST', body: { name: name, delta: delta } })
      .then(function() {
        byId('pointsTeacherRuleName').value = '';
        byId('pointsTeacherRuleDelta').value = '';
        notify('规则已添加', 'success');
        return refreshClass(selectedClassId);
      }).catch(function(error) { notify(error.message, 'error'); });
  }

  function editRule(ruleId) {
    var rule = (managementState.rules || []).find(function(item) { return item.id === ruleId; });
    if (!rule) return;
    var name = root.prompt('规则名称', rule.name);
    if (name === null) return;
    var delta = root.prompt('分值（正数加分，负数扣分）', rule.delta);
    if (delta === null) return;
    request('/api/classes/' + encodeURIComponent(selectedClassId) + '/score-rules/' + encodeURIComponent(ruleId), {
      method: 'PATCH', body: { name: name, delta: Number(delta) }
    }).then(function() { notify('规则已更新', 'success'); return refreshClass(selectedClassId); })
      .catch(function(error) { notify(error.message, 'error'); });
  }

  function disableRule(ruleId) {
    var rule = (managementState.rules || []).find(function(item) { return item.id === ruleId; });
    if (!rule || !root.confirm('停用规则「' + rule.name + '」？历史流水不会受影响。')) return;
    request('/api/classes/' + encodeURIComponent(selectedClassId) + '/score-rules/' + encodeURIComponent(ruleId), {
      method: 'PATCH', body: { active: false }
    }).then(function() { notify('规则已停用', 'success'); return refreshClass(selectedClassId); })
      .catch(function(error) { notify(error.message, 'error'); });
  }

  function startNewPeriod() {
    var current = managementState && managementState.current_period;
    var name = root.prompt('新学期名称', '新学期');
    if (!name) return;
    if (!root.confirm('开始「' + name + '」？' + (current ? '当前「' + current.name + '」将结束，历史数据仍可查看。' : ''))) return;
    request('/api/classes/' + encodeURIComponent(selectedClassId) + '/score-periods', { method: 'POST', body: { name: name } })
      .then(function() { selectedPeriodId = ''; notify('新学期已开始', 'success'); return refreshClass(selectedClassId); })
      .catch(function(error) { notify(error.message, 'error'); });
  }

  function setPeriod(periodId) {
    selectedPeriodId = periodId;
    rankingScope = 'term';
    ledgerScope = 'term';
    refreshClass(selectedClassId);
  }

  function setRankingScope(scope) {
    rankingScope = scope;
    refreshClass(selectedClassId);
  }
  function setLedgerScope(scope) {
    ledgerScope = scope;
    refreshClass(selectedClassId);
  }
  function applyLedgerFilters() { refreshClass(selectedClassId); }

  function reverseEntry(entryId) {
    if (!root.confirm('撤销这笔积分？系统会新增一条相反分值的冲正流水。')) return;
    request('/api/classes/' + encodeURIComponent(selectedClassId) + '/points/entries/' + encodeURIComponent(entryId) + '/reverse', {
      method: 'POST', body: { client_operation_id: mutationId('teacher-reverse') }
    }).then(function() { notify('已撤销，原流水仍保留', 'success'); return refreshClass(selectedClassId); })
      .catch(function(error) { notify(error.message, 'error'); });
  }

  function handleSocketEvent(eventType, payload) {
    if (!selectedClassId) return;
    if (payload && payload.class_id && payload.class_id !== selectedClassId) return;
    refreshClass(selectedClassId);
  }

  function boot(nextOptions) {
    options = Object.assign(options, nextOptions || {});
    if (booted || !root || !root.document) return;
    booted = true;
    setClasses(options.getClasses ? options.getClasses() : []);
  }

  return {
    boot: boot,
    setClasses: setClasses,
    openClass: openClass,
    refreshClass: refreshClass,
    toggleFromClassList: toggleFromClassList,
    toggleManagement: toggleManagement,
    toggleSound: toggleSound,
    selectStudent: selectStudent,
    clearSelection: clearSelection,
    applyRule: applyRule,
    addStudent: addStudent,
    editStudent: editStudent,
    archiveStudent: archiveStudent,
    addRule: addRule,
    editRule: editRule,
    disableRule: disableRule,
    startNewPeriod: startNewPeriod,
    setPeriod: setPeriod,
    setRankingScope: setRankingScope,
    setLedgerScope: setLedgerScope,
    applyLedgerFilters: applyLedgerFilters,
    reverseEntry: reverseEntry,
    handleSocketEvent: handleSocketEvent
  };
});
