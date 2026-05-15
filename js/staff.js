// 人員管理：CRUD、排序、持久化

const Staff = (() => {
  const ORDER_MIGRATION_KEY = 'sr_staff_order_20260513_v1';
  const PREFERRED_ORDER = [
    'caimh',
    'sjuan',
    'chenyt',
    'liwj',
    'lixf',
    'linyy',
    'laiyh',
    'huangym',
    'caicc',
    'chenye',
    'xiemq',
    'wupc',
    'yangyy',
    'linyh',
    'qiupr',
    'linzt',
    'huangyy',
    'huangwl',
    'linc',
    'liaosq',
    'huangwl2',
    'zhuangcq',
  ];

  function load() {
    const raw = localStorage.getItem(LS_KEYS.staff);
    if (!raw) {
      const init = DEFAULT_STAFF.map(s => ({...s}));
      save(init);
      return init;
    }
    try {
      const list = JSON.parse(raw);
      return migrateOrderOnce(list);
    } catch (e) {
      console.warn('staff parse failed, reseting');
      const init = DEFAULT_STAFF.map(s => ({...s}));
      save(init);
      return init;
    }
  }

  function save(list) {
    localStorage.setItem(LS_KEYS.staff, JSON.stringify(list));
  }

  function migrateOrderOnce(list) {
    if (localStorage.getItem(ORDER_MIGRATION_KEY) === '1') return list;
    const order = new Map(PREFERRED_ORDER.map((id, idx) => [id, idx]));
    const next = [...list].sort((a, b) => {
      const ai = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
      const bi = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return list.indexOf(a) - list.indexOf(b);
    });
    save(next);
    localStorage.setItem(ORDER_MIGRATION_KEY, '1');
    return next;
  }

  function reset() {
    const init = DEFAULT_STAFF.map(s => ({...s}));
    save(init);
    return init;
  }

  function add(list, { name, fixedShift, forbidden, note }) {
    const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
    const item = { id, name: (name||'未命名').trim() };
    if (fixedShift) item.fixedShift = fixedShift;
    if (forbidden && forbidden.length) item.forbidden = forbidden;
    if (note) item.note = note;
    const next = list.concat(item);
    save(next);
    return next;
  }

  function remove(list, id) {
    const next = list.filter(s => s.id !== id);
    save(next);
    return next;
  }

  function update(list, id, patch) {
    const next = list.map(s => s.id === id ? { ...s, ...patch } : s);
    save(next);
    return next;
  }

  function reorder(list, fromId, toId) {
    if (fromId === toId) return list;
    const next = [...list];
    const fromIdx = next.findIndex(s => s.id === fromId);
    const toIdx   = next.findIndex(s => s.id === toId);
    if (fromIdx < 0 || toIdx < 0) return list;
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    save(next);
    return next;
  }

  return { load, save, reset, add, remove, update, reorder };
})();
