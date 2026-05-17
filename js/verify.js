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

function validateFlow(y, m, flow) {
  const days = buildMonthStructure(y, m, {});
  const schedule = { year: y, month: m, days, assignments: {} };
  let snapshot = null;
  let draftCoverage = [];

  if (flow === 'init-repair') {
    Scheduler.initPatternDraft(schedule, staff, {});
    draftCoverage = typeCount(Validator.validate(schedule, staff), ['short-coverage', 'duplicate-coverage']);
    snapshot = snapshotHolidayPattern(schedule, days);
    Scheduler.repairSchedule(schedule, staff, {});
  } else {
    const draft = { year: y, month: m, days, assignments: {} };
    Scheduler.initPatternDraft(draft, staff, {});
    draftCoverage = typeCount(Validator.validate(draft, staff), ['short-coverage', 'duplicate-coverage']);
    snapshot = snapshotHolidayPattern(draft, days);
    Scheduler.autoFillV2(schedule, staff, {});
  }

  const errors = Validator.validate(schedule, staff);
  const guo = typeCount(errors, ['wrong-國-quota', 'circle-wrong-國-quota']);
  const coverage = typeCount(errors, ['short-coverage', 'duplicate-coverage']);
  const hard = typeCount(errors, [
    'N-prev-not-off-or-N',
    'N-next-triangle',
    'E-bad-next',
    '3-bad-next',
    'over-6-consec',
    'forbidden',
    'too-many-leave',
    'too-many-weekday-off',
    'holiday-white',
    'circle-invalid-staff',
    'circle-invalid-day',
  ]);
  const holidayLockedHard = hard.filter(e => errorInvolvesHolidayPattern(e, days));
  const ne = typeCount(errors, ['no-weekday-N', 'no-weekday-E']);
  const weekly = typeCount(errors, ['wrong-weekly-休-quota', 'wrong-weekly-例-quota']);

  process.stdout.write(`\n[${y}-${String(m).padStart(2, '0')}] ${flow}\n`);
  check('底稿每日特殊班缺/重複 0', draftCoverage.length === 0,
    draftCoverage.map(e => e.msg).join('; '));
  check('國月配額錯誤 0', guo.length === 0, guo.map(e => e.msg).join('; '));
  check('每日特殊班缺/重複 0', coverage.length === 0, coverage.map(e => e.msg).join('; '));
  process.stdout.write(`  validator 殘餘錯誤統計: weekly=${weekly.length}, hard=${hard.length}, holiday-hard=${holidayLockedHard.length}, N/E=${ne.length}\n`);

  if (snapshot) {
    const changed = holidayChanges(snapshot, schedule);
    check('假日底稿修班後不變', changed.length === 0,
      changed.slice(0, 5).map(([key]) => key).join('; '));
  }
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

function targetedHolidayLockTest() {
  const y = 2026;
  const m = 5;
  const days = buildMonthStructure(y, m, {});
  const schedule = { year: y, month: m, days, assignments: {} };
  Scheduler.initPatternDraft(schedule, staff, {});

  let chosen = null;
  for (const d of days) {
    if (d.rotationGroup !== 'regular' && d.rotationGroup !== 'national') continue;
    if (!dayRequirements(d.dow, d.isHoliday).includes('N')) continue;
    const forbidden = staff.find(s => !s.fixedShift && (s.forbidden || []).includes('N') &&
      schedule.assignments[s.id][d.date] !== 'N');
    const holder = staff.find(s => schedule.assignments[s.id][d.date] === 'N');
    if (forbidden && holder && holder.id !== forbidden.id) {
      chosen = { day: d, forbidden, holder };
      break;
    }
  }

  process.stdout.write('\n[targeted holiday lock]\n');
  if (!chosen) {
    check('測試資料可建立假日禁忌 N', false, '找不到可替換的假日 N');
    return;
  }

  const originalForbiddenCode = schedule.assignments[chosen.forbidden.id][chosen.day.date];
  schedule.assignments[chosen.forbidden.id][chosen.day.date] = 'N';
  schedule.assignments[chosen.holder.id][chosen.day.date] = originalForbiddenCode;

  Scheduler.repairSchedule(schedule, staff, {});
  const errors = Validator.validate(schedule, staff);
  const forbiddenError = errors.find(e =>
    e.type === 'forbidden' &&
    e.staffId === chosen.forbidden.id &&
    e.date === chosen.day.date);

  check('假日禁忌班修班後仍鎖定原格', schedule.assignments[chosen.forbidden.id][chosen.day.date] === 'N',
    `${chosen.forbidden.name} ${chosen.day.date}`);
  check('假日禁忌班仍由 validator 明確回報', Boolean(forbiddenError),
    forbiddenError ? forbiddenError.msg : '未回報 forbidden');
}

function targetedHolidayLeaveTest() {
  const y = 2026;
  const m = 5;
  const days = buildMonthStructure(y, m, {});

  const workSchedule = { year: y, month: m, days, assignments: {} };
  Scheduler.initPatternDraft(workSchedule, staff, {});
  let workCase = null;
  for (const d of days) {
    if (d.rotationGroup !== 'regular' && d.rotationGroup !== 'national') continue;
    const holder = rotationStaff.find(s => {
      const code = workSchedule.assignments[s.id][d.date];
      return code && !['休', '休*', '例', '國', '請', '白'].includes(code);
    });
    if (holder) {
      workCase = { day: d, staff: holder, code: workSchedule.assignments[holder.id][d.date] };
      break;
    }
  }

  process.stdout.write('\n[targeted holiday leave]\n');
  if (!workCase) {
    check('測試資料可找到假日工作班', false, '找不到假日工作班');
    return;
  }

  Scheduler.repairSchedule(workSchedule, staff, {
    [workCase.staff.id]: { [workCase.day.date]: '請' },
  });
  const workDiag = (workSchedule.diagnostics || []).find(d =>
    d.type === 'manual-holiday-leave-not-applied' &&
    d.staffId === workCase.staff.id &&
    d.date === workCase.day.date);
  check('假日工作班請假不改原班', workSchedule.assignments[workCase.staff.id][workCase.day.date] === workCase.code,
    `${workCase.staff.name} ${workCase.day.date} ${workCase.code}`);
  check('假日工作班請假會顯示未套用診斷', Boolean(workDiag),
    workDiag ? workDiag.msg : '未回報 manual-holiday-leave-not-applied');

  const restSchedule = { year: y, month: m, days, assignments: {} };
  Scheduler.initPatternDraft(restSchedule, staff, {});
  let restCase = null;
  for (const d of days) {
    if (d.rotationGroup !== 'regular' && d.rotationGroup !== 'national') continue;
    const holder = rotationStaff.find(s => ['休', '休*', '例', '國'].includes(restSchedule.assignments[s.id][d.date]));
    if (holder) {
      restCase = { day: d, staff: holder, code: restSchedule.assignments[holder.id][d.date] };
      break;
    }
  }

  if (!restCase) {
    check('測試資料可找到假日休例國', false, '找不到假日休例國');
    return;
  }

  Scheduler.repairSchedule(restSchedule, staff, {
    [restCase.staff.id]: { [restCase.day.date]: '請' },
  });
  const restDiag = (restSchedule.diagnostics || []).find(d =>
    d.staffId === restCase.staff.id &&
    d.date === restCase.day.date &&
    d.msg && d.msg.includes('手動需求「請」尚未套用'));
  check('休例國上寫請會保留原休假 token', restSchedule.assignments[restCase.staff.id][restCase.day.date] === restCase.code,
    `${restCase.staff.name} ${restCase.day.date} ${restCase.code}`);
  check('休例國上寫請不產生未套用錯誤', !restDiag,
    restDiag ? restDiag.msg : 'no manual leave failure');
}

MONTHS.forEach(({ y, m }) => {
  validateFlow(y, m, 'init-repair');
  validateFlow(y, m, 'autoFillV2');
});
targetedNETest();
targetedDraftOnlyTest();
targetedHolidayLockTest();
targetedHolidayLeaveTest();

process.stdout.write(`\nSUMMARY: ${total - failed}/${total} passed\n`);
process.exit(failed > 0 ? 1 : 0);
