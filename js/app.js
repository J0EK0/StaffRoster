// 主程式：UI 渲染 + 互動

(function() {

  // ===== 狀態 =====
  const state = {
    year: 0, month: 0,
    staff: [],
    days: [],
    schedule: null,         // { year, month, days, assignments }
    constraints: {},        // { staffId: { date: code } }
    customHolidays: {},     // { date: name }
    rotation: null,         // { weekday: { staffId: { date: code } }, regular/national: { _order, staffId: { date: code } } }
    showRuleIssues: false,
  };
  const STAT_CODES = ['N','E','3','7','1','2','中','△','A','◎','休*','休','例','國'];
  const FIXED_STAT_CODES = ['假日', '花花', 'OC'];
  const FIXED_STAT_TITLES = {
    '假日': '假日 / 國定假日有上班 (非休例國請) 的天數',
    '花花': '平日 (一~五) 工作班且非白班的班別總數',
    'OC':   'On Call：平日 7/E/N/△；假日 1/2/E/N/休*',
  };
  const OC_WEEKDAY = new Set(['7','E','N','△']);
  const OC_HOLIDAY = new Set(['1','2','E','N','休*']);
  const isFlowerShift = code => Boolean(code) && WORK_CODES.includes(code) && code !== '白';

  function formatRequirementIssues(missing, duplicate, count) {
    const parts = [];
    if (missing.length) parts.push(`缺：${missing.join(',')}`);
    if (duplicate.length) {
      parts.push(`多：${duplicate.map(code => `${code}×${count[code]}`).join(',')}`);
    }
    return parts.join('；');
  }

  function renderCode(el, code) {
    if (code === '休*') {
      el.innerHTML = '<span class="rs-star">*</span><span class="rs-rest">休</span>';
    } else if (isRestWorkCode(code)) {
      el.innerHTML = `<span class="rs-rest">休</span><span class="rs-work">${escapeHtml(effectiveWorkCode(code))}</span>`;
    } else {
      el.textContent = code == null ? '' : code;
    }
  }
  const STAT_COL_WIDTH = 34;
  const STATS_COLLAPSED_KEY = 'roster.statsCollapsed';
  const NAME_COL_WIDTH_KEY = 'roster.nameColWidth';
  const NAME_COL_MIN_WIDTH = 128;
  const NAME_COL_MAX_WIDTH = 280;
  const NAME_COL_DEFAULT_WIDTH = 156;
  const QUICK_FILL_CODES = ['N','E','休N','休E','◎','1','2','中','A','3','7','△','R','門','白','休','休*','例','國','請'];
  let activeQuickFillCode = undefined;

  // ===== 初始化 =====
  function init() {
    state.staff = Staff.load();
    applyNameColumnWidth(loadNameColumnWidth());

    // 預設下個月
    const nm = nextMonth();
    state.year = nm.y;
    state.month = nm.m;

    setupYearMonthSelectors();
    setupTopbarButtons();
    setupStatsToggle();
    setupQuickFillToolbar();

    loadCurrentMonth();
    render();
  }

  function setupYearMonthSelectors() {
    const yearSel = document.getElementById('year-select');
    const monthSel = document.getElementById('month-select');
    const thisYear = new Date().getFullYear();
    yearSel.innerHTML = '';
    for (let y = thisYear - 1; y <= thisYear + 3; y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y + '年';
      yearSel.appendChild(opt);
    }
    monthSel.innerHTML = '';
    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m + '月';
      monthSel.appendChild(opt);
    }
    yearSel.value = state.year;
    monthSel.value = state.month;

    yearSel.addEventListener('change', () => { state.year = parseInt(yearSel.value, 10); loadCurrentMonth(); render(); });
    monthSel.addEventListener('change', () => { state.month = parseInt(monthSel.value, 10); loadCurrentMonth(); render(); });
  }

  function setupTopbarButtons() {
    document.getElementById('btn-prev-month').addEventListener('click', () => {
      const p = shiftMonth({y: state.year, m: state.month}, -1);
      state.year = p.y; state.month = p.m;
      syncSelectors(); loadCurrentMonth(); render();
    });
    document.getElementById('btn-next-month').addEventListener('click', () => {
      const p = shiftMonth({y: state.year, m: state.month}, 1);
      state.year = p.y; state.month = p.m;
      syncSelectors(); loadCurrentMonth(); render();
    });
    document.getElementById('btn-today').addEventListener('click', () => {
      const t = new Date();
      state.year = t.getFullYear();
      state.month = t.getMonth() + 1;
      syncSelectors(); loadCurrentMonth(); render();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest || !e.target.closest('#btn-add-staff, #btn-add-staff-row')) return;
      const name = prompt('新人員姓名：');
      if (!name || !name.trim()) return;
      state.staff = Staff.add(state.staff, { name: name.trim() });
      // 同步擴展 assignments
      state.schedule.assignments[state.staff[state.staff.length-1].id] = {};
      state.days.forEach(d => { state.schedule.assignments[state.staff[state.staff.length-1].id][d.date] = null; });
      saveSchedule();
      render();
    });
    document.getElementById('btn-init-draft').addEventListener('click', () => {
      // 若在偏好模式 → 先離開
      if (document.body.classList.contains('prefs-mode') && window.PrefsStage) {
        window.PrefsStage.setActive(false);
      }
      Scheduler.initPatternDraft(state.schedule, state.staff, state.constraints, state.rotation);
      normalizeAllCircleBalance();
      state.showRuleIssues = true;
      if (window.Stepper) window.Stepper.mark('draft');
      saveSchedule();
      render();
    });
    document.getElementById('btn-rotation-modal').addEventListener('click', () => {
      openRotationModal();
    });
    document.getElementById('btn-auto-fill').addEventListener('click', () => {
      Scheduler.repairSchedule(state.schedule, state.staff, state.constraints);
      normalizeAllCircleBalance();
      state.showRuleIssues = true;
      if (window.Stepper) window.Stepper.mark('repair');
      saveSchedule();
      render();
    });
    const ruleBtnEl = document.getElementById('btn-check-rules');
    if (ruleBtnEl) ruleBtnEl.addEventListener('click', () => { runRuleCheck(); });
    window.runRuleCheck = runRuleCheck;
    document.getElementById('btn-clear-schedule').addEventListener('click', () => {
      if (!confirm('確定清空本月排班內容？會保留並顯示目前個別日期指定/請假偏好。')) return;
      Scheduler.clearAssignments(state.schedule, state.staff);
      applyConstraintsToSchedule();
      state.showRuleIssues = false;
      saveSchedule();
      render();
    });
    document.getElementById('btn-reset-month').addEventListener('click', () => {
      if (!confirm('確定清空本月所有格子與個別日期指定/請假偏好？固定班與禁忌班設定會保留。')) return;
      state.constraints = {};
      localStorage.removeItem(LS_KEYS.constraints(state.year, state.month));
      Scheduler.clearAssignments(state.schedule, state.staff);
      state.showRuleIssues = false;
      saveSchedule();
      render();
    });
    document.getElementById('btn-export').addEventListener('click', () => {
      Exporter.exportXlsx(state.schedule, state.staff);
      if (window.Stepper) window.Stepper.mark('export');
    });
  }

  function syncSelectors() {
    document.getElementById('year-select').value = state.year;
    document.getElementById('month-select').value = state.month;
  }

  // ===== 載入當月狀態 =====
  function loadCurrentMonth() {
    const customRaw = localStorage.getItem(LS_KEYS.customHolidays(state.year, state.month));
    state.customHolidays = customRaw ? JSON.parse(customRaw) : {};

    state.days = buildMonthStructure(state.year, state.month, state.customHolidays);

    const schedRaw = localStorage.getItem(LS_KEYS.schedule(state.year, state.month));
    let schedule = null;
    if (schedRaw) {
      try { schedule = JSON.parse(schedRaw); } catch(e) { schedule = null; }
    }
    if (!schedule) {
      schedule = {
        year: state.year, month: state.month,
        days: state.days,
        assignments: {},
      };
      state.staff.forEach(s => {
        schedule.assignments[s.id] = {};
        state.days.forEach(d => { schedule.assignments[s.id][d.date] = null; });
      });
    } else {
      // 同步 days (避免月份結構過時)
      schedule.days = state.days;
      // 補齊新成員
      state.staff.forEach(s => {
        if (!schedule.assignments[s.id]) {
          schedule.assignments[s.id] = {};
          state.days.forEach(d => { schedule.assignments[s.id][d.date] = null; });
        } else {
          // 補齊缺少的日期 key
          state.days.forEach(d => {
            if (!(d.date in schedule.assignments[s.id])) {
              schedule.assignments[s.id][d.date] = null;
            }
          });
        }
      });
    }
    state.schedule = schedule;
    state.constraints = removeManualWhiteConstraints(Constraints.load(state.year, state.month));
    const rotRaw = localStorage.getItem(LS_KEYS.rotation(state.year));
    state.rotation = normalizeRotationData(rotRaw ? JSON.parse(rotRaw) : null);
    state.showRuleIssues = false;
  }

  function saveSchedule() {
    localStorage.setItem(
      LS_KEYS.schedule(state.year, state.month),
      JSON.stringify(state.schedule)
    );
  }

  function applyConstraintsToSchedule() {
    state.staff.forEach(s => {
      if (!state.schedule.assignments[s.id]) state.schedule.assignments[s.id] = {};
      const staffConstraints = state.constraints[s.id] || {};
      state.days.forEach(d => {
        if (Object.prototype.hasOwnProperty.call(staffConstraints, d.date)) {
          state.schedule.assignments[s.id][d.date] = staffConstraints[d.date] || null;
        }
      });
    });
    state.schedule.diagnostics = [];
  }

  function removeManualWhiteConstraints(constraints) {
    const cleaned = {};
    let changed = false;
    Object.keys(constraints || {}).forEach(staffId => {
      const staffData = constraints[staffId] || {};
      const next = {};
      Object.keys(staffData).forEach(dateKey => {
        if (staffData[dateKey] === '白') {
          changed = true;
          return;
        }
        next[dateKey] = staffData[dateKey];
      });
      if (Object.keys(next).length > 0) cleaned[staffId] = next;
      else if (Object.keys(staffData).length > 0) changed = true;
    });
    if (changed) Constraints.save(state.year, state.month, cleaned);
    return changed ? cleaned : (constraints || {});
  }

  function setupStatsToggle() {
    const btn = document.getElementById('btn-toggle-stats');
    if (!btn) return;
    const apply = (collapsed) => {
      const tbl = document.getElementById('schedule-table');
      if (tbl) tbl.classList.toggle('stats-collapsed', collapsed);
      btn.classList.toggle('collapsed', collapsed);
      const lbl = btn.querySelector('.lbl');
      if (lbl) lbl.textContent = collapsed ? '展開統計' : '收起統計';
    };
    apply(isStatsCollapsed());
    btn.addEventListener('click', () => {
      const next = !isStatsCollapsed();
      try { localStorage.setItem(STATS_COLLAPSED_KEY, next ? '1' : '0'); } catch (e) {}
      apply(next);
    });
  }

  function setupQuickFillToolbar() {
    const bar = document.getElementById('quick-fill-toolbar');
    if (!bar) return;
    bar.innerHTML = '';

    QUICK_FILL_CODES.forEach(code => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `quick-fill-btn shift-${code}`;
      btn.title = `快速填入 ${code}`;
      btn.dataset.code = code;
      renderCode(btn, code);
      btn.addEventListener('click', () => {
        activeQuickFillCode = activeQuickFillCode === code ? undefined : code;
        updateQuickFillToolbar();
      });
      bar.appendChild(btn);
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'quick-fill-btn quick-fill-clear';
    clearBtn.title = '清空工具：點格子只清空該格';
    clearBtn.dataset.code = '__clear__';
    clearBtn.textContent = '清空';
    clearBtn.addEventListener('click', () => {
      activeQuickFillCode = activeQuickFillCode === null ? undefined : null;
      updateQuickFillToolbar();
    });
    bar.appendChild(clearBtn);

    updateQuickFillToolbar();
  }

  function updateQuickFillToolbar() {
    document.querySelectorAll('#quick-fill-toolbar .quick-fill-btn').forEach(btn => {
      const isClear = btn.dataset.code === '__clear__';
      const selected = isClear ? activeQuickFillCode === null : activeQuickFillCode === btn.dataset.code;
      btn.classList.toggle('active', selected);
    });
    document.body.classList.toggle('quick-fill-active', activeQuickFillCode !== undefined);
    document.body.classList.toggle('quick-fill-erasing', activeQuickFillCode === null);
  }

  function isStatsCollapsed() {
    try { return localStorage.getItem(STATS_COLLAPSED_KEY) === '1'; }
    catch (e) { return false; }
  }

  function clampNameColumnWidth(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NAME_COL_DEFAULT_WIDTH;
    return Math.max(NAME_COL_MIN_WIDTH, Math.min(NAME_COL_MAX_WIDTH, Math.round(n)));
  }

  function loadNameColumnWidth() {
    try {
      return clampNameColumnWidth(localStorage.getItem(NAME_COL_WIDTH_KEY) || NAME_COL_DEFAULT_WIDTH);
    } catch (e) {
      return NAME_COL_DEFAULT_WIDTH;
    }
  }

  function applyNameColumnWidth(width) {
    document.documentElement.style.setProperty('--name-col-width', `${clampNameColumnWidth(width)}px`);
  }

  function setNameColumnWidth(width) {
    const next = clampNameColumnWidth(width);
    applyNameColumnWidth(next);
    try { localStorage.setItem(NAME_COL_WIDTH_KEY, String(next)); } catch (e) {}
  }

  function currentNameColumnWidth() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--name-col-width');
    return clampNameColumnWidth(parseFloat(raw) || NAME_COL_DEFAULT_WIDTH);
  }

  function addNameColumnResizer(cell) {
    const handle = document.createElement('span');
    handle.className = 'name-col-resizer';
    handle.title = '拖曳調整姓名欄寬度';
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = currentNameColumnWidth();
      document.body.classList.add('resizing-name-col');
      const onMove = (ev) => setNameColumnWidth(startWidth + ev.clientX - startX);
      const onUp = () => {
        document.body.classList.remove('resizing-name-col');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
    cell.appendChild(handle);
  }

  // ===== 渲染 =====
  function render() {
    const tbl = document.getElementById('schedule-table');
    tbl.innerHTML = '';
    tbl.classList.toggle('stats-collapsed', isStatsCollapsed());

    const thead = document.createElement('thead');
    const tr1 = document.createElement('tr');
    const nameHead = th('col-name', '姓名 / 日期');
    addNameColumnResizer(nameHead);
    tr1.appendChild(nameHead);
    state.days.forEach(d => {
      const cls = ['day-num'];
      if (d.isHoliday) cls.push('day-holiday');
      else if (d.dow === 0) cls.push('day-sun');
      else if (d.dow === 6) cls.push('day-sat');
      const t = th(cls.join(' '), d.day);
      t.title = d.holidayName || '';
      tr1.appendChild(t);
    });
    STAT_CODES.forEach((code, idx) => {
      const cell = th('col-stat', code);
      positionStatCell(cell, idx);
      if (code === '休') cell.title = '普通休，不含休*';
      tr1.appendChild(cell);
    });
    FIXED_STAT_CODES.forEach((code, idx) => {
      const cell = th('col-stat col-stat-fixed', code);
      positionFixedStatCell(cell, idx);
      cell.title = FIXED_STAT_TITLES[code] || code;
      tr1.appendChild(cell);
    });
    thead.appendChild(tr1);

    const tr2 = document.createElement('tr');
    tr2.appendChild(th('col-name', ''));
    state.days.forEach(d => {
      const cls = ['day-num'];
      if (d.isHoliday) cls.push('day-holiday');
      else if (d.dow === 0) cls.push('day-sun');
      else if (d.dow === 6) cls.push('day-sat');
      tr2.appendChild(th(cls.join(' '), DOW_LABEL[d.dow]));
    });
    STAT_CODES.forEach((code, idx) => {
      const cell = th('col-stat', '');
      positionStatCell(cell, idx);
      if (code === '休') cell.title = '普通休，不含休*';
      tr2.appendChild(cell);
    });
    FIXED_STAT_CODES.forEach((code, idx) => {
      const cell = th('col-stat col-stat-fixed', '');
      positionFixedStatCell(cell, idx);
      tr2.appendChild(cell);
    });
    thead.appendChild(tr2);
    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');

    // 偏好模式：把畫面上的 assignments 暫時清空（不動 state 資料）
    const prefsMode = document.body.classList.contains('prefs-mode');
    tbl.classList.toggle('in-prefs-mode', prefsMode);

    // 員工列
    state.staff.forEach((s, rowIdx) => {
      const tr = document.createElement('tr');
      tr.className = 'staff-row';
      tr.dataset.staffId = s.id;
      tr.setAttribute('draggable', 'true');

      // 姓名欄
      const nameTd = document.createElement('td');
      nameTd.className = 'col-name';
      const cell = document.createElement('div');
      cell.className = 'staff-name-cell';
      if (s.fixedShift) cell.classList.add('fixed');
      let nameHtml = `<span class="name">${escapeHtml(s.name)}</span>`;
      if (s.fixedShift) nameHtml += `<span class="badge" title="${escapeHtml(s.note||'固定班')}">${s.fixedShift}</span>`;
      if (s.forbidden && s.forbidden.length) nameHtml += `<span class="badge" style="background:#fee2e2;color:#7f1d1d" title="禁忌班：${escapeHtml(s.forbidden.join('、'))}">禁${s.forbidden.join('')}</span>`;
      if (!s.fixedShift && (!s.forbidden || !s.forbidden.length)) nameHtml += `<span class="badge badge-empty" aria-hidden="true"></span>`;
      nameHtml += `<button class="gear" title="設定限制">⚙</button>`;
      nameHtml += `<button class="del" title="刪除">×</button>`;
      cell.innerHTML = nameHtml;
      nameTd.appendChild(cell);
      tr.appendChild(nameTd);

      cell.querySelector('.gear').addEventListener('click', (e) => {
        e.stopPropagation();
        openConstraintModal(s);
      });
      cell.querySelector('.del').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`刪除 ${s.name}？`)) return;
        state.staff = Staff.remove(state.staff, s.id);
        delete state.schedule.assignments[s.id];
        saveSchedule();
        render();
      });

      // 拖曳重排
      tr.addEventListener('dragstart', (e) => {
        tr.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', s.id);
      });
      tr.addEventListener('dragend', () => {
        tr.classList.remove('dragging');
        document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
      });
      tr.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        tr.classList.add('drop-target');
      });
      tr.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromId = e.dataTransfer.getData('text/plain');
        if (fromId && fromId !== s.id) {
          state.staff = Staff.reorder(state.staff, fromId, s.id);
          render();
        }
      });

      // 每日格子
      state.days.forEach((d, dayIdx) => {
        const td = document.createElement('td');
        td.className = 'shift-cell';
        if (d.isHoliday) td.classList.add('cell-holiday');
        else if (d.dow === 0) td.classList.add('cell-sun');
        else if (d.dow === 6) td.classList.add('cell-sat');
        let code = state.schedule.assignments[s.id] ? state.schedule.assignments[s.id][d.date] : null;
        // 偏好模式：只顯示有設過偏好的格子，其餘全部空白
        if (prefsMode) {
          const pref = state.constraints[s.id] && state.constraints[s.id][d.date];
          code = pref || null;
          if (pref) td.classList.add('pref-marked');
        }
        if (code) {
          td.classList.add(`shift-${code}`);
          renderCode(td, code);
        }
        td.dataset.staffId = s.id;
        td.dataset.date = d.date;

        td.addEventListener('click', (e) => {
          e.stopPropagation();
          if (activeQuickFillCode !== undefined) {
            setCell(s.id, d.date, activeQuickFillCode);
          } else {
            openShiftPopover(td, s, d);
          }
        });
        tr.appendChild(td);
      });

      const stats = computeStats(s.id);
      STAT_CODES.forEach((code, idx) => {
        const statsTd = document.createElement('td');
        statsTd.className = 'col-stat';
        positionStatCell(statsTd, idx);
        statsTd.textContent = stats[code] || 0;
        statsTd.title = `${s.name} ${code}=${stats[code] || 0}`;
        tr.appendChild(statsTd);
      });
      FIXED_STAT_CODES.forEach((code, idx) => {
        const statsTd = document.createElement('td');
        statsTd.className = 'col-stat col-stat-fixed';
        positionFixedStatCell(statsTd, idx);
        statsTd.textContent = stats[code] || 0;
        statsTd.title = `${s.name} ${code}=${stats[code] || 0}`;
        tr.appendChild(statsTd);
      });

      tbody.appendChild(tr);
    });

    // 每日需求驗證列
    const reqTr = document.createElement('tr');
    reqTr.className = 'req-row';
    const reqLabel = document.createElement('td');
    reqLabel.className = 'col-name';
    reqLabel.textContent = '每日名額';
    reqTr.appendChild(reqLabel);

    state.days.forEach(d => {
      const reqs = dayRequirements(d.dow, d.isHoliday);
      const count = {};
      state.staff.forEach(s => {
        const c = state.schedule.assignments[s.id] ? state.schedule.assignments[s.id][d.date] : null;
        if (c) {
          const key = effectiveWorkCode(c);
          count[key] = (count[key]||0) + 1;
        }
      });
      const missing = reqs.filter(r => (count[r]||0) < 1);
      const duplicate = reqs.filter(r => (count[r]||0) > 1);
      const td = document.createElement('td');
      if (missing.length === 0 && duplicate.length === 0) {
        td.className = 'req-ok';
        td.textContent = '✓';
        td.title = `齊：${reqs.join(',')}`;
      } else {
        td.className = 'req-fail';
        td.textContent = '✗';
        td.title = formatRequirementIssues(missing, duplicate, count);
      }
      reqTr.appendChild(td);
    });
    STAT_CODES.forEach((_code, idx) => {
      const reqStats = document.createElement('td');
      reqStats.className = 'col-stat';
      positionStatCell(reqStats, idx);
      reqTr.appendChild(reqStats);
    });
    FIXED_STAT_CODES.forEach((_code, idx) => {
      const reqStats = document.createElement('td');
      reqStats.className = 'col-stat col-stat-fixed';
      positionFixedStatCell(reqStats, idx);
      reqTr.appendChild(reqStats);
    });
    tbody.appendChild(reqTr);

    // 表尾「+ 新增人員」ghost row
    if (!prefsMode) {
      const addTr = document.createElement('tr');
      addTr.className = 'add-staff-row';
      const addTd = document.createElement('td');
      addTd.colSpan = 1 + state.days.length + STAT_CODES.length + FIXED_STAT_CODES.length;
      addTd.innerHTML = '<button id="btn-add-staff-row" class="add-staff-btn" type="button"><span class="plus">+</span> 新增人員</button>';
      addTr.appendChild(addTd);
      tbody.appendChild(addTr);
    }

    tbl.appendChild(tbody);

    if (state.showRuleIssues) {
      renderViolations();
    } else {
      clearRuleIssueDisplay();
    }
  }

  function computeStats(staffId) {
    const staffMember = state.staff.find(s => s.id === staffId);
    const a = state.schedule.assignments[staffId] || {};
    const out = {};
    STAT_CODES.forEach(code => { out[code] = 0; });
    FIXED_STAT_CODES.forEach(code => { out[code] = 0; });
    out.work = 0;
    let circleRestToCount = circleRestDebitCount(staffId, staffMember);
    const addShiftStats = (code) => {
      if (!code) return;
      if (isCircleShiftCode(code)) {
        if (out['◎'] !== undefined) out['◎']++;
        if (circleRestToCount > 0 && out['休'] !== undefined) {
          out['休']++;
          circleRestToCount--;
        }
        return;
      }
      if (isRestWorkCode(code)) {
        const base = effectiveWorkCode(code);
        if (out[base] !== undefined) out[base]++;
        if (out['休'] !== undefined) out['休']++;
        return;
      }
      if (out[code] !== undefined) out[code]++;
    };
    state.days.forEach(d => {
      const c = a[d.date];
      addShiftStats(c);
      if (c && !OFF_CODES.includes(c)) out.work++;
      const isHolidayLike = d.isHoliday || d.dow === 0 || d.dow === 6 || isCircleShiftCode(c);
      const base = effectiveWorkCode(c);
      if (isHolidayLike) {
        if (c && (!OFF_CODES.includes(c) || c === '休*')) out['假日']++;
        if (c && (OC_HOLIDAY.has(base) || c === '休*')) out['OC']++;
      } else {
        if (isFlowerShift(c)) out['花花']++;
        if (c && OC_WEEKDAY.has(base)) out['OC']++;
      }
    });
    return out;
  }

  function circleRestDebitCount(staffId, staffMember) {
    if (!isCircleStaff(staffMember)) return 0;
    const a = state.schedule.assignments[staffId] || {};
    const manual = state.constraints[staffId] || {};
    let circles = 0;
    let manualWeekdayRest = 0;
    state.days.forEach(d => {
      if (a[d.date] === '◎' && isCircleDay(d)) circles++;
      if (manual[d.date] === '休' && isWeekdayRestCreditDay(d)) manualWeekdayRest++;
    });
    return Math.max(0, circles - manualWeekdayRest);
  }

  function positionStatCell(cell, idx) {
    // STAT_CODES come first (leftmost), FIXED_STAT_CODES rightmost (always visible)
    const total = STAT_CODES.length + FIXED_STAT_CODES.length;
    cell.style.right = `${(total - 1 - idx) * STAT_COL_WIDTH}px`;
  }
  function positionFixedStatCell(cell, idx) {
    cell.style.right = `${(FIXED_STAT_CODES.length - 1 - idx) * STAT_COL_WIDTH}px`;
  }

  function collectRuleIssues() {
    return [
      ...Validator.validate(state.schedule, state.staff),
      ...((state.schedule && state.schedule.diagnostics) || []),
    ];
  }

  function runRuleCheck() {
    state.showRuleIssues = true;
    const errs = renderViolations({ showClean: true });
    const box = document.getElementById('violations');
    if (box && !box.classList.contains('hidden')) {
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    return errs;
  }

  function renderViolations(options = {}) {
    const { showClean = false } = options;
    const rawErrs = collectRuleIssues();
    const box = document.getElementById('violations');
    box.classList.remove('ok');

    // 高亮違規格子
    clearRuleHighlights();
    rawErrs.forEach(e => {
      const staffIds = Array.isArray(e.staffIds) ? e.staffIds : (e.staffId ? [e.staffId] : []);
      staffIds.forEach(staffId => {
        if (!staffId || !e.date) return;
        const td = document.querySelector(`#schedule-table .shift-cell[data-staff-id="${staffId}"][data-date="${e.date}"]`);
        if (td) td.classList.add('violation');
      });
    });

    // 去重（相同訊息只顯示一次）
    const seen = new Set();
    const errs = rawErrs.filter(e => {
      if (seen.has(e.msg)) return false;
      seen.add(e.msg);
      return true;
    });

    if (errs.length === 0) {
      if (showClean) {
        box.classList.remove('hidden');
        box.classList.add('ok');
        box.innerHTML = '<h4>檢查完成</h4><p>目前沒有檢查到規則問題。</p>';
      } else {
        box.classList.add('hidden');
        box.innerHTML = '';
      }
      return rawErrs;
    }

    const CATEGORY_LABEL = {
      'forbidden': '禁忌班',
      'E-bad-next': '接續違規', '3-bad-next': '接續違規',
      'N-prev-not-off-or-N': 'N班前置', 'N-next-triangle': 'N後接續',
      'over-6-consec': '連續超時',
      'wrong-weekly-休-quota': '週配額', 'wrong-weekly-例-quota': '週配額',
      'wrong-國-quota': '月配額',
      'no-guo': '國定假日',
      'short-coverage': '每日覆蓋', 'duplicate-coverage': '每日覆蓋',
      'too-many-leave': '請假限額', 'too-many-weekday-off': '平日限額',
      'holiday-white': '假日白班',
      'circle-invalid-staff': '圓圈班', 'circle-invalid-day': '圓圈班',
      'draft-no-candidate': '排班診斷',
    };

    const groups = new Map();
    errs.forEach(e => {
      const label = CATEGORY_LABEL[e.type] || '其他';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(e);
    });

    const groupsHtml = Array.from(groups.entries()).map(([label, items]) =>
      `<div class="violations-group">` +
      `<div class="violations-group-header">${escapeHtml(label)}<span class="violations-group-count">${items.length}</span></div>` +
      `<ul>${items.map(e => `<li>${escapeHtml(e.msg)}</li>`).join('')}</ul>` +
      `</div>`
    ).join('');

    box.classList.remove('hidden');
    box.innerHTML = `<h4>規則違規 (${errs.length} 項)</h4>${groupsHtml}`;
    return rawErrs;
  }

  function clearRuleIssueDisplay() {
    clearRuleHighlights();
    const box = document.getElementById('violations');
    box.classList.remove('ok');
    box.classList.add('hidden');
    box.innerHTML = '';
  }

  function clearRuleHighlights() {
    document.querySelectorAll('#schedule-table .shift-cell.violation').forEach(c => c.classList.remove('violation'));
  }

  // ===== Shift popover =====
  function openShiftPopover(td, staff, day) {
    const pop = document.getElementById('shift-popover');
    pop.innerHTML = '';

    const work = SHIFT_DEFS.filter(s => s.kind === 'work');
    const off  = SHIFT_DEFS.filter(s => s.kind === 'off');

    [...work, ...off].forEach(s => {
      const b = document.createElement('button');
      renderCode(b, s.code);
      b.title = s.label;
      b.className = `shift-${s.code}`;
      b.addEventListener('click', () => {
        setCell(staff.id, day.date, s.code);
        pop.classList.add('hidden');
      });
      pop.appendChild(b);
    });
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '清空';
    clearBtn.className = 'clear-btn';
    clearBtn.addEventListener('click', () => {
      setCell(staff.id, day.date, null);
      pop.classList.add('hidden');
    });
    pop.appendChild(clearBtn);

    // 定位
    const rect = td.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    pop.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 260) + 'px';
    pop.classList.remove('hidden');

    // 點外關閉
    setTimeout(() => {
      const onDocClick = (e) => {
        if (!pop.contains(e.target) && e.target !== td) {
          pop.classList.add('hidden');
          document.removeEventListener('click', onDocClick);
        }
      };
      document.addEventListener('click', onDocClick);
    }, 0);
  }

  function normalizeAllCircleBalance() {
    state.staff.forEach(s => {
      if (isCircleStaff(s)) {
        normalizeCircleBalance(s.id, s, state.schedule.assignments, state.constraints, state.days);
      }
    });
    Constraints.save(state.year, state.month, state.constraints);
  }

  function setCell(staffId, dateKey, code) {
    code = normalizeManualCellCode(staffId, dateKey, code);
    if (!state.schedule.assignments[staffId]) state.schedule.assignments[staffId] = {};
    state.schedule.assignments[staffId][dateKey] = code;
    state.schedule.diagnostics = [];
    // 同步存入 constraints，這樣下次按「自動排班」會把這格當成硬性指定不會覆蓋
    if (!state.constraints[staffId]) state.constraints[staffId] = {};
    if (code === null || code === '' || code === '白') {
      delete state.constraints[staffId][dateKey];
    } else {
      state.constraints[staffId][dateKey] = code;
    }
    normalizeCircleBalance(
      staffId, state.staff.find(s => s.id === staffId),
      state.schedule.assignments, state.constraints, state.days
    );
    Constraints.save(state.year, state.month, state.constraints);
    saveSchedule();
    render();
  }

  function normalizeManualCellCode(staffId, dateKey, code) {
    if (code !== '請') return code;
    const cur = state.schedule.assignments[staffId] && state.schedule.assignments[staffId][dateKey];
    if (cur === '休*') return '休';
    if (cur === '休' || cur === '例' || cur === '國') return cur;
    return code;
  }

  // ===== 個人限制 modal =====
  function openConstraintModal(staff) {
    Constraints.openModal(
      staff,
      state.year, state.month,
      state.days,
      state.constraints,
      ({ staffPatch, constraintData }) => {
        const normalizedConstraintData = {};
        Object.keys(constraintData || {}).forEach(dKey => {
          const code = normalizeManualCellCode(staff.id, dKey, constraintData[dKey]);
          if (code && code !== '白') normalizedConstraintData[dKey] = code;
        });
        state.staff = Staff.update(state.staff, staff.id, staffPatch);
        state.constraints = { ...state.constraints, [staff.id]: normalizedConstraintData };
        Constraints.save(state.year, state.month, state.constraints);
        // 同步即時套用 constraints 到 schedule
        Object.keys(normalizedConstraintData).forEach(dKey => {
          if (state.schedule.assignments[staff.id]) {
            state.schedule.assignments[staff.id][dKey] = normalizedConstraintData[dKey];
          }
        });
        saveSchedule();
        render();
      }
    );
  }

  // ===== 底稿 Modal =====
  function normalizeRotationData(data) {
    const normalizeGroup = (group, useHolidayOrderPreset = false) => {
      const out = group || {};
      if (!out._inactive) out._inactive = {};
      if (useHolidayOrderPreset && out._orderPreset !== HOLIDAY_ORDER_PRESET_VERSION) {
        out._order = DEFAULT_HOLIDAY_ROTATION_ORDER.slice();
        out._orderPreset = HOLIDAY_ORDER_PRESET_VERSION;
      }
      return out;
    };
    return {
      weekday: normalizeGroup(data && data.weekday),
      regular: normalizeGroup(data && data.regular, true),
      national: normalizeGroup(data && data.national, true),
    };
  }

  function isDraftStaffActive(groupData, staffMember) {
    if (!staffMember || staffMember.fixedShift) return false;
    return !(groupData && groupData._inactive && groupData._inactive[staffMember.id]);
  }

  function activeDraftStaff(groupData) {
    return orderedDraftStaff(groupData).filter(s => isDraftStaffActive(groupData, s));
  }

  function orderedDraftStaff(groupData) {
    const base = state.staff.slice();
    const order = Array.isArray(groupData && groupData._order) ? groupData._order : [];
    if (order.length === 0) return base;

    const byId = new Map(base.map(s => [s.id, s]));
    const used = new Set();
    const ordered = [];
    order.forEach(id => {
      const s = byId.get(id);
      if (!s || used.has(id)) return;
      ordered.push(s);
      used.add(id);
    });
    base.forEach(s => {
      if (!used.has(s.id)) ordered.push(s);
    });
    return ordered;
  }

  function reorderDraftStaff(groupData, fromId, toId, currentStaff) {
    if (!groupData || !fromId || !toId || fromId === toId) return false;
    const next = currentStaff.map(s => s.id);
    const fromIdx = next.indexOf(fromId);
    const toIdx = next.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return false;
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    groupData._order = next;
    return true;
  }

  function toggleDraftStaff(groupData, staffMember) {
    if (!staffMember || staffMember.fixedShift) return;
    if (!groupData._inactive) groupData._inactive = {};
    if (groupData._inactive[staffMember.id]) delete groupData._inactive[staffMember.id];
    else groupData._inactive[staffMember.id] = true;
  }

  const ROT_CODES = ['E', '中', 'N', '1', '2', '休*'];
  const WEEKDAY_ROT_CODES = ['1', '中', '2', 'A', '3', '7', 'E', 'N', '△'];
  const WEEKDAY_QUICK_PATTERN = ['1', '中', '2', 'A', '3', '7', 'E', 'N', '△'];
  const HOLIDAY_ORDER_PRESET_VERSION = 'holiday-order-20260513-v1';
  const DEFAULT_HOLIDAY_ROTATION_ORDER = [
    'linyh',     // 林意惠
    'huangym',   // 黃月美
    'chenye',    // 陳妍恩
    'huangwl',   // 黃丸玲
    'lixf',      // 李秀芳
    'huangyy',   // 黃有玉
    'chenyt',    // 陳玥彤
    'laiyh',     // 賴鈺函
    'caicc',     // 蔡瓊慧
    'qiupr',     // 邱珮茹
    'liwj',      // 李文君
    'wupc',      // 吳沛宸
    'xiemq',     // 謝沐騏
    'yangyy',    // 楊于瑩
    'linyy',     // 林妍堉
    'linzt',     // 林子庭
    'linc',      // 李唸慈
    'huangwl2',  // 黃文伶
    'zhuangcq',  // 莊筑琪
  ];

  function buildYearHolidayDays(year, startMonth) {
    const allDays = [];
    for (let m = startMonth; m <= 12; m++) {
      const customRaw = localStorage.getItem(LS_KEYS.customHolidays(year, m));
      const custom = customRaw ? JSON.parse(customRaw) : {};
      const days = buildMonthStructure(year, m, custom);
      days.forEach(d => { d.month = m; });
      allDays.push(...days);
    }
    return allDays;
  }

  function openRotationModal() {
    const modal = document.getElementById('rotation-modal');
    const title = document.getElementById('rotation-modal-title');
    title.textContent = `底稿設定 — ${state.year}年${state.month}月`;

    const allDays = buildYearHolidayDays(state.year, state.month);
    const weekdayDays = state.days
      .filter(d => d.dow >= 1 && d.dow <= 5 && !d.isHoliday)
      .map(d => ({ ...d, month: state.month }));
    const regularDays = allDays.filter(d => d.rotationGroup === 'regular');
    const nationalDays = allDays.filter(d => d.rotationGroup === 'national');

    const rotData = normalizeRotationData(JSON.parse(JSON.stringify(state.rotation || {})));

    renderRotationTable('rotation-table-weekday', weekdayDays, rotData.weekday);
    renderRotationTable('rotation-table-regular', regularDays, rotData.regular);
    renderRotationTable('rotation-table-national', nationalDays, rotData.national);

    modal.classList.remove('hidden');
    document.getElementById('rotation-modal-content').scrollTop = 0;

    const onClose = () => {
      modal.classList.add('hidden');
      cleanup();
    };
    const onSave = () => {
      state.rotation = normalizeRotationData(rotData);
      localStorage.setItem(LS_KEYS.rotation(state.year), JSON.stringify(state.rotation));
      modal.classList.add('hidden');
      cleanup();
    };
    const saveBtn = document.getElementById('btn-rotation-save');
    const cancelBtn = document.getElementById('btn-rotation-cancel');
    const closeBtn = document.getElementById('btn-rotation-close');
    const onBgClick = (e) => { if (e.target === modal.querySelector('.modal-bg')) onClose(); };

    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onClose);
    closeBtn.addEventListener('click', onClose);
    modal.addEventListener('click', onBgClick);

    function cleanup() {
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onClose);
      closeBtn.removeEventListener('click', onClose);
      modal.removeEventListener('click', onBgClick);
    }
  }

  function generateRotationDraft(days, groupData, rotStaff, containerId) {
    if (days.length === 0) return;
    if (rotStaff.length === 0) return;
    const len = rotStaff.length;

    if (containerId === 'rotation-table-weekday') {
      let seedIdx = -1;
      for (let di = days.length - 1; di >= 0; di--) {
        const hasAny = rotStaff.some(s => groupData[s.id] && groupData[s.id][days[di].date]);
        if (hasAny) { seedIdx = di; break; }
      }

      const seedPattern = [];
      if (seedIdx >= 0) {
        rotStaff.forEach((s, idx) => {
          const code = groupData[s.id] && groupData[s.id][days[seedIdx].date];
          if (code) seedPattern.push({ offset: idx, code });
        });
      } else {
        WEEKDAY_QUICK_PATTERN.forEach((code, idx) => {
          if (code) seedPattern.push({ offset: idx, code });
        });
      }
      if (seedPattern.length === 0) return;

      const startFrom = seedIdx >= 0 ? seedIdx + 1 : 0;
      const baseIdx = seedIdx >= 0 ? seedIdx : 0;
      for (let di = startFrom; di < days.length; di++) {
        const d = days[di];
        const hasAny = rotStaff.some(s => groupData[s.id] && groupData[s.id][d.date]);
        if (hasAny) continue;

        const shift = di - baseIdx;
        seedPattern.forEach(p => {
          const s = rotStaff[(p.offset + shift) % len];
          if (!groupData[s.id]) groupData[s.id] = {};
          groupData[s.id][d.date] = p.code;
        });
      }

      renderRotationTable(containerId, days, groupData);
      return;
    }

    function extractPattern(seedIdx) {
      const pattern = [];
      let starOff = -1;
      rotStaff.forEach((s, idx) => {
        const code = groupData[s.id] && groupData[s.id][days[seedIdx].date];
        if (!code) return;
        if (code === '休*') { starOff = idx; }
        else { pattern.push({ offset: idx, code }); }
      });
      return { pattern, starOff, seedIdx };
    }

    const hasSundayInDays = days.some(d => d.dow === 0);
    const hasNonSundayInDays = days.some(d => d.dow !== 0);

    // Find last filled Saturday (or holiday) seed AND last filled Sunday seed
    let satSeed = null, sunSeed = null;
    for (let di = days.length - 1; di >= 0; di--) {
      const d = days[di];
      const hasAny = rotStaff.some(s => groupData[s.id] && groupData[s.id][d.date]);
      if (!hasAny) continue;
      const isSunday = d.dow === 0;
      if (isSunday && !sunSeed) { sunSeed = extractPattern(di); }
      else if (!isSunday && !satSeed) { satSeed = extractPattern(di); }
      if ((satSeed || !hasNonSundayInDays) && (sunSeed || !hasSundayInDays)) break;
    }

    if (!satSeed && !sunSeed) return;

    // Derive Sunday from Saturday if needed
    if (!sunSeed && satSeed && hasSundayInDays) {
      const sundayCodes = new Set(['N','E','1']);
      sunSeed = {
        pattern: satSeed.pattern.filter(p => sundayCodes.has(p.code)),
        starOff: satSeed.starOff >= 0 ? satSeed.starOff : ((Math.max(...satSeed.pattern.map(p => p.offset), -1) + 1) % len),
        seedIdx: satSeed.seedIdx,
      };
    }
    // If only Sunday seed exists, derive Saturday from it
    if (!satSeed && sunSeed) {
      satSeed = { pattern: sunSeed.pattern.filter(p => p.code !== '休*'), starOff: -1, seedIdx: sunSeed.seedIdx };
    }

    // Find the earliest seed index to start generating from
    const startFrom = Math.min(
      satSeed ? satSeed.seedIdx : Infinity,
      sunSeed ? sunSeed.seedIdx : Infinity
    );

    for (let di = startFrom + 1; di < days.length; di++) {
      const d = days[di];
      const isSunday = d.dow === 0;
      // Skip if this day already has data
      const hasAny = rotStaff.some(s => groupData[s.id] && groupData[s.id][d.date]);
      if (hasAny) continue;

      if (isSunday && sunSeed) {
        const shift = di - sunSeed.seedIdx;
        sunSeed.pattern.forEach(p => {
          const s = rotStaff[(p.offset + shift) % len];
          if (!groupData[s.id]) groupData[s.id] = {};
          groupData[s.id][d.date] = p.code;
        });
        if (sunSeed.starOff >= 0) {
          const s = rotStaff[(sunSeed.starOff + shift) % len];
          if (!groupData[s.id]) groupData[s.id] = {};
          groupData[s.id][d.date] = '休*';
        }
      } else if (satSeed) {
        const shift = di - satSeed.seedIdx;
        satSeed.pattern.forEach(p => {
          const s = rotStaff[(p.offset + shift) % len];
          if (!groupData[s.id]) groupData[s.id] = {};
          groupData[s.id][d.date] = p.code;
        });
      }
    }

    renderRotationTable(containerId, days, groupData);
  }

  function renderRotationTable(containerId, days, groupData) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    const isWeekdayDraft = containerId === 'rotation-table-weekday';
    const isNational = containerId === 'rotation-table-national';
    if (days.length === 0) {
      const p = document.createElement('p');
      p.className = 'rotation-empty';
      p.textContent = isWeekdayDraft ? '本月無平日'
        : (isNational ? '本月無國定／連假' : '本月無普通假日');
      container.appendChild(p);
      return;
    }

    const canReorderStaff = !isWeekdayDraft;
    const displayStaff = canReorderStaff ? orderedDraftStaff(groupData) : state.staff;
    const currentActiveStaff = () => displayStaff.filter(s => isDraftStaffActive(groupData, s));
    if (displayStaff.length === 0) return;

    // Quick-fill state for this table
    const quickFill = { active: false, dayDate: null, idx: 0 };

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'rot-toolbar';

    const draftBtn = document.createElement('button');
    draftBtn.textContent = '產生底稿';
    draftBtn.title = '從最後填的日期往後輪轉';
    draftBtn.className = 'rot-draft-btn';
    draftBtn.addEventListener('click', () => {
      generateRotationDraft(days, groupData, currentActiveStaff(), containerId);
    });
    toolbar.appendChild(draftBtn);

    const quickBtn = document.createElement('button');
    quickBtn.textContent = '快速填入';
    quickBtn.title = isWeekdayDraft
      ? '平日：1→中→2→A→3→7→E→N→△'
      : '六/國定/連假（非日）：中→E→N→1→2 ／ 日：休*→N→E→1';
    quickBtn.className = 'rot-quick-btn';
    quickBtn.addEventListener('click', () => {
      quickFill.active = !quickFill.active;
      quickBtn.classList.toggle('active', quickFill.active);
      quickFill.idx = 0;
      quickFill.dayDate = null;
    });
    toolbar.appendChild(quickBtn);

    container.appendChild(toolbar);

    // Stats helper
    const hasSunday = days.some(d => d.dow === 0);
    const hasNonSunday = days.some(d => d.dow !== 0);
    const statCodes = isWeekdayDraft
      ? WEEKDAY_ROT_CODES
      : isNational
      ? [...(hasNonSunday ? ['E','中','N','1','2'] : []), ...(hasSunday ? ['休*'] : [])]
      : ROT_CODES;
    function computeRotStats(staffId) {
      const out = {};
      statCodes.forEach(c => { out[c] = 0; });
      days.forEach(d => {
        const c = groupData[staffId] && groupData[staffId][d.date];
        if (c && out[c] !== undefined) out[c]++;
      });
      return out;
    }

    const wrap = document.createElement('div');
    wrap.className = 'rotation-table-wrap';
    const tbl = document.createElement('table');
    tbl.className = 'rotation-table';
    let suppressNameClick = false;

    // thead
    const thead = document.createElement('thead');
    const headTr = document.createElement('tr');
    const nameHead = document.createElement('th');
    nameHead.className = 'rot-name';
    nameHead.textContent = '姓名';
    headTr.appendChild(nameHead);
    days.forEach(d => {
      const th = document.createElement('th');
      if (d.isHoliday) th.className = 'rot-holiday';
      else if (d.dow === 0) th.className = 'rot-sun';
      else if (d.dow === 6) th.className = 'rot-sat';
      th.textContent = `${d.month}/${d.day} ${DOW_LABEL[d.dow]}`;
      if (d.holidayName) th.title = d.holidayName;
      headTr.appendChild(th);
    });
    statCodes.forEach(code => {
      const th = document.createElement('th');
      th.className = 'rot-stat-head';
      renderCode(th, code);
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);

    // Date action row (clear single date / clear from date onwards)
    const actionTr = document.createElement('tr');
    actionTr.className = 'rot-action-row';
    const actionLabel = document.createElement('th');
    actionLabel.className = 'rot-name';
    actionTr.appendChild(actionLabel);
    days.forEach((d, di) => {
      const th = document.createElement('th');
      th.className = 'rot-action-cell';
      const clearOne = document.createElement('button');
      clearOne.className = 'rot-col-btn';
      clearOne.title = '清空此日';
      clearOne.textContent = '×';
      clearOne.addEventListener('click', (e) => {
        e.stopPropagation();
        displayStaff.forEach(s => { if (groupData[s.id]) delete groupData[s.id][d.date]; });
        renderRotationTable(containerId, days, groupData);
      });
      const clearAfter = document.createElement('button');
      clearAfter.className = 'rot-col-btn';
      clearAfter.title = '清空此日及之後';
      clearAfter.textContent = '×→';
      clearAfter.addEventListener('click', (e) => {
        e.stopPropagation();
        for (let j = di; j < days.length; j++) {
          displayStaff.forEach(s => { if (groupData[s.id]) delete groupData[s.id][days[j].date]; });
        }
        renderRotationTable(containerId, days, groupData);
      });
      th.appendChild(clearOne);
      th.appendChild(clearAfter);
      actionTr.appendChild(th);
    });
    statCodes.forEach(() => {
      actionTr.appendChild(document.createElement('th'));
    });
    thead.appendChild(actionTr);

    tbl.appendChild(thead);

    // tbody
    const tbody = document.createElement('tbody');
    displayStaff.forEach((s, rowIdx) => {
      const isActive = isDraftStaffActive(groupData, s);
      const tr = document.createElement('tr');
      tr.dataset.staffId = s.id;
      if (!isActive) tr.classList.add('rot-inactive');
      if (s.fixedShift) tr.classList.add('rot-fixed');
      if (canReorderStaff) tr.classList.add('rot-reorderable');
      const nameTd = document.createElement('td');
      nameTd.className = 'rot-name';
      nameTd.textContent = s.name;
      nameTd.title = s.fixedShift ? `${s.name} 是固定班，不參與底稿輪換`
        : `${s.name}：${isActive ? '有參與此區底稿' : '未參與此區底稿'}，點姓名切換`;
      if (canReorderStaff) {
        nameTd.title += '；拖曳姓名可調整此區排序';
        nameTd.setAttribute('draggable', 'true');
      }
      nameTd.addEventListener('click', (e) => {
        e.stopPropagation();
        if (suppressNameClick) return;
        toggleDraftStaff(groupData, s);
        renderRotationTable(containerId, days, groupData);
      });
      if (canReorderStaff) {
        nameTd.addEventListener('dragstart', (e) => {
          suppressNameClick = true;
          tr.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', s.id);
        });
        nameTd.addEventListener('dragend', () => {
          tr.classList.remove('dragging');
          tbody.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
          setTimeout(() => { suppressNameClick = false; }, 0);
        });
        tr.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          tbody.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
          tr.classList.add('drop-target');
        });
        tr.addEventListener('dragleave', () => {
          tr.classList.remove('drop-target');
        });
        tr.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const fromId = e.dataTransfer.getData('text/plain');
          tbody.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
          if (reorderDraftStaff(groupData, fromId, s.id, displayStaff)) {
            renderRotationTable(containerId, days, groupData);
          }
        });
      }
      tr.appendChild(nameTd);

      days.forEach(d => {
        const td = document.createElement('td');
        td.className = 'rot-cell';
        const code = groupData[s.id] && groupData[s.id][d.date];
        if (code) {
          renderCode(td, code);
          td.classList.add(`shift-${code}`);
        }
        td.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!isDraftStaffActive(groupData, s)) return;
          if (quickFill.active) {
            if (quickFill.dayDate !== d.date) { quickFill.dayDate = d.date; quickFill.idx = 0; }
            const seq = isWeekdayDraft ? WEEKDAY_QUICK_PATTERN : (d.dow === 0 ? ['休*','N','E','1'] : ['中','E','N','1','2']);
            if (quickFill.idx < seq.length) {
              const code = seq[quickFill.idx];
              if (code) {
                if (!groupData[s.id]) groupData[s.id] = {};
                groupData[s.id][d.date] = code;
                renderCode(td, code);
                td.className = 'rot-cell shift-' + code;
              } else {
                if (groupData[s.id]) delete groupData[s.id][d.date];
                td.textContent = '';
                td.className = 'rot-cell';
              }
              quickFill.idx++;
              updateStats();
              updateReqRow();
            }
          } else {
            openRotationPopover(td, s, d, groupData, () => { updateStats(); updateReqRow(); }, statCodes);
          }
        });
        tr.appendChild(td);
      });

      // Stats cells
      const stats = isActive ? computeRotStats(s.id) : {};
      statCodes.forEach(code => {
        const statTd = document.createElement('td');
        statTd.className = 'rot-stat';
        statTd.textContent = stats[code] || '';
        tr.appendChild(statTd);
      });

      tbody.appendChild(tr);
    });

    // Validation row
    const reqTr = document.createElement('tr');
    reqTr.className = 'rot-req-row';
    const reqLabel = document.createElement('td');
    reqLabel.className = 'rot-name rot-req-label';
    reqLabel.textContent = '需求';
    reqTr.appendChild(reqLabel);
    days.forEach(d => {
      const td = document.createElement('td');
      td.className = 'rot-req-cell';
      const needed = isWeekdayDraft ? dayRequirements(d.dow, false) : (d.dow === 0 ? ['休*','N','E','1'] : ['中','E','N','1','2']);
      const count = {};
      let filled = 0;
      currentActiveStaff().forEach(s => {
        const c = groupData[s.id] && groupData[s.id][d.date];
        if (!c) return;
        count[c] = (count[c] || 0) + 1;
        filled++;
      });
      const missing = needed.filter(c => !count[c]);
      const duplicate = needed.filter(c => (count[c] || 0) > 1);
      if (missing.length === 0 && duplicate.length === 0 && filled > 0) {
        td.textContent = '✓';
        td.classList.add('rot-req-ok');
      } else if (filled > 0) {
        td.textContent = '✗';
        td.classList.add('rot-req-fail');
        td.title = formatRequirementIssues(missing, duplicate, count);
      }
      reqTr.appendChild(td);
    });
    statCodes.forEach(() => {
      reqTr.appendChild(document.createElement('td'));
    });
    tbody.appendChild(reqTr);

    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    container.appendChild(wrap);

    function updateStats() {
      const rows = tbody.querySelectorAll('tr:not(.rot-req-row)');
      rows.forEach((tr, ri) => {
        const s = displayStaff[ri];
        if (!s) return;
        const stats = isDraftStaffActive(groupData, s) ? computeRotStats(s.id) : {};
        const statCells = tr.querySelectorAll('.rot-stat');
        statCodes.forEach((code, ci) => {
          if (statCells[ci]) statCells[ci].textContent = stats[code] || '';
        });
      });
    }
    function updateReqRow() {
      const reqCells = reqTr.querySelectorAll('.rot-req-cell');
      days.forEach((d, di) => {
        const td = reqCells[di];
        if (!td) return;
        const needed = isWeekdayDraft ? dayRequirements(d.dow, false) : (d.dow === 0 ? ['休*','N','E','1'] : ['中','E','N','1','2']);
        const count = {};
        let filled = 0;
        currentActiveStaff().forEach(s => {
          const c = groupData[s.id] && groupData[s.id][d.date];
          if (!c) return;
          count[c] = (count[c] || 0) + 1;
          filled++;
        });
        const missing = needed.filter(c => !count[c]);
        const duplicate = needed.filter(c => (count[c] || 0) > 1);
        td.className = 'rot-req-cell';
        if (missing.length === 0 && duplicate.length === 0 && filled > 0) {
          td.textContent = '✓'; td.classList.add('rot-req-ok'); td.title = '';
        } else if (filled > 0) {
          td.textContent = '✗'; td.classList.add('rot-req-fail'); td.title = formatRequirementIssues(missing, duplicate, count);
        } else {
          td.textContent = ''; td.title = '';
        }
      });
    }
  }

  function openRotationPopover(td, staff, day, groupData, onChange, codes = ROT_CODES) {
    const pop = document.getElementById('shift-popover');
    pop.innerHTML = '';

    codes.forEach(code => {
      const b = document.createElement('button');
      renderCode(b, code);
      b.title = (SHIFT_MAP[code] && SHIFT_MAP[code].label) || code;
      b.className = `shift-${code}`;
      b.addEventListener('click', () => {
        if (!groupData[staff.id]) groupData[staff.id] = {};
        groupData[staff.id][day.date] = code;
        renderCode(td, code);
        td.className = 'rot-cell shift-' + code;
        pop.classList.add('hidden');
        if (onChange) onChange();
      });
      pop.appendChild(b);
    });
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '清空';
    clearBtn.className = 'clear-btn';
    clearBtn.addEventListener('click', () => {
      if (groupData[staff.id]) delete groupData[staff.id][day.date];
      td.textContent = '';
      td.className = 'rot-cell';
      pop.classList.add('hidden');
      if (onChange) onChange();
    });
    pop.appendChild(clearBtn);

    const rect = td.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    pop.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 260) + 'px';
    pop.classList.remove('hidden');

    setTimeout(() => {
      const onDocClick = (e) => {
        if (!pop.contains(e.target) && e.target !== td) {
          pop.classList.add('hidden');
          document.removeEventListener('click', onDocClick);
        }
      };
      document.addEventListener('click', onDocClick);
    }, 0);
  }

  // ===== 工具 =====
  function th(cls, text) {
    const el = document.createElement('th');
    el.className = cls;
    el.textContent = text;
    return el;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ===== 啟動 =====
  // 暴露給 prefs-stage.js / ui-extras.js 等附加模組使用
  window.appState = state;
  window.appRender = render;

  document.addEventListener('DOMContentLoaded', init);

})();
