/**
 * ShiftConfigUI
 *
 * 班別設定 Modal 的 UI 邏輯。
 * 四個 Tab：班別列表 / 每日需求 / 接班規則 / 派班優先
 *
 * 依賴：ShiftConfigManager（shift-config.js）、app.js 的 render()
 */
const ShiftConfigUI = (() => {

  let _working = null;   // modal 開著時的 workingCopy（deep clone）
  const DAY_TYPES = [
    { key: 'weekday',  label: '平日（一～五）' },
    { key: 'saturday', label: '週六' },
    { key: 'sunday',   label: '週日' },
    { key: 'holiday',  label: '國定假日' },
  ];

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------
  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls)  e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function workingShiftMap() {
    const m = {};
    _working.shifts.forEach(s => { m[s.code] = s; });
    return m;
  }

  // ------------------------------------------------------------------
  // Tab 切換
  // ------------------------------------------------------------------
  function setupTabs() {
    document.querySelectorAll('#sc-tabs .sc-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#sc-tabs .sc-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderTab(btn.dataset.tab);
      });
    });
  }

  function renderTab(tab) {
    const content = document.getElementById('sc-content');
    content.innerHTML = '';
    if (tab === 'shifts')     renderShiftsTab(content);
    if (tab === 'daily-reqs') renderDailyReqsTab(content);
    if (tab === 'sequence')   renderSequenceTab(content);
    if (tab === 'priority')   renderPriorityTab(content);
  }

  function activeTab() {
    const btn = document.querySelector('#sc-tabs .sc-tab-btn.active');
    return btn ? btn.dataset.tab : 'shifts';
  }

  // ------------------------------------------------------------------
  // Tab 1：班別列表
  // ------------------------------------------------------------------
  function renderShiftsTab(container) {
    const wrap = el('div', 'sc-shifts-wrap');

    // 表頭
    const header = el('div', 'sc-shift-row sc-shift-header');
    ['代碼','名稱','種類','複合班（消耗配額/算作）','兜底','操作'].forEach(h => {
      header.appendChild(el('span', '', h));
    });
    wrap.appendChild(header);

    // 每一列
    _working.shifts.forEach((s, idx) => {
      wrap.appendChild(buildShiftRow(s, idx));
    });

    // 新增按鈕
    const addBtn = el('button', 'sc-add-btn', '＋ 新增班別');
    addBtn.addEventListener('click', () => {
      _working.shifts.push({
        code: '', label: '', kind: 'work',
        restQuota: null, workCode: null,
        circle: false, isDefault: false, isFallback: false,
      });
      renderTab('shifts');
    });
    wrap.appendChild(addBtn);
    container.appendChild(wrap);
  }

  function buildShiftRow(s, idx) {
    const row = el('div', 'sc-shift-row' + (s.isDefault ? ' sc-default' : ''));

    // 代碼
    const codeInput = el('input');
    codeInput.value = s.code;
    codeInput.placeholder = '例：早';
    codeInput.maxLength = 3;
    codeInput.disabled = s.isDefault;
    codeInput.addEventListener('input', () => { s.code = codeInput.value.trim(); });
    row.appendChild(codeInput);

    // 名稱
    const labelInput = el('input');
    labelInput.value = s.label;
    labelInput.placeholder = '顯示名稱';
    labelInput.addEventListener('input', () => { s.label = labelInput.value; });
    row.appendChild(labelInput);

    // 種類
    const kindSel = el('select');
    [['work','工作班'],['off','休假班']].forEach(([v, t]) => {
      const o = el('option', '', t);
      o.value = v;
      if (s.kind === v) o.selected = true;
      kindSel.appendChild(o);
    });
    kindSel.disabled = s.isDefault;
    kindSel.addEventListener('change', () => { s.kind = kindSel.value; });
    row.appendChild(kindSel);

    // 複合班（restQuota / workCode）
    const compoundWrap = el('span', 'sc-compound');
    if (s.kind === 'work') {
      const rqSel = el('select', 'sc-rq');
      [['','—'],['休','扣休'],['例','扣例'],['國','扣國']].forEach(([v, t]) => {
        const o = el('option', '', t); o.value = v;
        if ((s.restQuota||'') === v) o.selected = true;
        rqSel.appendChild(o);
      });
      rqSel.addEventListener('change', () => { s.restQuota = rqSel.value || null; });
      compoundWrap.appendChild(rqSel);

      const wcInput = el('input');
      wcInput.className = 'sc-wc';
      wcInput.value = s.workCode || '';
      wcInput.placeholder = '算作哪班';
      wcInput.maxLength = 3;
      wcInput.addEventListener('input', () => { s.workCode = wcInput.value.trim() || null; });
      compoundWrap.appendChild(wcInput);
    } else {
      compoundWrap.textContent = '—';
    }
    row.appendChild(compoundWrap);

    // 兜底班 radio
    const fbRadio = document.createElement('input');
    fbRadio.type = 'radio';
    fbRadio.name = 'isFallback';
    fbRadio.checked = s.isFallback;
    fbRadio.disabled = s.kind !== 'work';
    fbRadio.addEventListener('change', () => {
      if (fbRadio.checked) {
        _working.shifts.forEach(sh => { sh.isFallback = false; });
        s.isFallback = true;
      }
    });
    row.appendChild(fbRadio);

    // 操作
    const ops = el('span', 'sc-ops');
    if (!s.isDefault) {
      const delBtn = el('button', 'sc-del-btn', '刪除');
      delBtn.addEventListener('click', () => {
        _working.shifts.splice(idx, 1);
        renderTab('shifts');
      });
      ops.appendChild(delBtn);
    } else {
      ops.appendChild(el('span', 'sc-default-label', '內建'));
    }
    row.appendChild(ops);

    return row;
  }

  // ------------------------------------------------------------------
  // Tab 2：每日需求
  // ------------------------------------------------------------------
  function renderDailyReqsTab(container) {
    DAY_TYPES.forEach(({ key, label }) => {
      const section = el('div', 'sc-section');
      section.appendChild(el('h3', 'sc-section-title', label));

      const entries = _working.dailyReqs[key] || [];

      // 每一列
      entries.forEach((entry, idx) => {
        section.appendChild(buildReqRow(key, entry, idx));
      });

      // 新增按鈕
      const addBtn = el('button', 'sc-add-btn', '＋ 新增需求班別');
      addBtn.addEventListener('click', () => {
        (_working.dailyReqs[key] = _working.dailyReqs[key] || []).push({ code: '', count: 1 });
        renderTab('daily-reqs');
      });
      section.appendChild(addBtn);
      container.appendChild(section);
    });
  }

  function buildReqRow(dayTypeKey, entry, idx) {
    const row = el('div', 'sc-req-row');

    // 班別選單
    const codeSel = el('select', 'sc-req-code');
    const wm = workingShiftMap();
    const blankOpt = el('option', '', '— 選班別 —'); blankOpt.value = ''; codeSel.appendChild(blankOpt);
    _working.shifts.filter(s => s.kind === 'work' && !s.isFallback).forEach(s => {
      const o = el('option', '', `${s.code}　${s.label}`); o.value = s.code;
      if (entry.code === s.code) o.selected = true;
      codeSel.appendChild(o);
    });
    codeSel.addEventListener('change', () => { entry.code = codeSel.value; });
    row.appendChild(codeSel);

    // 人數
    row.appendChild(el('span', '', '  需要'));
    const countInput = el('input', 'sc-req-count');
    countInput.type = 'number'; countInput.min = 1; countInput.max = 10;
    countInput.value = entry.count;
    countInput.addEventListener('input', () => { entry.count = Math.max(1, parseInt(countInput.value)||1); });
    row.appendChild(countInput);
    row.appendChild(el('span', '', '人'));

    // 刪除
    const delBtn = el('button', 'sc-del-btn', '刪除');
    delBtn.addEventListener('click', () => {
      _working.dailyReqs[dayTypeKey].splice(idx, 1);
      renderTab('daily-reqs');
    });
    row.appendChild(delBtn);

    return row;
  }

  // ------------------------------------------------------------------
  // Tab 3：接班規則
  // ------------------------------------------------------------------
  function renderSequenceTab(container) {
    const rules = _working.sequenceRules;

    Object.entries(rules).forEach(([fromCode, rule]) => {
      container.appendChild(buildSequenceRuleBlock(fromCode, rule, rules));
    });

    // 新增規則：選單取代 prompt
    const existing = new Set(Object.keys(rules));
    const candidates = _working.shifts.filter(s => s.kind === 'work' && !existing.has(s.code));

    const addRow = el('div', 'sc-seq-add-rule');
    const ruleSel = el('select', 'sc-seq-rule-sel');
    const blankOpt = el('option', '', candidates.length > 0 ? '— 選擇要設定規則的班別 —' : '（所有工作班均已設定）');
    blankOpt.value = '';
    ruleSel.appendChild(blankOpt);
    candidates.forEach(s => {
      const o = el('option', '', `${s.code}　${s.label}`);
      o.value = s.code;
      ruleSel.appendChild(o);
    });
    ruleSel.disabled = candidates.length === 0;

    const addBtn = el('button', 'sc-add-btn', '＋ 新增此班的接班規則');
    addBtn.disabled = candidates.length === 0;
    addBtn.addEventListener('click', () => {
      const code = ruleSel.value;
      if (!code) return;
      rules[code] = { allowedAfter: [] };
      renderTab('sequence');
    });

    addRow.appendChild(ruleSel);
    addRow.appendChild(addBtn);
    container.appendChild(addRow);
  }

  function buildSequenceRuleBlock(fromCode, rule, allRules) {
    const block = el('div', 'sc-seq-block');
    const def = workingShiftMap()[fromCode];
    const title = el('div', 'sc-seq-title');
    title.appendChild(el('span', '', `${fromCode}（${def ? def.label : '?'}）上完，隔天只能排：`));

    // 刪除此規則
    const delRuleBtn = el('button', 'sc-del-btn sc-del-rule', '刪除此規則');
    delRuleBtn.addEventListener('click', () => {
      delete allRules[fromCode];
      renderTab('sequence');
    });
    title.appendChild(delRuleBtn);
    block.appendChild(title);

    // 白名單 tags
    const tagsWrap = el('div', 'sc-seq-tags');
    (rule.allowedAfter || []).forEach((wc, i) => {
      const tag = el('span', 'sc-seq-tag');
      tag.textContent = wc;
      const rmBtn = el('button', 'sc-tag-rm', '×');
      rmBtn.addEventListener('click', () => {
        rule.allowedAfter.splice(i, 1);
        renderTab('sequence');
      });
      tag.appendChild(rmBtn);
      tagsWrap.appendChild(tag);
    });

    // 新增允許班別：選單（只列出還未加入的工作班）
    const allowedSet = new Set(rule.allowedAfter || []);
    const available = _working.shifts.filter(s => s.kind === 'work' && !allowedSet.has(s.code));
    if (available.length > 0) {
      const addWrap = el('span', 'sc-seq-add');
      const wcSel = el('select', 'sc-seq-sel');
      const blankOpt = el('option', '', '＋ 新增允許班別');
      blankOpt.value = '';
      wcSel.appendChild(blankOpt);
      available.forEach(s => {
        const o = el('option', '', `${s.code}　${s.label}`);
        o.value = s.code;
        wcSel.appendChild(o);
      });
      wcSel.addEventListener('change', () => {
        const code = wcSel.value;
        if (!code) return;
        if (!rule.allowedAfter.includes(code)) {
          rule.allowedAfter.push(code);
        }
        renderTab('sequence');
      });
      addWrap.appendChild(wcSel);
      tagsWrap.appendChild(addWrap);
    }
    block.appendChild(tagsWrap);

    const hint = el('p', 'sc-seq-hint', '※ 休假班永遠允許，不需列出。空白名單 = 無限制。');
    block.appendChild(hint);
    return block;
  }

  // ------------------------------------------------------------------
  // Tab 4：派班優先順序
  // ------------------------------------------------------------------
  function renderPriorityTab(container) {
    const list = el('ol', 'sc-priority-list');
    const priority = _working.draftPriority;

    priority.forEach((code, idx) => {
      const item = el('li', 'sc-priority-item');
      const def = workingShiftMap()[code];
      item.textContent = `${code}　${def ? def.label : '（未知班別）'}`;

      // 上移 / 下移
      const upBtn = el('button', 'sc-pri-btn', '▲');
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', () => {
        [priority[idx-1], priority[idx]] = [priority[idx], priority[idx-1]];
        renderTab('priority');
      });
      const dnBtn = el('button', 'sc-pri-btn', '▼');
      dnBtn.disabled = idx === priority.length - 1;
      dnBtn.addEventListener('click', () => {
        [priority[idx], priority[idx+1]] = [priority[idx+1], priority[idx]];
        renderTab('priority');
      });
      item.appendChild(upBtn);
      item.appendChild(dnBtn);
      list.appendChild(item);
    });

    const hint = el('p', 'sc-seq-hint', '僅影響底稿派班的優先順序，不影響實際約束。');
    container.appendChild(list);
    container.appendChild(hint);
  }

  // ------------------------------------------------------------------
  // 開啟 / 關閉 modal
  // ------------------------------------------------------------------
  function open() {
    _working = deepClone(ShiftConfigManager._config || ShiftConfigManager.buildDefault());
    document.getElementById('shift-config-modal').classList.remove('hidden');
    setupTabs();
    renderTab('shifts');
  }

  function close() {
    document.getElementById('shift-config-modal').classList.add('hidden');
    _working = null;
  }

  function save() {
    // 基本驗證
    const codes = _working.shifts.map(s => s.code.trim()).filter(Boolean);
    const unique = new Set(codes);
    if (unique.size !== codes.length) {
      alert('班別代碼有重複，請修正後再儲存');
      return;
    }
    const invalid = _working.shifts.filter(s => !s.code.trim() || !s.label.trim());
    if (invalid.length > 0) {
      alert('有班別代碼或名稱為空，請填寫後再儲存');
      return;
    }
    ShiftConfigManager.save(_working);

    // 通知 app.js 重新初始化（重建 STAT_CODES 等）
    if (typeof App !== 'undefined' && App.reinit) {
      App.reinit();
    } else {
      // fallback：reload
      window.location.reload();
    }
    close();
  }

  // ------------------------------------------------------------------
  // 初始化：綁定按鈕事件
  // ------------------------------------------------------------------
  function init() {
    document.getElementById('btn-shift-config').addEventListener('click', () => {
      // 關閉 more-menu
      document.getElementById('more-menu-pop').classList.add('hidden');
      open();
    });
    document.getElementById('btn-shift-config-close').addEventListener('click', close);
    document.getElementById('btn-sc-cancel').addEventListener('click', close);
    document.getElementById('btn-sc-save').addEventListener('click', save);
    document.getElementById('btn-sc-reset').addEventListener('click', () => {
      if (!confirm('確定要重設為系統預設值嗎？所有自訂班別設定將清除。')) return;
      _working = deepClone(ShiftConfigManager.buildDefault());
      renderTab(activeTab());
    });
    // 點背景關閉
    document.getElementById('shift-config-modal').querySelector('.modal-bg')
      .addEventListener('click', close);
  }

  // DOM ready 後初始化
  document.addEventListener('DOMContentLoaded', init);

  return { open, close };
})();
