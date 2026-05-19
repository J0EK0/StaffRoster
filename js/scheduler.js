// 自動排班引擎 v2 — 底稿 → token 對帳 → X 同日 work/work 換班 → Y 雙日 work/off 守恆換班
// 對日常排班規模 (30 天 × ~22 人) 在毫秒內可解。

const Scheduler = (() => {

  const OFF = new Set(OFF_CODES);
  const REST_TOKENS = new Set(['休','休*','例','國']);
  const SPECIAL_WORK_CODES = new Set(['N','E','3','7','1','2','中','△','A']);
  const isOff = c => c && OFF.has(c);
  const isWork = c => c && !OFF.has(c);
  const isRestToken = c => REST_TOKENS.has(c);
  const isRestWork = c => isRestWorkCode(c);
  const workCode = c => effectiveWorkCode(c);
  const coverageCode = c => SPECIAL_WORK_CODES.has(workCode(c)) ? workCode(c) : c;
  const isSpecialWorkCode = c => SPECIAL_WORK_CODES.has(workCode(c));

  function isAllowedAfterE(nextCode) {
    if (!nextCode) return true;
    if (isOff(nextCode)) return true;
    const nextWork = workCode(nextCode);
    return nextWork === '7' || nextWork === 'E';
  }

  function isAllowedAfter3(nextCode) {
    if (!nextCode) return true;
    if (isOff(nextCode)) return true;
    const nextWork = workCode(nextCode);
    return nextWork === '7' || nextWork === '3';
  }

  function canCountAsRequired(code, reqCode) {
    return coverageCode(code) === reqCode;
  }

  // ============================================================
  // 共用 helpers
  // ============================================================

  function restTargets(days) {
    return {
      '休': days.filter(d => d.dow === 6).length,
      '例': days.filter(d => d.dow === 0).length,
      '國': days.filter(d => d.isHoliday).length,
    };
  }

  function countRestQuotas(assignments, staffId, days) {
    const count = { '例':0, '休':0, '國':0 };
    days.forEach(d => {
      const c = restQuotaCode(assignments[staffId][d.date]);
      if (count[c] !== undefined) count[c]++;
    });
    return count;
  }

  function monthlyGuoDeviation(assignments, staffId, days) {
    const target = restTargets(days)['國'];
    return Math.abs(countRestQuotas(assignments, staffId, days)['國'] - target);
  }

  function staffRestQuotaDeviation(assignments, staffId, days) {
    return weeklyRestDeviation(days, assignments, staffId)
         + monthlyGuoDeviation(assignments, staffId, days);
  }

  function staffMonthlyNECounts(assignments, staffId, days) {
    const out = { N: 0, E: 0 };
    days.filter(isTrueWeekday).forEach(d => {
      const c = assignments[staffId] && assignments[staffId][d.date];
      const wc = workCode(c);
      if (wc === 'N') out.N++;
      if (wc === 'E') out.E++;
    });
    return out;
  }

  function totalWorkDays(assignments, staffId, days) {
    let n = 0;
    days.forEach(d => {
      const c = assignments[staffId][d.date];
      if (c && isWork(c)) n++;
    });
    return n;
  }

  function countAssignedCode(assignments, staffId, days, code) {
    let n = 0;
    days.forEach(d => {
      if (!assignments[staffId]) return;
      const cur = assignments[staffId][d.date];
      if (cur === code || workCode(cur) === code) n++;
    });
    return n;
  }

  function countSpecialWork(assignments, staffId, days) {
    let n = 0;
    days.forEach(d => {
      const code = assignments[staffId] && assignments[staffId][d.date];
      if (isSpecialWorkCode(code)) n++;
    });
    return n;
  }

  function neTransferPriority(assignments, days, mutations) {
    const receivers = [];
    (mutations || []).forEach(m => {
      const valueWork = workCode(m.value);
      if (valueWork !== 'N' && valueWork !== 'E') return;
      const current = assignments[m.staffId] && assignments[m.staffId][m.date];
      if (current === m.value) return;
      const sameCode = countAssignedCode(assignments, m.staffId, days, valueWork);
      const totalNE = countAssignedCode(assignments, m.staffId, days, 'N')
                    + countAssignedCode(assignments, m.staffId, days, 'E');
      receivers.push({ sameCode, totalNE });
    });

    if (receivers.length === 0) return null;
    return {
      sameCodeSum: receivers.reduce((sum, r) => sum + r.sameCode, 0),
      sameCodeMax: Math.max(...receivers.map(r => r.sameCode)),
      totalNESum: receivers.reduce((sum, r) => sum + r.totalNE, 0),
      receiverCount: receivers.length,
    };
  }

  function focusedNeTransferPriority(assignments, days, staffId, code) {
    code = workCode(code);
    if (code !== 'N' && code !== 'E') return null;
    return {
      sameCode: countAssignedCode(assignments, staffId, days, code),
      totalNE: countAssignedCode(assignments, staffId, days, 'N')
             + countAssignedCode(assignments, staffId, days, 'E'),
    };
  }

  function compareFocusedNeTransfer(a, b) {
    const aa = a && a.focusedNeTransfer;
    const bb = b && b.focusedNeTransfer;
    if (!aa || !bb) return 0;
    if (aa.sameCode !== bb.sameCode) return aa.sameCode - bb.sameCode;
    return aa.totalNE - bb.totalNE;
  }

  function compareNeTransferPriority(a, b) {
    const aa = a && a.neTransfer;
    const bb = b && b.neTransfer;
    if (!aa || !bb) return 0;
    if (aa.sameCodeSum !== bb.sameCodeSum) return aa.sameCodeSum - bb.sameCodeSum;
    if (aa.sameCodeMax !== bb.sameCodeMax) return aa.sameCodeMax - bb.sameCodeMax;
    if (aa.totalNESum !== bb.totalNESum) return aa.totalNESum - bb.totalNESum;
    return aa.receiverCount - bb.receiverCount;
  }

  function isLocked(locked, staffId, dateKey) {
    return Boolean(locked && locked[staffId] && locked[staffId][dateKey] !== undefined);
  }

  function lockCell(locked, staffId, dateKey, value) {
    if (!locked[staffId]) locked[staffId] = {};
    locked[staffId][dateKey] = value === undefined ? true : value;
  }

  function buildConstraintLocks(constraints) {
    const locked = {};
    if (!constraints) return locked;
    Object.keys(constraints).forEach(staffId => {
      Object.keys(constraints[staffId] || {}).forEach(dateKey => {
        lockCell(locked, staffId, dateKey, constraints[staffId][dateKey]);
      });
    });
    return locked;
  }

  function mergeLocks() {
    const out = {};
    Array.from(arguments).forEach(src => {
      if (!src) return;
      Object.keys(src).forEach(staffId => {
        Object.keys(src[staffId] || {}).forEach(dateKey => {
          lockCell(out, staffId, dateKey, src[staffId][dateKey]);
        });
      });
    });
    return out;
  }

  function unlockCellCopy(locked, staffId, dateKey) {
    const out = mergeLocks(locked);
    if (out[staffId]) {
      delete out[staffId][dateKey];
      if (Object.keys(out[staffId]).length === 0) delete out[staffId];
    }
    return out;
  }

  function addDiagnostic(diagnostics, type, staff, day, msg) {
    diagnostics.push({
      type,
      staffId: staff ? staff.id : null,
      name: staff ? staff.name : null,
      date: day ? day.date : null,
      msg,
    });
  }

  function emptyAssignments(staff, days) {
    const a = {};
    staff.forEach(s => {
      a[s.id] = {};
      days.forEach(d => { a[s.id][d.date] = null; });
    });
    return a;
  }

  function isHolidayLike(d) {
    return d.isHoliday || d.dow === 0 || d.dow === 6;
  }

  function isWeekday(d) {
    return !isHolidayLike(d);
  }

  function defaultOffCode(d) {
    if (d.isHoliday) return '國';
    if (d.dow === 6) return '休';
    if (d.dow === 0) return '例';
    return null;
  }

  // ============================================================
  // 階段 1 helpers：鎖死層
  // ============================================================

  function preFillFixed(assignments, staff, days) {
    staff.forEach(s => {
      if (!s.fixedShift) return;
      days.forEach(d => {
        if (d.isHoliday) {
          assignments[s.id][d.date] = '國';
        } else if (d.dow === 6) {
          assignments[s.id][d.date] = '休';
        } else if (d.dow === 0) {
          assignments[s.id][d.date] = '例';
        } else {
          assignments[s.id][d.date] = s.fixedShift;
        }
      });
    });
  }

  function applyUserConstraintsDirectLegacy(assignments, staff, days, constraints) {
    if (!constraints) return;
    staff.forEach(s => {
      const userData = constraints[s.id] || {};
      Object.keys(userData).forEach(dKey => {
        if (assignments[s.id][dKey] !== undefined) {
          assignments[s.id][dKey] = userData[dKey];
        }
      });
    });
  }

  // ============================================================
  // 階段 0：feasibility 預檢
  // ============================================================

  // 預檢：分為 fatal (無法排) 與 warning (可排但會有殘餘衝突)
  function feasibilityCheck(staff, days) {
    const fatal = [];
    const warnings = [];

    const W = days.filter(d => !isHolidayLike(d)).length;
    const S = days.filter(d => d.dow === 6 && !d.isHoliday).length;
    const U = days.filter(d => d.dow === 0 && !d.isHoliday).length;
    const H = days.filter(d => d.isHoliday).length;

    const rotStaff = staff.filter(s => !s.fixedShift);
    const neStaff = rotStaff.filter(s => !(s.forbidden||[]).includes('N') && !(s.forbidden||[]).includes('E'));

    if (rotStaff.length === 0) {
      fatal.push('沒有非固定班員工可排班');
      return { ok: false, issues: fatal, warnings };
    }
    if (neStaff.length === 0) {
      fatal.push('沒有可上 N/E 的員工（請確認禁忌設定）');
    }

    // 特殊班需求 vs 整體工作日
    const specialNeeds = days.reduce((sum, d) =>
      sum + dayRequirements(d.dow, d.isHoliday).filter(c => !OFF.has(c)).length, 0);
    const rotWorkdays = rotStaff.length * (days.length - (S + U + H));
    if (rotWorkdays < specialNeeds) {
      fatal.push(`特殊班需求 (${specialNeeds}) 超過輪班員工總工作日 (${rotWorkdays})`);
    }

    // 平日 off 上限警告：假日特殊班會釋出 token 至平日；若超過平日容量，token 配額無法滿足
    const holidaySpecial = days
      .filter(d => isHolidayLike(d))
      .reduce((sum, d) =>
        sum + dayRequirements(d.dow, d.isHoliday).filter(c => !OFF.has(c)).length, 0);
    const weekdayCapacity = MAX_DAILY_LEAVE * W;
    if (holidaySpecial > weekdayCapacity) {
      warnings.push(`假日特殊班 ${holidaySpecial} 個將釋出 token 至平日，但平日 off 容量僅 ${weekdayCapacity}（差 ${holidaySpecial - weekdayCapacity}）。預期會有殘餘 token 配額違規。`);
    }

    return { ok: fatal.length === 0, issues: fatal, warnings };
  }

  // ============================================================
  // 絕對硬規則：底稿階段必擋
  // 不擋：N 前 off/N（規則 1）、連續 ≤6（規則 4）、月配額（規則 5）、平日 off ≤4（規則 6）
  // ============================================================

  function absoluteHardOk(assignments, s, days, dayIdx, code) {
    const dKey = days[dayIdx].date;

    if (assignments[s.id][dKey] !== null) return false;
    if (s.fixedShift) return false;
    if ((s.forbidden||[]).includes(code) || (s.forbidden||[]).includes(workCode(code))) return false;

    if (!isWork(code)) return true;

    // N 隔日不能 △
    if (workCode(code) === 'N' && dayIdx < days.length - 1) {
      const nxt = assignments[s.id][days[dayIdx+1].date];
      if (workCode(nxt) === '△') return false;
    }
    if (workCode(code) === '△' && dayIdx > 0) {
      const prev = assignments[s.id][days[dayIdx-1].date];
      if (workCode(prev) === 'N') return false;
    }

    // E/3 接續：前一天若是 E/3，今天只能是白名單內
    if (dayIdx > 0) {
      const prev = assignments[s.id][days[dayIdx-1].date];
      if (workCode(prev) === 'E' && !['7','E'].includes(workCode(code))) return false;
      if (workCode(prev) === '3' && !['7','3'].includes(workCode(code))) return false;
    }
    // 今天 E/3，隔日已派的非白名單
    if (workCode(code) === 'E' && dayIdx < days.length - 1) {
      const nxt = assignments[s.id][days[dayIdx+1].date];
      if (!isAllowedAfterE(nxt)) return false;
    }
    if (workCode(code) === '3' && dayIdx < days.length - 1) {
      const nxt = assignments[s.id][days[dayIdx+1].date];
      if (!isAllowedAfter3(nxt)) return false;
    }

    // 隔日已 N，今日非 N 工作班 → 違反 N 前置（這條保留為絕對硬，避免後續修不回來）
    if (workCode(code) !== 'N' && dayIdx < days.length - 1) {
      const nxt = assignments[s.id][days[dayIdx+1].date];
      if (workCode(nxt) === 'N') return false;
    }

    return true;
  }

  // ============================================================
  // 階段 2：以日為主軸 min-conflicts greedy 底稿
  // ============================================================

  // 假日預設 off 給所有未鎖員工
  function fillHolidayDefaults(assignments, staff, days) {
    days.forEach(d => {
      if (!isHolidayLike(d)) return;
      const offCode = defaultOffCode(d);
      staff.forEach(s => {
        if (s.fixedShift) return; // 已由 preFillFixed 處理
        if (assignments[s.id][d.date] !== null) return; // 使用者鎖定或預填
        assignments[s.id][d.date] = offCode;
      });
    });
  }

  // 計算當前 monthlyCount
  function buildMonthlyCount(assignments, staff, days) {
    const mc = {};
    staff.forEach(s => { mc[s.id] = {}; });
    days.forEach(d => {
      staff.forEach(s => {
        const c = assignments[s.id][d.date];
        if (!c) return;
        mc[s.id][c] = (mc[s.id][c]||0) + 1;
        const base = coverageCode(c);
        if (base !== c) mc[s.id][base] = (mc[s.id][base]||0) + 1;
      });
    });
    return mc;
  }

  // 對某日某班別找最佳候選人；若候選人原本被預設為 off，會先暫時清空後再檢查
  function pickCandidate(assignments, staff, days, dayIdx, code, monthlyCount, locked) {
    const d = days[dayIdx];
    const dKey = d.date;
    const isH = isHolidayLike(d);

    const candidates = [];
    staff.forEach(s => {
      if (s.fixedShift) return;
      if (isLocked(locked, s.id, dKey)) return;
      const cur = assignments[s.id][dKey];
      // 候選人 = 空白 或 假日預設 off (可被替換為工作班)
      const canReplace = cur === null || (isH && (cur === '休' || cur === '休*' || cur === '例' || cur === '國'));
      if (!canReplace) return;

      // 暫時清空檢查 absoluteHardOk
      const saved = cur;
      assignments[s.id][dKey] = null;
      const ok = absoluteHardOk(assignments, s, days, dayIdx, code);
      assignments[s.id][dKey] = saved;
      if (!ok) return;

      candidates.push(s);
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      // (1) 月計數最少優先（Q1=分散排：避免 N/E 集中在同一人）
      const aCnt = monthlyCount[a.id][code] || 0;
      const bCnt = monthlyCount[b.id][code] || 0;
      if (aCnt !== bCnt) return aCnt - bCnt;
      // (2) N 排相同次數時，挑「前一天已 off/N」的員工（節省 N 前置衝突）
      if (code === 'N' && dayIdx > 0) {
        const aPrev = assignments[a.id][days[dayIdx-1].date];
        const bPrev = assignments[b.id][days[dayIdx-1].date];
        const aGood = isOff(aPrev) || workCode(aPrev) === 'N' ? 0 : 1;
        const bGood = isOff(bPrev) || workCode(bPrev) === 'N' ? 0 : 1;
        if (aGood !== bGood) return aGood - bGood;
      }
      // (3) 工作天少優先（平均化整體工作量）
      const aW = totalWorkDays(assignments, a.id, days);
      const bW = totalWorkDays(assignments, b.id, days);
      if (aW !== bW) return aW - bW;
      return 0;
    });

    return candidates[0];
  }

  // 主要：以日為主軸，每日跑特殊班需求
  function generateDraft(assignments, staff, days, locked, diagnostics) {
    fillHolidayDefaults(assignments, staff, days);
    const monthlyCount = buildMonthlyCount(assignments, staff, days);

    const PRIORITY = ['N','E','△','3','7','A','中','1','2'];

    days.forEach((d, dayIdx) => {
      const reqs = dayRequirements(d.dow, d.isHoliday).slice();
      reqs.sort((a,b) => {
        const ai = PRIORITY.indexOf(a);
        const bi = PRIORITY.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

      reqs.forEach(req => {
        // 已有人擔任此班 → 跳過（使用者預鎖或前面已派）
        const already = staff.some(s => canCountAsRequired(assignments[s.id][d.date], req));
        if (already) return;

        const chosen = pickCandidate(assignments, staff, days, dayIdx, req, monthlyCount, locked);
        if (!chosen) {
          addDiagnostic(diagnostics, 'draft-no-candidate', null, d,
            `${d.date} 班別「${req}」找不到候選人（底稿階段）`);
          return;
        }

        // 若該員工原本是假日預設 off，扣掉舊 monthlyCount
        const prev = assignments[chosen.id][d.date];
        if (prev) monthlyCount[chosen.id][prev] = (monthlyCount[chosen.id][prev]||1) - 1;
        assignments[chosen.id][d.date] = req;
        monthlyCount[chosen.id][req] = (monthlyCount[chosen.id][req]||0) + 1;
      });

      // 平日剩餘員工 → 白
      if (!isHolidayLike(d)) {
        staff.forEach(s => {
          if (s.fixedShift) return;
          if (assignments[s.id][d.date] === null) {
            assignments[s.id][d.date] = '白';
            monthlyCount[s.id]['白'] = (monthlyCount[s.id]['白']||0) + 1;
          }
        });
      }
    });

    return monthlyCount;
  }

  // ============================================================
  // Init 底稿：人工式斜對角 pattern，先看節奏，再進下一步修班
  // ============================================================

  const WEEKDAY_PATTERN = ['7', 'E', null, 'N', null, '△', '2', null, null, 'A', null, null, '3', '中', '1', null];
  const HOLIDAY_PATTERN = ['中', 'E', 'N', '1', '2'];
  const SUNDAY_PATTERN = ['休*', 'N', 'E', '1'];

  function ensureAssignmentShape(assignments, staff, days) {
    staff.forEach(s => {
      if (!assignments[s.id]) assignments[s.id] = {};
      days.forEach(d => {
        if (!(d.date in assignments[s.id])) assignments[s.id][d.date] = null;
      });
    });
  }

  function hasAnyAssignment(assignments, staff, days) {
    return staff.some(s => days.some(d => assignments[s.id] && assignments[s.id][d.date]));
  }

  function dayHasCode(assignments, staff, dateKey, code) {
    return staff.some(s => assignments[s.id] && assignments[s.id][dateKey] === code);
  }

  function isPresetBlankForDay(code, day) {
    if (code === null || code === undefined) return true;
    if (isWeekday(day)) return code === '白';
    return isOff(code);
  }

  function pickPatternStaff(assignments, rotStaff, day, idealIdx, assigned, locked, code, days, dayIdx) {
    if (rotStaff.length === 0) return null;
    const wc = code ? workCode(code) : null;
    // Sequence checks only apply on holiday/weekend days: weekday violations are fixable by repair.
    const isHolidayDay = day.rotationGroup === 'regular' || day.rotationGroup === 'national';
    for (let step = 0; step < rotStaff.length; step++) {
      const s = rotStaff[(idealIdx + step) % rotStaff.length];
      if (assigned.has(s.id)) continue;
      if (isLocked(locked, s.id, day.date)) continue;
      if (!isPresetBlankForDay(assignments[s.id][day.date], day)) continue;
      if (code && ((s.forbidden || []).includes(code) || (s.forbidden || []).includes(wc))) continue;
      if (isHolidayDay && days && dayIdx > 0) {
        const prevDate = days[dayIdx - 1].date;
        const prevCode = assignments[s.id][prevDate];
        const prevWc = prevCode ? workCode(prevCode) : null;
        if (wc === 'N' && prevCode !== null && !isOff(prevCode) && prevWc !== 'N') continue;
        if (prevWc === 'E' && code && !isAllowedAfterE(code)) continue;
        if (prevWc === '3' && code && !isAllowedAfter3(code)) continue;
      }
      return s;
    }
    return null;
  }

  function placePatternCode(assignments, staff, rotStaff, day, baseOffset, patternIdx, code, assigned, locked, days, dayIdx) {
    if (!code) return null;
    if (rotStaff.length === 0) return null;
    if (dayHasCode(assignments, staff, day.date, code)) return null;
    const chosen = pickPatternStaff(
      assignments,
      rotStaff,
      day,
      (baseOffset + patternIdx) % rotStaff.length,
      assigned,
      locked,
      code,
      days,
      dayIdx
    );
    if (!chosen) return null;
    assignments[chosen.id][day.date] = code;
    assigned.add(chosen.id);
    return chosen;
  }

  function activeDraftStaffForGroup(staff, groupData) {
    const ordered = orderedDraftStaffForGroup(staff, groupData);
    const inactive = (groupData && groupData._inactive) || {};
    return ordered.filter(s => !s.fixedShift && !inactive[s.id]);
  }

  function orderedDraftStaffForGroup(staff, groupData) {
    const order = Array.isArray(groupData && groupData._order) ? groupData._order : [];
    if (order.length === 0) return staff;

    const byId = new Map(staff.map(s => [s.id, s]));
    const used = new Set();
    const ordered = [];
    order.forEach(id => {
      const s = byId.get(id);
      if (!s || used.has(id)) return;
      ordered.push(s);
      used.add(id);
    });
    staff.forEach(s => {
      if (!used.has(s.id)) ordered.push(s);
    });
    return ordered;
  }

  function fillPatternDraft(assignments, staff, days, locked, rotation) {
    let weekdayOffset = 0;
    let holidayOffset = 0;

    days.forEach((day, dayIdx) => {
      const assigned = new Set();

      staff.forEach(s => {
        const cur = assignments[s.id][day.date];
        if (!s.fixedShift && cur && !isPresetBlankForDay(cur, day)) assigned.add(s.id);
      });

      if (isWeekday(day)) {
        staff.forEach(s => {
          if (s.fixedShift) return;
          if (assignments[s.id][day.date] === null) assignments[s.id][day.date] = '白';
        });

        const weekdayData = rotation && rotation.weekday;
        const weekdayStaff = activeDraftStaffForGroup(staff, weekdayData);
        const hasWeekdayData = weekdayData && weekdayStaff.some(s => weekdayData[s.id] && weekdayData[s.id][day.date]);

        if (hasWeekdayData) {
          weekdayStaff.forEach(s => {
            const code = weekdayData[s.id] && weekdayData[s.id][day.date];
            if (code) {
              assignments[s.id][day.date] = code;
              assigned.add(s.id);
            }
          });
        } else {
          WEEKDAY_PATTERN.forEach((code, idx) => {
            placePatternCode(assignments, staff, weekdayStaff, day, weekdayOffset, idx, code, assigned, locked, days, dayIdx);
          });
        }
        weekdayOffset = (weekdayOffset + 1) % Math.max(weekdayStaff.length, 1);
      } else {
        const offCode = defaultOffCode(day);
        staff.forEach(s => {
          if (s.fixedShift) return;
          if (assignments[s.id][day.date] === null) assignments[s.id][day.date] = offCode;
        });

        const rotGroup = day.rotationGroup || (day.isHoliday ? 'national' : 'regular');
        const rotData = rotation && rotation[rotGroup];
        const holidayStaff = activeDraftStaffForGroup(staff, rotData);
        const hasRotData = rotData && holidayStaff.some(s => rotData[s.id] && rotData[s.id][day.date]);

        if (hasRotData) {
          // Apply explicit rotation data for holiday/weekend cells.
          // Forbidden-shift filter is intentionally absent: rotation holiday assignments
          // are hard-locked by the CP-SAT solver and override forbidden rules for those cells.
          holidayStaff.forEach(s => {
            const code = rotData[s.id] && rotData[s.id][day.date];
            if (!code) return;
            const wc = workCode(code);
            // Sequence checks only when prev day is also a holiday cell:
            // weekday prev may be changed to off by constraints, repair can fix those.
            if (dayIdx > 0) {
              const prevDay = days[dayIdx - 1];
              const prevIsHoliday = prevDay.rotationGroup === 'regular' || prevDay.rotationGroup === 'national';
              if (prevIsHoliday) {
                const prevCode = assignments[s.id][prevDay.date];
                const prevWc = prevCode ? workCode(prevCode) : null;
                if (wc === 'N' && prevCode !== null && !isOff(prevCode) && prevWc !== 'N') return;
                if (prevWc === 'E' && !isAllowedAfterE(code)) return;
                if (prevWc === '3' && !isAllowedAfter3(code)) return;
              }
            }
            assignments[s.id][day.date] = code;
            assigned.add(s.id);
          });
        }
        // Always run pattern fill: fills skipped slots (forbidden/sequence) and no-data days alike.
        const pattern = (day.dow === 0) ? SUNDAY_PATTERN : HOLIDAY_PATTERN;
        pattern.forEach((code, idx) => {
          placePatternCode(assignments, staff, holidayStaff, day, holidayOffset, idx, code, assigned, locked, days, dayIdx);
        });
        holidayOffset = (holidayOffset + 1) % Math.max(holidayStaff.length, 1);
      }
    });
  }

  function initPatternDraft(schedule, staff, _constraints, rotation) {
    const { days } = schedule;
    const assignments = emptyAssignments(staff, days);
    // Init 底稿只填固定班與底稿 pattern，不套用禁忌、接續、請假或偏好修正。
    // 使用者的請假/指定班會保留在 constraints，等「下一步修班」再套用與交換。
    const locked = {};

    preFillFixed(assignments, staff, days);
    fillPatternDraft(assignments, staff, days, locked, rotation);

    schedule.assignments = assignments;
    schedule.diagnostics = [];
    if (typeof console !== 'undefined') {
      console.log('[Scheduler v2] init 底稿完成：pattern draft ready');
    }
    return schedule;
  }

  // ============================================================
  // 守恆型修班 helpers：X 同日 work/work、Y 雙日 work/off
  // ============================================================

  // 偵測修班硬衝突：禁忌班、N 前置、N 後 △、E/3 後接續、連續 ≤6
  function detectConflicts(assignments, staff, days) {
    const conflicts = [];
    staff.forEach(s => {
      if (s.fixedShift) return;
      const forbidden = new Set(s.forbidden || []);
      let run = 0;
      for (let i = 0; i < days.length; i++) {
        const cur = assignments[s.id][days[i].date];
        const curWork = workCode(cur);

        if (cur && (forbidden.has(cur) || forbidden.has(curWork))) {
          conflicts.push({ type:'forbidden', staffId:s.id, dayIdx:i });
        }
        if (curWork === 'N' && i > 0) {
          const prev = assignments[s.id][days[i-1].date];
          if (prev !== null && !isOff(prev) && workCode(prev) !== 'N') {
            conflicts.push({ type:'N-prev', staffId:s.id, dayIdx:i });
          }
        }
        if (curWork === 'N' && i < days.length - 1) {
          const nxt = assignments[s.id][days[i+1].date];
          if (workCode(nxt) === '△') {
            conflicts.push({ type:'N-next-triangle', staffId:s.id, dayIdx:i });
          }
        }
        if (curWork === 'E' && i < days.length - 1) {
          const nxt = assignments[s.id][days[i+1].date];
          if (!isAllowedAfterE(nxt)) {
            conflicts.push({ type:'E-bad-next', staffId:s.id, dayIdx:i });
          }
        }
        if (curWork === '3' && i < days.length - 1) {
          const nxt = assignments[s.id][days[i+1].date];
          if (!isAllowedAfter3(nxt)) {
            conflicts.push({ type:'3-bad-next', staffId:s.id, dayIdx:i });
          }
        }

        if (cur && isWork(cur)) {
          run++;
          if (run > 6) {
            conflicts.push({ type:'over-6', staffId:s.id, dayIdx:i });
          }
        } else {
          run = 0;
        }
      }
    });
    return conflicts;
  }

  function countStaffConflicts(assignments, s, days) {
    if (!s || s.fixedShift) return 0;
    const forbidden = new Set(s.forbidden || []);
    let run = 0;
    let count = 0;

    for (let i = 0; i < days.length; i++) {
      const cur = assignments[s.id][days[i].date];
      const curWork = workCode(cur);

      if (cur && (forbidden.has(cur) || forbidden.has(curWork))) count++;
      if (curWork === 'N' && i > 0) {
        const prev = assignments[s.id][days[i - 1].date];
        if (prev !== null && !isOff(prev) && workCode(prev) !== 'N') count++;
      }
      if (curWork === 'N' && i < days.length - 1) {
        const nxt = assignments[s.id][days[i + 1].date];
        if (workCode(nxt) === '△') count++;
      }
      if (curWork === 'E' && i < days.length - 1) {
        const nxt = assignments[s.id][days[i + 1].date];
        if (!isAllowedAfterE(nxt)) count++;
      }
      if (curWork === '3' && i < days.length - 1) {
        const nxt = assignments[s.id][days[i + 1].date];
        if (!isAllowedAfter3(nxt)) count++;
      }

      if (cur && isWork(cur)) {
        run++;
        if (run > 6) count++;
      } else {
        run = 0;
      }
    }

    return count;
  }

  // 每日特殊班缺額 + 重複 (一班別超過 1 人) 加總
  function detectCoverageIssues(assignments, staff, days) {
    let gaps = 0;
    let dups = 0;
    days.forEach(d => {
      const reqs = dayRequirements(d.dow, d.isHoliday);
      const have = {};
      staff.forEach(s => {
        const c = assignments[s.id][d.date];
        if (c) {
          const key = coverageCode(c);
          have[key] = (have[key]||0) + 1;
        }
      });
      reqs.forEach(req => {
        const n = have[req] || 0;
        if (n < 1) gaps++;
        else if (n > 1) dups += (n - 1);
      });
    });
    return { gaps, dups };
  }

  // cost function
  function totalCost(assignments, staff, days) {
    const conflicts = detectConflicts(assignments, staff, days);
    const cov = detectCoverageIssues(assignments, staff, days);

    let quotaDev = 0;
    staff.forEach(s => {
      if (s.fixedShift) return;
      quotaDev += staffRestQuotaDeviation(assignments, s.id, days);
    });

    const rotN = staff.filter(s => !s.fixedShift && !(s.forbidden||[]).includes('N'));
    const ns = rotN.map(s => {
      return staffMonthlyNECounts(assignments, s.id, days).N;
    });
    const rotE = staff.filter(s => !s.fixedShift && !(s.forbidden||[]).includes('E'));
    const es = rotE.map(s => {
      return staffMonthlyNECounts(assignments, s.id, days).E;
    });

    const stddev = arr => {
      if (arr.length === 0) return 0;
      const mean = arr.reduce((a,b)=>a+b,0) / arr.length;
      return Math.sqrt(arr.reduce((a,b)=>a+(b-mean)*(b-mean),0) / arr.length);
    };

    let missNE = 0;
    rotN.forEach((s, i) => { if (ns[i] === 0) missNE++; });
    rotE.forEach((s, i) => { if (es[i] === 0) missNE++; });

    // 平日 off 過量懲罰
    let dailyOffOver = 0;
    days.forEach(d => {
      if (isHolidayLike(d)) return;
      let n = 0;
      staff.forEach(s => {
        const c = assignments[s.id][d.date];
        if (OFF.has(c)) n++;
      });
      if (n > MAX_DAILY_LEAVE) dailyOffOver += (n - MAX_DAILY_LEAVE);
    });

    return 1000 * conflicts.length
         + 800  * cov.gaps      // 每日缺特殊班
         + 500  * quotaDev      // token 配額偏差（規則 5 硬性，與硬規則相當權重）
         + 200  * cov.dups      // 每日特殊班重複
         + 50  * dailyOffOver
         + 10  * (stddev(ns) + stddev(es))
         + 20  * missNE;
  }

  function quotaDeviation(assignments, staff, days) {
    let dev = 0;
    staff.forEach(s => {
      if (s.fixedShift) return;
      dev += staffRestQuotaDeviation(assignments, s.id, days);
    });
    return dev;
  }

  function weekdayOffOverCount(assignments, staff, days) {
    let over = 0;
    days.forEach(d => {
      if (!isWeekday(d)) return;
      let n = 0;
      staff.forEach(s => {
        const c = assignments[s.id][d.date];
        if (OFF.has(c)) n++;
      });
      if (n > MAX_DAILY_LEAVE) over += (n - MAX_DAILY_LEAVE);
    });
    return over;
  }

  function dailyOffCount(assignments, staff, day) {
    let n = 0;
    staff.forEach(s => {
      const c = assignments[s.id][day.date];
      if (OFF.has(c)) n++;
    });
    return n;
  }

  function scheduleMetrics(assignments, staff, days) {
    const conflicts = detectConflicts(assignments, staff, days);
    const cov = detectCoverageIssues(assignments, staff, days);
    return {
      hard: conflicts.length,
      gaps: cov.gaps,
      dups: cov.dups,
      quotaDev: quotaDeviation(assignments, staff, days),
      dailyOffOver: weekdayOffOverCount(assignments, staff, days),
    };
  }

  function isNoWorseSurface(before, after) {
    return after.gaps <= before.gaps
        && after.dups <= before.dups
        && after.quotaDev <= before.quotaDev
        && after.dailyOffOver <= before.dailyOffOver;
  }

  function improvesHardSafely(before, after) {
    return after.hard < before.hard && isNoWorseSurface(before, after);
  }

  function noHardRuleRegression(before, after) {
    return after.hard <= before.hard && isNoWorseSurface(before, after);
  }

  function tryPatch(assignments, staff, days, mutations, accept) {
    if (!mutations || mutations.length === 0) return null;

    const beforeValues = new Map();
    mutations.forEach(m => {
      const key = `${m.staffId}@@${m.date}`;
      if (!beforeValues.has(key)) {
        beforeValues.set(key, {
          staffId: m.staffId,
          date: m.date,
          value: assignments[m.staffId][m.date],
        });
      }
    });

    const before = scheduleMetrics(assignments, staff, days);
    mutations.forEach(m => {
      assignments[m.staffId][m.date] = m.value;
    });
    const after = scheduleMetrics(assignments, staff, days);
    const ok = accept(before, after);

    if (!ok) {
      beforeValues.forEach(v => {
        assignments[v.staffId][v.date] = v.value;
      });
      return null;
    }

    return { before, after };
  }

  function commitMutations(assignments, mutations) {
    mutations.forEach(m => {
      assignments[m.staffId][m.date] = m.value;
    });
  }

  function cloneAssignments(assignments, staff, days) {
    const copy = {};
    staff.forEach(s => {
      copy[s.id] = {};
      days.forEach(d => {
        copy[s.id][d.date] = assignments[s.id][d.date];
      });
    });
    return copy;
  }

  function replaceAssignments(target, source, staff, days) {
    staff.forEach(s => {
      if (!target[s.id]) target[s.id] = {};
      days.forEach(d => {
        target[s.id][d.date] = source[s.id][d.date];
      });
    });
  }

  function evaluateMutations(assignments, staff, days, mutations) {
    if (!mutations || mutations.length === 0) return null;

    const beforeValues = new Map();
    mutations.forEach(m => {
      const key = `${m.staffId}@@${m.date}`;
      if (!beforeValues.has(key)) {
        beforeValues.set(key, {
          staffId: m.staffId,
          date: m.date,
          value: assignments[m.staffId][m.date],
        });
      }
    });

    const neTransfer = neTransferPriority(assignments, days, mutations);
    const before = scheduleMetrics(assignments, staff, days);
    commitMutations(assignments, mutations);
    const after = scheduleMetrics(assignments, staff, days);
    const cost = totalCost(assignments, staff, days);

    beforeValues.forEach(v => {
      assignments[v.staffId][v.date] = v.value;
    });

    return { before, after, cost, mutations, neTransfer };
  }

  function compareRepairCandidates(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    if (a.after.hard !== b.after.hard) return a.after.hard - b.after.hard;
    if (a.after.gaps !== b.after.gaps) return a.after.gaps - b.after.gaps;
    if (a.after.dups !== b.after.dups) return a.after.dups - b.after.dups;
    if (a.after.quotaDev !== b.after.quotaDev) return a.after.quotaDev - b.after.quotaDev;
    if (a.after.dailyOffOver !== b.after.dailyOffOver) return a.after.dailyOffOver - b.after.dailyOffOver;
    const focusedNe = compareFocusedNeTransfer(a, b);
    if (focusedNe !== 0) return focusedNe;
    const ne = compareNeTransferPriority(a, b);
    if (ne !== 0) return ne;
    return a.cost - b.cost;
  }

  function betterRepairCandidate(candidate, best) {
    return compareRepairCandidates(candidate, best) < 0;
  }

  function manualChangeAccept(before, after) {
    return after.hard <= before.hard
        && after.gaps <= before.gaps
        && after.dups <= before.dups
        && after.quotaDev <= before.quotaDev
        && after.dailyOffOver <= before.dailyOffOver;
  }

  function manualCoverageAccept(before, after) {
    return after.gaps < before.gaps
        && after.hard <= before.hard
        && after.dups <= before.dups
        && after.quotaDev <= before.quotaDev
        && after.dailyOffOver <= before.dailyOffOver;
  }

  function phase1CoverageAccept(before, after) {
    return after.gaps < before.gaps
        && after.hard <= before.hard
        && after.dups <= before.dups
        && after.dailyOffOver <= before.dailyOffOver;
  }

  function compoundOffAccept(before, after) {
    return after.gaps < before.gaps
        && after.hard <= before.hard
        && after.dups <= before.dups
        && after.dailyOffOver <= before.dailyOffOver
        && after.quotaDev <= before.quotaDev + 1;
  }

  function buildDayWeekIndex(days) {
    const weeks = getMonthWeeks(days);
    const idx = {};
    weeks.forEach((week, wi) => week.forEach(d => { idx[d.date] = wi; }));
    return { idx, weeks };
  }

  function mutationTouchesLocked(mutations, locked) {
    return (mutations || []).some(m => isLocked(locked, m.staffId, m.date));
  }

  function evaluateManualMutations(assignments, staff, days, locked, mutations, accept) {
    if (!mutations || mutations.length === 0) return null;
    if (mutationTouchesLocked(mutations, locked)) return null;
    const candidate = evaluateMutations(assignments, staff, days, mutations);
    if (!candidate) return null;
    if (!(accept || manualChangeAccept)(candidate.before, candidate.after)) return null;
    return candidate;
  }

  function evaluateRepairPackage(assignments, staff, days, locked, mutations, accept, options) {
    if (!mutations || mutations.length === 0) return null;
    if (mutationTouchesLocked(mutations, locked)) return null;

    const before = scheduleMetrics(assignments, staff, days);
    const scratch = cloneAssignments(assignments, staff, days);
    commitMutations(scratch, mutations);

    if (options && options.localRepair) {
      greedyRepairPass(scratch, staff, days, locked, true);
      if (options.tokenAware) {
        repairTokenAwareConflicts(scratch, staff, days, locked, true);
        greedyRepairPass(scratch, staff, days, locked, true);
      }
    }

    const after = scheduleMetrics(scratch, staff, days);
    if (!(accept || noHardRuleRegression)(before, after)) return null;

    return {
      assignments: scratch,
      before,
      after,
      mutations,
      cost: totalCost(scratch, staff, days),
      neTransfer: neTransferPriority(assignments, days, mutations),
    };
  }

  function dayCodeCounts(assignments, staff, day) {
    const count = {};
    staff.forEach(s => {
      const c = assignments[s.id] && assignments[s.id][day.date];
      if (c) {
        const key = coverageCode(c);
        count[key] = (count[key] || 0) + 1;
      }
    });
    return count;
  }

  function missingRequiredCodes(assignments, staff, day) {
    const count = dayCodeCounts(assignments, staff, day);
    return dayRequirements(day.dow, day.isHoliday)
      .filter(code => (count[code] || 0) < 1);
  }

  function workCodeBlockReasons(assignments, s, days, dayIdx, code, locked) {
    const day = days[dayIdx];
    const reasons = [];
    const baseCode = workCode(code);
    if (!s || !day) return ['資料不存在'];
    if (s.fixedShift) reasons.push('固定班不參與補班');
    if (isLocked(locked, s.id, day.date)) reasons.push('此格為手動鎖定');
    if (!code || !isWork(code)) reasons.push('缺班代碼不是工作班');
    if ((s.forbidden || []).includes(code) || (s.forbidden || []).includes(baseCode)) reasons.push(`禁忌班 ${baseCode}`);
    if (code === '白' && !isWeekday(day)) reasons.push('假日不能補白班');

    if (!isWork(code)) return reasons;

    if (baseCode === 'N' && dayIdx < days.length - 1) {
      const nxt = assignments[s.id][days[dayIdx+1].date];
      if (workCode(nxt) === '△') reasons.push('補 N 會造成隔日 △');
    }
    if (baseCode === '△' && dayIdx > 0) {
      const prev = assignments[s.id][days[dayIdx-1].date];
      if (workCode(prev) === 'N') reasons.push('前一天 N 後不能接 △');
    }
    if (dayIdx > 0) {
      const prev = assignments[s.id][days[dayIdx-1].date];
      if (workCode(prev) === 'E' && !['7','E'].includes(baseCode)) reasons.push('前一天 E 後只能接 7/E');
      if (workCode(prev) === '3' && !['7','3'].includes(baseCode)) reasons.push('前一天 3 後只能接 7/3');
    }
    if (baseCode === 'E' && dayIdx < days.length - 1) {
      const nxt = assignments[s.id][days[dayIdx+1].date];
      if (!isAllowedAfterE(nxt)) reasons.push(`補 E 後隔日接 ${nxt} 不合法`);
    }
    if (baseCode === '3' && dayIdx < days.length - 1) {
      const nxt = assignments[s.id][days[dayIdx+1].date];
      if (!isAllowedAfter3(nxt)) reasons.push(`補 3 後隔日接 ${nxt} 不合法`);
    }
    if (baseCode !== 'N' && dayIdx < days.length - 1) {
      const nxt = assignments[s.id][days[dayIdx+1].date];
      if (workCode(nxt) === 'N') reasons.push('隔日 N 前一天必須 off/N');
    }
    return reasons;
  }

  function workPreferenceAttemptBlocked(reasons) {
    return (reasons || []).some(reason =>
      reason.startsWith('固定班') ||
      reason.startsWith('此格為手動鎖定') ||
      reason.startsWith('缺班代碼') ||
      reason.startsWith('禁忌班') ||
      reason.startsWith('假日不能補白班') ||
      reason.startsWith('N 前一天') ||
      reason.startsWith('前一天 E') ||
      reason.startsWith('前一天 3') ||
      reason.startsWith('前一天 N')
    );
  }

  function canAttemptManualWorkPreference(assignments, s, days, dayIdx, code, locked) {
    return !workPreferenceAttemptBlocked(workCodeBlockReasons(assignments, s, days, dayIdx, code, locked));
  }

  function restWorkPreferenceAttemptBlocked(reasons) {
    return (reasons || []).some(reason =>
      reason.startsWith('固定班') ||
      reason.startsWith('此格為手動鎖定') ||
      reason.startsWith('缺班代碼') ||
      reason.startsWith('禁忌班') ||
      reason.startsWith('假日不能補白班')
    );
  }

  function canAttemptRestWorkPreference(assignments, s, days, dayIdx, code, locked) {
    return !restWorkPreferenceAttemptBlocked(workCodeBlockReasons(assignments, s, days, dayIdx, code, locked));
  }

  function canReceiveManualOffCode(s, day, code, locked) {
    if (!s || s.fixedShift || !day) return false;
    if (isLocked(locked, s.id, day.date)) return false;
    if (!code || !OFF.has(code)) return false;
    if (code === '休*') return day.dow === 0;
    return true;
  }

  function collectManualRequests(constraints, staff, days) {
    if (!constraints) return [];
    const staffIdx = {};
    staff.forEach((s, idx) => { staffIdx[s.id] = idx; });
    const dayIdx = {};
    days.forEach((d, idx) => { dayIdx[d.date] = idx; });

    const out = [];
    staff.forEach(s => {
      const userData = constraints[s.id] || {};
      Object.keys(userData).forEach(dateKey => {
        if (dayIdx[dateKey] === undefined) return;
        const code = userData[dateKey];
        if (!code || !SHIFT_MAP[code]) return;
        out.push({
          staff: s,
          staffIdx: staffIdx[s.id],
          day: days[dayIdx[dateKey]],
          dayIdx: dayIdx[dateKey],
          date: dateKey,
          code,
        });
      });
    });

    out.sort((a, b) => {
      if (a.dayIdx !== b.dayIdx) return a.dayIdx - b.dayIdx;
      const aOff = OFF.has(a.code) ? 0 : 1;
      const bOff = OFF.has(b.code) ? 0 : 1;
      if (aOff !== bOff) return aOff - bOff;
      return a.staffIdx - b.staffIdx;
    });
    return out;
  }

  function locksForManualRequest(appliedLocks, allManualLocks, req) {
    return unlockCellCopy(mergeLocks(allManualLocks, appliedLocks), req.staff.id, req.date);
  }

  function isHardManualRequest(req) {
    return req && (req.code === '請' || isRestToken(req.code) || isCircleShiftCode(req.code));
  }

  function isWorkPreferenceRequest(req) {
    return req && isSpecialWorkCode(req.code);
  }

  function buildLocksFromRequests(requests) {
    const locked = {};
    (requests || []).forEach(req => {
      lockCell(locked, req.staff.id, req.date, req.code);
    });
    return locked;
  }

  function commitBestManualCandidate(assignments, best) {
    if (!best) return false;
    commitMutations(assignments, best.mutations);
    return true;
  }

  function tryFillMissingCoverageForManualOff(assignments, staff, days, locked, req) {
    let changed = true;
    while (changed) {
      changed = false;
      const missing = missingRequiredCodes(assignments, staff, req.day);
      if (missing.length === 0) return true;

      let best = null;
      const count = dayCodeCounts(assignments, staff, req.day);
      missing.forEach(code => {
        staff.forEach(s => {
          if (s.id === req.staff.id || s.fixedShift) return;
          if (isLocked(locked, s.id, req.date)) return;
          if (!canReceiveWorkCode(assignments, s, days, req.dayIdx, code, locked)) return;

          const cur = assignments[s.id][req.date];
          if (!isWork(cur)) return;
          const curCoverage = coverageCode(cur);
          if (cur !== '白' && dayRequirements(req.day.dow, req.day.isHoliday).includes(curCoverage) && (count[curCoverage] || 0) <= 1) return;

          const candidate = evaluateManualMutations(assignments, staff, days, locked, [
            { staffId: s.id, date: req.date, value: code },
          ], manualCoverageAccept);
          if (!candidate) return;

          const score = (cur === '白' ? 0 : 100) + candidate.cost;
          if (!best || score < best.score) best = { ...candidate, score };
        });
      });

      if (best) {
        commitMutations(assignments, best.mutations);
        changed = true;
      }
    }

    return missingRequiredCodes(assignments, staff, req.day).length === 0;
  }

  function tryFillMissingCoverageFromWhite(assignments, staff, days, locked, req) {
    let changed = true;
    while (changed) {
      changed = false;
      const missing = missingRequiredCodes(assignments, staff, req.day)
        .filter(code => SPECIAL_WORK_CODES.has(code));
      if (missing.length === 0) return true;

      let best = null;
      missing.forEach(code => {
        staff.forEach(s => {
          if (s.id === req.staff.id || s.fixedShift) return;
          if (isLocked(locked, s.id, req.date)) return;
          if (assignments[s.id][req.date] !== '白') return;
          if (!canReceiveWorkCode(assignments, s, days, req.dayIdx, code, locked)) return;

          const candidate = evaluateManualMutations(assignments, staff, days, locked, [
            { staffId: s.id, date: req.date, value: code },
          ], manualCoverageAccept);
          if (!candidate) return;

          const score = countAssignedCode(assignments, s.id, days, code) * 10000
                      + countSpecialWork(assignments, s.id, days) * 100
                      + totalWorkDays(assignments, s.id, days);
          if (!best || score < best.score) best = { ...candidate, score };
        });
      });

      if (best) {
        commitMutations(assignments, best.mutations);
        changed = true;
      }
    }

    return missingRequiredCodes(assignments, staff, req.day)
      .filter(code => SPECIAL_WORK_CODES.has(code))
      .length === 0;
  }

  function coverageGaps(assignments, staff, days) {
    const out = [];
    days.forEach((day, dayIdx) => {
      missingRequiredCodes(assignments, staff, day)
        .filter(code => SPECIAL_WORK_CODES.has(code))
        .forEach(code => out.push({ day, dayIdx, date: day.date, code }));
    });
    return out;
  }

  function betterCoverageCandidate(candidate, best) {
    const cmp = compareRepairCandidates(candidate, best);
    if (cmp !== 0) return cmp < 0;
    return (candidate.score || 0) < (best.score || 0);
  }

  function coverageCandidateScore(assignments, staffId, days, dayIdx, code, penalty) {
    return (penalty || 0)
         + countAssignedCode(assignments, staffId, days, code) * 100000
         + countSpecialWork(assignments, staffId, days) * 1000
         + totalWorkDays(assignments, staffId, days) * 10
         + dayIdx;
  }

  function commitCoverageCandidate(assignments, staff, days, candidate) {
    if (!candidate) return false;
    if (candidate.assignments) {
      replaceAssignments(assignments, candidate.assignments, staff, days);
    } else {
      commitMutations(assignments, candidate.mutations);
    }
    return true;
  }

  function restCompensatedCoverageCandidates(assignments, staff, days, locked, staffMember, dayIdx, code) {
    const day = days[dayIdx];
    if (!day || !isHolidayLike(day)) return [];
    if (!canReceiveWorkCode(assignments, staffMember, days, dayIdx, code, locked)) return [];

    const cur = assignments[staffMember.id][day.date];
    if (!isOff(cur) || cur === '請' || cur === '休*') return [];

    const restCode = isRestToken(cur) ? restQuotaCode(cur) : cur;
    const out = [];
    days.forEach((compDay, compIdx) => {
      if (compIdx === dayIdx || !isWeekday(compDay)) return;
      if (assignments[staffMember.id][compDay.date] !== '白') return;
      if (!canReceiveManualOffCode(staffMember, compDay, restCode, locked)) return;

      out.push({
        compIdx,
        mutations: [
          { staffId: staffMember.id, date: day.date, value: code },
          { staffId: staffMember.id, date: compDay.date, value: restCode },
        ],
      });
    });

    out.sort((a, b) => Math.abs(a.compIdx - dayIdx) - Math.abs(b.compIdx - dayIdx));
    return out;
  }

  function blockingAdjacentWorkIdxsForCoverage(assignments, s, days, dayIdx, code) {
    const out = [];
    const push = idx => {
      if (idx < 0 || idx >= days.length) return;
      const cur = assignments[s.id][days[idx].date];
      if (!cur || !isWork(cur) || cur === '白') return;
      if (!out.includes(idx)) out.push(idx);
    };

    if (dayIdx > 0) {
      const prev = assignments[s.id][days[dayIdx - 1].date];
      const baseCode = workCode(code);
      if (baseCode === 'N' && prev && !isOff(prev) && workCode(prev) !== 'N') push(dayIdx - 1);
      if (baseCode === '△' && workCode(prev) === 'N') push(dayIdx - 1);
      if (workCode(prev) === 'E' && !['7','E'].includes(baseCode)) push(dayIdx - 1);
      if (workCode(prev) === '3' && !['7','3'].includes(baseCode)) push(dayIdx - 1);
    }

    if (dayIdx < days.length - 1) {
      const next = assignments[s.id][days[dayIdx + 1].date];
      const baseCode = workCode(code);
      if (baseCode === 'N' && workCode(next) === '△') push(dayIdx + 1);
      if (baseCode === 'E' && !isAllowedAfterE(next)) push(dayIdx + 1);
      if (baseCode === '3' && !isAllowedAfter3(next)) push(dayIdx + 1);
      if (baseCode !== 'N' && workCode(next) === 'N') push(dayIdx + 1);
    }

    return out;
  }

  function pickCoverageBridgeMove(assignments, staff, days, locked, workStaff, workIdx) {
    let best = null;
    const workDay = days[workIdx];
    const workCode = workDay && assignments[workStaff.id][workDay.date];
    if (!workDay || !workCode || !isWork(workCode) || workCode === '白') return null;

    staff.forEach(partner => {
      if (partner.id === workStaff.id || partner.fixedShift) return;
      if (!isRestToken(assignments[partner.id][workDay.date])) return;

      days.forEach((_day, compIdx) => {
        const mutations = pairedWorkOffSwapMutations(
          assignments,
          staff,
          days,
          locked,
          workStaff,
          partner,
          workIdx,
          compIdx
        );
        const candidate = evaluateMutations(assignments, staff, days, mutations);
        if (!candidate || !isNoWorseSurface(candidate.before, candidate.after)) return;
        if (candidate.after.hard > candidate.before.hard + 3) return;

        candidate.focusedNeTransfer = focusedNeTransferPriority(
          assignments,
          days,
          partner.id,
          workCode
        );
        candidate.score = Math.abs(compIdx - workIdx)
                        + coverageCandidateScore(assignments, partner.id, days, workIdx, workCode, 5000);
        if (betterCoverageCandidate(candidate, best)) best = candidate;
      });
    });

    return best;
  }

  function buildWhiteBridgeCoverageCandidate(assignments, staff, days, locked, staffMember, gap) {
    if (staffMember.fixedShift) return null;
    if (assignments[staffMember.id][gap.date] !== '白') return null;
    if (isLocked(locked, staffMember.id, gap.date)) return null;
    if (!canReceiveWorkCode(assignments, staffMember, days, gap.dayIdx, gap.code, locked)) return null;

    const blockers = blockingAdjacentWorkIdxsForCoverage(assignments, staffMember, days, gap.dayIdx, gap.code);
    if (blockers.length === 0 || blockers.length > 2) return null;

    const scratch = cloneAssignments(assignments, staff, days);
    blockers.forEach(blockerIdx => {
      const bridge = pickCoverageBridgeMove(scratch, staff, days, locked, staffMember, blockerIdx);
      if (bridge) commitMutations(scratch, bridge.mutations);
    });

    const unresolved = blockingAdjacentWorkIdxsForCoverage(scratch, staffMember, days, gap.dayIdx, gap.code);
    if (unresolved.length > 0) return null;
    if (!canReceiveWorkCode(scratch, staffMember, days, gap.dayIdx, gap.code, locked)) return null;

    const mutation = { staffId: staffMember.id, date: gap.date, value: gap.code };
    if (mutationTouchesLocked([mutation], locked)) return null;
    commitMutations(scratch, [mutation]);

    const before = scheduleMetrics(assignments, staff, days);
    const after = scheduleMetrics(scratch, staff, days);
    if (!manualCoverageAccept(before, after)) return null;

    return {
      assignments: scratch,
      before,
      after,
      cost: totalCost(scratch, staff, days),
      focusedNeTransfer: focusedNeTransferPriority(assignments, days, staffMember.id, gap.code),
      score: coverageCandidateScore(assignments, staffMember.id, days, gap.dayIdx, gap.code, 10000),
    };
  }

  function collectCoverageRepairCandidate(assignments, staff, days, locked) {
    let best = null;
    const { idx: weekIdx, weeks: weekLists } = buildDayWeekIndex(days);

    coverageGaps(assignments, staff, days).forEach(gap => {
      staff.forEach(s => {
        if (s.fixedShift) return;
        if (isLocked(locked, s.id, gap.date)) return;

        const cur = assignments[s.id][gap.date];
        if (cur === '白') {
          if (canReceiveWorkCode(assignments, s, days, gap.dayIdx, gap.code, locked)) {
            const candidate = evaluateManualMutations(assignments, staff, days, locked, [
              { staffId: s.id, date: gap.date, value: gap.code },
            ], manualCoverageAccept);
            if (candidate) {
              candidate.focusedNeTransfer = focusedNeTransferPriority(assignments, days, s.id, gap.code);
              candidate.score = coverageCandidateScore(assignments, s.id, days, gap.dayIdx, gap.code, 0);
              if (betterCoverageCandidate(candidate, best)) best = candidate;
            }
          }

          const bridge = buildWhiteBridgeCoverageCandidate(assignments, staff, days, locked, s, gap);
          if (bridge && betterCoverageCandidate(bridge, best)) best = bridge;

          // Compound fix: E/3 gap where simple upgrade fails (E-bad-next on the next 白).
          // (A) try 7 on next day — no quota impact.
          // (B) 3-mutation: E + 例 on next day + relocate an existing 例 in same week → quota-neutral.
          // (C) cross-person: same as (B) but borrow 例 from another staff's same day.
          const gapWc = workCode(gap.code);
          if (gapWc === 'E' || gapWc === '3') {
            const nextIdx = gap.dayIdx + 1;
            if (nextIdx < days.length && isWeekday(days[nextIdx]) &&
                assignments[s.id][days[nextIdx].date] === '白' &&
                !isLocked(locked, s.id, days[nextIdx].date)) {
              let compound = null;

              // (A) try 7 — no quota change
              compound = evaluateManualMutations(assignments, staff, days, locked, [
                { staffId: s.id, date: gap.date, value: gap.code },
                { staffId: s.id, date: days[nextIdx].date, value: '7' },
              ], manualCoverageAccept);

              if (!compound) {
                // (B) 3-mutation: move existing 例/休 in same week to nextIdx
                const wi = weekIdx[gap.date];
                const sameWeekDays = weekLists[wi] || [];
                const freeRest = sameWeekDays.find(d => {
                  if (d.date === gap.date || d.date === days[nextIdx].date) return false;
                  if (isLocked(locked, s.id, d.date)) return false;
                  return isRestToken(assignments[s.id][d.date]);
                });
                if (freeRest) {
                  const followCode = assignments[s.id][freeRest.date];
                  compound = evaluateManualMutations(assignments, staff, days, locked, [
                    { staffId: s.id, date: gap.date, value: gap.code },
                    { staffId: s.id, date: days[nextIdx].date, value: followCode },
                    { staffId: s.id, date: freeRest.date, value: '白' },
                  ], manualCoverageAccept);
                }
              }

              if (!compound) {
                // (C) cross-person: other staff has 例/休 on nextIdx, swap it
                for (const other of staff) {
                  if (other.id === s.id || other.fixedShift) continue;
                  if (isLocked(locked, other.id, days[nextIdx].date)) continue;
                  const otherCode = assignments[other.id][days[nextIdx].date];
                  if (!isRestToken(otherCode) || otherCode === '休*') continue;
                  compound = evaluateManualMutations(assignments, staff, days, locked, [
                    { staffId: s.id, date: gap.date, value: gap.code },
                    { staffId: s.id, date: days[nextIdx].date, value: otherCode },
                    { staffId: other.id, date: days[nextIdx].date, value: '白' },
                  ], manualCoverageAccept);
                  if (compound) break;
                }
              }

              if (!compound) {
                // (D) last-resort: accept one quotaDev increase to get E off-next satisfied
                for (const followCode of ['例', '休']) {
                  compound = evaluateManualMutations(assignments, staff, days, locked, [
                    { staffId: s.id, date: gap.date, value: gap.code },
                    { staffId: s.id, date: days[nextIdx].date, value: followCode },
                  ], compoundOffAccept);
                  if (compound) break;
                }
              }

              if (compound) {
                compound.focusedNeTransfer = focusedNeTransferPriority(assignments, days, s.id, gap.code);
                compound.score = coverageCandidateScore(assignments, s.id, days, gap.dayIdx, gap.code, 3000);
                if (betterCoverageCandidate(compound, best)) best = compound;
              }
            }
          }
          return;
        }

        if (!isHolidayLike(gap.day)) return;
        restCompensatedCoverageCandidates(assignments, staff, days, locked, s, gap.dayIdx, gap.code)
          .forEach(item => {
            const candidate = evaluateManualMutations(assignments, staff, days, locked, item.mutations, manualCoverageAccept);
            if (!candidate) return;
            candidate.focusedNeTransfer = focusedNeTransferPriority(assignments, days, s.id, gap.code);
            candidate.score = coverageCandidateScore(assignments, s.id, days, gap.dayIdx, gap.code, 2000)
                            + Math.abs(item.compIdx - gap.dayIdx);
            if (betterCoverageCandidate(candidate, best)) best = candidate;
          });
      });
    });

    return best;
  }

  function repairCoverageGaps(assignments, staff, days, locked, quiet) {
    const MAX_ITER = 100;
    let iter = 0;
    let applied = 0;
    while (iter < MAX_ITER) {
      iter++;
      const before = scheduleMetrics(assignments, staff, days);
      if (before.gaps === 0) break;

      const best = collectCoverageRepairCandidate(assignments, staff, days, locked);
      if (!best) break;

      commitCoverageCandidate(assignments, staff, days, best);
      applied++;
    }

    if (!quiet && typeof console !== 'undefined') {
      const after = scheduleMetrics(assignments, staff, days);
      console.log(`[Scheduler v2] 缺班修補：iter=${iter}, applied=${applied}, gaps=${after.gaps}, cost=${totalCost(assignments, staff, days).toFixed(2)}`);
    }

    return applied;
  }

  function revertManualOffIfItBrokeCoverage(assignments, staff, days, locked, req) {
    const missing = missingRequiredCodes(assignments, staff, req.day);
    for (const code of missing) {
      if (!canReceiveWorkCode(assignments, req.staff, days, req.dayIdx, code, locked)) continue;
      const candidate = evaluateManualMutations(assignments, staff, days, locked, [
        { staffId: req.staff.id, date: req.date, value: code },
      ], manualCoverageAccept);
      if (!candidate) continue;
      commitMutations(assignments, candidate.mutations);
      return true;
    }
    return false;
  }

  function tryApplyManualLeave(assignments, staff, days, locked, req) {
    if (!canReceiveManualOffCode(req.staff, req.day, '請', locked)) return false;
    const cur = assignments[req.staff.id][req.date];

    if (isRestToken(cur)) {
      return true;
    }

    if ((req.day.rotationGroup === 'regular' || req.day.rotationGroup === 'national') &&
        cur && isWork(cur)) {
      return false;
    }

    if (cur === '請') {
      tryFillMissingCoverageFromWhite(assignments, staff, days, locked, req);
      return true;
    }

    assignments[req.staff.id][req.date] = '請';
    if (cur && cur !== '白' && isSpecialWorkCode(cur)) {
      tryFillMissingCoverageFromWhite(assignments, staff, days, locked, req);
    }
    return true;
  }

  function tryApplyManualRestFromWork(assignments, staff, days, locked, req, cur) {
    const desiredQuota = restQuotaCode(req.code);
    let best = null;

    staff.forEach(partner => {
      if (partner.id === req.staff.id || partner.fixedShift) return;
      if (isLocked(locked, partner.id, req.date)) return;
      const partnerOff = assignments[partner.id][req.date];
      if (!isRestToken(partnerOff)) return;
      if (restQuotaCode(partnerOff) !== desiredQuota) return;
      if (!canReceiveWorkCode(assignments, partner, days, req.dayIdx, cur, locked)) return;

      days.forEach((compDay, compIdx) => {
        if (compIdx === req.dayIdx) return;
        if (isLocked(locked, req.staff.id, compDay.date) || isLocked(locked, partner.id, compDay.date)) return;

        const ownCompOff = assignments[req.staff.id][compDay.date];
        const partnerCompWork = assignments[partner.id][compDay.date];
        if (!isRestToken(ownCompOff) || ownCompOff === '休*') return;
        if (restQuotaCode(ownCompOff) !== desiredQuota) return;
        if (!isWork(partnerCompWork)) return;
        if (!canReceiveWorkCode(assignments, req.staff, days, compIdx, partnerCompWork, locked)) return;

        const candidate = evaluateManualMutations(assignments, staff, days, locked, [
          { staffId: req.staff.id, date: req.date, value: req.code },
          { staffId: partner.id, date: req.date, value: cur },
          { staffId: req.staff.id, date: compDay.date, value: partnerCompWork },
          { staffId: partner.id, date: compDay.date, value: ownCompOff },
        ]);
        if (!candidate) return;

        const score = Math.abs(compIdx - req.dayIdx) + candidate.cost;
        if (!best || score < best.score) best = { ...candidate, score };
      });
    });

    return commitBestManualCandidate(assignments, best);
  }

  function tryMoveOwnRestTokenToManualDay(assignments, staff, days, locked, req, cur) {
    const desiredQuota = restQuotaCode(req.code);
    let best = null;

    days.forEach((donorDay, donorIdx) => {
      if (donorIdx === req.dayIdx) return;
      if (isLocked(locked, req.staff.id, donorDay.date)) return;

      const donorCode = assignments[req.staff.id][donorDay.date];
      if (!isRestToken(donorCode) || donorCode === '休*') return;
      if (restQuotaCode(donorCode) !== desiredQuota) return;

      let donorReplacement = null;
      if (cur && isWork(cur)) donorReplacement = cur;
      else if (isWeekday(donorDay)) donorReplacement = '白';
      else if (cur && isRestToken(cur)) donorReplacement = cur;
      else return;

      if (isWork(donorReplacement) && !canReceiveWorkCode(assignments, req.staff, days, donorIdx, donorReplacement, locked)) return;
      if (isRestToken(donorReplacement) && !canReceiveManualOffCode(req.staff, donorDay, donorReplacement, locked)) return;

      const candidate = evaluateManualMutations(assignments, staff, days, locked, [
        { staffId: req.staff.id, date: req.date, value: req.code },
        { staffId: req.staff.id, date: donorDay.date, value: donorReplacement },
      ]);
      if (!candidate) return;

      const score = Math.abs(donorIdx - req.dayIdx) + candidate.cost;
      if (!best || score < best.score) best = { ...candidate, score };
    });

    return commitBestManualCandidate(assignments, best);
  }

  function tryApplyManualRest(assignments, staff, days, locked, req) {
    if (!canReceiveManualOffCode(req.staff, req.day, req.code, locked)) return false;
    const cur = assignments[req.staff.id][req.date];

    if (cur === req.code) {
      if (tryFillMissingCoverageForManualOff(assignments, staff, days, locked, req)) return true;
      revertManualOffIfItBrokeCoverage(assignments, staff, days, locked, req);
      return false;
    }

    if (cur && isWork(cur) && cur !== '白') {
      return tryApplyManualRestFromWork(assignments, staff, days, locked, req, cur);
    }

    return tryMoveOwnRestTokenToManualDay(assignments, staff, days, locked, req, cur);
  }

  function tryApplyManualWorkFromRest(assignments, staff, days, locked, req) {
    let best = null;
    const ownRest = assignments[req.staff.id][req.date];

    staff.forEach(holder => {
      if (holder.id === req.staff.id || holder.fixedShift) return;
      if (isLocked(locked, holder.id, req.date)) return;
      if (!canCountAsRequired(assignments[holder.id][req.date], workCode(req.code))) return;

      days.forEach((_compDay, compIdx) => {
        const mutations = pairedWorkOffSwapMutations(
          assignments,
          staff,
          days,
          locked,
          holder,
          req.staff,
          req.dayIdx,
          compIdx
        );
        best = considerPreferenceCandidateWithNextRelief(
          assignments, staff, days, locked, req, mutations, 2, Math.abs(compIdx - req.dayIdx), best);
      });

      if (!isRestToken(ownRest) || ownRest === '休*') return;
      if (!canReceiveManualOffCode(holder, req.day, ownRest, locked)) return;

      days.forEach((addDay, addIdx) => {
        if (addIdx === req.dayIdx) return;
        if (!isWeekday(addDay)) return;
        if (isLocked(locked, req.staff.id, addDay.date)) return;
        if (assignments[req.staff.id][addDay.date] !== '白') return;
        if (!canReceiveManualOffCode(req.staff, addDay, ownRest, locked)) return;

        days.forEach((removeDay, removeIdx) => {
          if (removeIdx === req.dayIdx) return;
          if (!isWeekday(removeDay)) return;
          if (isLocked(locked, holder.id, removeDay.date)) return;
          const holderRest = assignments[holder.id][removeDay.date];
          if (!isRestToken(holderRest) || holderRest === '休*') return;
          if (restQuotaCode(holderRest) !== restQuotaCode(ownRest)) return;

          const penalty = Math.abs(addIdx - req.dayIdx) + Math.abs(removeIdx - req.dayIdx) + 500;
          best = considerPreferenceCandidateWithNextRelief(
            assignments, staff, days, locked, req, [
              { staffId: req.staff.id, date: req.date, value: req.code },
              { staffId: holder.id, date: req.date, value: ownRest },
              { staffId: req.staff.id, date: addDay.date, value: ownRest },
              { staffId: holder.id, date: removeDay.date, value: '白' },
            ], 2, penalty, best);
        });
      });
    });

    return commitBestManualCandidate(assignments, best);
  }

  function valueAfterMutations(assignments, staffId, date, mutations) {
    let value = assignments[staffId] && assignments[staffId][date];
    (mutations || []).forEach(m => {
      if (m.staffId === staffId && m.date === date) value = m.value;
    });
    return value;
  }

  function canReceiveShiftCode(assignments, staffMember, days, dayIdx, code, locked) {
    const day = days[dayIdx];
    if (!staffMember || staffMember.fixedShift || !day) return false;
    if (isLocked(locked, staffMember.id, day.date)) return false;
    if (isWork(code)) {
      if ((staffMember.forbidden || []).includes(code) || (staffMember.forbidden || []).includes(workCode(code))) return false;
      if (code === '白' && !isWeekday(day)) return false;
      return true;
    }
    if (isRestToken(code)) return canReceiveManualOffCode(staffMember, days[dayIdx], code, locked);
    return false;
  }

  function considerPreferenceCandidateWithNextRelief(assignments, staff, days, locked, req, mutations, peopleCount, penalty, best) {
    if (!mutations || mutations.length === 0) return best;
    best = considerPreferenceCandidate(assignments, staff, days, locked, req, mutations, peopleCount, penalty, best);

    const nextIdx = req.dayIdx + 1;
    const nextDay = days[nextIdx];
    if (!nextDay || isLocked(locked, req.staff.id, nextDay.date)) return best;

    const requesterNext = valueAfterMutations(assignments, req.staff.id, nextDay.date, mutations);
    if (!requesterNext || allowedNextAfterCode(req.code, requesterNext)) return best;

    staff.forEach(other => {
      if (other.id === req.staff.id || other.fixedShift) return;
      if (isLocked(locked, other.id, nextDay.date)) return;
      const otherNext = valueAfterMutations(assignments, other.id, nextDay.date, mutations);
      if (!otherNext || otherNext === requesterNext) return;
      if (!allowedNextAfterCode(req.code, otherNext)) return;
      if (!canReceiveShiftCode(assignments, req.staff, days, nextIdx, otherNext, locked)) return;
      if (!canReceiveShiftCode(assignments, other, days, nextIdx, requesterNext, locked)) return;

      const nextSwap = mutations.concat([
        { staffId: req.staff.id, date: nextDay.date, value: otherNext },
        { staffId: other.id, date: nextDay.date, value: requesterNext },
      ]);
      best = considerPreferenceCandidate(
        assignments, staff, days, locked, req, nextSwap, peopleCount + 1, (penalty || 0) + 250, best);

      if (isWork(requesterNext) && isRestToken(otherNext) && otherNext !== '休*') {
        days.forEach((compDay, compIdx) => {
          if (compIdx === req.dayIdx || compIdx === nextIdx) return;
          if (!isWeekday(compDay)) return;
          if (isLocked(locked, req.staff.id, compDay.date) || isLocked(locked, other.id, compDay.date)) return;

          const requesterComp = valueAfterMutations(assignments, req.staff.id, compDay.date, mutations);
          const otherComp = valueAfterMutations(assignments, other.id, compDay.date, mutations);
          if (!isRestToken(requesterComp) || requesterComp === '休*') return;
          if (restQuotaCode(requesterComp) !== restQuotaCode(otherNext)) return;
          if (otherComp !== '白') return;
          if (!canReceiveManualOffCode(other, compDay, otherNext, locked)) return;

          best = considerPreferenceCandidate(assignments, staff, days, locked, req, nextSwap.concat([
            { staffId: req.staff.id, date: compDay.date, value: '白' },
            { staffId: other.id, date: compDay.date, value: otherNext },
          ]), peopleCount + 1, (penalty || 0) + Math.abs(compIdx - nextIdx) + 350, best);
        });
      }
    });

    return best;
  }

  function allowedNextAfterCode(code, nextCode) {
    if (!nextCode) return true;
    const base = workCode(code);
    if (base === 'E') return isAllowedAfterE(nextCode);
    if (base === '3') return isAllowedAfter3(nextCode);
    if (base === 'N') return workCode(nextCode) !== '△';
    return true;
  }

  function tryApplyManualWorkHandoff(assignments, staff, days, locked, req, cur) {
    let replacement = null;
    if (cur && isWork(cur)) replacement = cur;
    else if (isWeekday(req.day)) replacement = '白';
    else return false;

    let best = null;
    staff.forEach(holder => {
      if (holder.id === req.staff.id || holder.fixedShift) return;
      if (isLocked(locked, holder.id, req.date)) return;
      if (!canCountAsRequired(assignments[holder.id][req.date], workCode(req.code))) return;

      if (isWork(replacement) && !canReceiveWorkCode(assignments, holder, days, req.dayIdx, replacement, locked)) return;
      if (isRestToken(replacement) && !canReceiveManualOffCode(holder, req.day, replacement, locked)) return;

      const candidate = evaluateManualMutations(assignments, staff, days, locked, [
        { staffId: req.staff.id, date: req.date, value: req.code },
        { staffId: holder.id, date: req.date, value: replacement },
      ]);
      if (candidate) {
        const score = countAssignedCode(assignments, req.staff.id, days, req.code) * 10000
                    + countSpecialWork(assignments, req.staff.id, days) * 100
                    + candidate.cost;
        if (!best || score < best.score) best = { ...candidate, score };
      }

      const nextIdx = req.dayIdx + 1;
      const nextDay = days[nextIdx];
      if (!nextDay) return;
      if (isLocked(locked, req.staff.id, nextDay.date) || isLocked(locked, holder.id, nextDay.date)) return;

      const requesterNext = assignments[req.staff.id][nextDay.date];
      const holderNext = assignments[holder.id][nextDay.date];
      if (!requesterNext || !holderNext || requesterNext === holderNext) return;
      if (!isWork(requesterNext) || !isWork(holderNext)) return;
      if (allowedNextAfterCode(req.code, requesterNext)) return;
      if (!allowedNextAfterCode(req.code, holderNext)) return;
      if (!canReceiveWorkCode(assignments, req.staff, days, nextIdx, holderNext, locked)) return;
      if (!canReceiveWorkCode(assignments, holder, days, nextIdx, requesterNext, locked)) return;

      const paired = evaluateManualMutations(assignments, staff, days, locked, [
        { staffId: req.staff.id, date: req.date, value: req.code },
        { staffId: holder.id, date: req.date, value: replacement },
        { staffId: req.staff.id, date: nextDay.date, value: holderNext },
        { staffId: holder.id, date: nextDay.date, value: requesterNext },
      ]);
      if (!paired) return;

      const pairedScore = countAssignedCode(assignments, req.staff.id, days, req.code) * 10000
                        + countSpecialWork(assignments, req.staff.id, days) * 100
                        + paired.cost;
      if (!best || pairedScore < best.score) best = { ...paired, score: pairedScore };
    });

    return commitBestManualCandidate(assignments, best);
  }

  function preferenceCandidateScore(assignments, req, days, candidate, peopleCount, penalty) {
    return (penalty || 0)
         + peopleCount * 1000000
         + countAssignedCode(assignments, req.staff.id, days, req.code) * 10000
         + countSpecialWork(assignments, req.staff.id, days) * 100
         + candidate.cost;
  }

  function considerPreferenceCandidate(assignments, staff, days, locked, req, mutations, peopleCount, penalty, best) {
    const candidate = evaluateManualMutations(assignments, staff, days, locked, mutations);
    if (!candidate) return best;
    candidate.focusedNeTransfer = focusedNeTransferPriority(assignments, days, req.staff.id, req.code);
    candidate.score = preferenceCandidateScore(assignments, req, days, candidate, peopleCount, penalty);
    if (!best || candidate.score < best.score) return candidate;
    return best;
  }

  function tryApplyManualWorkSameDayCycle(assignments, staff, days, locked, req, maxPeople) {
    const cur = assignments[req.staff.id] && assignments[req.staff.id][req.date];
    if (!cur || !isWork(cur)) return false;

    const holders = staff.filter(s =>
      s.id !== req.staff.id &&
      !s.fixedShift &&
      !isLocked(locked, s.id, req.date) &&
      assignments[s.id] &&
      canCountAsRequired(assignments[s.id][req.date], workCode(req.code)));
    if (holders.length === 0) return false;

    const movable = staff.filter(s => {
      if (s.id === req.staff.id || s.fixedShift) return false;
      if (isLocked(locked, s.id, req.date)) return false;
      const code = assignments[s.id] && assignments[s.id][req.date];
      return code && isWork(code);
    });

    let best = null;
    holders.forEach(holder => {
      if (maxPeople >= 3) {
        movable.forEach(third => {
          if (third.id === holder.id) return;
          const thirdCode = assignments[third.id][req.date];
          if (!canReceiveWorkCode(assignments, holder, days, req.dayIdx, thirdCode, locked)) return;
          if (!canReceiveWorkCode(assignments, third, days, req.dayIdx, cur, locked)) return;

          best = considerPreferenceCandidateWithNextRelief(assignments, staff, days, locked, req, [
            { staffId: req.staff.id, date: req.date, value: req.code },
            { staffId: holder.id, date: req.date, value: thirdCode },
            { staffId: third.id, date: req.date, value: cur },
          ], 3, 0, best);
        });
      }

      if (maxPeople >= 4) {
        movable.forEach(third => {
          if (third.id === holder.id) return;
          const thirdCode = assignments[third.id][req.date];
          movable.forEach(fourth => {
            if (fourth.id === holder.id || fourth.id === third.id) return;
            const fourthCode = assignments[fourth.id][req.date];
            if (!canReceiveWorkCode(assignments, holder, days, req.dayIdx, thirdCode, locked)) return;
            if (!canReceiveWorkCode(assignments, third, days, req.dayIdx, fourthCode, locked)) return;
            if (!canReceiveWorkCode(assignments, fourth, days, req.dayIdx, cur, locked)) return;

            best = considerPreferenceCandidateWithNextRelief(assignments, staff, days, locked, req, [
              { staffId: req.staff.id, date: req.date, value: req.code },
              { staffId: holder.id, date: req.date, value: thirdCode },
              { staffId: third.id, date: req.date, value: fourthCode },
              { staffId: fourth.id, date: req.date, value: cur },
            ], 4, 1000, best);
          });
        });
      }
    });

    return commitBestManualCandidate(assignments, best);
  }

  function nearestDayMutations(days, targetIdx, build) {
    const out = [];
    days.forEach((day, idx) => {
      if (idx === targetIdx) return;
      const mutations = build(day, idx);
      if (!mutations) return;
      out.push({ mutations, score: Math.abs(idx - targetIdx) });
    });
    out.sort((a, b) => a.score - b.score);
    return out;
  }

  function restWorkRequesterBalanceOptions(assignments, days, locked, req) {
    const cur = assignments[req.staff.id] && assignments[req.staff.id][req.date];
    const curQuota = restQuotaCode(cur);
    if (curQuota === '休') return [{ mutations: [], score: 0 }];

    if (curQuota === '例' || curQuota === '國') {
      return nearestDayMutations(days, req.dayIdx, (day) => {
        if (isLocked(locked, req.staff.id, day.date)) return null;
        const donor = assignments[req.staff.id][day.date];
        if (isRestWork(donor) || donor === '休*' || restQuotaCode(donor) !== '休') return null;
        return [{ staffId: req.staff.id, date: day.date, value: curQuota }];
      });
    }

    return nearestDayMutations(days, req.dayIdx, (day, idx) => {
      if (!isWeekday(day)) return null;
      if (isLocked(locked, req.staff.id, day.date)) return null;
      const donor = assignments[req.staff.id][day.date];
      if (isRestWork(donor) || donor === '休*' || restQuotaCode(donor) !== '休') return null;
      if (!canReceiveWorkCode(assignments, req.staff, days, idx, '白', locked)) return null;
      return [{ staffId: req.staff.id, date: day.date, value: '白' }];
    });
  }

  function restWorkHolderReliefOptions(assignments, days, locked, holder, req) {
    if (isWeekday(req.day) && canReceiveWorkCode(assignments, holder, days, req.dayIdx, '白', locked)) {
      return [{
        mutations: [{ staffId: holder.id, date: req.date, value: '白' }],
        score: 0,
      }];
    }

    return nearestDayMutations(days, req.dayIdx, (day, idx) => {
      if (!isWeekday(day)) return null;
      if (isLocked(locked, holder.id, day.date)) return null;
      const donor = assignments[holder.id][day.date];
      if (isRestWork(donor) || donor === '休*' || restQuotaCode(donor) !== '休') return null;
      if (!canReceiveWorkCode(assignments, holder, days, idx, '白', locked)) return null;
      return [
        { staffId: holder.id, date: req.date, value: '休' },
        { staffId: holder.id, date: day.date, value: '白' },
      ];
    });
  }

  function sundayStarReplacementOptions(assignments, staff, days, locked, req) {
    if (req.day.dow !== 0) return [{ mutations: [], score: 0 }];
    if (assignments[req.staff.id][req.date] !== '休*') return [{ mutations: [], score: 0 }];
    if (staff.some(s => s.id !== req.staff.id && assignments[s.id] && assignments[s.id][req.date] === '休*')) {
      return [{ mutations: [], score: 0 }];
    }

    const out = [];
    staff.forEach(s => {
      if (s.id === req.staff.id || s.fixedShift) return;
      if (isLocked(locked, s.id, req.date)) return;
      const cur = assignments[s.id] && assignments[s.id][req.date];
      if (!['休','例','國'].includes(cur)) return;

      const baseMutations = [{ staffId: s.id, date: req.date, value: '休*' }];
      const balanced = buildStaffRestBalanceMutations(assignments, staff, days, locked, s, baseMutations);
      out.push({
        mutations: balanced || baseMutations,
        score: (balanced ? 0 : 1000) + (cur === '休' ? 0 : 50),
      });
    });
    out.sort((a, b) => a.score - b.score);
    return out;
  }

  function evaluateRestWorkPreferenceCandidate(assignments, staff, days, locked, req, mutations) {
    if (!mutations || mutationTouchesLocked(mutations, locked)) return null;
    const before = scheduleMetrics(assignments, staff, days);
    const scratch = cloneAssignments(assignments, staff, days);
    commitMutations(scratch, mutations);

    const afterLock = mergeLocks(locked);
    lockCell(afterLock, req.staff.id, req.date, req.code);
    runLocalPostPreferenceRepair(scratch, staff, days, afterLock, []);

    const after = scheduleMetrics(scratch, staff, days);
    if (!manualChangeAccept(before, after)) return null;
    if (scratch[req.staff.id][req.date] !== req.code) return null;

    return {
      assignments: scratch,
      before,
      after,
      mutations,
      cost: totalCost(scratch, staff, days),
      neTransfer: neTransferPriority(assignments, days, mutations),
    };
  }

  function commitRestWorkCandidate(assignments, staff, days, best) {
    if (!best) return false;
    if (best.assignments) {
      replaceAssignments(assignments, best.assignments, staff, days);
      return true;
    }
    commitMutations(assignments, best.mutations);
    return true;
  }

  function tryApplyRestWorkPreference(assignments, staff, days, locked, req) {
    if (!isRestWork(req.code)) return false;
    if (!canAttemptRestWorkPreference(assignments, req.staff, days, req.dayIdx, req.code, locked)) return false;
    if (assignments[req.staff.id][req.date] === req.code) return true;

    const baseCode = workCode(req.code);
    const requesterOptions = restWorkRequesterBalanceOptions(assignments, days, locked, req);
    if (requesterOptions.length === 0) return false;
    const starOptions = sundayStarReplacementOptions(assignments, staff, days, locked, req);
    if (starOptions.length === 0) return false;

    const holders = staff.filter(s => {
      if (s.id === req.staff.id || s.fixedShift) return false;
      if (isLocked(locked, s.id, req.date)) return false;
      const cur = assignments[s.id] && assignments[s.id][req.date];
      return cur && !isRestWork(cur) && canCountAsRequired(cur, baseCode);
    });
    const holderOptions = holders.length
      ? holders.flatMap(holder =>
          restWorkHolderReliefOptions(assignments, days, locked, holder, req)
            .map(option => ({ ...option, holder })))
      : [{ mutations: [], score: 0, holder: null }];

    let best = null;
    requesterOptions.forEach(requesterOption => {
      starOptions.forEach(starOption => {
        holderOptions.forEach(holderOption => {
          const mutations = [
            { staffId: req.staff.id, date: req.date, value: req.code },
            ...requesterOption.mutations,
            ...starOption.mutations,
            ...holderOption.mutations,
          ];
          const candidate = evaluateRestWorkPreferenceCandidate(assignments, staff, days, locked, req, mutations);
          if (!candidate) return;
          candidate.focusedNeTransfer = focusedNeTransferPriority(assignments, days, req.staff.id, baseCode);
          candidate.score = requesterOption.score * 10
                          + starOption.score * 10
                          + holderOption.score * 10
                          + (holderOption.holder ? 0 : 500)
                          + preferenceCandidateScore(assignments, req, days, candidate, holderOption.holder ? 2 : 1, 0);
          if (!best || candidate.score < best.score) best = candidate;
        });
      });
    });

    return commitRestWorkCandidate(assignments, staff, days, best);
  }

  function tryApplyManualWork(assignments, staff, days, locked, req) {
    if (isRestWork(req.code)) return tryApplyRestWorkPreference(assignments, staff, days, locked, req);
    if (!canAttemptManualWorkPreference(assignments, req.staff, days, req.dayIdx, req.code, locked)) return false;
    const cur = assignments[req.staff.id][req.date];
    if (cur === req.code) return true;

    let best = null;

    if (cur && isWork(cur)) {
      staff.forEach(partner => {
        if (partner.id === req.staff.id || partner.fixedShift) return;
        if (isLocked(locked, partner.id, req.date)) return;
        if (!canCountAsRequired(assignments[partner.id][req.date], workCode(req.code))) return;
        if (!canReceiveWorkCode(assignments, partner, days, req.dayIdx, cur, locked)) return;

        best = considerPreferenceCandidateWithNextRelief(assignments, staff, days, locked, req, [
          { staffId: req.staff.id, date: req.date, value: req.code },
          { staffId: partner.id, date: req.date, value: cur },
        ], 2, 0, best);
      });

      best = considerPreferenceCandidateWithNextRelief(assignments, staff, days, locked, req, [
        { staffId: req.staff.id, date: req.date, value: req.code },
      ], 1, 1000, best);

      if (commitBestManualCandidate(assignments, best)) return true;
      if (tryApplyManualWorkHandoff(assignments, staff, days, locked, req, cur)) return true;
      if (tryApplyManualWorkSameDayCycle(assignments, staff, days, locked, req, 3)) return true;
      return tryApplyManualWorkSameDayCycle(assignments, staff, days, locked, req, 4);
    }

    if (isRestToken(cur)) {
      return tryApplyManualWorkFromRest(assignments, staff, days, locked, req);
    }

    if (tryApplyManualWorkHandoff(assignments, staff, days, locked, req, cur)) {
      return true;
    }

    if (tryApplyManualWorkSameDayCycle(assignments, staff, days, locked, req, 3)) {
      return true;
    }

    if (tryApplyManualWorkSameDayCycle(assignments, staff, days, locked, req, 4)) {
      return true;
    }

    return commitBestManualCandidate(assignments,
      evaluateManualMutations(assignments, staff, days, locked, [
        { staffId: req.staff.id, date: req.date, value: req.code },
      ]));
  }

  function tryApplyManualRequest(assignments, staff, days, locked, req) {
    if (req.staff.fixedShift) {
      if (isLocked(locked, req.staff.id, req.date)) return false;
      if (req.code === '請') {
        const cur = assignments[req.staff.id] && assignments[req.staff.id][req.date];
        if (isRestToken(cur)) return true;
        if ((req.day.rotationGroup === 'regular' || req.day.rotationGroup === 'national') &&
            cur && isWork(cur)) return false;
        assignments[req.staff.id][req.date] = '請';
        return true;
      }
      if (isCircleShiftCode(req.code)) {
        assignments[req.staff.id][req.date] = req.code;
        return true;
      }
      if (req.code === '休' && isCircleStaff(req.staff) && isWeekdayRestCreditDay(req.day)) {
        assignments[req.staff.id][req.date] = '休';
        return true;
      }
      return false;
    }
    if (isCircleShiftCode(req.code)) {
      if (isLocked(locked, req.staff.id, req.date)) return false;
      assignments[req.staff.id][req.date] = req.code;
      return true;
    }
    if (req.code === '請') return tryApplyManualLeave(assignments, staff, days, locked, req);
    if (isRestToken(req.code)) return tryApplyManualRest(assignments, staff, days, locked, req);
    if (isWork(req.code)) return tryApplyManualWork(assignments, staff, days, locked, req);
    return false;
  }

  function classifyManualMutationFailure(assignments, staff, days, req) {
    const candidate = evaluateMutations(assignments, staff, days, [
      { staffId: req.staff.id, date: req.date, value: req.code },
    ]);
    if (!candidate) return null;
    const before = candidate.before;
    const after = candidate.after;
    if (after.gaps > before.gaps || after.dups > before.dups) return 'coverage';
    if (after.quotaDev > before.quotaDev) return 'quota';
    if (after.dailyOffOver > before.dailyOffOver) return 'off-limit';
    if (after.hard > before.hard) return 'sequence';
    return null;
  }

  function manualFailureInfo(assignments, staff, days, locked, req) {
    if (isLocked(locked, req.staff.id, req.date)) {
      return { type: 'manual-locked', reason: '被其他手動設定鎖住' };
    }

    if (req.code === '請') {
      const cur = assignments[req.staff.id] && assignments[req.staff.id][req.date];
      if ((req.day.rotationGroup === 'regular' || req.day.rotationGroup === 'national') &&
          cur && isWork(cur)) {
        return { type: 'manual-holiday-leave-not-applied', reason: `假日底稿班「${cur}」已鎖定，保留原班，請假未套用` };
      }
    }

    if (req.staff.fixedShift && req.code !== '請' && !isCircleShiftCode(req.code)
        && !(req.code === '休' && isCircleStaff(req.staff) && isWeekdayRestCreditDay(req.day))) {
      return { type: 'manual-forbidden', reason: '固定班不參與工作班偏好交換' };
    }

    if (isWorkPreferenceRequest(req)) {
      const reasons = workCodeBlockReasons(assignments, req.staff, days, req.dayIdx, req.code, locked);
      const text = reasons.join('、');
      if (text.includes('禁忌')) return { type: 'manual-forbidden', reason: text };
      if (text.includes('鎖定')) return { type: 'manual-locked', reason: text };
      if (text.includes('接') || text.includes('隔日') || text.includes('前一天') || text.includes('N')) {
        return { type: 'manual-sequence', reason: text };
      }

      const holders = staff.filter(s =>
        s.id !== req.staff.id &&
        assignments[s.id] &&
        canCountAsRequired(assignments[s.id][req.date], workCode(req.code)));
      if (holders.length > 0 && holders.every(s => isLocked(locked, s.id, req.date))) {
        return { type: 'manual-locked', reason: `同日原本拿「${req.code}」的人都被鎖住` };
      }

      const directReason = classifyManualMutationFailure(assignments, staff, days, req);
      if (directReason) {
        const label = {
          coverage: '直接套用會造成每日特殊班缺班或重複',
          quota: '直接套用會破壞休/例/國配額',
          'off-limit': '直接套用會讓平日 off 超過上限',
          sequence: '直接套用會造成禁忌、接續或連續上班違規',
        }[directReason];
        return { type: `manual-${directReason}`, reason: label };
      }

      return { type: 'manual-search-depth', reason: '兩人、同日三人、深度 3 的局部交換都找不到合法解' };
    }

    if (isRestToken(req.code) || req.code === '請') {
      const cur = assignments[req.staff.id] && assignments[req.staff.id][req.date];
      if (cur && isWork(cur)) {
        return { type: 'manual-coverage', reason: '請假/off 會移走工作班，且找不到合法補班或守恆交換' };
      }
      return { type: 'manual-quota', reason: '找不到不破壞休/例/國配額的 off 套用方式' };
    }

    return { type: 'manual-search-depth', reason: '找不到合法交換' };
  }

  function addManualConstraintDiagnostic(diagnostics, req, assignments, staff, days, locked) {
    const info = manualFailureInfo(assignments, staff, days, locked, req);
    addDiagnostic(diagnostics, info.type, req.staff, req.day,
      `${req.staff.name} ${req.date} 手動需求「${req.code}」尚未套用：${info.reason}`);
  }

  function appliedManualCode(assignments, req) {
    const actual = assignments[req.staff.id] && assignments[req.staff.id][req.date];
    if (actual === req.code) return actual;
    if (req.code === '請' && isRestToken(actual)) return actual;
    return null;
  }

  function runLocalPostPreferenceRepair(assignments, staff, days, locked, diagnostics) {
    ensureSundayStarCoverage(assignments, staff, days, locked, diagnostics);
    rebalanceRestQuotaLabels(assignments, staff, days, locked, diagnostics);
    repairCoverageGaps(assignments, staff, days, locked, true);
    repairConflicts(assignments, staff, days, locked, diagnostics, true);
  }

  function buildSatisfiedPreferenceLocks(assignments, requests) {
    const locked = {};
    (requests || []).forEach(req => {
      if (appliedManualCode(assignments, req)) {
        lockCell(locked, req.staff.id, req.date, req.code);
      }
    });
    return locked;
  }

  function satisfiedRequestCount(assignments, requests) {
    return (requests || []).reduce((n, req) => n + (appliedManualCode(assignments, req) ? 1 : 0), 0);
  }

  function unsatisfiedRequests(assignments, requests) {
    return (requests || []).filter(req => !appliedManualCode(assignments, req));
  }

  function addUnappliedPreferenceDiagnostics(assignments, staff, days, requests, diagnostics, locked) {
    unsatisfiedRequests(assignments, requests).forEach(req => {
      addManualConstraintDiagnostic(diagnostics, req, assignments, staff, days, locked);
    });
  }

  function applyManualRequestsByStage(assignments, staff, days, requests, baseLocks, appliedLocks, diagnostics, recordFailures, stage) {
    const unresolved = [];

    requests.forEach(req => {
      if (stage !== 'work' && assignments[req.staff.id] && assignments[req.staff.id][req.date] === req.code && isLocked(appliedLocks, req.staff.id, req.date)) {
        return;
      }

      const locked = locksForManualRequest(appliedLocks, baseLocks, req);
      const ok = stage === 'work'
        ? tryApplyManualWork(assignments, staff, days, locked, req)
        : tryApplyManualRequest(assignments, staff, days, locked, req);
      const appliedCode = ok ? appliedManualCode(assignments, req) : null;
      if (appliedCode) {
        if (stage === 'work') {
          const afterLock = mergeLocks(baseLocks, appliedLocks);
          lockCell(afterLock, req.staff.id, req.date, appliedCode);
          runLocalPostPreferenceRepair(assignments, staff, days, afterLock, diagnostics);
        } else {
          lockCell(appliedLocks, req.staff.id, req.date, appliedCode);
        }
      } else {
        unresolved.push(req);
        if (recordFailures) addManualConstraintDiagnostic(diagnostics, req, assignments, staff, days, locked);
      }
    });

    return { appliedLocks, unresolved };
  }

  function applyWorkPreferences(assignments, staff, days, requests, hardLocked, diagnostics) {
    const maxRounds = 3;

    for (let round = 0; round < maxRounds; round++) {
      const pending = unsatisfiedRequests(assignments, requests);
      if (pending.length === 0) break;

      const before = satisfiedRequestCount(assignments, requests);
      applyManualRequestsByStage(
        assignments, staff, days, pending, hardLocked, {}, diagnostics, false, 'work');
      stabilizeHardRules(assignments, staff, days, hardLocked, diagnostics, 2);

      const after = satisfiedRequestCount(assignments, requests);
      if (after <= before) break;
    }

    return buildSatisfiedPreferenceLocks(assignments, requests);
  }

  function splitManualRequests(constraints, staff, days) {
    const requests = collectManualRequests(constraints, staff, days);
    const hard = requests.filter(isHardManualRequest);
    const work = requests.filter(isWorkPreferenceRequest);
    return { hard, work };
  }

  function applyUserConstraintsByExchange(assignments, staff, days, constraints, appliedLocks, diagnostics, recordFailures) {
    const stages = splitManualRequests(constraints, staff, days);
    const hardLocks = buildLocksFromRequests(stages.hard);
    const hard = applyManualRequestsByStage(
      assignments, staff, days, stages.hard, hardLocks, appliedLocks, diagnostics, recordFailures, 'hard');
    const work = applyManualRequestsByStage(
      assignments, staff, days, stages.work, hardLocks, appliedLocks, diagnostics, recordFailures, 'work');
    return {
      appliedLocks,
      unresolved: hard.unresolved.concat(work.unresolved),
      hardLocks,
    };
  }

  function canReceiveWorkCode(_assignments, s, days, dayIdx, code, locked) {
    const day = days[dayIdx];
    if (!s || s.fixedShift || !day) return false;
    if (isLocked(locked, s.id, day.date)) return false;
    if (!code || !isWork(code)) return false;
    if ((s.forbidden || []).includes(code) || (s.forbidden || []).includes(workCode(code))) return false;
    if (code === '白' && !isWeekday(day)) return false;
    return true;
  }

  function sameDaySwapDaysForConflict(conf, days) {
    if (conf.type === 'N-next-triangle') {
      return [conf.dayIdx, conf.dayIdx + 1].filter(idx => idx >= 0 && idx < days.length);
    }
    if (conf.type === 'E-bad-next' || conf.type === '3-bad-next') {
      return [conf.dayIdx + 1].filter(idx => idx >= 0 && idx < days.length);
    }
    return [conf.dayIdx];
  }

  function sameDayWorkSwapMutations(assignments, staff, days, locked, dayIdx, aId, bId) {
    const day = days[dayIdx];
    if (!day || aId === bId) return null;
    if (isLocked(locked, aId, day.date) || isLocked(locked, bId, day.date)) return null;

    const a = staff.find(x => x.id === aId);
    const b = staff.find(x => x.id === bId);
    if (!a || !b || a.fixedShift || b.fixedShift) return null;

    const aCode = assignments[aId][day.date];
    const bCode = assignments[bId][day.date];
    if (!aCode || !bCode || aCode === bCode) return null;
    if (!isWork(aCode) || !isWork(bCode)) return null;
    if (!canReceiveWorkCode(assignments, a, days, dayIdx, bCode, locked)) return null;
    if (!canReceiveWorkCode(assignments, b, days, dayIdx, aCode, locked)) return null;

    return [
      { staffId: aId, date: day.date, value: bCode },
      { staffId: bId, date: day.date, value: aCode },
    ];
  }

  function sameDayWorkCycleMutations(assignments, staff, days, locked, dayIdx, ids) {
    const day = days[dayIdx];
    if (!day || !ids || ids.length < 3) return null;
    if (new Set(ids).size !== ids.length) return null;

    const people = ids.map(id => staff.find(x => x.id === id));
    if (people.some(s => !s || s.fixedShift || isLocked(locked, s.id, day.date))) return null;

    const codes = ids.map(id => assignments[id] && assignments[id][day.date]);
    if (codes.some(code => !code || !isWork(code))) return null;

    const mutations = ids.map((id, idx) => {
      const value = codes[(idx + 1) % codes.length];
      return { staffId: id, date: day.date, value };
    });
    if (mutations.every((m, idx) => m.value === codes[idx])) return null;

    for (let idx = 0; idx < ids.length; idx++) {
      if (!canReceiveWorkCode(assignments, people[idx], days, dayIdx, mutations[idx].value, locked)) {
        return null;
      }
    }

    return mutations;
  }

  function collectSameDayCycleMutations(assignments, staff, days, locked, dayIdx, focusStaffId, maxCount) {
    const day = days[dayIdx];
    if (!day || !focusStaffId) return [];
    const focus = staff.find(s => s.id === focusStaffId);
    if (!focus || focus.fixedShift || isLocked(locked, focus.id, day.date)) return [];
    const focusCode = assignments[focus.id] && assignments[focus.id][day.date];
    if (!focusCode || !isWork(focusCode)) return [];

    const movable = staff.filter(s => {
      if (s.id === focusStaffId || s.fixedShift) return false;
      if (isLocked(locked, s.id, day.date)) return false;
      const code = assignments[s.id] && assignments[s.id][day.date];
      return code && isWork(code);
    });

    const out = [];
    const limit = maxCount || 120;
    const push = mutations => {
      if (!mutations || out.length >= limit) return;
      out.push(mutations);
    };

    for (let i = 0; i < movable.length && out.length < limit; i++) {
      for (let j = 0; j < movable.length && out.length < limit; j++) {
        if (i === j) continue;
        push(sameDayWorkCycleMutations(
          assignments, staff, days, locked, dayIdx,
          [focusStaffId, movable[i].id, movable[j].id]
        ));
      }
    }

    for (let i = 0; i < movable.length && out.length < limit; i++) {
      for (let j = 0; j < movable.length && out.length < limit; j++) {
        if (i === j) continue;
        for (let k = 0; k < movable.length && out.length < limit; k++) {
          if (k === i || k === j) continue;
          push(sameDayWorkCycleMutations(
            assignments, staff, days, locked, dayIdx,
            [focusStaffId, movable[i].id, movable[j].id, movable[k].id]
          ));
        }
      }
    }

    return out;
  }

  function repairBySameDayWorkSwaps(assignments, staff, days, locked, allowedTypes, label, quiet) {
    const allowed = new Set(allowedTypes);
    const MAX_ITER = 160;
    let iter = 0;
    let applied = 0;

    while (iter < MAX_ITER) {
      iter++;
      const conflicts = detectConflicts(assignments, staff, days)
        .filter(c => allowed.has(c.type));
      if (conflicts.length === 0) break;

      let best = null;
      conflicts.forEach(conf => {
        sameDaySwapDaysForConflict(conf, days).forEach(dayIdx => {
          staff.forEach(other => {
            if (other.id === conf.staffId) return;
            const movingCode = assignments[conf.staffId][days[dayIdx].date];
            const mutations = sameDayWorkSwapMutations(
              assignments,
              staff,
              days,
              locked,
              dayIdx,
              conf.staffId,
              other.id
            );
            const candidate = evaluateMutations(assignments, staff, days, mutations);
            if (!candidate || !improvesHardSafely(candidate.before, candidate.after)) return;
            candidate.focusedNeTransfer = focusedNeTransferPriority(
              assignments,
              days,
              other.id,
              movingCode
            );
            if (betterRepairCandidate(candidate, best)) best = candidate;
          });
        });
      });

      if (!best) break;
      commitMutations(assignments, best.mutations);
      applied++;
    }

    if (!quiet && typeof console !== 'undefined') {
      console.log(`[Scheduler v2] ${label}：iter=${iter}, applied=${applied}, cost=${totalCost(assignments, staff, days).toFixed(2)}`);
    }
  }

  function findWorkRun(assignments, staffId, days, seedIdx) {
    if (seedIdx < 0 || seedIdx >= days.length) return null;
    if (!isWork(assignments[staffId][days[seedIdx].date])) return null;

    let start = seedIdx;
    while (start > 0 && isWork(assignments[staffId][days[start - 1].date])) start--;

    let end = seedIdx;
    while (end < days.length - 1 && isWork(assignments[staffId][days[end + 1].date])) end++;

    return { start, end };
  }

  function pairedWorkOffSwapMutations(assignments, staff, days, locked, workStaff, partner, workIdx, compIdx) {
    const workDay = days[workIdx];
    const compDay = days[compIdx];
    if (!workDay || !compDay || workIdx === compIdx) return null;
    if (workStaff.fixedShift || partner.fixedShift) return null;
    if (isLocked(locked, workStaff.id, workDay.date) || isLocked(locked, partner.id, workDay.date)) return null;
    if (isLocked(locked, workStaff.id, compDay.date) || isLocked(locked, partner.id, compDay.date)) return null;

    const aWork = assignments[workStaff.id][workDay.date];
    const bOff = assignments[partner.id][workDay.date];
    const aOff = assignments[workStaff.id][compDay.date];
    const bWork = assignments[partner.id][compDay.date];

    if (!isWork(aWork) || !isRestToken(bOff)) return null;
    if (!isRestToken(aOff) || !isWork(bWork)) return null;
    if (aOff === '休*' || bOff === '休*') return null;
    if (restQuotaCode(aOff) !== restQuotaCode(bOff)) return null;
    if (!canReceiveWorkCode(assignments, partner, days, workIdx, aWork, locked)) return null;
    if (!canReceiveWorkCode(assignments, workStaff, days, compIdx, bWork, locked)) return null;

    return [
      { staffId: workStaff.id, date: workDay.date, value: bOff },
      { staffId: partner.id, date: workDay.date, value: aWork },
      { staffId: workStaff.id, date: compDay.date, value: bWork },
      { staffId: partner.id, date: compDay.date, value: aOff },
    ];
  }

  function workOffSwapDaysForConflict(conf, days) {
    const out = [];
    if (conf.type === 'forbidden') out.push(conf.dayIdx);
    if (conf.type === 'N-prev') {
      if (conf.dayIdx > 0) out.push(conf.dayIdx - 1);
      out.push(conf.dayIdx);
    }
    if (conf.type === 'N-next-triangle') {
      if (conf.dayIdx + 1 < days.length) out.push(conf.dayIdx + 1);
      out.push(conf.dayIdx);
    }
    if (conf.type === 'E-bad-next' || conf.type === '3-bad-next') {
      if (conf.dayIdx + 1 < days.length) out.push(conf.dayIdx + 1);
      out.push(conf.dayIdx);
    }
    return [...new Set(out)].filter(idx => idx >= 0 && idx < days.length);
  }

  function repairByPairedWorkOffFallback(assignments, staff, days, locked, allowedTypes, label, quiet) {
    const allowed = new Set(allowedTypes);
    const MAX_ITER = 120;
    let iter = 0;
    let applied = 0;

    while (iter < MAX_ITER) {
      iter++;
      const conflicts = detectConflicts(assignments, staff, days)
        .filter(c => allowed.has(c.type));
      if (conflicts.length === 0) break;

      let best = null;
      conflicts.forEach(conf => {
        const workStaff = staff.find(s => s.id === conf.staffId);
        if (!workStaff || workStaff.fixedShift) return;

        workOffSwapDaysForConflict(conf, days).forEach(workIdx => {
          if (!isWork(assignments[workStaff.id][days[workIdx].date])) return;
          const movingCode = assignments[workStaff.id][days[workIdx].date];

          staff.forEach(partner => {
            if (partner.id === workStaff.id || partner.fixedShift) return;
            if (!isRestToken(assignments[partner.id][days[workIdx].date])) return;

            days.forEach((_day, compIdx) => {
              const mutations = pairedWorkOffSwapMutations(
                assignments,
                staff,
                days,
                locked,
                workStaff,
                partner,
                workIdx,
                compIdx
              );
              const candidate = evaluateMutations(assignments, staff, days, mutations);
              if (!candidate || !improvesHardSafely(candidate.before, candidate.after)) return;
              candidate.focusedNeTransfer = focusedNeTransferPriority(
                assignments,
                days,
                partner.id,
                movingCode
              );
              if (betterRepairCandidate(candidate, best)) best = candidate;
            });
          });
        });
      });

      if (!best) break;
      commitMutations(assignments, best.mutations);
      applied++;
    }

    if (!quiet && typeof console !== 'undefined') {
      console.log(`[Scheduler v2] ${label}：iter=${iter}, applied=${applied}, cost=${totalCost(assignments, staff, days).toFixed(2)}`);
    }
  }

  function repairOverSixWithPairedWorkOffSwaps(assignments, staff, days, locked, quiet) {
    const MAX_ITER = 100;
    let iter = 0;
    let applied = 0;

    while (iter < MAX_ITER) {
      iter++;
      const conflicts = detectConflicts(assignments, staff, days)
        .filter(c => c.type === 'over-6');
      if (conflicts.length === 0) break;

      let best = null;
      conflicts.forEach(conf => {
        const workStaff = staff.find(s => s.id === conf.staffId);
        const run = findWorkRun(assignments, conf.staffId, days, conf.dayIdx);
        if (!workStaff || !run) return;

        const workIdxs = [];
        for (let idx = run.start; idx <= run.end; idx++) workIdxs.push(idx);
        workIdxs.sort((a, b) => Math.abs(a - conf.dayIdx) - Math.abs(b - conf.dayIdx));

        workIdxs.forEach(workIdx => {
          const movingCode = assignments[workStaff.id][days[workIdx].date];
          staff.forEach(partner => {
            if (partner.id === workStaff.id || partner.fixedShift) return;
            if (!isRestToken(assignments[partner.id][days[workIdx].date])) return;

            days.forEach((_day, compIdx) => {
              const mutations = pairedWorkOffSwapMutations(
                assignments,
                staff,
                days,
                locked,
                workStaff,
                partner,
                workIdx,
                compIdx
              );
              const candidate = evaluateMutations(assignments, staff, days, mutations);
              if (!candidate || !improvesHardSafely(candidate.before, candidate.after)) return;
              candidate.focusedNeTransfer = focusedNeTransferPriority(
                assignments,
                days,
                partner.id,
                movingCode
              );
              if (betterRepairCandidate(candidate, best)) best = candidate;
            });
          });
        });
      });

      if (!best) break;
      commitMutations(assignments, best.mutations);
      applied++;
    }

    if (!quiet && typeof console !== 'undefined') {
      console.log(`[Scheduler v2] 階段 4 連續>6 Y 雙日守恆：iter=${iter}, applied=${applied}, cost=${totalCost(assignments, staff, days).toFixed(2)}`);
    }
  }

  function repairForbiddenAndSequenceConflicts(assignments, staff, days, locked, quiet) {
    repairBySameDayWorkSwaps(assignments, staff, days, locked,
      ['forbidden'], '階段 1 禁忌班 X 同日 work/work', quiet);
    repairByPairedWorkOffFallback(assignments, staff, days, locked,
      ['forbidden'], '階段 1 禁忌班 Y 雙日 work/off fallback', quiet);
    repairBySameDayWorkSwaps(assignments, staff, days, locked,
      ['N-next-triangle'], '階段 2 N後△ X 同日 work/work', quiet);
    repairByPairedWorkOffFallback(assignments, staff, days, locked,
      ['N-next-triangle'], '階段 2 N後△ Y 雙日 work/off fallback', quiet);
    repairBySameDayWorkSwaps(assignments, staff, days, locked,
      ['N-prev','E-bad-next','3-bad-next'], '階段 3 接續規則 X 同日 work/work', quiet);
    repairByPairedWorkOffFallback(assignments, staff, days, locked,
      ['N-prev','E-bad-next','3-bad-next'], '階段 3 接續規則 Y 雙日 work/off fallback', quiet);
  }

  function greedyRepairPass(assignments, staff, days, locked, quiet) {
    repairForbiddenAndSequenceConflicts(assignments, staff, days, locked, quiet);
    repairOverSixWithPairedWorkOffSwaps(assignments, staff, days, locked, quiet);
    repairForbiddenAndSequenceConflicts(assignments, staff, days, locked, quiet);
  }

  function collectBridgeMovesForConflict(assignments, staff, days, locked, conflict) {
    const moves = [];
    const seen = new Set();
    const pushMove = (mutations, focusedNeTransfer) => {
      if (!mutations || mutations.length === 0) return;
      if (mutationTouchesLocked(mutations, locked)) return;
      const key = mutations
        .map(m => `${m.staffId}:${m.date}:${m.value}`)
        .sort()
        .join('|');
      if (seen.has(key)) return;
      seen.add(key);

      const candidate = evaluateMutations(assignments, staff, days, mutations);
      if (!candidate) return;
      // Package search may repair the temporary damage inside a scratch board, so keep only a loose blast-radius guard here.
      if (candidate.after.hard > candidate.before.hard + 4) return;
      if (candidate.after.gaps > candidate.before.gaps + 2) return;
      if (candidate.after.dups > candidate.before.dups + 2) return;
      if (candidate.after.quotaDev > candidate.before.quotaDev + 2) return;
      if (candidate.after.dailyOffOver > candidate.before.dailyOffOver + 1) return;
      candidate.focusedNeTransfer = focusedNeTransfer || null;
      moves.push(candidate);
    };

    sameDaySwapDaysForConflict(conflict, days).forEach(dayIdx => {
      const conflictDay = days[dayIdx];
      const movingCode = conflictDay && assignments[conflict.staffId] && assignments[conflict.staffId][conflictDay.date];
      staff.forEach(other => {
        if (other.id === conflict.staffId) return;
        pushMove(sameDayWorkSwapMutations(
          assignments,
          staff,
          days,
          locked,
          dayIdx,
          conflict.staffId,
          other.id
        ), focusedNeTransferPriority(assignments, days, other.id, movingCode));
      });

      collectSameDayCycleMutations(assignments, staff, days, locked, dayIdx, conflict.staffId, 12)
        .forEach(mutations => {
          const receiver = mutations.find(m => m.value === movingCode && m.staffId !== conflict.staffId);
          pushMove(mutations, receiver
            ? focusedNeTransferPriority(assignments, days, receiver.staffId, movingCode)
            : null);
        });
    });

    const workStaff = staff.find(s => s.id === conflict.staffId);
    if (workStaff && !workStaff.fixedShift) {
      workOffSwapDaysForConflict(conflict, days).forEach(workIdx => {
        if (!isWork(assignments[workStaff.id][days[workIdx].date])) return;
        const movingCode = assignments[workStaff.id][days[workIdx].date];

        staff.forEach(partner => {
          if (partner.id === workStaff.id || partner.fixedShift) return;
          if (!isRestToken(assignments[partner.id][days[workIdx].date])) return;

          days.forEach((_day, compIdx) => {
            pushMove(pairedWorkOffSwapMutations(
              assignments,
              staff,
              days,
              locked,
              workStaff,
              partner,
              workIdx,
              compIdx
            ), focusedNeTransferPriority(assignments, days, partner.id, movingCode));
          });
        });
      });
    }

    moves.sort(compareRepairCandidates);
    return moves.slice(0, 12);
  }

  function repairByBoundedBridgeSearch(assignments, staff, days, locked, quiet) {
    const TARGET_TYPES = new Set(['forbidden','N-prev','N-next-triangle','E-bad-next','3-bad-next','over-6']);
    const MAX_ROUNDS = 3;
    let applied = 0;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const before = scheduleMetrics(assignments, staff, days);
      if (before.hard === 0) break;

      const conflicts = detectConflicts(assignments, staff, days)
        .filter(c => TARGET_TYPES.has(c.type));
      if (conflicts.length === 0) break;

      let best = null;

      conflicts.forEach(conflict => {
        const moves = collectBridgeMovesForConflict(assignments, staff, days, locked, conflict);
        moves.forEach(move => {
          let candidate = null;
          if (improvesHardSafely(move.before, move.after)) {
            const scratch = cloneAssignments(assignments, staff, days);
            commitMutations(scratch, move.mutations);
            candidate = {
              assignments: scratch,
              before: move.before,
              after: move.after,
              mutations: move.mutations,
              cost: totalCost(scratch, staff, days),
              neTransfer: move.neTransfer,
              focusedNeTransfer: move.focusedNeTransfer,
            };
          } else {
            candidate = evaluateRepairPackage(
              assignments,
              staff,
              days,
              locked,
              move.mutations,
              improvesHardSafely,
              { localRepair: true, tokenAware: false }
            );
          }
          if (!candidate) return;
          candidate.neTransfer = move.neTransfer || candidate.neTransfer;
          candidate.focusedNeTransfer = move.focusedNeTransfer;
          if (betterRepairCandidate(candidate, best)) {
            best = candidate;
          }
        });
      });

      if (!best) break;
      replaceAssignments(assignments, best.assignments, staff, days);
      applied++;
    }

    if (!quiet && typeof console !== 'undefined') {
      console.log(`[Scheduler v2] bounded bridge search：applied=${applied}, cost=${totalCost(assignments, staff, days).toFixed(2)}`);
    }
  }

  // 主修正流程：X 只做同日 work↔work；Y 只做雙日 work/off 守恆交換。
  function repairConflicts(assignments, staff, days, locked, _diagnostics, quiet) {
    greedyRepairPass(assignments, staff, days, locked, !!quiet);
    repairTokenAwareConflicts(assignments, staff, days, locked, true);
    repairByBoundedBridgeSearch(assignments, staff, days, locked, !!quiet);
    greedyRepairPass(assignments, staff, days, locked, !!quiet);
    repairTokenAwareConflicts(assignments, staff, days, locked, true);
    // 不寫 diagnostics — 由主流程最後 writeFinalDiagnostics 統一處理
  }

  function compensationCandidates(assignments, days, locked, fromStaff, toStaff, code, excludeIdxs) {
    const excluded = new Set(excludeIdxs || []);
    const out = [];

    days.forEach((d, idx) => {
      if (excluded.has(idx)) return;
      if (!isWeekday(d)) return;
      if (isLocked(locked, fromStaff.id, d.date) || isLocked(locked, toStaff.id, d.date)) return;
      if (assignments[fromStaff.id][d.date] !== code) return;

      const partnerCode = assignments[toStaff.id][d.date];
      if (!partnerCode || isOff(partnerCode)) return;
      if (partnerCode !== '白') {
        if ((fromStaff.forbidden || []).includes(partnerCode) || (fromStaff.forbidden || []).includes(workCode(partnerCode))) return;
        if (!dayRequirements(d.dow, d.isHoliday).includes(coverageCode(partnerCode))) return;
      }

      out.push({
        idx,
        mutations: [
          { staffId: fromStaff.id, date: d.date, value: partnerCode },
          { staffId: toStaff.id, date: d.date, value: code },
        ],
      });
    });

    out.sort((a, b) => a.idx - b.idx);
    return out;
  }

  function tryMoveOwnTokenToDay(assignments, staff, days, locked, staffMember, targetIdx) {
    const targetDay = days[targetIdx];
    if (!targetDay || staffMember.fixedShift) return false;
    if (isLocked(locked, staffMember.id, targetDay.date)) return false;
    if (assignments[staffMember.id][targetDay.date] !== '白') return false;

    const donors = [];
    days.forEach((d, idx) => {
      if (idx === targetIdx) return;
      if (!isWeekday(d)) return;
      if (isLocked(locked, staffMember.id, d.date)) return;
      const code = assignments[staffMember.id][d.date];
      if (!isRestToken(code)) return;
      donors.push({
        idx,
        code,
        score: Math.abs(idx - targetIdx),
      });
    });
    donors.sort((a, b) => a.score - b.score);

    for (const donor of donors) {
      const donorDay = days[donor.idx];
      const result = tryPatch(assignments, staff, days, [
        { staffId: staffMember.id, date: targetDay.date, value: donor.code },
        { staffId: staffMember.id, date: donorDay.date, value: '白' },
      ], improvesHardSafely);
      if (result) return true;
    }

    return false;
  }

  function tryTwoDayNightBridge(assignments, staff, days, locked, staffMember, nightIdx) {
    const prevIdx = nightIdx - 1;
    const bridgeIdx = prevIdx - 1;
    if (prevIdx < 0 || bridgeIdx < 0 || staffMember.fixedShift) return false;
    const prevDay = days[prevIdx];
    const bridgeDay = days[bridgeIdx];
    if (isLocked(locked, staffMember.id, prevDay.date) ||
        isLocked(locked, staffMember.id, bridgeDay.date)) return false;

    const prevCode = assignments[staffMember.id][prevDay.date];
    const bridgeCode = assignments[staffMember.id][bridgeDay.date];
    if (!prevCode || !bridgeCode || !isWork(prevCode) || !isWork(bridgeCode)) return false;

    for (const donor of staff) {
      if (donor.id === staffMember.id || donor.fixedShift) continue;
      if (isLocked(locked, donor.id, prevDay.date) || isLocked(locked, donor.id, bridgeDay.date)) continue;
      if (workCode(assignments[donor.id][prevDay.date]) !== 'N') continue;
      if (workCode(assignments[donor.id][bridgeDay.date]) !== 'N') continue;
      if (!canReceiveWorkCode(assignments, staffMember, days, prevIdx, assignments[donor.id][prevDay.date], locked)) continue;
      if (!canReceiveWorkCode(assignments, donor, days, prevIdx, prevCode, locked)) continue;
      if (!canReceiveWorkCode(assignments, staffMember, days, bridgeIdx, assignments[donor.id][bridgeDay.date], locked)) continue;
      if (!canReceiveWorkCode(assignments, donor, days, bridgeIdx, bridgeCode, locked)) continue;

      const mutations = [
        { staffId: staffMember.id, date: prevDay.date, value: assignments[donor.id][prevDay.date] },
        { staffId: donor.id, date: prevDay.date, value: prevCode },
        { staffId: staffMember.id, date: bridgeDay.date, value: assignments[donor.id][bridgeDay.date] },
        { staffId: donor.id, date: bridgeDay.date, value: bridgeCode },
      ];
      const candidate = evaluateRepairPackage(
        assignments, staff, days, locked, mutations,
        improvesHardSafely, { localRepair: true, tokenAware: true });
      if (!candidate) continue;
      replaceAssignments(assignments, candidate.assignments, staff, days);
      return true;
    }

    return false;
  }

  function tryTransferNightRunToPreviousNightHolder(assignments, staff, days, locked, staffMember, nightIdx) {
    const prevIdx = nightIdx - 1;
    if (prevIdx < 0 || staffMember.fixedShift) return false;

    let runEnd = nightIdx;
    while (runEnd + 1 < days.length &&
           workCode(assignments[staffMember.id][days[runEnd + 1].date]) === 'N') {
      runEnd++;
    }

    for (const partner of staff) {
      if (partner.id === staffMember.id || partner.fixedShift) continue;
      if (workCode(assignments[partner.id][days[prevIdx].date]) !== 'N') continue;

      const mutations = [];
      let ok = true;
      for (let idx = nightIdx; idx <= runEnd; idx++) {
        const day = days[idx];
        if (isLocked(locked, staffMember.id, day.date) || isLocked(locked, partner.id, day.date)) {
          ok = false;
          break;
        }
        const staffCode = assignments[staffMember.id][day.date];
        const partnerCode = assignments[partner.id][day.date];
        if (workCode(staffCode) !== 'N') {
          ok = false;
          break;
        }
        if (!partnerCode || !isWork(partnerCode)) {
          ok = false;
          break;
        }
        if (!canReceiveWorkCode(assignments, partner, days, idx, staffCode, locked) ||
            !canReceiveWorkCode(assignments, staffMember, days, idx, partnerCode, locked)) {
          ok = false;
          break;
        }
        mutations.push(
          { staffId: staffMember.id, date: day.date, value: partnerCode },
          { staffId: partner.id, date: day.date, value: staffCode },
        );
      }
      if (!ok || mutations.length === 0) continue;

      const candidate = evaluateRepairPackage(
        assignments, staff, days, locked, mutations,
        improvesHardSafely, { localRepair: true, tokenAware: true });
      if (!candidate) continue;
      replaceAssignments(assignments, candidate.assignments, staff, days);
      return true;
    }

    return false;
  }

  function tryMoveOwnTokenToWorkDayWithWhiteDonor(assignments, staff, days, locked, staffMember, targetIdx) {
    const targetDay = days[targetIdx];
    if (!targetDay || staffMember.fixedShift) return false;
    if (isLocked(locked, staffMember.id, targetDay.date)) return false;

    const workShift = assignments[staffMember.id][targetDay.date];
    if (!workShift || !isWork(workShift) || isRestWork(workShift)) return false;

    const donors = staff.filter(s =>
      s.id !== staffMember.id &&
      !s.fixedShift &&
      !isLocked(locked, s.id, targetDay.date) &&
      assignments[s.id][targetDay.date] === '白' &&
      canReceiveWorkCode(assignments, s, days, targetIdx, workShift, locked)
    );
    if (donors.length === 0) return false;

    const tokenDays = [];
    const state = buildWeeklyRestState(days, assignments, staffMember.id);
    const weekIdx = state.dayWeekIndex[targetDay.date];
    const searchDays = weekIdx === undefined ? days : state.weeks[weekIdx];
    searchDays.forEach(d => {
      const idx = days.indexOf(d);
      if (idx < 0 || idx === targetIdx || !isWeekday(d)) return;
      if (isLocked(locked, staffMember.id, d.date)) return;
      const code = assignments[staffMember.id][d.date];
      if (!isRestToken(code) || code === '休*') return;
      tokenDays.push({ idx, day: d, code, score: Math.abs(idx - targetIdx) });
    });
    tokenDays.sort((a, b) => a.score - b.score);

    for (const token of tokenDays) {
      for (const donor of donors) {
        const mutations = [
          { staffId: staffMember.id, date: targetDay.date, value: token.code },
          { staffId: donor.id, date: targetDay.date, value: workShift },
          { staffId: staffMember.id, date: token.day.date, value: '白' },
        ];
        const candidate = evaluateRepairPackage(
          assignments, staff, days, locked, mutations,
          improvesHardSafely, { localRepair: true, tokenAware: true });
        if (!candidate) continue;
        replaceAssignments(assignments, candidate.assignments, staff, days);
        return true;
      }
    }

    return false;
  }

  function trySwapWorkWithOffAndCompensate(assignments, staff, days, locked, workStaff, workIdx) {
    const workDay = days[workIdx];
    if (!workDay || workStaff.fixedShift) return false;
    if (isLocked(locked, workStaff.id, workDay.date)) return false;

    const workShift = assignments[workStaff.id][workDay.date];
    const baseWork = workCode(workShift);
    if (!workShift || !isWork(workShift) || workShift === '白') return false;
    if (!dayRequirements(workDay.dow, workDay.isHoliday).includes(coverageCode(workShift))) return false;

    const partners = staff
      .filter(s => s.id !== workStaff.id && !s.fixedShift)
      .filter(s => !isLocked(locked, s.id, workDay.date))
      .filter(s => !(s.forbidden || []).includes(workShift) && !(s.forbidden || []).includes(baseWork))
      .map(s => ({
        staff: s,
        offCode: assignments[s.id][workDay.date],
      }))
      .filter(x => isRestToken(x.offCode));

    if (baseWork === 'N' || baseWork === 'E') {
      partners.sort((a, b) => {
        const aSame = countAssignedCode(assignments, a.staff.id, days, baseWork);
        const bSame = countAssignedCode(assignments, b.staff.id, days, baseWork);
        if (aSame !== bSame) return aSame - bSame;
        const aNE = countAssignedCode(assignments, a.staff.id, days, 'N')
                  + countAssignedCode(assignments, a.staff.id, days, 'E');
        const bNE = countAssignedCode(assignments, b.staff.id, days, 'N')
                  + countAssignedCode(assignments, b.staff.id, days, 'E');
        return aNE - bNE;
      });
    }

    for (const partner of partners) {
      const comps = compensationCandidates(
        assignments,
        days,
        locked,
        workStaff,
        partner.staff,
        partner.offCode,
        [workIdx]
      );

      for (const comp of comps) {
        const result = tryPatch(assignments, staff, days, [
          { staffId: workStaff.id, date: workDay.date, value: partner.offCode },
          { staffId: partner.staff.id, date: workDay.date, value: workShift },
          ...comp.mutations,
        ], improvesHardSafely);
        if (result) return true;
      }
    }

    return false;
  }

  function repairTokenAwareConflict(assignments, staff, days, locked, conflict) {
    const s = staff.find(x => x.id === conflict.staffId);
    if (!s || s.fixedShift) return false;

    if (conflict.type === 'N-prev') {
      const prevIdx = conflict.dayIdx - 1;
      if (prevIdx < 0) return false;
      const prevDay = days[prevIdx];
      const prevCode = assignments[s.id][prevDay.date];

      if (tryTransferNightRunToPreviousNightHolder(assignments, staff, days, locked, s, conflict.dayIdx)) {
        return true;
      }
      if (tryTwoDayNightBridge(assignments, staff, days, locked, s, conflict.dayIdx)) {
        return true;
      }
      if (prevCode === '白') {
        return tryMoveOwnTokenToDay(assignments, staff, days, locked, s, prevIdx);
      }
      if (prevCode && isWork(prevCode)) {
        if (tryMoveOwnTokenToWorkDayWithWhiteDonor(assignments, staff, days, locked, s, prevIdx)) {
          return true;
        }
        return trySwapWorkWithOffAndCompensate(assignments, staff, days, locked, s, prevIdx);
      }
    }

    if (conflict.type === 'E-bad-next' || conflict.type === '3-bad-next') {
      const nextIdx = conflict.dayIdx + 1;
      if (nextIdx >= days.length) return false;
      const nextDay = days[nextIdx];
      const nextCode = assignments[s.id][nextDay.date];

      if (nextCode === '白') {
        return tryMoveOwnTokenToDay(assignments, staff, days, locked, s, nextIdx);
      }
      if (nextCode && isWork(nextCode)) {
        return trySwapWorkWithOffAndCompensate(assignments, staff, days, locked, s, nextIdx);
      }
    }

    return false;
  }

  function repairTokenAwareConflicts(assignments, staff, days, locked, quiet) {
    const MAX_ITER = 120;
    let iter = 0;
    let repaired = 0;

    while (iter < MAX_ITER) {
      iter++;
      const conflicts = detectConflicts(assignments, staff, days);
      if (conflicts.length === 0) break;

      let changed = false;
      for (const conflict of conflicts) {
        if (repairTokenAwareConflict(assignments, staff, days, locked, conflict)) {
          repaired++;
          changed = true;
          break;
        }
      }

      if (!changed) break;
    }

    if (!quiet && typeof console !== 'undefined') {
      console.log(`[Scheduler v2] token-aware 修正：iter=${iter}, applied=${repaired}, cost=${totalCost(assignments, staff, days).toFixed(2)}`);
    }
  }

  function writeFinalDiagnostics(assignments, staff, days, diagnostics, locked) {
    const remaining = detectConflicts(assignments, staff, days);
    remaining.forEach(c => {
      const s = staff.find(x => x.id === c.staffId);
      const d = days[c.dayIdx];
      const code = assignments[s.id][d.date];
      const msg = ({
        'forbidden': `${s.name} ${d.date} 排了禁忌班「${code}」`,
        'N-prev': `${s.name} ${d.date} 上 N，前一天非 off/N`,
        'N-next-triangle': `${s.name} ${d.date} 上 N，但隔日是 △`,
        'E-bad-next': `${s.name} ${d.date} E 後接續違規`,
        '3-bad-next': `${s.name} ${d.date} 3 後接續違規`,
        'over-6': `${s.name} ${d.date} 連續工作超過 6 天`,
      })[c.type] || `${s.name} ${d.date} ${c.type}`;
      addDiagnostic(diagnostics, c.type, s, d, msg);
    });
    const cov = detectCoverageIssues(assignments, staff, days);
    if (cov.gaps > 0 || cov.dups > 0) {
      addDiagnostic(diagnostics, 'coverage-issue', null, null,
        `每日特殊班 coverage：缺 ${cov.gaps} 格，重複 ${cov.dups} 格`);
    }
    writeCoverageGapDiagnostics(assignments, staff, days, diagnostics, locked);
  }

  function writeCoverageGapDiagnostics(assignments, staff, days, diagnostics, locked) {
    days.forEach((day, dayIdx) => {
      const missing = missingRequiredCodes(assignments, staff, day)
        .filter(code => SPECIAL_WORK_CODES.has(code));
      if (missing.length === 0) return;

      missing.forEach(code => {
        const whiteRows = staff.filter(s => assignments[s.id] && assignments[s.id][day.date] === '白');
        const available = [];
        const blocked = [];
        const restAvailable = [];
        const restBlocked = [];

        whiteRows.forEach(s => {
          const reasons = workCodeBlockReasons(assignments, s, days, dayIdx, code, locked);
          if (reasons.length === 0) {
            const candidate = evaluateManualMutations(assignments, staff, days, locked, [
              { staffId: s.id, date: day.date, value: code },
            ], manualCoverageAccept);
            if (candidate) available.push(s.name);
            else blocked.push(`${s.name}（補後會破壞其他規則或未改善缺班）`);
          } else {
            blocked.push(`${s.name}（${reasons.join('、')}）`);
          }
        });

        if (isHolidayLike(day)) {
          staff
            .filter(s => {
              const cur = assignments[s.id] && assignments[s.id][day.date];
              return isRestToken(cur) && cur !== '休*';
            })
            .forEach(s => {
              const reasons = workCodeBlockReasons(assignments, s, days, dayIdx, code, locked);
              if (reasons.length > 0) {
                restBlocked.push(`${s.name}（${reasons.join('、')}）`);
                return;
              }

              const candidates = restCompensatedCoverageCandidates(assignments, staff, days, locked, s, dayIdx, code);
              const ok = candidates.some(item =>
                evaluateManualMutations(assignments, staff, days, locked, item.mutations, manualCoverageAccept));
              if (ok) {
                restAvailable.push(s.name);
              } else {
                const cur = assignments[s.id][day.date];
                restBlocked.push(`${s.name}（找不到平日白班補回「${restQuotaCode(cur)}」，或補後會破壞規則）`);
              }
            });
        }

        const parts = [
          `${day.date} 缺「${code}」`,
          whiteRows.length ? `當天白班 ${whiteRows.length} 人` : '當天沒有白班可補',
        ];
        if (available.length) parts.push(`可補白班：${available.slice(0, 8).join('、')}`);
        if (blocked.length) parts.push(`不能補：${blocked.slice(0, 8).join('；')}`);
        if (blocked.length > 8) parts.push(`另 ${blocked.length - 8} 人未列出`);
        if (restAvailable.length) parts.push(`可用假日休例國轉補：${restAvailable.slice(0, 8).join('、')}`);
        if (restBlocked.length) parts.push(`假日休例國也補不了：${restBlocked.slice(0, 8).join('；')}`);
        if (restBlocked.length > 8) parts.push(`另 ${restBlocked.length - 8} 個休例國候選未列出`);

        addDiagnostic(diagnostics, 'coverage-gap-detail', null, day, parts.join('；'));
      });
    });
  }

  // ============================================================
  // token 帳本 helpers
  // ============================================================

  // allowedDays 為 null 時搜尋整月；否則只搜尋 allowedDays 內的平日
  function pickDraftRestShortfallDay(assignments, staff, days, locked, dailyOff, staffMember, code, allowedDays) {
    let best = null;
    const searchDays = allowedDays || days;

    searchDays.forEach(d => {
      if (!isWeekday(d)) return;
      const idx = days.indexOf(d);
      if (idx < 0) return;
      if (dailyOff[idx] >= MAX_DAILY_LEAVE) return;
      if (isLocked(locked, staffMember.id, d.date)) return;
      if (assignments[staffMember.id][d.date] !== '白') return;

      const candidate = evaluateMutations(assignments, staff, days, [
        { staffId: staffMember.id, date: d.date, value: code },
      ]);
      if (!candidate || !noHardRuleRegression(candidate.before, candidate.after)) return;
      if (betterRepairCandidate(candidate, best)) best = { ...candidate, dayIdx: idx };
    });

    return best;
  }

  function candidateImprovesQuota(candidate) {
    return candidate
        && noHardRuleRegression(candidate.before, candidate.after)
        && candidate.after.quotaDev < candidate.before.quotaDev;
  }

  function evaluateFocusedRestQuotaMutations(assignments, staff, days, focusStaff, mutations) {
    if (!mutations || mutations.length === 0 || !focusStaff || focusStaff.length === 0) return null;

    const beforeValues = new Map();
    mutations.forEach(m => {
      const key = `${m.staffId}@@${m.date}`;
      if (!beforeValues.has(key)) {
        beforeValues.set(key, {
          staffId: m.staffId,
          date: m.date,
          value: assignments[m.staffId][m.date],
        });
      }
    });

    const focusedHard = () => focusStaff.reduce((sum, s) => sum + countStaffConflicts(assignments, s, days), 0);
    const focusedQuota = () => focusStaff.reduce((sum, s) => {
      if (!s || s.fixedShift) return sum;
      return sum + staffRestQuotaDeviation(assignments, s.id, days);
    }, 0);

    const before = {
      hard: focusedHard(),
      gaps: 0,
      dups: 0,
      quotaDev: focusedQuota(),
      dailyOffOver: weekdayOffOverCount(assignments, staff, days),
    };

    commitMutations(assignments, mutations);

    const after = {
      hard: focusedHard(),
      gaps: 0,
      dups: 0,
      quotaDev: focusedQuota(),
      dailyOffOver: weekdayOffOverCount(assignments, staff, days),
    };

    beforeValues.forEach(v => {
      assignments[v.staffId][v.date] = v.value;
    });

    if (!candidateImprovesQuota({ before, after })) return null;
    return { before, after, cost: 0, mutations };
  }

  function evaluateLocalRestQuotaMutations(assignments, staff, days, staffMember, mutations) {
    return evaluateFocusedRestQuotaMutations(assignments, staff, days, [staffMember], mutations);
  }

  function betterQuotaCandidate(candidate, best, penalty) {
    if (!candidateImprovesQuota(candidate)) return best;
    const score = candidate.after.quotaDev * 100000
                + candidate.after.dailyOffOver * 10000
                + (penalty || 0)
                + candidate.cost;
    if (!best || score < best.score) return { ...candidate, score };
    return best;
  }

  function findWeeklyRestRepair(assignments, staff, days, locked, dailyOff, staffMember) {
    const state = buildWeeklyRestState(days, assignments, staffMember.id);
    const over = [];
    const short = [];

    state.weeks.forEach((_week, wi) => {
      ['休', '例'].forEach(code => {
        const delta = state.counts[wi][code] - state.targets[wi][code];
        if (delta > 0) over.push({ wi, code, delta });
        if (delta < 0) short.push({ wi, code, delta: -delta });
      });
    });

    const donorDays = item => state.weeks[item.wi].map(d => {
      const idx = days.indexOf(d);
      return { d, idx, cur: assignments[staffMember.id][d.date] };
    }).filter(x => {
      if (x.idx < 0) return false;
      if (isRestWork(x.cur) || x.cur === '休*') return false;
      if (restQuotaCode(x.cur) !== item.code) return false;
      // 鎖定的平日格不可動；鎖定的假日 off 格允許 休↔例 同週換標
      if (isLocked(locked, staffMember.id, x.d.date) && !isHolidayLike(x.d)) return false;
      return true;
    });

    const weekdayDonorDays = item => donorDays(item).filter(x => isWeekday(x.d));

    const receiverDays = item => state.weeks[item.wi].map(d => {
      const idx = days.indexOf(d);
      return { d, idx };
    }).filter(x => {
      if (x.idx < 0 || !isWeekday(x.d)) return false;
      if (dailyOff[x.idx] >= MAX_DAILY_LEAVE) return false;
      if (isLocked(locked, staffMember.id, x.d.date)) return false;
      if (assignments[staffMember.id][x.d.date] !== '白') return false;
      if (!canReceiveManualOffCode(staffMember, x.d, item.code, locked)) return false;
      return true;
    });

    const tryMutations = (mutations) => {
      return evaluateLocalRestQuotaMutations(assignments, staff, days, staffMember, mutations);
    };

    for (const o of over) {
      for (const s of short) {
        if (o.wi === s.wi && o.code !== s.code) {
          const donors = donorDays(o).sort((a, b) => a.idx - b.idx);
          for (const donor of donors) {
            const mutation = [{ staffId: staffMember.id, date: donor.d.date, value: s.code }];
            const candidate = tryMutations(mutation);
            if (candidate) return candidate;
          }
        }
      }
    }

    for (const o of over) {
      for (const s of short) {
        const donors = weekdayDonorDays(o).sort((a, b) => a.idx - b.idx);
        const receivers = receiverDays(s).sort((a, b) => Math.abs(a.idx - donors[0]?.idx || 0) - Math.abs(b.idx - donors[0]?.idx || 0));
        for (const donor of donors) {
          for (const receiver of receivers) {
            if (donor.idx === receiver.idx) continue;
            const mutations = [
              { staffId: staffMember.id, date: donor.d.date, value: '白' },
              { staffId: staffMember.id, date: receiver.d.date, value: s.code },
            ];
            const candidate = tryMutations(mutations);
            if (candidate) return candidate;
          }
        }
      }
    }

    for (const s of short) {
      const receivers = receiverDays(s).sort((a, b) => a.idx - b.idx);
      for (const receiver of receivers) {
          const mutation = [{ staffId: staffMember.id, date: receiver.d.date, value: s.code }];
        const candidate = tryMutations(mutation);
        if (candidate) return candidate;
      }
    }

    for (const s of short) {
      const workDays = state.weeks[s.wi].map(d => {
        const idx = days.indexOf(d);
        return { d, idx, cur: assignments[staffMember.id][d.date] };
      }).filter(x => {
        if (x.idx < 0 || !isWeekday(x.d)) return false;
        if (isLocked(locked, staffMember.id, x.d.date)) return false;
        if (!x.cur || !isWork(x.cur) || isRestWork(x.cur)) return false;
        if (!canReceiveManualOffCode(staffMember, x.d, s.code, locked)) return false;
        return true;
      }).sort((a, b) => a.idx - b.idx);

      for (const receiver of workDays) {
        if (dailyOff[receiver.idx] >= MAX_DAILY_LEAVE) continue;
        for (const donor of staff) {
          if (donor.fixedShift || donor.id === staffMember.id) continue;
          if (isLocked(locked, donor.id, receiver.d.date)) continue;
          if (assignments[donor.id][receiver.d.date] !== '白') continue;

          const saved = assignments[donor.id][receiver.d.date];
          assignments[donor.id][receiver.d.date] = null;
          const donorCanWork = absoluteHardOk(assignments, donor, days, receiver.idx, receiver.cur);
          assignments[donor.id][receiver.d.date] = saved;
          if (!donorCanWork) continue;

          const mutations = [
            { staffId: staffMember.id, date: receiver.d.date, value: s.code },
            { staffId: donor.id, date: receiver.d.date, value: receiver.cur },
          ];
          const candidate = evaluateFocusedRestQuotaMutations(
            assignments, staff, days, [staffMember, donor], mutations);
          if (candidate) return candidate;
        }
      }

      for (const receiver of workDays) {
        for (const donor of staff) {
          if (donor.fixedShift || donor.id === staffMember.id) continue;
          if (isLocked(locked, donor.id, receiver.d.date)) continue;
          const donorCur = assignments[donor.id][receiver.d.date];
          if (donorCur === '請' || donorCur === '休*') continue;
          if (restQuotaCode(donorCur) !== s.code) continue;

          const saved = donorCur;
          assignments[donor.id][receiver.d.date] = null;
          const donorCanWork = absoluteHardOk(assignments, donor, days, receiver.idx, receiver.cur);
          assignments[donor.id][receiver.d.date] = saved;
          if (!donorCanWork) continue;

          const mutations = [
            { staffId: staffMember.id, date: receiver.d.date, value: donorCur },
            { staffId: donor.id, date: receiver.d.date, value: receiver.cur },
          ];
          const candidate = evaluateFocusedRestQuotaMutations(
            assignments, staff, days, [staffMember, donor], mutations);
          if (candidate) return candidate;
        }
      }
    }

    for (const o of over) {
      const donors = weekdayDonorDays(o).sort((a, b) => a.idx - b.idx);
      for (const donor of donors) {
        const mutation = [{ staffId: staffMember.id, date: donor.d.date, value: '白' }];
        const candidate = tryMutations(mutation);
        if (candidate) return candidate;
      }
    }

    return null;
  }

  function repairWeeklyRestQuotas(assignments, staff, days, locked, diagnostics) {
    const MAX_ITER = 80;
    const dailyOff = days.map(d => isWeekday(d) ? dailyOffCount(assignments, staff, d) : 0);

    staff.forEach(s => {
      if (s.fixedShift) return;
      let iter = 0;
      while (iter < MAX_ITER && weeklyRestDeviation(days, assignments, s.id) > 0) {
        iter++;
        const best = findWeeklyRestRepair(assignments, staff, days, locked, dailyOff, s);
        if (!best) break;

        best.mutations.forEach(m => {
          const idx = days.findIndex(d => d.date === m.date);
          if (idx < 0 || !isWeekday(days[idx])) return;
          const before = assignments[m.staffId][m.date];
          const beforeOff = OFF.has(before);
          const afterOff = OFF.has(m.value);
          if (!beforeOff && afterOff) dailyOff[idx]++;
          if (beforeOff && !afterOff) dailyOff[idx]--;
        });
        commitMutations(assignments, best.mutations);
      }

      const state = buildWeeklyRestState(days, assignments, s.id);
      state.weeks.forEach((week, wi) => {
        ['休', '例'].forEach(code => {
          const diff = state.counts[wi][code] - state.targets[wi][code];
          if (diff < 0) {
            addDiagnostic(diagnostics, 'token-shortfall',
              s, null, `${s.name} 週 ${week[0].date} 「${code}」尚缺 ${Math.abs(diff)} 個；週內或邊界允許週找不到可用平日白班格`);
          } else if (diff > 0) {
            addDiagnostic(diagnostics, 'token-over',
              s, null, `${s.name} 週 ${week[0].date} 「${code}」過多 ${diff} 個，找不到可搬移或重標籤的格`);
          }
        });
      });
    });
  }

  // 只在底稿剛產生後使用：補足每位員工缺少的休/例/國 token。
  // 休/例：週內補充（不可跨週），國：全月補充。
  // 特殊情況：月份第一週無平日（月 1 日為週六或週日）時，
  //   若該六/日有人上班，其休/例配額允許遞延至第二週。
  function reconcileDraftRestShortfalls(assignments, staff, days, locked, diagnostics) {
    repairWeeklyRestQuotas(assignments, staff, days, locked, diagnostics);
    const dailyOff = days.map(d => isWeekday(d) ? dailyOffCount(assignments, staff, d) : 0);

    staff.forEach(s => {
      if (s.fixedShift) return;

      // ── 國：全月補充（不受週限制）──
      const T國 = restTargets(days)['國'];
      let q國 = countRestQuotas(assignments, s.id, days)['國'];
      if (q國 < T國) {
        let toAdd = T國 - q國;
        while (toAdd > 0) {
          const best = pickDraftRestShortfallDay(assignments, staff, days, locked, dailyOff, s, '國', null);
          if (!best) break;
          commitMutations(assignments, best.mutations);
          dailyOff[best.dayIdx]++;
          toAdd--;
        }
        q國 = countRestQuotas(assignments, s.id, days)['國'];
        if (q國 < T國) {
          addDiagnostic(diagnostics, 'token-shortfall',
            s, null, `${s.name} 「國」尚缺 ${T國 - q國} 個；找不到平日白班且 off cap < ${MAX_DAILY_LEAVE} 的格子可升 off`);
        }
      }
    });
  }

  function rebalanceRestQuotaLabels(assignments, staff, days, locked, diagnostics) {
    repairWeeklyRestQuotas(assignments, staff, days, locked, diagnostics);

    staff.forEach(s => {
      if (s.fixedShift) return;

      // 國：保持月全局平衡（不受週限制）
      const monthlyTarget國 = restTargets(days)['國'];
      let changed國 = true;
      while (changed國) {
        changed國 = false;
        const q國 = countRestQuotas(assignments, s.id, days)['國'];
        if (q國 <= monthlyTarget國) break;

        let best = null;
        days.forEach((d, idx) => {
          const cur = assignments[s.id][d.date];
          if (cur !== '國') return;
          if (isLocked(locked, s.id, d.date)) return;

          // 找月內欠缺的非國 rest code
          const q = countRestQuotas(assignments, s.id, days);
          const T = restTargets(days);
          const short = ['休', '例'].find(code => q[code] < T[code]);
          if (!short) return;

          const candidate = evaluateMutations(assignments, staff, days, [
            { staffId: s.id, date: d.date, value: short },
          ]);
          if (!candidate || !noHardRuleRegression(candidate.before, candidate.after)) return;

          const score = restRelabelScore('國', short, d, idx);
          if (!best || score < best.score) best = { ...candidate, score };
        });

        if (!best) break;
        commitMutations(assignments, best.mutations);
        changed國 = true;
      }

      const q國Final = countRestQuotas(assignments, s.id, days)['國'];
      if (q國Final > restTargets(days)['國']) {
        addDiagnostic(diagnostics, 'token-over',
          s, null, `${s.name} 「國」過多 ${q國Final - restTargets(days)['國']} 個，找不到可重標籤的休例國格`);
      }
    });
  }

  function restRelabelScore(over, short, d, idx) {
    if (over === '休' && short === '例') {
      if (d.dow === 6 && !d.isHoliday) return idx;
      if (isWeekday(d)) return 100 + idx;
      return 200 + idx;
    }
    if (isWeekday(d)) return idx;
    return 100 + idx;
  }

  function buildStaffRestBalanceMutations(assignments, staff, days, locked, staffMember, baseMutations) {
    const out = baseMutations.slice();
    const scratch = cloneAssignments(assignments, staff, days);
    commitMutations(scratch, baseMutations);
    const codes = ['休','例','國'];

    for (let guard = 0; guard < 8; guard++) {
      if (staffRestQuotaDeviation(scratch, staffMember.id, days) === 0) return out;

      let best = null;
      days.forEach((d, idx) => {
        const cur = scratch[staffMember.id][d.date];
        if (isRestWork(cur) || cur === '休*') return;
        if (isLocked(locked, staffMember.id, d.date)) return;
        const curQuota = restQuotaCode(cur);

        if (codes.includes(curQuota)) {
          codes.forEach(code => {
            if (code === curQuota) return;
            const mutation = { staffId: staffMember.id, date: d.date, value: code };
            const scratch2 = cloneAssignments(scratch, staff, days);
            commitMutations(scratch2, [mutation]);
            if (staffRestQuotaDeviation(scratch2, staffMember.id, days) >= staffRestQuotaDeviation(scratch, staffMember.id, days)) return;

            const candidate = evaluateMutations(assignments, staff, days, out.concat(mutation));
            if (!candidate || !noHardRuleRegression(candidate.before, candidate.after)) return;

            const score = staffRestQuotaDeviation(scratch2, staffMember.id, days) * 100000
                        + restRelabelScore(curQuota, code, d, idx)
                        + candidate.cost;
            if (!best || score < best.score) best = { mutation, score };
          });
        }

        if (cur === '白' && isWeekday(d)) {
          codes.forEach(code => {
            if (code === '國' && countRestQuotas(scratch, staffMember.id, days)['國'] >= restTargets(days)['國']) return;
            if (!canReceiveManualOffCode(staffMember, d, code, locked)) return;
            const mutation = { staffId: staffMember.id, date: d.date, value: code };
            const scratch2 = cloneAssignments(scratch, staff, days);
            commitMutations(scratch2, [mutation]);
            if (staffRestQuotaDeviation(scratch2, staffMember.id, days) >= staffRestQuotaDeviation(scratch, staffMember.id, days)) return;

            const candidate = evaluateMutations(assignments, staff, days, out.concat(mutation));
            if (!candidate || !noHardRuleRegression(candidate.before, candidate.after)) return;

            const score = staffRestQuotaDeviation(scratch2, staffMember.id, days) * 100000 + idx + candidate.cost;
            if (!best || score < best.score) best = { mutation, score };
          });
        }
      });

      if (!best) return null;
      commitMutations(scratch, [best.mutation]);
      out.push(best.mutation);
    }

    return null;
  }

  function normalizeSundayStarPlacement(assignments, staff, days, locked, diagnostics) {
    days.forEach(d => {
      if (d.dow === 0) return;

      staff.forEach(s => {
        if (!assignments[s.id] || assignments[s.id][d.date] !== '休*') return;
        if (s.fixedShift || isLocked(locked, s.id, d.date)) {
          addDiagnostic(diagnostics, 'sunday-star-placement',
            s, d, `${s.name} ${d.date} 休* 只能放在週日，但此格為鎖定格，未自動調整`);
          return;
        }
        assignments[s.id][d.date] = '休';
      });
    });
  }

  function ensureSundayStarCoverage(assignments, staff, days, locked, diagnostics) {
    normalizeSundayStarPlacement(assignments, staff, days, locked, diagnostics);

    days.forEach(d => {
      if (d.dow !== 0) return;

      const stars = staff
        .filter(s => assignments[s.id] && assignments[s.id][d.date] === '休*');

      if (stars.length > 1) {
        let extra = stars.length - 1;
        stars.forEach(s => {
          if (extra <= 0) return;
          if (s.fixedShift || isLocked(locked, s.id, d.date)) return;
          assignments[s.id][d.date] = '例';
          extra--;
        });
        if (extra > 0) {
          addDiagnostic(diagnostics, 'sunday-star-over',
            null, d, `${d.date} 休* 超過 1 個，且多餘休* 為鎖定格，未自動調整`);
        }
      }

      if (staff.some(s => assignments[s.id] && assignments[s.id][d.date] === '休*')) return;

      let best = null;
      staff.forEach(s => {
        if (s.fixedShift) return;
        if (isLocked(locked, s.id, d.date)) return;
        const cur = assignments[s.id][d.date];
        if (!['例','休','國'].includes(cur)) return;

        const baseMutations = [
          { staffId: s.id, date: d.date, value: '休*' },
        ];
        const balancedMutations = buildStaffRestBalanceMutations(
          assignments, staff, days, locked, s, baseMutations);
        const mutations = balancedMutations || baseMutations;
        const candidate = evaluateMutations(assignments, staff, days, mutations);
        if (!candidate || !noHardRuleRegression(candidate.before, candidate.after)) return;

        const score = (balancedMutations ? 0 : 10000) + (cur === '例' ? 0 : 100) + candidate.cost;
        if (!best || score < best.score) best = { ...candidate, score };
      });

      if (best) {
        commitMutations(assignments, best.mutations);
      } else {
        addDiagnostic(diagnostics, 'sunday-star-shortfall',
          null, d, `${d.date} 缺週日休* 名額，找不到可轉為休*的未鎖定休假格`);
      }
    });
  }

  // 對每位員工把休/例/國 token 數補/減到目標數
  // 多餘 → 平日改白 / 假日改 null（但假日不能 null，必須是 off → 嘗試從別人那借）
  // 不足 → 找平日「白」改成對應 off
  function reconcileTokens(assignments, staff, days, diagnostics) {
    staff.forEach(s => {
      if (s.fixedShift) return;
      const T = restTargets(days);
      const q = countRestQuotas(assignments, s.id, days);

      ['休','例','國'].forEach(code => {
        const target = T[code];
        const cur = q[code];
        if (cur === target) return;

        if (cur > target) {
          // 過多 → 平日 off → 白
          let toRemove = cur - target;
          for (let i = 0; i < days.length && toRemove > 0; i++) {
            const d = days[i];
            if (isHolidayLike(d)) continue;
            if (assignments[s.id][d.date] === code) {
              assignments[s.id][d.date] = '白';
              toRemove--;
            }
          }
          if (toRemove > 0) {
            addDiagnostic(diagnostics, 'token-over',
              s, null, `${s.name} 「${code}」過多 ${toRemove} 個，無法搬離假日格`);
          }
        } else {
          // 不足 → 找平日「白」改成對應 off
          let toAdd = target - cur;
          for (let i = 0; i < days.length && toAdd > 0; i++) {
            const d = days[i];
            if (isHolidayLike(d)) continue;
            if (assignments[s.id][d.date] === '白') {
              assignments[s.id][d.date] = code;
              toAdd--;
            }
          }
          if (toAdd > 0) {
            addDiagnostic(diagnostics, 'token-shortfall',
              s, null, `${s.name} 「${code}」尚缺 ${toAdd} 個，找不到平日「白」可改`);
          }
        }
      });
    });
  }

  // 平日 off ≤4 上限：搬移多餘 token 到其他平日「白」格
  function capDailyWeekdayOff(assignments, staff, days, diagnostics, locked) {
    const movableOff = new Set(['休','休*','例','國']);
    const isWD = d => !isHolidayLike(d);

    const dailyOff = days.map(d => {
      if (!isWD(d)) return 0;
      let n = 0;
      staff.forEach(s => {
        const c = assignments[s.id][d.date];
        if (OFF.has(c)) n++;
      });
      return n;
    });

    const weeks = getMonthWeeks(days);
    // 判斷兩個 day index 是否在同一週（用於休/例的同週限制）
    const dayWeekIdx = new Array(days.length);
    weeks.forEach((week, wi) => {
      week.forEach(d => { dayWeekIdx[days.indexOf(d)] = wi; });
    });

    days.forEach((d, dayIdx) => {
      if (!isWD(d)) return;

      while (dailyOff[dayIdx] > MAX_DAILY_LEAVE) {
        let bestMove = null;
        staff.forEach(s => {
          if (s.fixedShift) return;
          const code = assignments[s.id][d.date];
          if (!movableOff.has(code)) return;
          if (isLocked(locked, s.id, d.date)) return;

          days.forEach((td, ti) => {
            if (ti === dayIdx || !isWD(td)) return;
            if (dailyOff[ti] >= MAX_DAILY_LEAVE) return;
            if (isLocked(locked, s.id, td.date)) return;
            if (assignments[s.id][td.date] !== '白') return;
            // 休/例：不可跨週搬移
            if ((code === '休' || code === '休*' || code === '例') &&
                dayWeekIdx[ti] !== dayWeekIdx[dayIdx]) return;

            const score = dailyOff[ti] * 100 + Math.abs(ti - dayIdx);
            if (!bestMove || score < bestMove.score) {
              bestMove = { staff: s, code, targetIdx: ti, score };
            }
          });
        });

        if (!bestMove) {
          addDiagnostic(diagnostics, 'weekday-off-over-cap', null, d,
            `${d.date} 平日不上班人數超過 ${MAX_DAILY_LEAVE}，沒有可搬移的 token`);
          break;
        }

        assignments[bestMove.staff.id][d.date] = '白';
        assignments[bestMove.staff.id][days[bestMove.targetIdx].date] = bestMove.code;
        dailyOff[dayIdx]--;
        dailyOff[bestMove.targetIdx]++;
      }
    });
  }

  // 補 N/E 目標：每位輪 N/E 員工平日至少 1N1E
  function ensureMonthlyNE(assignments, staff, days, locked, diagnostics) {
    const rotN = staff.filter(s => !s.fixedShift && !(s.forbidden||[]).includes('N'));
    const rotE = staff.filter(s => !s.fixedShift && !(s.forbidden||[]).includes('E'));
    const weekdays = days.filter(d => d.dow >= 1 && d.dow <= 5 && !d.isHoliday);

    const countCode = (staffId, code) => {
      let n = 0;
      weekdays.forEach(d => {
        const cur = assignments[staffId][d.date];
        if (cur === code || workCode(cur) === code) n++;
      });
      return n;
    };

    const ensure = (s, code) => {
      if (countCode(s.id, code) > 0) return true;

      let best = null;
      for (let i = 0; i < weekdays.length; i++) {
        const d = weekdays[i];
        const cur = assignments[s.id][d.date];
        if (cur !== '白' && (!cur || !isWork(cur) || isRestWork(cur))) continue;
        if (isLocked(locked, s.id, d.date)) continue;

        staff.forEach(target => {
          if (target.id === s.id || target.fixedShift) return;
          if (workCode(assignments[target.id][d.date]) !== code) return;
          if (isLocked(locked, target.id, d.date)) return;
          if (countCode(target.id, code) <= 1) return;

          const candidate = evaluateMutations(assignments, staff, days, [
            { staffId: s.id, date: d.date, value: code },
            { staffId: target.id, date: d.date, value: cur },
          ]);
          let accepted = null;
          if (candidate && noHardRuleRegression(candidate.before, candidate.after)) {
            accepted = candidate;
          } else {
            accepted = evaluateRepairPackage(assignments, staff, days, locked, [
              { staffId: s.id, date: d.date, value: code },
              { staffId: target.id, date: d.date, value: cur },
            ], noHardRuleRegression, { localRepair: true, tokenAware: true });
            if (accepted && staffMonthlyNECounts(accepted.assignments, s.id, days)[code] === 0) accepted = null;
          }
          if (!accepted) return;

          accepted.focusedNeTransfer = focusedNeTransferPriority(assignments, days, s.id, code);
          if (betterRepairCandidate(accepted, best)) best = accepted;
        });
      }

      if (!best) return false;
      if (best.assignments) replaceAssignments(assignments, best.assignments, staff, days);
      else commitMutations(assignments, best.mutations);
      return true;
    };

    rotN.forEach(s => {
      if (!ensure(s, 'N')) {
        addDiagnostic(diagnostics, 'no-weekday-N', s, null,
          `${s.name} 平日未排到 N（大夜）`);
      }
    });
    rotE.forEach(s => {
      if (!ensure(s, 'E')) {
        addDiagnostic(diagnostics, 'no-weekday-E', s, null,
          `${s.name} 平日未排到 E（小夜）`);
      }
    });
  }

  function validatorErrorsFor(assignments, staff, days) {
    if (typeof Validator === 'undefined' || !Validator || typeof Validator.validate !== 'function') return null;
    return Validator.validate({ year: days[0] ? Number(days[0].date.slice(0, 4)) : null, month: null, days, assignments }, staff);
  }

  function validatorErrorDates(err, days) {
    if (!err || !err.date) return [];
    const idx = days.findIndex(d => d.date === err.date);
    if (idx < 0) return [err.date];

    if (err.type === 'N-prev-not-off-or-N') {
      return idx > 0 ? [err.date, days[idx - 1].date] : [err.date];
    }
    if (err.type === 'N-next-triangle' || err.type === 'E-bad-next' || err.type === '3-bad-next') {
      return idx + 1 < days.length ? [err.date, days[idx + 1].date] : [err.date];
    }
    return [err.date];
  }

  function validatorErrorInvolvesLockedCell(err, days, locked) {
    const dates = validatorErrorDates(err, days);
    if (dates.length === 0) return false;
    if (err.staffId) return dates.some(date => isLocked(locked, err.staffId, date));

    return dates.some(date => {
      const day = days.find(d => d.date === date);
      return day && (day.rotationGroup === 'regular' || day.rotationGroup === 'national');
    });
  }

  function blockingValidatorErrors(errors, days, locked) {
    return (errors || []).filter(err => !validatorErrorInvolvesLockedCell(err, days, locked));
  }

  function validatorErrorKey(err) {
    return [
      err && err.type || '',
      err && err.staffId || '',
      err && err.date || '',
    ].join('|');
  }

  function findMonthlyNEChain(assignments, staff, days, locked, receiver, code, depth, seen) {
    if (depth <= 0 || !receiver || receiver.fixedShift) return null;
    const errType = code === 'N' ? 'no-weekday-N' : 'no-weekday-E';
    const receiverKey = `${receiver.id}:${code}`;
    if (seen.has(receiverKey)) return null;
    seen.add(receiverKey);

    const weekdays = days.filter(isTrueWeekday);
    const beforeHardKeys = new Set(
      blockingValidatorErrors(validatorErrorsFor(assignments, staff, days), days, locked)
        .filter(e => e.type !== 'no-weekday-N' && e.type !== 'no-weekday-E')
        .map(validatorErrorKey)
    );

    for (const d of weekdays) {
      const cur = assignments[receiver.id][d.date];
      if (cur !== '白' && (!cur || !isWork(cur) || isRestWork(cur))) continue;
      if (isLocked(locked, receiver.id, d.date)) continue;

      for (const donor of staff) {
        if (donor.id === receiver.id || donor.fixedShift) continue;
        if (isLocked(locked, donor.id, d.date)) continue;
        if (workCode(assignments[donor.id][d.date]) !== code) continue;

        const scratch = cloneAssignments(assignments, staff, days);
        scratch[receiver.id][d.date] = code;
        scratch[donor.id][d.date] = cur;
        const errs = blockingValidatorErrors(validatorErrorsFor(scratch, staff, days), days, locked);
        if (!errs) return null;

        const receiverStillMissing = errs.some(e => e.type === errType && e.staffId === receiver.id);
        if (receiverStillMissing) continue;

        const hardBlocks = errs.filter(e => e.type !== 'no-weekday-N' && e.type !== 'no-weekday-E');
        if (hardBlocks.some(e => !beforeHardKeys.has(validatorErrorKey(e)))) continue;

        const donorCarry = errs.find(e => e.type === errType && e.staffId === donor.id);
        if (!donorCarry) return scratch;

        const solved = findMonthlyNEChain(scratch, staff, days, locked, donor, code, depth - 1, new Set(seen));
        if (solved) return solved;
      }
    }

    return null;
  }

  function repairMonthlyNEChains(assignments, staff, days, locked, diagnostics) {
    if (typeof Validator === 'undefined' || !Validator || typeof Validator.validate !== 'function') return;
    const codes = [
      { code: 'N', type: 'no-weekday-N' },
      { code: 'E', type: 'no-weekday-E' },
    ];

    codes.forEach(item => {
      let guard = 0;
      while (guard < 10) {
        guard++;
        const errs = blockingValidatorErrors(validatorErrorsFor(assignments, staff, days), days, locked);
        const miss = errs.find(e => e.type === item.type);
        if (!miss) break;
        const receiver = staff.find(s => s.id === miss.staffId);
        const solved = findMonthlyNEChain(assignments, staff, days, locked, receiver, item.code, 12, new Set());
        if (!solved) break;
        replaceAssignments(assignments, solved, staff, days);
      }
    });
  }

  function sequenceRepairDayIdx(err, days) {
    if (!err || !err.date) return -1;
    const idx = days.findIndex(d => d.date === err.date);
    if (idx < 0) return -1;
    if (err.type === 'N-prev-not-off-or-N') return idx > 0 ? idx - 1 : -1;
    if (err.type === 'E-bad-next' || err.type === '3-bad-next') return idx + 1 < days.length ? idx + 1 : -1;
    return -1;
  }

  function findSequenceValidatorChain(assignments, staff, days, locked, err, depth, seen) {
    if (depth <= 0 || !err || !err.staffId) return null;
    const dayIdx = sequenceRepairDayIdx(err, days);
    if (dayIdx < 0) return null;
    const day = days[dayIdx];
    const key = `${err.type}:${err.staffId}:${day.date}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (isLocked(locked, err.staffId, day.date)) return null;

    const current = assignments[err.staffId][day.date];
    if (!current) return null;

    for (const other of staff) {
      if (other.id === err.staffId || other.fixedShift) continue;
      if (isLocked(locked, other.id, day.date)) continue;
      const otherCode = assignments[other.id][day.date];
      if (!otherCode || otherCode === current) continue;

      const scratch = cloneAssignments(assignments, staff, days);
      scratch[err.staffId][day.date] = otherCode;
      scratch[other.id][day.date] = current;
      const errs = blockingValidatorErrors(validatorErrorsFor(scratch, staff, days), days, locked)
        .filter(e => e.type !== 'no-weekday-N' && e.type !== 'no-weekday-E');
      if (!errs) return null;
      if (errs.length === 0) return scratch;
      if (errs.length !== 1) continue;
      if (!['N-prev-not-off-or-N','E-bad-next','3-bad-next'].includes(errs[0].type)) continue;
      const solved = findSequenceValidatorChain(scratch, staff, days, locked, errs[0], depth - 1, new Set(seen));
      if (solved) return solved;
    }

    return null;
  }

  function repairSequenceValidatorChains(assignments, staff, days, locked) {
    if (typeof Validator === 'undefined' || !Validator || typeof Validator.validate !== 'function') return;
    let guard = 0;
    while (guard < 10) {
      guard++;
      const errs = blockingValidatorErrors(validatorErrorsFor(assignments, staff, days), days, locked);
      const err = errs.find(e => {
        if (!['N-prev-not-off-or-N','E-bad-next','3-bad-next'].includes(e.type)) return false;
        const repairIdx = sequenceRepairDayIdx(e, days);
        return repairIdx >= 0 && !isLocked(locked, e.staffId, days[repairIdx].date);
      });
      if (!err) break;
      const solved = findSequenceValidatorChain(assignments, staff, days, locked, err, 6, new Set());
      if (!solved) break;
      replaceAssignments(assignments, solved, staff, days);
    }
  }

  function metricsKey(metrics) {
    return [
      metrics.hard,
      metrics.gaps,
      metrics.dups,
      metrics.quotaDev,
      metrics.dailyOffOver,
    ].join('|');
  }

  function stabilizeHardRules(assignments, staff, days, locked, diagnostics, maxRounds) {
    const rounds = maxRounds || 3;
    let appliedRounds = 0;

    for (let round = 0; round < rounds; round++) {
      const before = scheduleMetrics(assignments, staff, days);
      const beforeKey = metricsKey(before);

      ensureSundayStarCoverage(assignments, staff, days, locked, diagnostics);
      rebalanceRestQuotaLabels(assignments, staff, days, locked, diagnostics);
      repairCoverageGaps(assignments, staff, days, locked, true);
      repairConflicts(assignments, staff, days, locked, diagnostics, true);

      const after = scheduleMetrics(assignments, staff, days);
      appliedRounds++;
      if (metricsKey(after) === beforeKey) break;
    }

    if (typeof console !== 'undefined') {
      const m = scheduleMetrics(assignments, staff, days);
      console.log(`[Scheduler v2] 穩定迴圈：rounds=${appliedRounds}, hard=${m.hard}, gaps=${m.gaps}, quotaDev=${m.quotaDev}`);
    }
  }

  // 鎖定所有非固定班在假日（週六/日）和國定假日的格子，使修班流程不再動這些班別
  function buildHolidayPatternLocks(assignments, staff, days) {
    const locked = {};
    days.forEach(d => {
      if (d.rotationGroup !== 'regular' && d.rotationGroup !== 'national') return;
      staff.forEach(s => {
        if (s.fixedShift) return;
        const val = assignments[s.id] && assignments[s.id][d.date];
        if (val !== undefined && val !== null) lockCell(locked, s.id, d.date, val);
      });
    });
    return locked;
  }

  function convertRestToPlaceholders(assignments, staff, days, locked) {
    staff.forEach(s => {
      if (s.fixedShift) return;
      days.forEach(day => {
        if (isLocked(locked, s.id, day.date)) return;
        const v = assignments[s.id][day.date];
        if (v === '休' || v === '例' || v === '休*') {
          assignments[s.id][day.date] = '○';
        }
      });
    });
  }

  function applyRestLabels(assignments, staff, days, locked, diagnostics) {
    // Step 1: E-next-day ○ → 例 (must be off after E)
    staff.forEach(s => {
      if (s.fixedShift) return;
      for (let i = 0; i < days.length - 1; i++) {
        const d = days[i].date, next = days[i + 1].date;
        if (workCode(assignments[s.id][d]) === 'E'
            && assignments[s.id][next] === '○'
            && !isLocked(locked, s.id, next)) {
          assignments[s.id][next] = '例';
        }
      }
    });

    // Step 2: national holiday ○ → 國
    staff.forEach(s => {
      if (s.fixedShift) return;
      days.forEach(day => {
        if ((day.isHoliday || day.rotationGroup === 'national')
            && assignments[s.id][day.date] === '○'
            && !isLocked(locked, s.id, day.date)) {
          assignments[s.id][day.date] = '國';
        }
      });
    });

    // Step 3: weekly quota distribution
    staff.forEach(s => {
      if (s.fixedShift) return;
      const state = buildWeeklyRestState(days, assignments, s.id);
      state.weeks.forEach((week, wi) => {
        const circles = week.filter(d =>
          assignments[s.id][d.date] === '○' && !isLocked(locked, s.id, d.date)
        );
        let need休 = state.targets[wi]['休'] - state.counts[wi]['休'];
        let need例 = state.targets[wi]['例'] - state.counts[wi]['例'];

        circles.forEach(d => {
          if (d.dow === 6 && need休 > 0) {
            assignments[s.id][d.date] = '休'; need休--;
          } else if (d.dow === 0 && need例 > 0) {
            assignments[s.id][d.date] = '例'; need例--;
          } else if (need休 > 0) {
            assignments[s.id][d.date] = '休'; need休--;
          } else if (need例 > 0) {
            assignments[s.id][d.date] = '例'; need例--;
          } else {
            assignments[s.id][d.date] = '白';
          }
        });
      });
    });

    // Safety: convert any remaining ○ → 白
    staff.forEach(s => {
      days.forEach(day => {
        if (assignments[s.id] && assignments[s.id][day.date] === '○') {
          assignments[s.id][day.date] = '白';
        }
      });
    });
  }

  function runRepairPipeline(assignments, staff, days, constraints, diagnostics) {
    const appliedHardLocks = {};
    const stages = splitManualRequests(constraints, staff, days);
    const hardLocks = buildLocksFromRequests(stages.hard);
    const holidayPatternLocks = buildHolidayPatternLocks(assignments, staff, days);
    const initialLocks = mergeLocks(hardLocks, holidayPatternLocks);

    applyManualRequestsByStage(
      assignments, staff, days, stages.hard, initialLocks, appliedHardLocks, diagnostics, true, 'hard');

    let locked = mergeLocks(initialLocks, appliedHardLocks);
    rebalanceRestQuotaLabels(assignments, staff, days, locked, diagnostics);
    reconcileDraftRestShortfalls(assignments, staff, days, locked, diagnostics);
    repairCoverageGaps(assignments, staff, days, locked, false);
    repairConflicts(assignments, staff, days, locked, diagnostics);
    stabilizeHardRules(assignments, staff, days, locked, diagnostics, 3);

    applyWorkPreferences(assignments, staff, days, stages.work, locked, diagnostics);

    locked = mergeLocks(hardLocks, appliedHardLocks, holidayPatternLocks);
    stabilizeHardRules(assignments, staff, days, locked, diagnostics, 3);
    const preferenceLocks = buildSatisfiedPreferenceLocks(assignments, stages.work);
    addUnappliedPreferenceDiagnostics(assignments, staff, days, stages.work, diagnostics, locked);
    const finalLocks = mergeLocks(locked, preferenceLocks);
    ensureMonthlyNE(assignments, staff, days, finalLocks, diagnostics);
    stabilizeHardRules(assignments, staff, days, finalLocks, diagnostics, 2);
    ensureMonthlyNE(assignments, staff, days, finalLocks, diagnostics);
    stabilizeHardRules(assignments, staff, days, finalLocks, diagnostics, 1);
    repairMonthlyNEChains(assignments, staff, days, finalLocks, diagnostics);
    repairSequenceValidatorChains(assignments, staff, days, finalLocks);
    stabilizeHardRules(assignments, staff, days, finalLocks, diagnostics, 1);
    repairWeeklyRestQuotas(assignments, staff, days, finalLocks, diagnostics);
    writeFinalDiagnostics(assignments, staff, days, diagnostics, finalLocks);

    return { appliedManualLocks: appliedHardLocks, hardLocks, preferenceLocks };
  }

  // ============================================================
  // 主入口 v2
  // ============================================================

  function autoFillV2(schedule, staff, constraints) {
    const { days } = schedule;

    // 階段 0：feasibility 預檢
    const fc = feasibilityCheck(staff, days);
    if (!fc.ok) {
      schedule.assignments = emptyAssignments(staff, days);
      schedule.diagnostics = fc.issues.map(msg => ({
        type: 'feasibility-fail', staffId: null, name: null, date: null, msg
      }));
      if (typeof console !== 'undefined') {
        console.warn('[Scheduler v2] 預檢失敗（無法排班）：', fc.issues);
      }
      return schedule;
    }

    const diagnostics = [];

    // 預檢警告：能排但會有殘餘衝突
    (fc.warnings || []).forEach(msg => {
      diagnostics.push({ type: 'feasibility-warning', staffId: null, name: null, date: null, msg });
      if (typeof console !== 'undefined') console.warn('[Scheduler v2] 預檢警告：', msg);
    });

    const draft = { year: schedule.year, month: schedule.month, days, assignments: null, diagnostics: [] };
    initPatternDraft(draft, staff, {}, null);
    const assignments = draft.assignments;
    (draft.diagnostics || []).forEach(d => diagnostics.push(d));
    if (typeof console !== 'undefined') {
      const c0 = detectConflicts(assignments, staff, days);
      console.log(`[Scheduler v2] pattern 底稿完成：衝突 ${c0.length}, cost ${totalCost(assignments, staff, days).toFixed(2)}`);
    }

    runRepairPipeline(assignments, staff, days, constraints, diagnostics);

    if (typeof console !== 'undefined') {
      console.log(`[Scheduler v2] 完成：診斷 ${diagnostics.length} 筆, cost ${totalCost(assignments, staff, days).toFixed(2)}`);
    }

    schedule.assignments = assignments;
    schedule.diagnostics = diagnostics;
    return schedule;
  }

  function repairSchedule(schedule, staff, constraints) {
    const { days } = schedule;

    if (!schedule.assignments) schedule.assignments = emptyAssignments(staff, days);
    ensureAssignmentShape(schedule.assignments, staff, days);
    if (!hasAnyAssignment(schedule.assignments, staff, days)) {
      initPatternDraft(schedule, staff, constraints);
    }

    const assignments = schedule.assignments;
    const diagnostics = [];

    runRepairPipeline(assignments, staff, days, constraints, diagnostics);

    schedule.assignments = assignments;
    schedule.diagnostics = diagnostics;
    if (typeof console !== 'undefined') {
      console.log(`[Scheduler v2] 下一步修班完成：診斷 ${diagnostics.length} 筆, cost ${totalCost(assignments, staff, days).toFixed(2)}`);
    }
    return schedule;
  }

  // ============================================================
  // 舊版 (v1) — 保留以便 console 比對
  // 入口：autoFillLegacy
  // ============================================================

  function preferredOffOrder(day) {
    if (day.isHoliday) return ['國','例','休'];
    if (day.dow === 6) return ['休','國','例'];
    if (day.dow === 0) return ['例','國','休'];
    return ['休','例','國'];
  }

  function pickOffWithinQuota(count, targets, order) {
    for (const code of order) {
      if (count[code] < targets[code]) {
        count[code]++;
        return code;
      }
    }
    return null;
  }

  function canLeaveDonorBlank(assignments, staffId, days, donorIdx) {
    const prev = donorIdx > 0 ? assignments[staffId][days[donorIdx - 1].date] : null;
    const next = donorIdx < days.length - 1 ? assignments[staffId][days[donorIdx + 1].date] : null;
    if (workCode(prev) === 'E' || workCode(prev) === '3' || workCode(next) === 'N') return false;
    let run = 0;
    for (let i = donorIdx - 1; i >= 0; i--) {
      const c = assignments[staffId][days[i].date];
      if (c && isWork(c)) run++;
      else break;
    }
    for (let i = donorIdx + 1; i < days.length; i++) {
      const c = assignments[staffId][days[i].date];
      if (c && isWork(c)) run++;
      else break;
    }
    return run < 6;
  }

  function relocateOffTokenLegacy(assignments, staff, days, targetIdx, locked) {
    const targetDay = days[targetIdx];
    const order = preferredOffOrder(targetDay);
    const donors = [];
    days.forEach((d, idx) => {
      if (idx === targetIdx) return;
      const dKey = d.date;
      const code = assignments[staff.id][dKey];
      if (!order.includes(code)) return;
      if (isLocked(locked, staff.id, dKey)) return;
      if (!canLeaveDonorBlank(assignments, staff.id, days, idx)) return;
      const isHL = d.dow === 0 || d.dow === 6 || d.isHoliday;
      donors.push({ idx, code,
        score: order.indexOf(code) * 100 + (isHL ? 1000 : 0) + Math.abs(idx - targetIdx) });
    });
    if (donors.length === 0) return null;
    donors.sort((a,b) => a.score - b.score);
    const donor = donors[0];
    assignments[staff.id][targetDay.date] = donor.code;
    const donorDay = days[donor.idx];
    const donorIsHL = donorDay.dow === 0 || donorDay.dow === 6 || donorDay.isHoliday;
    assignments[staff.id][donorDay.date] = donorIsHL ? null : '白';
    return donor.code;
  }

  function placeOffWithinQuotaLegacy(assignments, staff, days, dayIdx, diagnostics, reasonType, locked) {
    if (!staff || staff.fixedShift || dayIdx < 0 || dayIdx >= days.length) return null;
    const d = days[dayIdx];
    if (assignments[staff.id][d.date] !== null) return null;
    const count = countRestQuotas(assignments, staff.id, days);
    const code = pickOffWithinQuota(count, restTargets(days), preferredOffOrder(d));
    if (code) { assignments[staff.id][d.date] = code; return code; }
    const r = relocateOffTokenLegacy(assignments, staff, days, dayIdx, locked);
    if (r) return r;
    addDiagnostic(diagnostics, reasonType || 'no-off-quota', staff, d,
      `${staff.name} ${d.date} 需要不上班，但休/例/國配額已用完`);
    return null;
  }

  function autoFillLegacy(schedule, staff, constraints) {
    // 簡化版舊版本：保留舊 token 校正語意供 console 比對
    // 主要保留入口名稱避免外部呼叫失敗
    const { days } = schedule;
    const assignments = emptyAssignments(staff, days);
    const diagnostics = [];
    preFillFixed(assignments, staff, days);
    applyUserConstraintsDirectLegacy(assignments, staff, days, constraints);
    generateDraft(assignments, staff, days, constraints || {}, diagnostics);
    reconcileTokens(assignments, staff, days, diagnostics);
    schedule.assignments = assignments;
    schedule.diagnostics = diagnostics;
    return schedule;
  }

  // ============================================================
  // Public API
  // ============================================================

  function autoFill(schedule, staff, constraints) {
    return autoFillV2(schedule, staff, constraints);
  }

  function clearAssignments(schedule, staff) {
    schedule.assignments = emptyAssignments(staff, schedule.days);
    schedule.diagnostics = [];
    return schedule;
  }

  return {
    autoFill,
    autoFillV2,
    initPatternDraft,
    repairSchedule,
    autoFillLegacy,
    clearAssignments,
    // 暴露 helpers 方便 console 除錯
    _internals: {
      feasibilityCheck,
      detectConflicts,
      totalCost,
      repairTokenAwareConflicts,
      restTargets,
      countRestQuotas,
    },
  };
})();
