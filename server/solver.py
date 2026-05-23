"""
CP-SAT repair solver.

Receives a pattern draft (schedule.assignments) produced by the JS
initPatternDraft() step, then finds the assignment closest to the draft
that satisfies all hard constraints.

Objective: minimise the number of cells that differ from the draft.
"""
from __future__ import annotations
import time
from typing import Optional

from ortools.sat.python import cp_model

from models import RepairRequest, RepairResponse
from rules import (
    MAX_DAILY_LEAVE,
    is_circle_staff, is_circle_day,
    is_holiday_like, is_true_weekday, is_fixed_staff, is_rotation_staff,
    compute_weekly_targets,
    build_runtime_rules, RuntimeRules,
)

Draft = dict[str, dict[str, Optional[str]]]  # staffId -> date -> code
Xmap = dict[tuple, cp_model.IntVar]


def _key(staff_id: str, date: str, code: str) -> tuple:
    return (staff_id, date, code)


def _allowed_codes_for(s, rr: RuntimeRules) -> list[str]:
    """Codes to create variables for a rotation staff member.
    Circle-only codes (◎ etc.) are excluded — they're handled separately for fixed staff.
    """
    return [c for c in rr.all_codes if not rr.is_circle(c)]


# ---------------------------------------------------------------------------
# Holiday rotation lock detection
# ---------------------------------------------------------------------------

def _find_rotation_holiday_locks(
    draft: Draft, rotation_staff, days
) -> dict[str, dict[str, str]]:
    """
    Identify non-default Sat/Sun/holiday cells in the draft.
    These represent rotation-assigned holiday shifts that must be hard-locked:
      - Cannot be changed by the solver
      - Forbidden-shift rules are skipped for these cells
      - Sequence constraints FROM these cells are skipped
      - User leave requests on these days are overridden

    Default codes (what the draft would have if no rotation assigned):
      - Sat (dow=6)     → '休'
      - Sun (dow=0)     → '例'
      - Holiday         → '國'
    """
    locks: dict[str, dict[str, str]] = {}
    for s in rotation_staff:
        staff_draft = draft.get(s.id, {})
        for d in days:
            if not is_holiday_like(d):
                continue
            code = staff_draft.get(d.date)
            if code is None:
                continue
            if d.isHoliday:
                default = '國'
            elif d.dow == 6:
                default = '休'
            else:  # Sunday
                default = '例'
            if code != default:
                locks.setdefault(s.id, {})[d.date] = code
    return locks


# ---------------------------------------------------------------------------
# Constraint builders
# ---------------------------------------------------------------------------

def _add_sequence_constraints(
    model: cp_model.CpModel, x: Xmap, staff, days,
    locked_holiday_cells: set[tuple],
    rr: RuntimeRules,
):
    """接班限制：N前置、N不接△（內建），以及 rr.sequence_rules 裡的自訂 allowedAfter 規則。

    Skip a constraint only when BOTH adjacent cells are locked — that is a
    genuinely unavoidable conflict in the rotation data.  When only one side
    is locked the free cell can always be adjusted by the solver.
    """
    # N前置/N不接△ 適用於所有 effective_work_code == 'N' 的班別
    n_codes = [c for c in rr.all_codes if rr.effective_work_code(c) == 'N']
    off_and_n = rr.off_set | set(n_codes)

    for s in staff:
        for i, day in enumerate(days):
            is_locked = (s.id, day.date) in locked_holiday_cells

            # --- N前置: prev must be OFF or N ---
            for n_code in n_codes:
                nv = x.get(_key(s.id, day.date, n_code))
                if nv is None:
                    continue
                if i == 0:
                    continue  # no prev context
                prev = days[i - 1]
                prev_locked = (s.id, prev.date) in locked_holiday_cells
                if is_locked and prev_locked:
                    continue
                prev_ok = [
                    x[_key(s.id, prev.date, c)]
                    for c in off_and_n
                    if _key(s.id, prev.date, c) in x
                ]
                if prev_ok:
                    model.add(sum(prev_ok) >= 1).only_enforce_if(nv)
                else:
                    model.add(nv == 0)

            # --- N不接△ ---
            if i < len(days) - 1:
                nxt = days[i + 1]
                nxt_locked = (s.id, nxt.date) in locked_holiday_cells
                if not (is_locked and nxt_locked):
                    tri = x.get(_key(s.id, nxt.date, '△'))
                    if tri is not None:
                        for n_code in n_codes:
                            nv = x.get(_key(s.id, day.date, n_code))
                            if nv is not None:
                                model.add(tri == 0).only_enforce_if(nv)

            # --- 自訂 allowedAfter 規則（涵蓋內建 E/3 及使用者新增的任何規則）---
            if i < len(days) - 1:
                nxt = days[i + 1]
                nxt_locked = (s.id, nxt.date) in locked_holiday_cells
                if not (is_locked and nxt_locked):
                    for from_code, allowed_list in rr.sequence_rules.items():
                        if not allowed_list:
                            continue  # 空白名單 = 無限制
                        # 找所有 effective_work_code == from_code 的來源班別
                        src_codes = [
                            c for c in rr.all_codes
                            if rr.effective_work_code(c) == from_code
                        ]
                        for sc in src_codes:
                            sv = x.get(_key(s.id, day.date, sc))
                            if sv is None:
                                continue
                            # 對所有不在白名單的 work code 加禁止約束
                            for fc in rr.all_codes:
                                if rr.allowed_after(from_code, fc):
                                    continue
                                fv = x.get(_key(s.id, nxt.date, fc))
                                if fv is not None:
                                    model.add(fv == 0).only_enforce_if(sv)


def _add_max_consecutive(model: cp_model.CpModel, x: Xmap, staff, days, rr: RuntimeRules):
    """Rotation staff ≤ 6 consecutive work days (sliding window of 7)."""
    for s in staff:
        if is_fixed_staff(s):
            continue
        for start in range(len(days) - 6):
            window = days[start:start + 7]
            work_vars = [
                x[_key(s.id, d.date, c)]
                for d in window
                for c in rr.work_codes
                if _key(s.id, d.date, c) in x
            ]
            if work_vars:
                model.add(sum(work_vars) <= 6)


def _add_weekly_quota(
    model: cp_model.CpModel, x: Xmap, staff, days, draft: Draft,
    rotation_holiday_locks: dict[str, dict[str, str]],
    rr: RuntimeRules,
):
    """Weekly 休/例 quota per rotation staff member.

    kyu (休) bucket: 休/休N/休E/休* on any day; 國 on Saturday.
    rei (例) bucket: 例 on any day; 國 on Sunday.

    When Saturday/Sunday is rotation-locked to a work code the solver
    cannot place 休/例 there, so it must find a weekday slot instead —
    this is the correct "make-up rest" behaviour for rotation workers.
    """
    for s in staff:
        if is_fixed_staff(s):
            continue
        week_targets = compute_weekly_targets(days, draft, s.id)

        for wt in week_targets:
            # --- 休 ---
            kyu_vars = []
            seen: set = set()
            for d in wt.days:
                for c in rr.all_codes:
                    k = _key(s.id, d.date, c)
                    v = x.get(k)
                    if v is None or k in seen:
                        continue
                    rq = rr.rest_quota_code(c)
                    if rq == '休':                          # 休, 休N, 休E, 休*, 及自訂複合班
                        kyu_vars.append(v); seen.add(k)
                    elif c == '國' and d.dow == 6:          # 國 on Saturday
                        kyu_vars.append(v); seen.add(k)
            if kyu_vars:
                model.add(sum(kyu_vars) == wt.target_kyu)

            # --- 例 ---
            rei_vars = []
            seen = set()
            for d in wt.days:
                k_rei = _key(s.id, d.date, '例')
                if k_rei in x and k_rei not in seen:
                    rei_vars.append(x[k_rei]); seen.add(k_rei)
                if d.dow == 0:
                    k_guo = _key(s.id, d.date, '國')       # 國 on Sunday → 例
                    if k_guo in x and k_guo not in seen:
                        rei_vars.append(x[k_guo]); seen.add(k_guo)
            if rei_vars:
                model.add(sum(rei_vars) == wt.target_rei)


def _add_monthly_guo_quota(model: cp_model.CpModel, x: Xmap, staff, days):
    """Monthly 國 count == number of national holidays (rotation staff only)."""
    n_holidays = sum(1 for d in days if d.isHoliday)
    for s in staff:
        if is_fixed_staff(s):
            continue
        guo_vars = [
            x[_key(s.id, d.date, '國')]
            for d in days
            if _key(s.id, d.date, '國') in x
        ]
        if guo_vars:
            model.add(sum(guo_vars) == n_holidays)


def _add_no_guo_rule(model: cp_model.CpModel, x: Xmap, staff, days, rr: RuntimeRules):
    """If the month has holidays, working staff must have ≥1 國 (rotation only)."""
    if not any(d.isHoliday for d in days):
        return
    for s in staff:
        if is_fixed_staff(s):
            continue
        guo_vars = [x[_key(s.id, d.date, '國')] for d in days if _key(s.id, d.date, '國') in x]
        work_vars = [x[_key(s.id, d.date, c)] for d in days for c in rr.work_codes if _key(s.id, d.date, c) in x]
        if not guo_vars or not work_vars:
            continue
        has_work = model.new_bool_var(f'hw_{s.id}')
        model.add(sum(work_vars) >= 1).only_enforce_if(has_work)
        model.add(sum(work_vars) == 0).only_enforce_if(has_work.Not())
        model.add(sum(guo_vars) >= 1).only_enforce_if(has_work)


def _add_daily_coverage(model: cp_model.CpModel, x: Xmap, staff, days, rr: RuntimeRules):
    """Each required shift per day must be covered by exactly N people (N from config)."""
    for day in days:
        req_count = rr.day_requirements_count(day.dow, day.isHoliday)
        for req_code, count in req_count.items():
            covering = [
                x[_key(s.id, day.date, c)]
                for s in staff
                for c in rr.all_codes
                if rr.effective_work_code(c) == req_code and _key(s.id, day.date, c) in x
            ]
            if covering:
                if count == 1:
                    model.add_exactly_one(covering)
                else:
                    model.add(sum(covering) == count)


def _add_forbidden(
    model: cp_model.CpModel, x: Xmap, staff, days,
    locked_holiday_cells: set[tuple],
    rr: RuntimeRules,
):
    """Staff cannot be assigned their forbidden codes.

    Locked holiday rotation cells are exempt — the rotation assignment
    wins even if it conflicts with the forbidden list.
    """
    for s in staff:
        if not s.forbidden:
            continue
        fset = set(s.forbidden)
        for day in days:
            if (s.id, day.date) in locked_holiday_cells:
                continue
            for c in rr.all_codes:
                if c in fset or rr.effective_work_code(c) in fset:
                    v = x.get(_key(s.id, day.date, c))
                    if v is not None:
                        model.add(v == 0)


def _add_daily_limits(
    model: cp_model.CpModel, x: Xmap, rotation_staff, days,
    all_staff=None, draft: Draft | None = None, constraints: dict | None = None,
    rr: RuntimeRules | None = None,
):
    """請假 ≤ 4/day and OFF ≤ 4/weekday, counting fixed staff as constants."""
    fixed_staff = [s for s in (all_staff or []) if is_fixed_staff(s)]
    off_set = rr.off_set if rr else set()

    def _fixed_code(s, date: str) -> str | None:
        c = (constraints or {}).get(s.id, {}).get(date)
        return c if c is not None else (draft or {}).get(s.id, {}).get(date)

    for day in days:
        fixed_leave = sum(1 for s in fixed_staff if _fixed_code(s, day.date) == '請')
        leave = [x[_key(s.id, day.date, '請')] for s in rotation_staff if _key(s.id, day.date, '請') in x]
        if leave or fixed_leave:
            model.add(sum(leave) + fixed_leave <= MAX_DAILY_LEAVE)

        if not is_holiday_like(day):
            fixed_off = sum(
                1 for s in fixed_staff
                if _fixed_code(s, day.date) in off_set
            )
            off_vars = [
                x[_key(s.id, day.date, c)]
                for s in rotation_staff
                for c in off_set
                if _key(s.id, day.date, c) in x
            ]
            if off_vars or fixed_off:
                model.add(sum(off_vars) + fixed_off <= MAX_DAILY_LEAVE)


def _add_holiday_no_white(
    model: cp_model.CpModel, x: Xmap, staff, days,
    locked_holiday_cells: set[tuple],
    rr: RuntimeRules,
):
    """兜底班不可出現在假日（週六/週日/國定），輪班人員限定。

    Locked holiday cells are exempt (their code is already locked to something else).
    """
    fallback = rr.fallback_code
    for day in days:
        if not is_holiday_like(day):
            continue
        for s in staff:
            if is_fixed_staff(s):
                continue
            if (s.id, day.date) in locked_holiday_cells:
                continue
            v = x.get(_key(s.id, day.date, fallback))
            if v is not None:
                model.add(v == 0)


def _add_rest_star_sunday_only(
    model: cp_model.CpModel, x: Xmap, staff, days,
    locked_holiday_cells: set[tuple],
):
    """'休*' can only appear on Sundays (dow == 0).

    Locked holiday cells are exempt (should not occur on non-Sundays in practice).
    """
    for s in staff:
        for day in days:
            if day.dow != 0:
                if (s.id, day.date) in locked_holiday_cells:
                    continue
                v = x.get(_key(s.id, day.date, '休*'))
                if v is not None:
                    model.add(v == 0)


def _add_user_constraints(
    model: cp_model.CpModel, x: Xmap,
    constraints: dict[str, dict[str, str]],
    locked_holiday_cells: set[tuple],
    day_dow: dict[str, int],
    rr: RuntimeRules | None = None,
):
    """Lock user-specified preferences.

    Locked holiday rotation cells take priority — rotation work shift wins.

    For '請' constraints:
      - Saturday: hard-lock to '休'  (JS validator counts 休 as kyu)
      - Sunday:   hard-lock to '例'  (JS validator counts 例 as rei)
      - Weekday:  any OFF code       (solver may use 例/休 for rotation-lock
                                      quota compensation on nearby weekdays)
    Aligns CP-SAT quota logic with JS countRestQuotasInDays.
    """
    for staff_id, date_map in constraints.items():
        for date, code in date_map.items():
            if (staff_id, date) in locked_holiday_cells:
                continue  # rotation lock wins
            if code == '請':
                dow = day_dow.get(date, -1)
                if dow == 6:    # Saturday → 休
                    v = x.get(_key(staff_id, date, '休'))
                    if v is not None:
                        model.add(v == 1)
                elif dow == 0:  # Sunday → 例
                    v = x.get(_key(staff_id, date, '例'))
                    if v is not None:
                        model.add(v == 1)
                else:           # Weekday → any OFF code
                    off_set = rr.off_set if rr else set()
                    off_vars = [
                        x[_key(staff_id, date, c)]
                        for c in off_set
                        if _key(staff_id, date, c) in x
                    ]
                    if off_vars:
                        model.add(sum(off_vars) == 1)
            else:
                v = x.get(_key(staff_id, date, code))
                if v is not None:
                    model.add(v == 1)


# ---------------------------------------------------------------------------
# Objective
# ---------------------------------------------------------------------------

def _build_objective(
    model: cp_model.CpModel, x: Xmap, staff, days,
    draft: Draft, user_locked: set[tuple],
    constraints: dict[str, dict[str, str]],
    locked_holiday_cells: set[tuple],
):
    """Minimise draft deviations (weight 1) + missing weekday N/E (weight 5)
    + weekday 請 substituted by 例/休 (weight 1, prefer keeping '請' on weekdays)."""
    penalties = []

    for s in staff:
        row = draft.get(s.id, {})
        for day in days:
            draft_code = row.get(day.date)
            if not draft_code:
                continue
            if (s.id, day.date) in user_locked:
                continue
            v = x.get(_key(s.id, day.date, draft_code))
            if v is not None:
                penalties.append(v.Not())

    # Soft: on weekdays, prefer '請' when user requested it (quota compensation may
    # change it to 例/休; Sat/Sun are hard-locked to 休/例 and need no soft nudge)
    day_dow = {d.date: d.dow for d in days}
    for staff_id, date_map in constraints.items():
        for date, code in date_map.items():
            if code != '請':
                continue
            if (staff_id, date) in locked_holiday_cells:
                continue
            if day_dow.get(date) in (0, 6):  # Sat/Sun: hard-locked, no soft penalty needed
                continue
            v_qing = x.get(_key(staff_id, date, '請'))
            if v_qing is not None:
                penalties.append(v_qing.Not())

    weekdays = [d for d in days if is_true_weekday(d)]
    for s in staff:
        if is_fixed_staff(s):
            continue
        for code in ('N', 'E'):
            ne_vars = [
                x[_key(s.id, d.date, code)]
                for d in weekdays
                if _key(s.id, d.date, code) in x
            ]
            if not ne_vars:
                continue
            has_ne = model.new_bool_var(f'has_{code}_{s.id}')
            model.add(sum(ne_vars) >= 1).only_enforce_if(has_ne)
            model.add(sum(ne_vars) == 0).only_enforce_if(has_ne.Not())
            penalties.extend([has_ne.Not()] * 5)

    if penalties:
        model.minimize(sum(penalties))


# ---------------------------------------------------------------------------
# Solution extraction
# ---------------------------------------------------------------------------

def _extract_solution(
    solver: cp_model.CpSolver, x: Xmap, staff, days, draft: Draft,
    rr: RuntimeRules,
    constraints: Optional[dict] = None,
) -> dict[str, dict[str, Optional[str]]]:
    result: dict[str, dict[str, Optional[str]]] = {}
    for s in staff:
        row: dict[str, Optional[str]] = {}
        for day in days:
            if is_fixed_staff(s):
                user_val = (constraints or {}).get(s.id, {}).get(day.date)
                code = user_val if user_val is not None else draft.get(s.id, {}).get(day.date)
                # Mirror _add_user_constraints: Saturday 請→休, Sunday 請→例
                if code == '請':
                    if day.dow == 6:
                        code = '休'
                    elif day.dow == 0:
                        code = '例'
                row[day.date] = code
            else:
                assigned: Optional[str] = None
                for c in rr.all_codes:
                    v = x.get(_key(s.id, day.date, c))
                    if v is not None and solver.value(v) == 1:
                        assigned = c
                        break
                if assigned is None:
                    assigned = draft.get(s.id, {}).get(day.date)
                row[day.date] = assigned
        result[s.id] = row
    return result


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

STATUS_MAP = {
    cp_model.OPTIMAL:    'OPTIMAL',
    cp_model.FEASIBLE:   'FEASIBLE',
    cp_model.INFEASIBLE: 'INFEASIBLE',
    cp_model.UNKNOWN:    'TIMEOUT',
}


def repair_schedule(req: RepairRequest) -> RepairResponse:
    t0 = time.monotonic()

    schedule    = req.schedule
    staff       = req.staff
    constraints = req.constraints
    days        = schedule.days
    draft       = schedule.assignments

    # ------------------------------------------------------------------
    # 0. 建立 RuntimeRules（從 shift_config 或預設值）
    # ------------------------------------------------------------------
    rr = build_runtime_rules(req.shift_config)

    user_locked: set[tuple] = {
        (s_id, date)
        for s_id, d_map in constraints.items()
        for date in d_map
    }

    rotation_staff = [s for s in staff if not is_fixed_staff(s)]

    # ------------------------------------------------------------------
    # Identify holiday rotation locks from draft
    # ------------------------------------------------------------------
    rotation_holiday_locks = _find_rotation_holiday_locks(draft, rotation_staff, days)
    locked_holiday_cells: set[tuple] = {
        (sid, date)
        for sid, d_map in rotation_holiday_locks.items()
        for date in d_map
    }

    day_dow: dict[str, int] = {d.date: d.dow for d in days}

    model = cp_model.CpModel()

    # ------------------------------------------------------------------
    # 1. Build variables + AddExactlyOne per (rotation staff, day)
    # ------------------------------------------------------------------
    x: Xmap = {}
    for s in rotation_staff:
        allowed = _allowed_codes_for(s, rr)
        for day in days:
            leave_requested = constraints.get(s.id, {}).get(day.date) == '請'
            domain = []
            for c in allowed:
                # Solver may not assign 請 unless the user explicitly requested it.
                if c == '請' and not leave_requested:
                    continue
                v = model.new_bool_var(f'{s.id}_{day.date}_{c}')
                x[_key(s.id, day.date, c)] = v
                domain.append(v)
            if domain:
                model.add_exactly_one(domain)

    # ------------------------------------------------------------------
    # 2a. Hard-lock holiday rotation cells
    # ------------------------------------------------------------------
    for sid, d_map in rotation_holiday_locks.items():
        for date, code in d_map.items():
            v = x.get(_key(sid, date, code))
            if v is not None:
                model.add(v == 1)

    # ------------------------------------------------------------------
    # 2b. Hard constraints (rotation staff only)
    # ------------------------------------------------------------------
    _add_sequence_constraints(model, x, rotation_staff, days, locked_holiday_cells, rr)
    _add_max_consecutive(model, x, rotation_staff, days, rr)
    _add_weekly_quota(model, x, rotation_staff, days, draft, rotation_holiday_locks, rr)
    _add_monthly_guo_quota(model, x, rotation_staff, days)
    _add_no_guo_rule(model, x, rotation_staff, days, rr)
    _add_daily_coverage(model, x, rotation_staff, days, rr)
    _add_forbidden(model, x, rotation_staff, days, locked_holiday_cells, rr)
    _add_daily_limits(model, x, rotation_staff, days, staff, draft, constraints, rr)
    _add_holiday_no_white(model, x, rotation_staff, days, locked_holiday_cells, rr)
    _add_rest_star_sunday_only(model, x, rotation_staff, days, locked_holiday_cells)
    _add_user_constraints(model, x, constraints, locked_holiday_cells, day_dow, rr)

    # ------------------------------------------------------------------
    # 3. Objective
    # ------------------------------------------------------------------
    _build_objective(model, x, rotation_staff, days, draft, user_locked, constraints, locked_holiday_cells)

    # ------------------------------------------------------------------
    # 4. Hint: seed solver with draft values
    # ------------------------------------------------------------------
    for s in rotation_staff:
        row = draft.get(s.id, {})
        for day in days:
            draft_code = row.get(day.date)
            if not draft_code:
                continue
            for c in _allowed_codes_for(s, rr):
                v = x.get(_key(s.id, day.date, c))
                if v is not None:
                    model.add_hint(v, 1 if c == draft_code else 0)

    # ------------------------------------------------------------------
    # 5. Solve
    # ------------------------------------------------------------------
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 30.0
    solver.parameters.num_search_workers = 4
    status_code = solver.solve(model)

    status = STATUS_MAP.get(status_code, 'ERROR')
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    diagnostics: list[dict] = []
    if status_code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        assignments = _extract_solution(solver, x, staff, days, draft, rr, constraints)
        if status == 'TIMEOUT':
            diagnostics.append({
                'type': 'solver-timeout', 'staffId': None, 'name': None, 'date': None,
                'msg': f'CP-SAT 求解超時，回傳目前最佳可行解（{elapsed_ms} ms）',
            })
    else:
        assignments = {s.id: dict(draft.get(s.id, {})) for s in staff}
        diagnostics.append({
            'type': 'solver-infeasible', 'staffId': None, 'name': None, 'date': None,
            'msg': '約束條件互相衝突，CP-SAT 無法找到可行排班。請檢查偏好或禁忌班設定。',
        })

    return RepairResponse(
        assignments=assignments,
        diagnostics=diagnostics,
        status=status,
        solve_time_ms=elapsed_ms,
    )
