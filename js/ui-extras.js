// Topbar workflow chip / drawer / more menu / stepper progress / auto rule check
(function () {
  // ── 更多選單 ──
  const moreBtn = document.getElementById('btn-more-menu');
  const morePop = document.getElementById('more-menu-pop');
  if (moreBtn && morePop) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      morePop.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!morePop.contains(e.target) && e.target !== moreBtn) {
        morePop.classList.add('hidden');
      }
    });
    morePop.addEventListener('click', () => morePop.classList.add('hidden'));
  }

  // ── 違規 chip + drawer ──
  const chip = document.getElementById('btn-violations-chip');
  const drawer = document.getElementById('violations-drawer');
  const violations = document.getElementById('violations');
  const closeBtn = document.getElementById('btn-violations-close');

  function setChip(kind, label) {
    if (!chip) return;
    chip.classList.remove('chip-idle', 'chip-ok', 'chip-warn');
    chip.classList.add(kind);
    const lbl = chip.querySelector('.chip-label');
    if (lbl) lbl.textContent = label;
  }

  function updateChip() {
    if (!chip || !violations) return;
    const hidden = violations.classList.contains('hidden');
    if (hidden) { setChip('chip-idle', '規則未檢查'); return; }
    const isOk = violations.classList.contains('ok');
    if (isOk) { setChip('chip-ok', '規則通過'); return; }
    const count = violations.querySelectorAll('li').length;
    setChip('chip-warn', count > 0 ? `${count} 條違規` : '有違規');
  }

  function toggleDrawer(force) {
    if (!drawer) return;
    const willOpen = typeof force === 'boolean' ? force : drawer.classList.contains('hidden');
    drawer.classList.toggle('hidden', !willOpen);
    drawer.setAttribute('aria-hidden', String(!willOpen));
  }

  if (chip) chip.addEventListener('click', () => toggleDrawer());
  if (closeBtn) closeBtn.addEventListener('click', () => toggleDrawer(false));

  if (violations) {
    new MutationObserver(() => {
      updateChip();
    }).observe(violations, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['class']
    });
    updateChip();
  }

  // ── 自動觸發規則檢查（debounce 800ms）──
  let ruleTimer = null;
  function scheduleRuleCheck() {
    clearTimeout(ruleTimer);
    ruleTimer = setTimeout(() => {
      if (typeof window.runRuleCheck === 'function') window.runRuleCheck();
    }, 800);
  }
  // 監看排班表 DOM 改變 → 觸發自動檢查
  const tbl = document.getElementById('schedule-table');
  if (tbl) {
    new MutationObserver(() => {
      // 偏好模式不檢查
      if (document.body.classList.contains('prefs-mode')) return;
      scheduleRuleCheck();
    }).observe(tbl, { childList: true, subtree: true, characterData: true });
  }

  // ── Stepper 進度狀態 ──
  const STEPS = {
    prefs: 'btn-set-prefs',
    draft: 'btn-init-draft',
    repair: 'btn-auto-fill',
    export: 'btn-export'
  };
  let currentStep = null;
  const indicator = document.querySelector('.workflow-steps .step-indicator');
  const stepsRoot = document.querySelector('.workflow-steps');

  function moveIndicator(targetEl) {
    if (!indicator || !stepsRoot || !targetEl) return;
    const parentRect = stepsRoot.getBoundingClientRect();
    const rect = targetEl.getBoundingClientRect();
    const left = rect.left - parentRect.left;
    indicator.style.width = rect.width + 'px';
    indicator.style.height = rect.height + 'px';
    indicator.style.transform = `translate(${left}px, -50%)`;
    indicator.classList.add('ready');
  }

  function mark(step) {
    currentStep = step;
    let activeEl = null;
    Object.entries(STEPS).forEach(([k, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('step-active', 'step-done');
      if (k === step) { el.classList.add('step-active'); activeEl = el; }
    });
    moveIndicator(activeEl);
  }
  // 視窗大小變動時重新對齊
  window.addEventListener('resize', () => {
    const active = document.querySelector('.workflow-steps .step.step-active');
    if (active) moveIndicator(active);
  });
  // 點任一步 → 設成 active（視覺）
  Object.entries(STEPS).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => mark(k));
  });
  // 預設：第 1 步 prefs 為 active
  mark('prefs');
  // 字型載入後 / next frame 再對齊一次
  requestAnimationFrame(() => {
    const active = document.querySelector('.workflow-steps .step.step-active');
    if (active) moveIndicator(active);
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      const active = document.querySelector('.workflow-steps .step.step-active');
      if (active) moveIndicator(active);
    });
  }

  window.Stepper = { mark };

  // ── 新增人員按鈕（位於表格底端）──
  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest('#btn-add-staff-row')) {
      const realBtn = document.getElementById('btn-add-staff');
      if (realBtn) realBtn.click();
    }
  });
})();
