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
    ALL_CODES, OFF_SET, WORK_CODES,
    MAX_DAILY_LEAVE,
    is_work, is_off, effective_work_code, rest_quota_code,
    is_circle_shift, is_circle_staff, is_circle_day,
    is_holiday_like, is_true_weekday, is_fixed_staff, is_rotation_staff,
    day_requirements, allowed_after_e, allowed_after_3,
    compute_weekly_targets,
)

Draft = dict[str, dict[str, Optional[str]]]  # staffId -> date -> code
Xmap = dict[tuple, cp_model.IntVar]


def _key(staff_id: str, date: str, code: str) -> tuple:
    return (staff_id, date, code)


def _allowed_codes_for(s) -> list[str]:
    """Codes to create variables for a given staff member (day-independent)."""
    if is_circle_staff(s):
        return ['◎', '休', '例', '國', '請']
    if is_fixed_staff(s):
        return [s.fixedShift, '休', '例', '國', '請']
    # Rotation staff: all codes except ◎
    return [c for c in ALL_CODES if c != '◎']


# ---------------------------------------------------------------------------
# Constraint builders
# ---------------------------------------------------------------------------

def _add_sequence_constraints(model: cp_model.CpModel, x: Xmap, staff, days):
    """N前置, N不接△, E/3接續 all in one pass."""
    off_and_n = OFF_SET | {'N', '休N'}

    for s in staff:
        for i, day in enumerate(days):
            # --- N前置: prev must be OFF or N ---
            for n_code in ('N', '休N'):
                nv = x.get(_key(s.id, day.date, n_code))
                if nv is None:
                    continue
                if i == 0:
                    continue  # no prev context — JS validator skips this too
                prev = days[i - 1]
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
                tri = x.get(_key(s.id, nxt.date, '△'))
                if tri is not None:
                    for n_code in ('N', '休N'):
                        nv = x.get(_key(s.id, day.date, n_code))
                        if nv is not None:
                            model.add(tri == 0).only_enforce_if(nv)

            # --- E/3接續 ---
            if i < len(days) - 1:
                nxt = days[i + 1]
                for base, checker in (('E', allowed_after_e), ('3', allowed_after_3)):
                    src_codes = [base, '休E'] if base == 'E' else [base]
                    for sc in src_codes:
                        sv = x.get(_key(s.id, day.date, sc))
                        if sv is None:
                            continue
                        for fc in ALL_CODES:
                            if checker(fc):
                                continue
                            fv = x.get(_key(s.id, nxt.date, fc))
                            if fv is not None:
                                model.add(fv == 0).only_enforce_if(sv)


def _add_max_consecutive(model: cp_model.CpModel, x: Xmap, staff, days):
    """Rotation staff ≤ 6 consecutive work days (sliding window of 7)."""
    for s in staff:
        if is_fixed_staff(s):
            continue
        for start in range(len(days) - 6):
            window = days[start:start + 7]
            work_vars = [
                x[_key(s.id, d.date, c)]
                for d in window
                for c in WORK_CODES
                if _key(s.id, d.date, c) in x
            ]
            if work_vars:
                model.add(sum(work_vars) <= 6)


def _add_weekly_quota(model: cp_model.CpModel, x: Xmap, staff, days, draft: Draft):
    """Weekly 休/例 quota per rotation staff member.

    Mirrors checkWeeklyRestQuota + buildWeeklyRestState in JS.
    '休' target = Saturdays in week; '例' target = Sundays in week (with boundary carry).
    '國' on Saturday counts toward 休; '國' on Sunday counts toward 例.
    """
    for s in staff:
        if is_fixed_staff(s):
            continue
        week_targets = compute_weekly_targets(days, draft, s.id)
        for wt in week_targets:
            # --- 休 ---
            kyu_vars = []
            seen = set()
            for d in wt.days:
                for c in ALL_CODES:
                    k = _key(s.id, d.date, c)
                    v = x.get(k)
                    if v is None or k in seen:
                        continue
                    rq = rest_quota_code(c)
                    if rq == '休':       # 休, 休N, 休E, 休*
                        kyu_vars.append(v); seen.add(k)
                    elif c == '國' and d.dow == 6:  # 國 on Saturday → 休
                        kyu_vars.append(v); seen.add(k)
            if kyu_vars:
                model.add(sum(kyu_vars) == wt.target_kyu)

            # --- 例 ---
            rei_vars = []
            seen = set()
            for d in wt.days:
                # '例' itself
                k_rei = _key(s.id, d.date, '例')
                if k_rei in x and k_rei not in seen:
                    rei_vars.append(x[k_rei]); seen.add(k_rei)
                # '國' on Sunday → 例
                if d.dow == 0:
                    k_guo = _key(s.id, d.date, '國')
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


def _add_no_guo_rule(model: cp_model.CpModel, x: Xmap, staff, days):
    """If the month has holidays, working staff must have ≥1 國 (rotation only)."""
    if not any(d.isHoliday for d in days):
        return
    for s in staff:
        if is_fixed_staff(s):
            continue
        guo_vars = [x[_key(s.id, d.date, '國')] for d in days if _key(s.id, d.date, '國') in x]
        work_vars = [x[_key(s.id, d.date, c)] for d in days for c in WORK_CODES if _key(s.id, d.date, c) in x]
        if not guo_vars or not work_vars:
            continue
        has_work = model.new_bool_var(f'hw_{s.id}')
        model.add(sum(work_vars) >= 1).only_enforce_if(has_work)
        model.add(sum(work_vars) == 0).only_enforce_if(has_work.Not())
        model.add(sum(guo_vars) >= 1).only_enforce_if(has_work)


def _add_daily_coverage(model: cp_model.CpModel, x: Xmap, staff, days):
    """Each required shift per day must have exactly 1 person covering it."""
    for day in days:
        for req in day_requirements(day.dow, day.isHoliday):
            covering = [
                x[_key(s.id, day.date, c)]
                for s in staff
                for c in ALL_CODES
                if effective_work_code(c) == req and _key(s.id, day.date, c) in x
            ]
            if covering:
                model.add_exactly_one(covering)


def _add_forbidden(model: cp_model.CpModel, x: Xmap, staff, days):
    """Staff cannot be assigned their forbidden codes."""
    for s in staff:
        if not s.forbidden:
            continue
        fset = set(s.forbidden)
        for day in days:
            for c in ALL_CODES:
                if c in fset or effective_work_code(c) in fset:
                    v = x.get(_key(s.id, day.date, c))
                    if v is not None:
                        model.add(v == 0)


def _add_daily_limits(model: cp_model.CpModel, x: Xmap, staff, days):
    """請假 ≤ 4/day and OFF ≤ 4/weekday."""
    for day in days:
        # 請假 limit (all days)
        leave = [x[_key(s.id, day.date, '請')] for s in staff if _key(s.id, day.date, '請') in x]
        if leave:
            model.add(sum(leave) <= MAX_DAILY_LEAVE)
        # Weekday OFF limit
        if not is_holiday_like(day):
            off_vars = [
                x[_key(s.id, day.date, c)]
                for s in staff
                for c in OFF_SET
                if _key(s.id, day.date, c) in x
            ]
            if off_vars:
                model.add(sum(off_vars) <= MAX_DAILY_LEAVE)


def _add_holiday_no_white(model: cp_model.CpModel, x: Xmap, staff, days):
    """No '白' on holiday-like days for rotation staff."""
    for day in days:
        if not is_holiday_like(day):
            continue
        for s in staff:
            if is_fixed_staff(s):
                continue
            v = x.get(_key(s.id, day.date, '白'))
            if v is not None:
                model.add(v == 0)


def _lock_fixed_staff(
    model: cp_model.CpModel, x: Xmap, staff, days, draft: Draft,
    user_locked: set[tuple],
):
    """
    Lock fixed-shift and circle staff to their draft values.
    User constraints take precedence (those cells are skipped).
    """
    for s in staff:
        if not is_fixed_staff(s):
            continue
        for day in days:
            if (s.id, day.date) in user_locked:
                continue
            draft_code = draft.get(s.id, {}).get(day.date)
            if draft_code is None:
                continue
            v = x.get(_key(s.id, day.date, draft_code))
            if v is not None:
                model.add(v == 1)


def _add_user_constraints(
    model: cp_model.CpModel, x: Xmap, constraints: dict[str, dict[str, str]]
):
    """Lock user-specified preferences."""
    for staff_id, date_map in constraints.items():
        for date, code in date_map.items():
            v = x.get(_key(staff_id, date, code))
            if v is not None:
                model.add(v == 1)


# ---------------------------------------------------------------------------
# Objective
# ---------------------------------------------------------------------------

def _build_objective(
    model: cp_model.CpModel, x: Xmap, staff, days,
    draft: Draft, user_locked: set[tuple],
):
    """Minimise draft deviations (weight 1) + missing weekday N/E (weight 5)."""
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

    # Soft goal: each rotation staff ≥1 weekday N and ≥1 weekday E
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
) -> dict[str, dict[str, Optional[str]]]:
    result: dict[str, dict[str, Optional[str]]] = {}
    for s in staff:
        row: dict[str, Optional[str]] = {}
        for day in days:
            assigned: Optional[str] = None
            for c in ALL_CODES:
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

    # Cells locked by user preferences
    user_locked: set[tuple] = {
        (s_id, date)
        for s_id, d_map in constraints.items()
        for date in d_map
    }

    model = cp_model.CpModel()

    # ------------------------------------------------------------------
    # 1. Build variables + AddExactlyOne per (staff, day)
    # ------------------------------------------------------------------
    x: Xmap = {}
    for s in staff:
        allowed = _allowed_codes_for(s)
        for day in days:
            domain = []
            for c in allowed:
                v = model.new_bool_var(f'{s.id}_{day.date}_{c}')
                x[_key(s.id, day.date, c)] = v
                domain.append(v)
            if domain:
                model.add_exactly_one(domain)

    # ------------------------------------------------------------------
    # 2. Hard constraints
    # ------------------------------------------------------------------
    _add_sequence_constraints(model, x, staff, days)
    _add_max_consecutive(model, x, staff, days)
    _add_weekly_quota(model, x, staff, days, draft)
    _add_monthly_guo_quota(model, x, staff, days)
    _add_no_guo_rule(model, x, staff, days)
    _add_daily_coverage(model, x, staff, days)
    _add_forbidden(model, x, staff, days)
    _add_daily_limits(model, x, staff, days)
    _add_holiday_no_white(model, x, staff, days)
    _lock_fixed_staff(model, x, staff, days, draft, user_locked)
    _add_user_constraints(model, x, constraints)

    # ------------------------------------------------------------------
    # 3. Objective
    # ------------------------------------------------------------------
    _build_objective(model, x, staff, days, draft, user_locked)

    # ------------------------------------------------------------------
    # 4. Hint: seed solver with the draft values so it starts near-feasible
    # ------------------------------------------------------------------
    for s in staff:
        row = draft.get(s.id, {})
        for day in days:
            draft_code = row.get(day.date)
            if not draft_code:
                continue
            for c in _allowed_codes_for(s):
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
        assignments = _extract_solution(solver, x, staff, days, draft)
        if status == 'TIMEOUT':
            diagnostics.append({
                'type': 'solver-timeout', 'staffId': None, 'name': None, 'date': None,
                'msg': f'CP-SAT 求解超時，回傳目前最佳可行解（{elapsed_ms} ms）',
            })
    else:
        # Return draft unchanged so the UI doesn't break
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
