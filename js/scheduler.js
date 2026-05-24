// 自動排班引擎 v2 — 底稿 → token 對帳 → X 同日 work/work 換班 → Y 雙日 work/off 守恆換班
// 對日常排班規模 (30 天 × ~22 人) 在毫秒內可解。

const Scheduler = (() => {

  const OFF = new Set(OFF_CODES);
  const REST_TOKENS = new Set(['休','休*','例','國']);
  const isOff = c => c && OFF.has(c);
  const isWork = c => c && !OFF.has(c);
  const isRestToken = c => REST_TOKENS.has(c);
  const isRestWork = c => isRestWorkCode(c);
  const workCode = c => ShiftConfigManager.effectiveWorkCode(c);

  // SPECIAL_WORK_CODES 改從 ShiftConfigManager 動態取（每次呼叫時更新）
  function getSpecialWorkCodesSet() { return ShiftConfigManager.getSpecialWorkCodes(); }
  const coverageCode = c => getSpecialWorkCodesSet().has(workCode(c)) ? workCode(c) : c;
  const isSpecialWorkCode = c => getSpecialWorkCodesSet().has(workCode(c));

  /** 通用接班規則查詢：取代 isAllowedAfterE / isAllowedAfter3 */
  function isAllowedAfterShift(fromCode, nextCode) {
    return ShiftConfigManager.isAllowedAfter(fromCode, nextCode);
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

    // E/3 接續：前一天若是 E/3，今天只能是白名單內（off 永遠允許，與 isAllowedAfter 一致）
    if (dayIdx > 0 && !isOff(code)) {
      const prev = assignments[s.id][days[dayIdx-1].date];
      if (workCode(prev) === 'E' && !['7','E'].includes(workCode(code))) return false;
      if (workCode(prev) === '3' && !['7','3'].includes(workCode(code))) return false;
    }
    // 今天有接班規則的班，隔日已派的非白名單
    if (dayIdx < days.length - 1) {
      const wc = workCode(code);
      const nxt = assignments[s.id][days[dayIdx+1].date];
      if (!isAllowedAfterShift(wc, nxt)) return false;
    }

    // 隔日已 N，今日非 N 工作班 → 違反 N 前置（off 允許，與後端 _add_sequence_constraints 一致）
    if (workCode(code) !== 'N' && !isOff(code) && dayIdx < days.length - 1) {
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

        days.forEach((d, dayIdx) => {
      const PRIORITY = ShiftConfigManager.getDraftPriority();
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
            const fb = ShiftConfigManager.getFallbackCode();
            assignments[s.id][d.date] = fb;
            monthlyCount[s.id][fb] = (monthlyCount[s.id][fb]||0) + 1;
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
    if (isWeekday(day)) return code === ShiftConfigManager.getFallbackCode();
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
        if (prevWc && code && !isAllowedAfterShift(prevWc, code)) continue;
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
          if (assignments[s.id][day.date] === null) assignments[s.id][day.date] = ShiftConfigManager.getFallbackCode();
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
                if (prevWc && !isAllowedAfterShift(prevWc, code)) return;
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
  // Public API
  // ============================================================

  function clearAssignments(schedule, staff) {
    schedule.assignments = emptyAssignments(staff, schedule.days);
    schedule.diagnostics = [];
    return schedule;
  }

  return {
    initPatternDraft,
    clearAssignments,
  };
})();
