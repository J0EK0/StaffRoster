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
