/**
 * ShiftConfigManager
 *
 * 管理使用者自訂班別設定（ShiftConfig），提供 runtime 查詢 API。
 * 所有消費方（scheduler.js、validator.js、app.js 等）從這裡取動態規則，
 * 不再直接讀 data.js 的 hardcode 常數。
 *
 * 載入順序：data.js → shift-config.js → 其他 js
 * 初始化：在 app.js 的 init() 最前面呼叫 ShiftConfigManager.init()
 */
const ShiftConfigManager = (() => {
  const LS_KEY = 'sr_shift_config_v1';

  let _config = null;   // 當前 config 物件
  let _shiftMap = {};   // code → shift def（自己維護，不用 data.js 的 SHIFT_MAP）
  let _offSet = new Set();
  let _specialWorkCodesSet = new Set();  // 在 dailyReqs 裡出現過的 work code
  let _ocWeekdaySet = new Set();         // 平日算入 OC 統計的 code
  let _ocHolidaySet = new Set();         // 假日算入 OC 統計的 code

  // 內建預設的 OC 統計歸屬（向下相容舊行為）
  const DEFAULT_OC_WEEKDAY = ['7', 'E', 'N', '△'];
  const DEFAULT_OC_HOLIDAY = ['1', '2', 'E', 'N', '休*'];

  // ------------------------------------------------------------------
  // 預設值：從 data.js 的 SHIFT_DEFS / DAILY_REQS 產生（向下相容）
  // ------------------------------------------------------------------
  function buildDefault() {
    return {
      version: 1,
      shifts: SHIFT_DEFS.map(d => ({
        code:       d.code,
        label:      d.label,
        kind:       d.kind,
        restQuota:  d.restQuota  || null,
        workCode:   d.workCode   || null,
        circle:     d.circle     || false,
        isDefault:  true,   // 標記為內建（供「重設預設值」與樣式使用，不再鎖定編輯）
        isFallback: d.code === '白',
        ocWeekday:  DEFAULT_OC_WEEKDAY.includes(d.code),
        ocHoliday:  DEFAULT_OC_HOLIDAY.includes(d.code),
      })),
      dailyReqs: {
        weekday:  DAILY_REQS.weekday.map( c => ({ code: c, count: 1 })),
        saturday: DAILY_REQS.saturday.map(c => ({ code: c, count: 1 })),
        sunday:   DAILY_REQS.sunday.map(  c => ({ code: c, count: 1 })),
        holiday:  DAILY_REQS.holiday.map( c => ({ code: c, count: 1 })),
      },
      sequenceRules: {
        'E': { allowedAfter: ['7', 'E'] },
        '3': { allowedAfter: ['7', '3'] },
      },
      draftPriority: ['N', 'E', '△', '3', '7', 'A', '中', '1', '2'],
    };
  }

  // ------------------------------------------------------------------
  // 從 config 建立 runtime 查詢結構
  // ------------------------------------------------------------------
  function _rebuild(cfg) {
    _config = cfg;
    _shiftMap = {};
    cfg.shifts.forEach(s => { _shiftMap[s.code] = s; });
    _offSet = new Set(cfg.shifts.filter(s => s.kind === 'off').map(s => s.code));

    // specialWorkCodes：所有在 dailyReqs 裡出現過的 code
    _specialWorkCodesSet = new Set();
    Object.values(cfg.dailyReqs).forEach(entries => {
      entries.forEach(e => _specialWorkCodesSet.add(e.code));
    });

    // OC 統計歸屬（平日 / 假日）
    _ocWeekdaySet = new Set(cfg.shifts.filter(s => s.ocWeekday).map(s => s.code));
    _ocHolidaySet = new Set(cfg.shifts.filter(s => s.ocHoliday).map(s => s.code));
  }

  // ------------------------------------------------------------------
  // load / save
  // ------------------------------------------------------------------
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1 && Array.isArray(parsed.shifts)) {
          _rebuild(parsed);
          return _config;
        }
      }
    } catch (e) {
      console.warn('[ShiftConfigManager] load failed, using default:', e);
    }
    const def = buildDefault();
    _rebuild(def);
    return _config;
  }

  function save(cfg) {
    _rebuild(cfg);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    } catch (e) {
      console.error('[ShiftConfigManager] save failed:', e);
    }
  }

  function init() {
    load();
  }

  // ------------------------------------------------------------------
  // 查詢 API
  // ------------------------------------------------------------------

  function getShifts() { return _config.shifts; }
  function getShiftMap() { return _shiftMap; }

  function getWorkCodes() {
    return _config.shifts.filter(s => s.kind === 'work').map(s => s.code);
  }
  function getOffCodes() {
    return _config.shifts.filter(s => s.kind === 'off').map(s => s.code);
  }
  function getOffSet() { return _offSet; }

  function getFallbackCode() {
    const f = _config.shifts.find(s => s.isFallback);
    return f ? f.code : '白';
  }

  /** 所有在 dailyReqs 中出現的 code（即需要排人的特殊班別） */
  function getSpecialWorkCodes() { return _specialWorkCodesSet; }

  /**
   * getDayRequirements(dow, isHoliday) → [{code, count}, ...]
   * 仍對外提供 string[] 版本供舊呼叫者使用（每個 count>1 的 code 重複出現）
   */
  function getDayRequirements(dow, isHoliday) {
    const key = dow === 0 ? 'sunday'
              : isHoliday  ? 'holiday'
              : dow === 6  ? 'saturday'
              :               'weekday';
    return _config.dailyReqs[key] || [];
  }

  /** 向下相容：返回 string[]（count>1 的 code 重複出現） */
  function getDayRequirementsCodes(dow, isHoliday) {
    const entries = getDayRequirements(dow, isHoliday);
    const result = [];
    entries.forEach(e => {
      for (let i = 0; i < e.count; i++) result.push(e.code);
    });
    return result;
  }

  /** 自訂的 effectiveWorkCode，使用自己的 _shiftMap */
  function effectiveWorkCode(code) {
    if (!code) return code;
    const d = _shiftMap[code];
    return (d && d.workCode) || code;
  }

  /**
   * isAllowedAfter(fromCode, nextCode) → bool
   * 上了 fromCode 班後，隔天排 nextCode 是否合法。
   * off codes 永遠允許；沒有規則 = 無限制。
   */
  function isAllowedAfter(fromCode, nextCode) {
    if (!nextCode || _offSet.has(nextCode)) return true;
    const rule = _config.sequenceRules[fromCode];
    if (!rule || !rule.allowedAfter || rule.allowedAfter.length === 0) return true;
    const nextWork = effectiveWorkCode(nextCode);
    return rule.allowedAfter.includes(nextWork);
  }

  function getDraftPriority() { return _config.draftPriority || []; }

  /** OC 統計：平日 / 假日是否算入（吃班別設定，預設沿用舊行為） */
  function isOcWeekday(code) { return _ocWeekdaySet.has(code); }
  function isOcHoliday(code) { return _ocHolidaySet.has(code); }

  /**
   * toApiPayload() → snake_case 格式的 shift_config，供 fetch body 使用
   */
  function toApiPayload() {
    if (!_config) return null;
    return {
      shifts: _config.shifts.map(s => ({
        code:       s.code,
        label:      s.label,
        kind:       s.kind,
        restQuota:  s.restQuota  || null,
        workCode:   s.workCode   || null,
        circle:     s.circle     || false,
        isDefault:  s.isDefault  || false,
        isFallback: s.isFallback || false,
      })),
      dailyReqs: _config.dailyReqs,
      sequenceRules: _config.sequenceRules,
      draftPriority: _config.draftPriority || [],
    };
  }

  // ------------------------------------------------------------------
  // 公開 API
  // ------------------------------------------------------------------
  return {
    init,
    load,
    save,
    buildDefault,
    getShifts,
    getShiftMap,
    getWorkCodes,
    getOffCodes,
    getOffSet,
    getFallbackCode,
    getSpecialWorkCodes,
    getDayRequirements,
    getDayRequirementsCodes,
    effectiveWorkCode,
    isAllowedAfter,
    getDraftPriority,
    isOcWeekday,
    isOcHoliday,
    toApiPayload,
    // 內部 _config 供 shift-config-ui.js 存取（讀取用）
    get _config() { return _config; },
  };
})();
