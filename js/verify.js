// 自動驗證腳本：用 Node.js vm 載入所有 JS，對多個月份跑排班 + 驗證
// 用法：node js/verify.js（從專案根目錄執行）

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const jsDir = path.join(__dirname);
const ctx = vm.createContext({ console, process, setTimeout, clearTimeout });
['data.js','calendar.js','validator.js','scheduler.js'].forEach(f =>
  vm.runInContext(fs.readFileSync(path.join(jsDir, f), 'utf8'), ctx, { filename: f })
);

const run = expr => vm.runInContext(expr, ctx);
const { autoFillV2, repairSchedule } = run('Scheduler');
const { validate } = run('Validator');
const DEFAULT_STAFF = run('DEFAULT_STAFF');
const buildMonthStructure = run('buildMonthStructure');

const MONTHS = [
  { y: 2026, m: 5,  note: '1日勞動節（國定假日週五）' },
  { y: 2026, m: 6,  note: '1日週一，含端午 6/19' },
  { y: 2026, m: 8,  note: '1日週六（week1 無平日）' },
  { y: 2026, m: 9,  note: '含中秋 9/25、教師節 9/28' },
  { y: 2026, m: 10, note: '含國慶連假' },
];

const staff = DEFAULT_STAFF;
const rotationStaff = staff.filter(s => !s.fixedShift);
const effectiveWorkCode = run('effectiveWorkCode');
const weekdayCode = (assignments, staffId, days) => {
  const weekdays = days.filter(d => d.dow >= 1 && d.dow <= 5 && !d.isHoliday);
  let nN = 0, nE = 0;
  weekdays.forEach(d => {
    const c = (assignments[staffId] || {})[d.date];
    const wc = effectiveWorkCode(c);
    if (wc === 'N') nN++;
    if (wc === 'E') nE++;
  });
  return { nN, nE };
};

let totalChecks = 0, totalPass = 0, totalFail = 0;

function check(label, pass, detail) {
  totalChecks++;
  if (pass) {
    totalPass++;
    process.stdout.write(`  ${label}: \x1b[32mPASS\x1b[0m ${detail ? '(' + detail + ')' : ''}\n`);
  } else {
    totalFail++;
    process.stdout.write(`  ${label}: \x1b[31mFAIL\x1b[0m ${detail ? '— ' + detail : ''}\n`);
  }
}

MONTHS.forEach(({ y, m, note }) => {
  process.stdout.write(`\n[${y}-${String(m).padStart(2,'0')}] ${note}\n`);

  const days = buildMonthStructure(y, m, {});

  // 建空 schedule
  const emptyAssign = {};
  staff.forEach(s => { emptyAssign[s.id] = {}; });
  const schedule = { year: y, month: m, days, assignments: emptyAssign };

  // 底稿
  autoFillV2(schedule, staff, {});

  // 記錄底稿後假日快照
  const snapshot = {};
  days.filter(d => d.rotationGroup === 'regular' || d.rotationGroup === 'national')
    .forEach(d => {
      rotationStaff.forEach(s => {
        const key = `${s.id}|${d.date}`;
        snapshot[key] = (schedule.assignments[s.id] || {})[d.date];
      });
    });

  // 修班
  repairSchedule(schedule, staff, {});

  // 檢查 A：假日格子是否被改
  const changed = [];
  Object.entries(snapshot).forEach(([key, before]) => {
    const [sid, date] = key.split('|');
    const after = (schedule.assignments[sid] || {})[date];
    if (before !== after) changed.push({ sid, date, before, after });
  });
  check('A 假日格子不被修班改動', changed.length === 0,
    changed.length === 0
      ? `0 cells changed`
      : changed.map(c => `${c.sid} ${c.date}: ${c.before}→${c.after}`).join('; '));

  // 檢查 B：週配額無違規
  const errors = validate(schedule, staff);
  const quotaErrs = errors.filter(e =>
    e.type === 'wrong-weekly-休-quota' || e.type === 'wrong-weekly-例-quota');
  check('B 週配額驗證無違規', quotaErrs.length === 0,
    quotaErrs.length === 0 ? '0 weekly quota errors'
      : quotaErrs.map(e => e.msg).join('; '));

  // 檢查 C：validator 不報 N/E hard error
  const neErrs = errors.filter(e =>
    e.type === 'no-weekday-N' || e.type === 'no-weekday-E');
  check('C 不出現 N/E hard error', neErrs.length === 0,
    neErrs.length === 0 ? 'no hard N/E errors'
      : neErrs.map(e => e.msg).join('; '));

  // 檢查 D：N/E 軟性分佈統計
  let missing0N = 0, missing0E = 0;
  rotationStaff.forEach(s => {
    if ((s.forbidden || []).includes('N') && (s.forbidden || []).includes('E')) return;
      const { nN, nE } = weekdayCode(schedule.assignments, s.id, days);
    if (!(s.forbidden || []).includes('N') && nN === 0) missing0N++;
    if (!(s.forbidden || []).includes('E') && nE === 0) missing0E++;
  });
  process.stdout.write(
    `  D N/E 分佈: ${missing0N} 人缺平日-N，${missing0E} 人缺平日-E` +
    (missing0N + missing0E === 0 ? ' \x1b[32m✓\x1b[0m' : ' \x1b[33m(診斷)\x1b[0m') + '\n');
});

process.stdout.write(
  `\nSUMMARY: ${totalChecks} checks — ` +
  `\x1b[32mPASS: ${totalPass}\x1b[0m, ` +
  (totalFail > 0 ? `\x1b[31mFAIL: ${totalFail}\x1b[0m` : `FAIL: 0`) + '\n'
);
process.exit(totalFail > 0 ? 1 : 0);
