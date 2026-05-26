// Tweaks — 三組會改變整體感受的排班視覺切換
(function () {
  const KEY = 'roster.tweaks';
  const DEFAULTS = /*EDITMODE-BEGIN*/{
    "color": "none",
    "density": "standard",
    "white": "full",
    "weekend": "subtle",
    "pref": "show"
  }/*EDITMODE-END*/;

  const TWEAK_DOMAINS = {
    color: ['none', 'pastel', 'vivid'],
    density: ['compact', 'standard', 'roomy'],
    white: ['full', 'faded', 'hidden'],
    weekend: ['subtle', 'strong'],
    pref: ['show', 'hide'],
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) {}
    return Object.assign({}, DEFAULTS);
  }

  function save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function apply(state) {
    const body = document.body;
    Object.keys(TWEAK_DOMAINS).forEach(key => {
      TWEAK_DOMAINS[key].forEach(v => body.classList.remove(`tw-${key}-${v}`));
      body.classList.add(`tw-${key}-${state[key]}`);
    });
  }

  function renderSegState(state) {
    document.querySelectorAll('#tweaks-panel .seg').forEach(seg => {
      const key = seg.dataset.tweak;
      seg.querySelectorAll('button').forEach(btn => {
        btn.classList.toggle('on', btn.dataset.value === state[key]);
      });
    });
  }

  const state = load();
  let panelVisible = false;

  function showPanel(v) {
    const panel = document.getElementById('tweaks-panel');
    if (!panel) return;
    panelVisible = v;
    panel.classList.toggle('hidden', !v);
    panel.setAttribute('aria-hidden', String(!v));
  }

  function init() {
    apply(state);
    renderSegState(state);

    document.querySelectorAll('#tweaks-panel .seg').forEach(seg => {
      const key = seg.dataset.tweak;
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const v = btn.dataset.value;
        if (!v || state[key] === v) return;
        state[key] = v;
        save(state);
        apply(state);
        renderSegState(state);
        try {
          window.parent.postMessage({
            type: '__edit_mode_set_keys',
            edits: { [key]: v }
          }, '*');
        } catch (e) {}
      });
    });

    const closeBtn = document.getElementById('btn-tweaks-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        showPanel(false);
        try { window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*'); } catch (e) {}
      });
    }

    // 本地開關鈕（在圖例列上）— 讓本地雙擊也能呼叫面板
    const openBtn = document.getElementById('btn-open-tweaks');
    if (openBtn) {
      openBtn.addEventListener('click', () => showPanel(!panelVisible));
    }

    window.addEventListener('message', (ev) => {
      const data = ev.data || {};
      if (data.type === '__activate_edit_mode') showPanel(true);
      else if (data.type === '__deactivate_edit_mode') showPanel(false);
    });

    try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
