// 規則驗證：驗證一份排班結果，回傳 violations 列表
// schedule = { year, month, days:[{date,dow,isHoliday}], assignments:{ staffId: { 'YYYY-MM-DD': code } } }

const Validator = (() => {
  const OFF_SET = new Set(OFF_CODES);

  function isOff(code) {
    return code && OFF_SET.has(code);
  }
  function isWork(code) {
    return code && !OFF_SET.has(code);
  }
  function workCode(code) {
    return effectiveWorkCode(code);
  }
  function isRestOnly(code) {
    return isOff(code);
  }
  function allowedAfterE(nextCode) {
    if (!nextCode) return true;
    if (isRestOnly(nextCode)) return true;
    const nextWork = workCode(nextCode);
    return nextWork === '7' || nextWork === 'E';
  }
  function allowedAfter3(nextCode) {
    if (!nextCode) return true;
    if (isRestOnly(nextCode)) return true;
    const nextWork = workCode(nextCode);
    return nextWork === '7' || nextWork === '3';
  }

  // 取單人在某日的班別
  function getCode(assignments, staffId, dKey) {
    return assignments[staffId] ? assignments[staffId][dKey] : null;
  }

  // 規則 1: N 前一天必須是 off 或 N
  function checkNAfterRestOrNight(schedule, staff, errs) {
    const { days, assignments } = schedule;
    staff.forEach(s => {
      for (let i = 0; i < days.length; i++) {
        const cur = getCode(assignments, s.id, days[i].date);
        if (workCode(cur) === 'N') {
          if (i === 0) continue; // 月初無法判斷
          const prev = getCode(assignments, s.id, days[i-1].date);
          if (prev && !isOff(prev) && workCode(prev) !== 'N') {
            errs.push({
              type:'N-prev-not-off-or-N',
              staffId:s.id, name:s.name, date:days[i].date,
              msg:`${s.name} ${days[i].date} 上 N，但前一天 (${days[i-1].date}) 為「${prev}」，不是休假或 N`
            });
          }
        }
      }
    });
  }

  // 規則 2: N 後不能 △
  function checkNNotFollowedByTriangle(schedule, staff, errs) {
    const { days, assignments } = schedule;
    staff.forEach(s => {
      for (let i = 0; i < days.length - 1; i++) {
        const cur = getCode(assignments, s.id, days[i].date);
        if (workCode(cur) === 'N') {
          const nxt = getCode(assignments, s.id, days[i+1].date);
          if (workCode(nxt) === '△') {
            errs.push({
              type:'N-next-triangle',
              staffId:s.id, name:s.name, date:days[i].date,
              msg:`${s.name} ${days[i].date} 上 N，但隔日 (${days[i+1].date}) 排△ 三角`
            });
          }
        }
      }
    });
  }

  // 規則 3: E/3 後只能 休/7/E (3 後可接 3)
  function checkEvening3End(schedule, staff, errs) {
    const { days, assignments } = schedule;
    staff.forEach(s => {
      for (let i = 0; i < days.length - 1; i++) {
        const cur = getCode(assignments, s.id, days[i].date);
        const nxt = getCode(assignments, s.id, days[i+1].date);
        if (!nxt) continue;
        if (workCode(cur) === 'E' && !allowedAfterE(nxt)) {
          errs.push({
            type:'E-bad-next',
            staffId:s.id, name:s.name, date:days[i].date,
            msg:`${s.name} ${days[i].date} E 後排「${nxt}」（只能接 休/例/國/請/7/E）`
          });
        }
        if (workCode(cur) === '3' && !allowedAfter3(nxt)) {
          errs.push({
            type:'3-bad-next',
            staffId:s.id, name:s.name, date:days[i].date,
            msg:`${s.name} ${days[i].date} 3 後排「${nxt}」（只能接 休/例/國/請/7/3）`
          });
        }
      }
    });
  }

  // 規則 4: 連續上班 ≤ 6 天 (固定班員工豁免)
  function checkMaxConsecutive(schedule, staff, errs) {
    const { days, assignments } = schedule;
    staff.forEach(s => {
      if (s.fixedShift) return;
      let run = 0;
      for (let i = 0; i < days.length; i++) {
        const cur = getCode(assignments, s.id, days[i].date);
        if (cur && isWork(cur)) {
          run++;
          if (run > 6) {
            errs.push({
              type:'over-6-consec',
              staffId:s.id, name:s.name, date:days[i].date,
              msg:`${s.name} ${days[i].date} 連續上班超過 6 天`
            });
            run = 0; // 避免一連串重複
          }
        } else {
          run = 0;
        }
      }
    });
  }

  // 規則 5: 月配額 — 每位員工該月：
  //   休數 = 該月週六總數
  //   例數 = 該月週日總數
  //   國數 = 該月國定假日總數
  // (固定班員工以 fixedShift 為主，目標仍同；但用戶要求暫時略過固定班的檢查)
  function checkMonthlyRestQuota(schedule, staff, errs) {
    const { days, assignments } = schedule;
    const target休 = days.filter(d => d.dow === 6).length;
    const target例 = days.filter(d => d.dow === 0).length;
    const target國 = days.filter(d => d.isHoliday).length;

    staff.forEach(s => {
      if (s.fixedShift) return;
      let n例 = 0, n休 = 0, n國 = 0;
      days.forEach(d => {
        const c = getCode(assignments, s.id, d.date);
        if (c === '例') n例++;
        if (restQuotaCode(c) === '休') n休++;
        if (c === '國') n國++;
      });
      if (n例 !== target例) {
        errs.push({
          type:'wrong-例-quota',
          staffId:s.id, name:s.name,
          msg:`${s.name} 該月「例」${n例} 個 (應為 ${target例} = 該月週日數)`
        });
      }
      if (n休 !== target休) {
        errs.push({
          type:'wrong-休-quota',
          staffId:s.id, name:s.name,
          msg:`${s.name} 該月「休」${n休} 個 (應為 ${target休} = 該月週六數，休* 計入休)`
        });
      }
      if (n國 !== target國) {
        errs.push({
          type:'wrong-國-quota',
          staffId:s.id, name:s.name,
          msg:`${s.name} 該月「國」${n國} 個 (應為 ${target國} = 該月國定假日數)`
        });
      }
    });

    // circle 員工安全網：◎ 計入休(debit)，例/國 由位移補償維持，正規化後應與目標相符
    staff.forEach(s => {
      if (!isCircleStaff(s)) return;
      let n例 = 0, n國 = 0, actual休 = 0, circles = 0, weekday休 = 0;
      days.forEach(d => {
        const c = getCode(assignments, s.id, d.date);
        if (c === '◎' && isCircleDay(d)) circles++;
        if (c === '例') n例++;
        else if (c === '國') n國++;
        else if (restQuotaCode(c) === '休') {
          actual休++;
          if (isWeekdayRestCreditDay(d)) weekday休++;
        }
      });
      const n休 = actual休 + Math.max(0, circles - weekday休);
      if (n休 !== target休) {
        errs.push({
          type:'circle-wrong-休-quota', staffId:s.id, name:s.name,
          msg:`${s.name} 圈圈員工該月「休」${n休} 個 (應為 ${target休})`
        });
      }
      if (n例 !== target例) {
        errs.push({
          type:'circle-wrong-例-quota', staffId:s.id, name:s.name,
          msg:`${s.name} 圈圈員工該月「例」${n例} 個 (應為 ${target例})`
        });
      }
      if (n國 !== target國) {
        errs.push({
          type:'circle-wrong-國-quota', staffId:s.id, name:s.name,
          msg:`${s.name} 圈圈員工該月「國」${n國} 個 (應為 ${target國})`
        });
      }
    });
  }

  // 新規則：一天最多 N 人「請」
  function checkDailyLeaveLimit(schedule, staff, errs) {
    const { days, assignments } = schedule;
    days.forEach(d => {
      let n = 0;
      staff.forEach(s => {
        if (getCode(assignments, s.id, d.date) === '請') n++;
      });
      if (n > MAX_DAILY_LEAVE) {
        errs.push({
          type:'too-many-leave',
          date: d.date,
          msg:`${d.date} 請假人數 ${n} 超過上限 ${MAX_DAILY_LEAVE}`
        });
      }
    });
  }

  // 新規則：平日一天最多 4 人不上班 (休/例/國/請)
  function checkWeekdayOffLimit(schedule, staff, errs) {
    const { days, assignments } = schedule;
    days.forEach(d => {
      const isH = (d.dow === 0 || d.dow === 6 || d.isHoliday);
      if (isH) return; // 假日不限
      let n = 0;
      staff.forEach(s => {
        const c = getCode(assignments, s.id, d.date);
        if (OFF_SET.has(c)) n++;
      });
      if (n > MAX_DAILY_LEAVE) {
        errs.push({
          type:'too-many-weekday-off',
          date: d.date,
          msg:`${d.date} 平日不上班人數 ${n} 超過上限 ${MAX_DAILY_LEAVE}`
        });
      }
    });
  }

  // 新規則：假日不可有「白」(只能 休/例/國)，平日 9 班外的非請假員工才上白
  function checkHolidayWhite(schedule, staff, errs) {
    const { days, assignments } = schedule;
    days.forEach(d => {
      const isHolidayLike = (d.dow === 0 || d.dow === 6 || d.isHoliday);
      if (!isHolidayLike) return;
      staff.forEach(s => {
        if (s.fixedShift) return; // 固定班員工豁免
        if (getCode(assignments, s.id, d.date) === '白') {
          errs.push({
            type:'holiday-white',
            staffId:s.id, name:s.name, date:d.date,
            msg:`${s.name} ${d.date} 假日不可排白班 (應為 休/例/國)`
          });
        }
      });
    });
  }

  // 規則 6: 若該月有國定假日，每位有上班的人需 ≥1 個「國」
  function checkHolidayAssign(schedule, staff, errs) {
    const { days, assignments } = schedule;
    const hasHoliday = days.some(d => d.isHoliday);
    if (!hasHoliday) return;
    staff.forEach(s => {
      // 全月固定班別的人略過（如：每日白斑、PAR、門診）
      if (s.fixedShift) return;
      let workCount = 0;
      let hasGuo = false;
      for (let i = 0; i < days.length; i++) {
        const c = getCode(assignments, s.id, days[i].date);
        if (c === '國') hasGuo = true;
        if (c && isWork(c)) workCount++;
      }
      if (workCount > 0 && !hasGuo) {
        errs.push({
          type:'no-guo',
          staffId:s.id, name:s.name, date:null,
          msg:`${s.name} 整月有上班但無「國」(該月有國定假日)`
        });
      }
    });
  }

  // 規則 7: 每日特殊班別名額需剛好 1 人
  function checkDailyCoverage(schedule, staff, errs) {
    const { days, assignments } = schedule;
    days.forEach(d => {
      const reqs = dayRequirements(d.dow, d.isHoliday);
      const count = {};
      const holders = {};
      staff.forEach(s => {
        const c = getCode(assignments, s.id, d.date);
        if (!c) return;
        const key = workCode(c);
        count[key] = (count[key]||0) + 1;
        if (!holders[key]) holders[key] = [];
        holders[key].push(s);
      });
      reqs.forEach(req => {
        const n = count[req] || 0;
        if (n < 1) {
          errs.push({
            type:'short-coverage',
            staffId:null, name:null, date:d.date,
            msg:`${d.date} (${DOW_LABEL[d.dow]}${d.isHoliday?'/國':''}) 缺班別「${req}」`
          });
        } else if (n > 1) {
          const people = holders[req] || [];
          errs.push({
            type:'duplicate-coverage',
            staffId:null, name:null, date:d.date,
            staffIds:people.map(s => s.id),
            names:people.map(s => s.name),
            msg:`${d.date} (${DOW_LABEL[d.dow]}${d.isHoliday?'/國':''}) 班別「${req}」${n} 人，限 1 人：${people.map(s => s.name).join('、')}`
          });
        }
      });
    });
  }

  // 規則 8: 每位輪班人員在平日（週一至週五，非國定假日）至少要有一個 N 和一個 E
  function checkMonthlyNE(schedule, staff, errs) {
    const { days, assignments } = schedule;
    const weekdays = days.filter(d => d.dow >= 1 && d.dow <= 5 && !d.isHoliday);
    staff.forEach(s => {
      if (s.fixedShift) return;
      const forbidden = new Set(s.forbidden || []);
      if (!forbidden.has('N')) {
        const hasN = weekdays.some(d => workCode(getCode(assignments, s.id, d.date)) === 'N');
        if (!hasN) errs.push({
          type: 'no-weekday-N',
          staffId: s.id, name: s.name, date: null,
          msg: `${s.name} 平日未排到 N（大夜）`,
        });
      }
      if (!forbidden.has('E')) {
        const hasE = weekdays.some(d => workCode(getCode(assignments, s.id, d.date)) === 'E');
        if (!hasE) errs.push({
          type: 'no-weekday-E',
          staffId: s.id, name: s.name, date: null,
          msg: `${s.name} 平日未排到 E（小夜）`,
        });
      }
    });
  }

  // 規則 9: 個人禁忌班
  function checkForbidden(schedule, staff, errs) {
    const { days, assignments } = schedule;
    staff.forEach(s => {
      const forbidden = new Set(s.forbidden || []);
      if (!forbidden.size) return;
      for (let i = 0; i < days.length; i++) {
        const c = getCode(assignments, s.id, days[i].date);
        if (c && (forbidden.has(c) || forbidden.has(workCode(c)))) {
          errs.push({
            type:'forbidden',
            staffId:s.id, name:s.name, date:days[i].date,
            msg:`${s.name} ${days[i].date} 排了禁忌班「${c}」`
          });
        }
      }
    });
  }

  function checkCircleShift(schedule, staff, errs) {
    const { days, assignments } = schedule;
    staff.forEach(s => {
      for (let i = 0; i < days.length; i++) {
        const d = days[i];
        const c = getCode(assignments, s.id, d.date);
        if (!isCircleShiftCode(c)) continue;
        if (!isCircleStaff(s)) {
          errs.push({
            type:'circle-invalid-staff',
            staffId:s.id, name:s.name, date:d.date,
            msg:`${s.name} ${d.date} 排了「◎」，但圈圈班只限固定 R/門 人員`
          });
        }
        if (!isCircleDay(d)) {
          errs.push({
            type:'circle-invalid-day',
            staffId:s.id, name:s.name, date:d.date,
            msg:`${s.name} ${d.date} 排了「◎」，但圈圈班只能放在假日類日期`
          });
        }
      }
    });
  }

  // 主入口：跑全部規則
  function validate(schedule, staff) {
    const errs = [];
    checkNAfterRestOrNight(schedule, staff, errs);
    checkNNotFollowedByTriangle(schedule, staff, errs);
    checkEvening3End(schedule, staff, errs);
    checkMaxConsecutive(schedule, staff, errs);
    checkMonthlyRestQuota(schedule, staff, errs); /* 含國的月配額檢查 */
    checkDailyCoverage(schedule, staff, errs);
    checkMonthlyNE(schedule, staff, errs); /* 軟性，已 noop */
    checkForbidden(schedule, staff, errs);
    checkDailyLeaveLimit(schedule, staff, errs);
    checkWeekdayOffLimit(schedule, staff, errs);
    checkHolidayWhite(schedule, staff, errs);
    checkCircleShift(schedule, staff, errs);
    return errs;
  }

  // 即時：檢查單一格修改是否合法
  // 用於手動點選格子時提示，不阻擋
  function checkCellAssign(schedule, staff, staffId, dateKey, code) {
    // 簡化版：暫存修改後 run validate，回 filter 該人 / 該日
    const tmp = {
      ...schedule,
      assignments: {
        ...schedule.assignments,
        [staffId]: { ...(schedule.assignments[staffId]||{}), [dateKey]: code }
      }
    };
    const errs = validate(tmp, staff);
    return errs.filter(e => e.staffId === staffId || e.date === dateKey);
  }

  return { validate, checkCellAssign, isOff, isWork };
})();
