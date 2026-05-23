// 規則驗證：驗證一份排班結果，回傳 violations 列表
// schedule = { year, month, days:[{date,dow,isHoliday}], assignments:{ staffId: { 'YYYY-MM-DD': code } } }

const Validator = (() => {
  // OFF_SET / workCode 改從 ShiftConfigManager 動態取，支援自訂班別
  function getOffSet() { return ShiftConfigManager.getOffSet(); }
  function isOff(code) { return code && getOffSet().has(code); }
  function isWork(code) { return code && !getOffSet().has(code); }
  function workCode(code) { return ShiftConfigManager.effectiveWorkCode(code); }
  function isRestOnly(code) { return isOff(code); }
  /** 通用接班規則：委託 ShiftConfigManager（涵蓋 E/3 及任何自訂規則） */
  function allowedAfterShift(fromCode, nextCode) {
    return ShiftConfigManager.isAllowedAfter(fromCode, nextCode);
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

  // 規則 3: 接班限制（動態，從 ShiftConfigManager.sequenceRules 取得）
  function checkEvening3End(schedule, staff, errs) {
    const { days, assignments } = schedule;
    const rules = ShiftConfigManager._config ? ShiftConfigManager._config.sequenceRules : {};
    if (Object.keys(rules).length === 0) return;
    staff.forEach(s => {
      for (let i = 0; i < days.length - 1; i++) {
        const cur = getCode(assignments, s.id, days[i].date);
        const nxt = getCode(assignments, s.id, days[i+1].date);
        if (!cur || !nxt) continue;
        const wc = workCode(cur);
        if (!rules[wc]) continue;
        if (!allowedAfterShift(wc, nxt)) {
          errs.push({
            type:`${wc}-bad-next`,
            staffId:s.id, name:s.name, date:days[i].date,
            msg:`${s.name} ${days[i].date} ${wc} 後排「${nxt}」（不符接班規則）`
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

  // 規則 5a: 週配額 — 每位員工每週：
  //   休數 = 該週週六數，例數 = 該週週日數
  //   月初/月末無真平日的邊界短週，若週內缺休/例，允許遞延至相鄰週
  function checkWeeklyRestQuota(schedule, staff, errs) {
    const { days, assignments } = schedule;

    staff.forEach(s => {
      if (s.fixedShift) return;

      const state = buildWeeklyRestState(days, assignments, s.id);

      state.weeks.forEach((week, wi) => {
        const target休 = state.targets[wi]['休'];
        const target例 = state.targets[wi]['例'];
        const n休 = state.counts[wi]['休'];
        const n例 = state.counts[wi]['例'];
        if (n休 !== target休) {
          errs.push({
            type:'wrong-weekly-休-quota',
            staffId:s.id, name:s.name,
            msg:`${s.name} ${week[0].date} 週「休」${n休} 個 (應為 ${target休})`
          });
        }
        if (n例 !== target例) {
          errs.push({
            type:'wrong-weekly-例-quota',
            staffId:s.id, name:s.name,
            msg:`${s.name} ${week[0].date} 週「例」${n例} 個 (應為 ${target例})`
          });
        }
      });
    });
  }

  // 規則 5b: 月配額 — 每位員工該月：
  //   國數 = 該月國定假日總數
  //   (休/例 改由週配額 checkWeeklyRestQuota 驗證；target休/例 保留供圓圈班安全網使用)
  function checkMonthlyRestQuota(schedule, staff, errs) {
    const { days, assignments } = schedule;
    const target休 = days.filter(d => d.dow === 6).length;
    const target例 = days.filter(d => d.dow === 0).length;
    const target國 = days.filter(d => d.isHoliday).length;

    staff.forEach(s => {
      if (s.fixedShift) return;
      let n國 = 0;
      days.forEach(d => {
        const c = getCode(assignments, s.id, d.date);
        if (c === '國') n國++;
      });
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
        if (c === '例' || (c === '國' && d.dow === 0)) n例++;
        if (c === '國') n國++;
        if (c === '國' && d.dow === 6) actual休++;
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
        if (getOffSet().has(c)) n++;
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
        if (getCode(assignments, s.id, d.date) === ShiftConfigManager.getFallbackCode()) {
          errs.push({
            type:'holiday-white',
            staffId:s.id, name:s.name, date:d.date,
            msg:`${s.name} ${d.date} 假日不可排${ShiftConfigManager.getFallbackCode()}班 (應為 休/例/國)`
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

  // 規則 7: 每日特殊班別名額需符合設定人數
  function checkDailyCoverage(schedule, staff, errs) {
    const { days, assignments } = schedule;
    days.forEach(d => {
      // 使用 ShiftConfigManager.getDayRequirements 取得 [{code, count}]，支援 count > 1
      const rawReqs = (typeof ShiftConfigManager !== 'undefined' && ShiftConfigManager._config)
        ? ShiftConfigManager.getDayRequirements(d.dow, d.isHoliday)
        : dayRequirements(d.dow, d.isHoliday).map(code => ({ code, count: 1 }));

      // 依 code 彙整（同一 code 多個 entry 合併 count）
      const reqMap = {};
      rawReqs.forEach(r => {
        const c = typeof r === 'string' ? r : r.code;
        const cnt = typeof r === 'string' ? 1 : (r.count || 1);
        reqMap[c] = (reqMap[c] || 0) + cnt;
      });

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

      Object.entries(reqMap).forEach(([req, requiredCount]) => {
        const n = count[req] || 0;
        if (n < requiredCount) {
          errs.push({
            type:'short-coverage',
            staffId:null, name:null, date:d.date,
            msg:`${d.date} (${DOW_LABEL[d.dow]}${d.isHoliday?'/國':''}) 缺班別「${req}」（需 ${requiredCount} 人，現有 ${n} 人）`
          });
        } else if (n > requiredCount) {
          const people = holders[req] || [];
          errs.push({
            type:'duplicate-coverage',
            staffId:null, name:null, date:d.date,
            staffIds:people.map(s => s.id),
            names:people.map(s => s.name),
            msg:`${d.date} (${DOW_LABEL[d.dow]}${d.isHoliday?'/國':''}) 班別「${req}」${n} 人，需 ${requiredCount} 人：${people.map(s => s.name).join('、')}`
          });
        }
      });
    });
  }

  // 規則 8 (軟性目標): N/E 平日至少各一次 — 引擎達不到時不算違規
  // 診斷由 ensureMonthlyNE 以 addDiagnostic 回報（no-weekday-N / no-weekday-E）
  function checkMonthlyNE(_schedule, _staff, _errs) {
    /* 軟性目標：validator 不報 hard error */
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
    checkWeeklyRestQuota(schedule, staff, errs);  /* 休/例週配額（取代月配額）*/
    checkMonthlyRestQuota(schedule, staff, errs); /* 國的月配額 + 圓圈班 */
    checkDailyCoverage(schedule, staff, errs);
    checkMonthlyNE(schedule, staff, errs);
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
