// 自動驗證腳本：node js/verify.js（從專案根目錄執行）

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const jsDir = __dirname;
const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, process });
['data.js', 'calendar.js', 'validator.js', 'scheduler.js'].forEach(file => {
  vm.runInContext(fs.readFileSync(path.join(jsDir, file), 'utf8'), ctx, { filename: file });
});

const run = expr => vm.runInContext(expr, ctx);
const Scheduler = run('Scheduler');
const Validator = run('Validator');
const DEFAULT_STAFF = run('DEFAULT_STAFF');
const buildMonthStructure = run('buildMonthStructure');
const dayRequirements = run('dayRequirements');
const OFF_CODES = new Set(run('OFF_CODES'));

const MONTHS = [5, 6, 7, 8, 9, 10].map(m => ({ y: 2026, m }));
const staff = DEFAULT_STAFF;
const rotationStaff = staff.filter(s => !s.fixedShift);

let total = 0;
let failed = 0;

function check(label, pass, detail) {
  total++;
  if (!pass) failed++;
  const mark = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  process.stdout.write(`  ${label}: ${mark}${detail ? ` (${detail})` : ''}\n`);
}

function typeCount(errors, types) {
  const set = new Set(types);
  return errors.filter(e => set.has(e.type));
}

function snapshotHolidayPattern(schedule, days) {
  const out = {};
  days
    .filter(d => d.rotationGroup === 'regular' || d.rotationGroup === 'national')
    .forEach(d => {
      rotationStaff.forEach(s => {
        const val = schedule.assignments[s.id][d.date];
        // Only snapshot working shifts — rest token relabeling (休↔例) is acceptable.
        if (val && !OFF_CODES.has(val)) out[`${s.id}|${d.date}`] = val;
      });
    });
  return out;
}

function holidayChanges(snapshot, schedule) {
  return Object.entries(snapshot).filter(([key, before]) => {
    const [staffId, date] = key.split('|');
    return schedule.assignments[staffId][date] !== before;
  });
}

function errorDates(error, days) {
  if (!error || !error.date) return [];
  const idx = days.findIndex(d => d.date === error.date);
  if (idx < 0) return [error.date];

  if (error.type === 'N-prev-not-off-or-N') {
    return idx > 0 ? [error.date, days[idx - 1].date] : [error.date];
  }
  if (error.type === 'N-next-triangle' || error.type === 'E-bad-next' || error.type === '3-bad-next') {
    return idx + 1 < days.length ? [error.date, days[idx + 1].date] : [error.date];
  }
  return [error.date];
}

function isHolidayPatternDate(date, days) {
  const day = days.find(d => d.date === date);
  return Boolean(day && (day.rotationGroup === 'regular' || day.rotationGroup === 'national'));
}

function errorInvolvesHolidayPattern(error, days) {
  return errorDates(error, days).some(date => isHolidayPatternDate(date, days));
}

function validateFlow(y, m) {
  const days = buildMonthStructure(y, m, {});
  const schedule = { year: y, month: m, days, assignments: {} };
  Scheduler.initPatternDraft(schedule, staff, {});
  const snapshot = snapshotHolidayPattern(schedule, days);

  const errors = Validator.validate(schedule, staff);
  const guo = typeCount(errors, ['wrong-國-quota', 'circle-wrong-國-quota']);
  const coverage = typeCount(errors, ['short-coverage', 'duplicate-coverage']);
  const hard = typeCount(errors, [
    'N-prev-not-off-or-N', 'N-next-triangle', 'E-bad-next', '3-bad-next',
    'over-6-consec', 'forbidden', 'too-many-leave', 'too-many-weekday-off',
    'holiday-white', 'circle-invalid-staff', 'circle-invalid-day',
  ]);
  const weekly = typeCount(errors, ['wrong-weekly-休-quota', 'wrong-weekly-例-quota']);

  process.stdout.write(`\n[${y}-${String(m).padStart(2, '0')}] init-draft\n`);
  check('底稿每日特殊班缺/重複 0', coverage.length === 0, coverage.map(e => e.msg).join('; '));
  // guo/weekly/hard are expected to have violations at draft stage (CP-SAT repairs them)
  process.stdout.write(`  validator 殘餘錯誤統計: guo=${guo.length}, weekly=${weekly.length}, hard=${hard.length}\n`);
  const changed = holidayChanges(snapshot, schedule);
  check('假日底稿不被修改', changed.length === 0, changed.slice(0, 5).map(([key]) => key).join('; '));
}

function targetedNETest() {
  const y = 2026;
  const m = 7;
  const days = buildMonthStructure(y, m, {});
  const assignments = {};
  staff.forEach(s => {
    assignments[s.id] = {};
    days.forEach(d => {
      if (s.fixedShift) {
        assignments[s.id][d.date] = d.isHoliday ? '國' : d.dow === 6 ? '休' : d.dow === 0 ? '例' : s.fixedShift;
      } else {
        assignments[s.id][d.date] = d.isHoliday ? '國' : d.dow === 6 ? '休' : d.dow === 0 ? '例' : '白';
      }
    });
  });

  const errors = Validator.validate({ year: y, month: m, days, assignments }, staff);
  const ne = typeCount(errors, ['no-weekday-N', 'no-weekday-E']);
  const expectedN = staff.filter(s => !s.fixedShift && !(s.forbidden || []).includes('N')).length;
  const expectedE = staff.filter(s => !s.fixedShift && !(s.forbidden || []).includes('E')).length;
  const fixedOrForbidden = ne.filter(e => {
    const s = staff.find(x => x.id === e.staffId);
    return !s || s.fixedShift ||
      (e.type === 'no-weekday-N' && (s.forbidden || []).includes('N')) ||
      (e.type === 'no-weekday-E' && (s.forbidden || []).includes('E'));
  });

  process.stdout.write('\n[targeted N/E]\n');
  check('全白輪班表 N/E 不是 validator hard error (軟性)', ne.length === 0,
    `${ne.length} violations`);
}

function targetedDraftOnlyTest() {
  const y = 2026;
  const m = 5;
  const days = buildMonthStructure(y, m, {});
  const schedule = { year: y, month: m, days, assignments: {} };
  Scheduler.initPatternDraft(schedule, staff, {});
  const errors = Validator.validate(schedule, staff);
  const hard = typeCount(errors, [
    'N-prev-not-off-or-N',
    'N-next-triangle',
    'E-bad-next',
    '3-bad-next',
    'over-6-consec',
    'forbidden',
  ]);
  const coverage = typeCount(errors, ['short-coverage', 'duplicate-coverage']);

  process.stdout.write('\n[targeted draft-only]\n');
  check('產生底稿只填班且不預先清 hard error', hard.length > 0,
    hard.slice(0, 3).map(e => e.msg).join('; '));
  check('產生底稿仍完整填每日特殊班', coverage.length === 0,
    coverage.map(e => e.msg).join('; '));
}


MONTHS.forEach(({ y, m }) => {
  validateFlow(y, m);
});
targetedNETest();
targetedDraftOnlyTest();

process.stdout.write(`
SUMMARY: ${total - failed}/${total} passed
`);
process.exit(failed > 0 ? 1 : 0);
