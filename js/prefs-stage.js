// 階段 ① 設定偏好 — 開啟一個偏好模式
// 在這個模式下：
//  - 點格子設定的內容會存進 state.constraints（沿用原有資料模型）
//  - 表格上方出現 banner，stepper 第 1 步高亮
//  - 側邊 drawer 列出目前所有偏好，可刪除
//  - 按「下一步 › 產生底稿」會關閉模式並觸發產生底稿
//
// 偏好不會清空現有底稿；如果還沒產生過底稿就會以全空白格開始。

(function () {
  let active = false;

  function $(id) { return document.getElementById(id); }

  function setActive(on) {
    active = on;
    document.body.classList.toggle('prefs-mode', on);
    const banner = $('prefs-banner');
    const drawer = $('prefs-drawer');
    if (banner) banner.classList.toggle('hidden', !on);
    if (drawer) {
      drawer.classList.toggle('hidden', !on);
      drawer.setAttribute('aria-hidden', on ? 'false' : 'true');
    }
    if (window.Stepper) window.Stepper.mark(on ? 'prefs' : null);
    // 進偏好模式 → 重新 render（會走 prefsMode 分支，畫面清空只剩偏好格）
    if (typeof window.appRender === 'function') window.appRender();
    if (on) renderList();
  }

  function getConstraints() {
    return (window.appState && window.appState.constraints) || {};
  }
  function getStaff() {
    return (window.appState && window.appState.staff) || [];
  }
  function getDayMap() {
    const sched = window.appState && window.appState.schedule;
    if (!sched || !sched.days) return {};
    const out = {};
    sched.days.forEach(d => { out[d.date] = d; });
    return out;
  }

  function renderList() {
    const wrap = $('prefs-list');
    const countEl = $('prefs-count');
    if (!wrap) return;
    const constraints = getConstraints();
    const staff = getStaff();
    const dayMap = getDayMap();

    const items = [];
    staff.forEach(s => {
      const sc = constraints[s.id] || {};
      Object.keys(sc).sort().forEach(date => {
        items.push({
          staffId: s.id,
          staffName: s.name,
          date,
          code: sc[date],
          dayLabel: dayMap[date] ? `${dayMap[date].day}日` : date.slice(-2)
        });
      });
    });

    if (countEl) countEl.textContent = items.length ? `共 ${items.length} 項` : '尚未設定';

    if (!items.length) {
      wrap.innerHTML = `<div class="prefs-empty">尚未設定任何偏好。<br>點表格上的格子，挑選想上的班或請假類型。</div>`;
      return;
    }

    wrap.innerHTML = items.map(it => `
      <div class="prefs-row" data-staff="${it.staffId}" data-date="${it.date}">
        <span class="prefs-name">${escapeHtml(it.staffName)}</span>
        <span class="prefs-day">${it.dayLabel}</span>
        <span class="prefs-code shift-${escapeAttr(it.code)}">${escapeHtml(it.code)}</span>
        <button class="prefs-del" title="移除">×</button>
      </div>
    `).join('');

    wrap.querySelectorAll('.prefs-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const row = e.target.closest('.prefs-row');
        if (!row) return;
        const sid = row.dataset.staff;
        const date = row.dataset.date;
        const cs = getConstraints();
        if (cs[sid]) {
          delete cs[sid][date];
          if (typeof Constraints !== 'undefined' && window.appState) {
            Constraints.save(window.appState.year, window.appState.month, cs);
          }
          // 同步清空 schedule 那格
          const sched = window.appState && window.appState.schedule;
          if (sched && sched.assignments[sid]) {
            sched.assignments[sid][date] = null;
            try { localStorage.setItem(`roster.schedule.${window.appState.year}-${window.appState.month}`, JSON.stringify(sched)); } catch(e) {}
          }
          if (typeof window.appRender === 'function') window.appRender();
          renderList();
        }
      });
    });
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function escapeAttr(s) { return String(s).replace(/[^a-zA-Z0-9\u4e00-\u9fff*]/g,''); }

  function init() {
    const stepBtn = $('btn-set-prefs');
    const bannerNext = $('btn-banner-next');
    const closeBtn = $('btn-prefs-close');

    if (stepBtn) {
      stepBtn.addEventListener('click', () => setActive(!active));
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => setActive(false));
    }
    if (bannerNext) {
      bannerNext.addEventListener('click', () => {
        setActive(false);
        const initBtn = $('btn-init-draft');
        if (initBtn) initBtn.click();
      });
    }

    // 監聽偏好改動（app.js 在 setCell 時會更新 constraints）
    // 用 polling-lite：每次 schedule 重 render 後也 re-render list
    const origRender = window.appRender;
    if (typeof origRender === 'function') {
      window.appRender = function () {
        origRender.apply(this, arguments);
        if (active) renderList();
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.PrefsStage = { setActive, isActive: () => active, renderList };
})();
