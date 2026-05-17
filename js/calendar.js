// 月份/日期相關的純函式

function pad2(n) { return String(n).padStart(2,'0'); }

function dateKey(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function daysInMonth(y, m) {
  // m: 1-12
  return new Date(y, m, 0).getDate();
}

function dayOfWeek(y, m, d) {
  // 0=Sun..6=Sat
  return new Date(y, m-1, d).getDay();
}

// 取得下一個月（依今天）
function nextMonth(today = new Date()) {
  const y = today.getFullYear();
  const m = today.getMonth() + 1; // 1-12
  if (m === 12) return { y: y+1, m: 1 };
  return { y, m: m+1 };
}

function shiftMonth({y,m}, delta) {
  let nm = m + delta;
  let ny = y;
  while (nm > 12) { nm -= 12; ny += 1; }
  while (nm < 1)  { nm += 12; ny -= 1; }
  return { y: ny, m: nm };
}

// 判斷某日是否為國定假日（內建表 + 使用者自定）
function isHolidayKey(dKey, customHolidays) {
  if (HOLIDAYS[dKey]) return true;
  if (customHolidays && customHolidays[dKey]) return true;
  return false;
}

function holidayName(dKey, customHolidays) {
  if (HOLIDAYS[dKey]) return HOLIDAYS[dKey];
  if (customHolidays && customHolidays[dKey]) return customHolidays[dKey];
  if (HOLIDAY_LABELS[dKey]) return HOLIDAY_LABELS[dKey];
  return null;
}

function isHolidayLabelKey(dKey) {
  return Boolean(HOLIDAY_LABELS[dKey]);
}

function rotationGroupForDate(dKey, dow, isHoliday) {
  if (isHoliday || isHolidayLabelKey(dKey)) return 'national';
  if (dow === 0 || dow === 6) return 'regular';
  return null;
}

// 建立空白月份結構
function buildMonthStructure(y, m, customHolidays) {
  const total = daysInMonth(y, m);
  const days = [];
  for (let d = 1; d <= total; d++) {
    const dow = dayOfWeek(y, m, d);
    const k = dateKey(y, m, d);
    const isHoliday = isHolidayKey(k, customHolidays);
    days.push({
      date: k,
      day: d,
      dow,
      isHoliday,
      holidayName: holidayName(k, customHolidays),
      rotationGroup: rotationGroupForDate(k, dow, isHoliday),
    });
  }
  return days;
}

// 將一個月的 days 陣列按「週一到週日」分週
// 月初不是週一時，第一週為不完整週（開始日到第一個週日）
// 月末不是週日時，最後一週也可能是不完整週
function getMonthWeeks(days) {
  const weeks = [];
  let current = [];
  for (const d of days) {
    current.push(d);
    if (d.dow === 0) { weeks.push(current); current = []; }
  }
  if (current.length > 0) weeks.push(current);
  return weeks;
}

function isTrueWeekday(day) {
  return Boolean(day && day.dow >= 1 && day.dow <= 5 && !day.isHoliday);
}

function countRestQuotasInDays(dayList, assignments, staffId) {
  const count = { '休': 0, '例': 0 };
  dayList.forEach(d => {
    const row = assignments && assignments[staffId];
    let c = row ? restQuotaCode(row[d.date]) : null;
    if (c === '國' && d.dow === 6) c = '休';
    if (c === '國' && d.dow === 0) c = '例';
    if (c === '休') count['休']++;
    if (c === '例') count['例']++;
  });
  return count;
}

function buildWeeklyRestState(days, assignments, staffId) {
  const weeks = getMonthWeeks(days);
  const targets = weeks.map(week => ({
    '休': week.filter(d => d.dow === 6).length,
    '例': week.filter(d => d.dow === 0).length,
  }));
  const dayWeekIndex = {};
  weeks.forEach((week, wi) => {
    week.forEach(d => { dayWeekIndex[d.date] = wi; });
  });

  const carryBoundaryShortfall = (fromIdx, toIdx) => {
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= weeks.length || toIdx >= weeks.length) return;
    const week = weeks[fromIdx];
    if (week.some(isTrueWeekday)) return;
    const count = countRestQuotasInDays(week, assignments, staffId);
    ['休', '例'].forEach(code => {
      const short = Math.max(0, targets[fromIdx][code] - count[code]);
      if (short > 0) {
        targets[fromIdx][code] -= short;
        targets[toIdx][code] += short;
      } else {
        // Unavoidable excess in a no-weekday boundary week: adjust target to match count.
        // This happens when 休* on Sunday makes休 count = 2 while target is 1.
        const over = Math.max(0, count[code] - targets[fromIdx][code]);
        if (over > 0) targets[fromIdx][code] += over;
      }
    });
  };

  if (weeks.length >= 2) {
    carryBoundaryShortfall(0, 1);
    if (weeks.length > 2) carryBoundaryShortfall(weeks.length - 1, weeks.length - 2);
  }

  const counts = weeks.map(week => countRestQuotasInDays(week, assignments, staffId));
  return { weeks, targets, counts, dayWeekIndex };
}

function weeklyRestDeviation(days, assignments, staffId) {
  const state = buildWeeklyRestState(days, assignments, staffId);
  let dev = 0;
  state.weeks.forEach((_week, wi) => {
    dev += Math.abs(state.counts[wi]['休'] - state.targets[wi]['休']);
    dev += Math.abs(state.counts[wi]['例'] - state.targets[wi]['例']);
  });
  return dev;
}

// 取得月份內所有國定假日
function holidaysInMonth(y, m, customHolidays) {
  const total = daysInMonth(y, m);
  const list = [];
  for (let d = 1; d <= total; d++) {
    const k = dateKey(y, m, d);
    if (isHolidayKey(k, customHolidays)) {
      list.push({ date: k, day: d, name: holidayName(k, customHolidays) });
    }
  }
  return list;
}
