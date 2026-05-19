// 班別代碼定義
const SHIFT_DEFS = [
  { code:'N',  label:'大夜N',  kind:'work' },
  { code:'E',  label:'小夜E',  kind:'work' },
  { code:'3',  label:'3-11',  kind:'work' },
  { code:'7',  label:'11-7',  kind:'work' },
  { code:'1',  label:'1班',    kind:'work' },
  { code:'2',  label:'2班',    kind:'work' },
  { code:'中', label:'中班',   kind:'work' },
  { code:'△', label:'三角',   kind:'work' },
  { code:'A',  label:'PCA',    kind:'work' },
  { code:'R',  label:'PAR',    kind:'work' },
  { code:'門', label:'門診',   kind:'work' },
  { code:'白', label:'白斑',   kind:'work' },
  { code:'休N', label:'休假上N', kind:'work', restQuota:'休', workCode:'N' },
  { code:'休E', label:'休假上E', kind:'work', restQuota:'休', workCode:'E' },
  { code:'◎',  label:'圈圈班', kind:'work', circle:true },
  { code:'休', label:'休',     kind:'off'  },
  { code:'休*', label:'休 (週日加班)', kind:'off'  },
  { code:'例', label:'例',     kind:'off'  },
  { code:'國', label:'國',     kind:'off'  },
  { code:'請', label:'請',     kind:'off'  },
  { code:'○', label:'休假占位', kind:'off'  },
];

const SHIFT_MAP = SHIFT_DEFS.reduce((m,s)=>{ m[s.code]=s; return m; }, {});
const WORK_CODES = SHIFT_DEFS.filter(s=>s.kind==='work').map(s=>s.code);
const OFF_CODES  = SHIFT_DEFS.filter(s=>s.kind==='off').map(s=>s.code);

function isRestWorkCode(code) {
  const def = SHIFT_MAP[code];
  return Boolean(def && def.restQuota && def.workCode);
}

function effectiveWorkCode(code) {
  const def = SHIFT_MAP[code];
  return (def && def.workCode) || code;
}

function isCircleShiftCode(code) {
  return code === '◎';
}

function isCircleStaff(staff) {
  return Boolean(staff && (staff.fixedShift === 'R' || staff.fixedShift === '門'));
}

function isCircleDay(day) {
  return Boolean(day && (day.isHoliday || day.dow === 0 || day.dow === 6 || day.rotationGroup === 'national'));
}

function isWeekdayRestCreditDay(day) {
  return Boolean(day && day.dow >= 1 && day.dow <= 5 && !day.isHoliday && day.rotationGroup !== 'national');
}

// 圈圈班放在週日(例日)/國定假日(國)時，那天的 例/國 被 ◎ 吃掉。
// 為維持月休例平衡，把同等數量的「休」改成「例」/「國」補回。
// circle 員工的「平日週六」自然只會是 休 或 ◎，出現 例/國 一律視為本函式產生的位移補償，
// 因此每次都先全部還原再重建，保證冪等、可隨 ◎ 增減自動修正。
function isCircleSwapSaturday(day) {
  return Boolean(day && day.dow === 6 && !day.isHoliday && day.rotationGroup !== 'national');
}

function normalizeCircleBalance(staffId, staffMember, assignments, constraints, days) {
  if (!isCircleStaff(staffMember)) return false;
  const row = assignments[staffId] || (assignments[staffId] = {});
  const con = constraints[staffId] || (constraints[staffId] = {});
  const before = {};
  days.forEach(d => { before[d.date] = row[d.date]; });

  const setVal = (date, val) => {
    if (row[date] === val) return;
    row[date] = val;
    con[date] = val;
  };

  // 1) 還原：所有「平日週六」的 例/國，以及平日(週一~五)的 例/國，皆為舊位移補償，先還原成 休
  days.forEach(d => {
    if (row[d.date] === '◎') return;
    if ((row[d.date] === '例' || row[d.date] === '國') &&
        (isCircleSwapSaturday(d) || isWeekdayRestCreditDay(d))) {
      setVal(d.date, '休');
    }
  });

  // 2) 計算被 ◎ 吃掉的 例 / 國 數量
  let need例 = 0, need國 = 0;
  const sunCircleIdx = new Set();
  days.forEach((d, i) => {
    if (row[d.date] !== '◎') return;
    if (d.dow === 0) { need例++; sunCircleIdx.add(i); }
    else if (d.isHoliday || d.rotationGroup === 'national') need國++;
  });

  // 3) 候選補償日：先「平日週六(休)」，且偏好「非週日◎同一週」的週六
  const sameWeekSat = new Set();
  sunCircleIdx.forEach(i => { if (i > 0 && days[i - 1].dow === 6) sameWeekSat.add(i - 1); });
  const satPool = [];
  days.forEach((d, i) => {
    if (isCircleSwapSaturday(d) && row[d.date] === '休') {
      satPool.push({ i, date: d.date, sameWeek: sameWeekSat.has(i) });
    }
  });
  satPool.sort((a, b) => (a.sameWeek === b.sameWeek ? a.i - b.i : (a.sameWeek ? 1 : -1)));

  // 後備：平日(週一~五)的「休」
  const weekdayPool = [];
  days.forEach(d => {
    if (isWeekdayRestCreditDay(d) && row[d.date] === '休') weekdayPool.push({ date: d.date });
  });

  const pool = satPool.concat(weekdayPool);
  let p = 0;
  for (let k = 0; k < need例 && p < pool.length; k++, p++) setVal(pool[p].date, '例');
  for (let k = 0; k < need國 && p < pool.length; k++, p++) setVal(pool[p].date, '國');

  return days.some(d => before[d.date] !== row[d.date]);
}

function restQuotaCode(code) {
  const def = SHIFT_MAP[code];
  if (def && def.restQuota) return def.restQuota;
  return code === '休*' ? '休' : code;
}

// 一天最多請假人數
const MAX_DAILY_LEAVE = 4;

// 每日「特殊班別名額」（不含白斑，白斑為兜底）
// 鍵 = day-of-week (0=Sunday..6=Saturday) ；國定假日 = 與週六同
const DAILY_REQS = {
  weekday : ['2','△','N','E','7','1','中','3','A'],
  saturday: ['E','中','N','1','2'],
  sunday  : ['N','E','1','休*'],
  holiday : ['E','中','N','1','2'],
};

function dayRequirements(dow, isHoliday) {
  if (dow === 0) return DAILY_REQS.sunday;
  if (isHoliday) return DAILY_REQS.holiday;
  if (dow === 6) return DAILY_REQS.saturday;
  return DAILY_REQS.weekday;
}

// 預設人員
const DEFAULT_STAFF = [
  { id:'caimh',   name:'蔡美華', fixedShift:'白', note:'每日固定白斑，不參與輪班' },
  { id:'sjuan',   name:'謝淑娟', fixedShift:'白', note:'每日固定白斑，不參與輪班' },
  { id:'chenyt',  name:'陳玥彤' },
  { id:'liwj',    name:'李文君', forbidden:['N','E'] },
  { id:'lixf',    name:'李秀芳' },
  { id:'linyy',   name:'林妍堉' },
  { id:'laiyh',   name:'賴鈺函' },
  { id:'huangym', name:'黃月美', forbidden:['N','E'] },
  { id:'caicc',   name:'蔡瓊慧' },
  { id:'chenye',  name:'陳妍恩' },
  { id:'xiemq',   name:'謝沐騏' },
  { id:'wupc',    name:'吳沛宸' },
  { id:'yangyy',  name:'楊于瑩' },
  { id:'linyh',   name:'林意惠' },
  { id:'qiupr',   name:'邱珮茹', forbidden:['N','E'] },
  { id:'linzt',   name:'林子庭' },
  { id:'huangyy', name:'黃有玉' },
  { id:'huangwl', name:'黃丸玲', forbidden:['N','E'] },
  { id:'linc',    name:'李唸慈' },
  { id:'liaosq',  name:'廖紹琪' },
  { id:'huangwl2',name:'黃文伶', fixedShift:'R', note:'每日固定 PAR' },
  { id:'zhuangcq',name:'莊筑琪', fixedShift:'門', note:'每日固定門診' },
];

// 台灣國定假日表（人事行政總處版本，重要日期；無法窮盡，使用者可在 UI 標記）
// key = 'YYYY-MM-DD'
const HOLIDAYS = {
  // 2025
  '2025-01-01':'元旦', '2025-01-27':'除夕補', '2025-01-28':'除夕',
  '2025-01-29':'初一', '2025-01-30':'初二', '2025-01-31':'初三',
  '2025-02-28':'和平紀念日', '2025-04-03':'兒童節彈休', '2025-04-04':'兒童節',
  '2025-04-05':'清明節', '2025-05-01':'勞動節', '2025-05-30':'端午節彈休',
  '2025-05-31':'端午節', '2025-09-29':'中秋節彈休', '2025-10-06':'中秋節',
  '2025-10-10':'國慶日',
  // 2026
  '2026-05-01': '勞動節',
  '2026-06-19': '端午節',
  '2026-09-25': '中秋節',
  '2026-09-28': '教師節',
  '2026-10-09': '國慶日補假',
  '2026-10-10': '國慶日',
  '2026-10-25': '光復節',
  '2026-10-26': '光復節補假',
  '2026-12-25': '行憲紀念日',
};

// 只用於顯示與「假日輪換」分組，不影響 isHoliday / 國配額。
const HOLIDAY_LABELS = {
  // 2026
  '2026-05-02': '勞動節連假',
  '2026-05-03': '勞動節連假',
  '2026-06-20': '端午節連假',
  '2026-06-21': '端午節連假',
  '2026-09-26': '中秋節連假',
  '2026-09-27': '中秋節連假',
  '2026-10-11': '國慶日連假',
  '2026-10-24': '光復節連假',
  '2026-12-26': '行憲紀念日連假',
  '2026-12-27': '行憲紀念日連假'
};

// LocalStorage keys
const LS_KEYS = {
  staff: 'sr_staff_v1',
  schedule: (y,m) => `sr_sched_${y}_${String(m).padStart(2,'0')}_v1`,
  constraints: (y,m) => `sr_constr_${y}_${String(m).padStart(2,'0')}_v1`,
  customHolidays: (y,m) => `sr_holi_${y}_${String(m).padStart(2,'0')}_v1`,
  rotation: (y) => `sr_rot_${y}_v1`,
};

const DOW_LABEL = ['日','一','二','三','四','五','六'];
