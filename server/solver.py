"""
CP-SAT repair solver.

Receives a pattern draft (schedule.assignments) produced by the JS
initPatternDraft() step, then finds the assignment closest to the draft
that satisfies all hard constraints.

Objective: minimise the number of cells that differ from the draft.

Three solve modes share the same model construction (see ConstraintRegistry):
  - 'hard'       : original behaviour. INFEASIBLE returns generic error.
  - 'assumption' : every tagged constraint gets an assumption literal,
                   enabling SufficientAssumptionsForInfeasibility() to
                   report a minimal conflict subset (IIS).
  - 'slack'      : every slack-eligible tagged constraint gets a slack
                   bool var; the objective minimises weighted slacks so
                   the solver returns a "best-effort" assignment that
                   tells us which rules had to be sacrificed.
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
# ConstraintRegistry — central place that decides how each "rule" is wired
# ---------------------------------------------------------------------------

# Categories that can be relaxed in slack mode. Others are kept hard
# even when registry.mode == 'slack' (禁忌班/休*週日限定/使用者手動鎖定
# 等不可違反規則).
SLACKABLE_CATEGORIES: set[str] = {
    'sequence',
    'max-consecutive',
    'weekly-quota-mid',   # 中間完整週（第 2–4 週）penalty=100
    'weekly-quota-soft',  # 第一週（月初 Thu/Fri/Sat/Sun 開始）或最後零散週 penalty=50
    'daily-coverage',
    'daily-limits',
}
# weekly-quota-hard：第一週（月初 Mon–Wed 開始），assumption 模式仍包 literal，slack 模式維持 hard

# Slack penalty per category. Higher = solver tries harder not to violate.
PENALTY: dict[str, int] = {
    'daily-coverage':    1000,
    'max-consecutive':    200,
    'sequence':           300,
    'weekly-quota-mid':   100,
    'weekly-quota-soft':   50,
    'daily-limits':       300,
}

CATEGORY_LABEL: dict[str, str] = {
    'sequence':            '接班規則',
    'max-consecutive':     '連續上班上限',
    'weekly-quota-hard':   '週配額（休/例）— Hard',
    'weekly-quota-mid':    '週配額（休/例）',
    'weekly-quota-soft':   '週配額（休/例）— 彈性週',
    'monthly-guo':         '月國定配額',
    'monthly-rest':        '月休/例配額',
    'daily-coverage':      '每日特殊班覆蓋',
    'forbidden':           '禁忌班',
    'daily-limits':        '每日請假/休假上限',
    'holiday-no-white':    '假日不可白班',
    'rest-star-sunday':    '休* 限週日',
    'user-lock':           '使用者手動鎖定 / 假日輪值鎖定',
}


class ConstraintRegistry:
    """Wraps model.add(...) calls so the same model code path can run in
    hard / assumption / slack modes.

    Usage in an _add_* function:

        gate = reg.gate(category='forbidden', staff_id=s.id, msg='...')
        ct = model.add(v == 0)
        if gate is not None:
            ct.only_enforce_if(gate)
    """

    def __init__(self, model: cp_model.CpModel, mode: str = 'hard'):
        assert mode in ('hard', 'assumption', 'slack')
        self.model = model
        self.mode = mode
        # mode='assumption': tag -> assumption literal (positive — model.add_assumptions(literals) forces them true)
        self.assumption_lits: dict[str, cp_model.IntVar] = {}
        # mode='slack': tag -> slack bool var (slack=1 means "constraint was waived")
        self.slacks: dict[str, cp_model.IntVar] = {}
        # All tags ever issued -> metadata for diagnostic translation
        self.tag_meta: dict[str, dict] = {}
        self._counter = 0

    def _new_tag(self, category: str, staff_id: Optional[str], date: Optional[str]) -> str:
        self._counter += 1
        return f'{category}|{staff_id or "_"}|{date or "_"}|{self._counter}'

    def gate(
        self,
        *,
        category: str,
        staff_id: Optional[str] = None,
        date: Optional[str] = None,
        msg: str,
    ) -> Optional[cp_model.IntVar]:
        """Return the literal to append to .only_enforce_if() for this rule group,
        or None when running in hard mode (or when category is not slackable in slack mode)."""
        tag = self._new_tag(category, staff_id, date)
        self.tag_meta[tag] = {
            'category': category,
            'staffId':  staff_id,
            'date':     date,
            'msg':      msg,
        }

        if self.mode == 'assumption':
            lit = self.model.new_bool_var(f'a:{tag}')
            self.assumption_lits[tag] = lit
            return lit

        if self.mode == 'slack' and category in SLACKABLE_CATEGORIES:
            slack = self.model.new_bool_var(f's:{tag}')
            self.slacks[tag] = slack
            # Constraint should be enforced when slack == 0, i.e. enforce_if(slack.Not())
            return slack.Not()

        # hard mode (or slack mode + non-slackable category): no gating
        return None

    def add_exactly_one_tagged(
        self,
        vars_list: list,
        *,
        category: str,
        staff_id: Optional[str] = None,
        date: Optional[str] = None,
        msg: str,
    ):
        """Replacement for model.add_exactly_one that participates in gating.

        Always splits into sum >= 1 and sum <= 1 in non-hard modes because
        OR-Tools' add_exactly_one does not support only_enforce_if cleanly."""
        if not vars_list:
            return
        if self.mode == 'hard':
            self.model.add_exactly_one(vars_list)
            return
        gate_lo = self.gate(category=category, staff_id=staff_id, date=date, msg=msg + ' (≥1)')
        gate_hi = self.gate(category=category, staff_id=staff_id, date=date, msg=msg + ' (≤1)')
        ct_lo = self.model.add(sum(vars_list) >= 1)
        ct_hi = self.model.add(sum(vars_list) <= 1)
        if gate_lo is not None:
            ct_lo.only_enforce_if(gate_lo)
        if gate_hi is not None:
            ct_hi.only_enforce_if(gate_hi)


# ---------------------------------------------------------------------------
# Constraint builders
# ---------------------------------------------------------------------------

def _add_sequence_constraints(
    model: cp_model.CpModel, x: Xmap, staff, days,
    locked_holiday_cells: set[tuple],
    rr: RuntimeRules,
    reg: ConstraintRegistry,
):
    """N前置、N不接△、自訂 allowedAfter 規則。"""
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
                    continue
                prev = days[i - 1]
                prev_locked = (s.id, prev.date) in locked_holiday_cells
                if is_locked and prev_locked:
                    continue
                prev_ok = [
                    x[_key(s.id, prev.date, c)]
                    for c in off_and_n
                    if _key(s.id, prev.date, c) in x
                ]
                gate = reg.gate(
                    category='sequence', staff_id=s.id, date=day.date,
                    msg=f'{s.name} {day.date} N 前置（前一天需為 off 或 N）',
                )
                if prev_ok:
                    ct = model.add(sum(prev_ok) >= 1).only_enforce_if(nv)
                    if gate is not None:
                        ct.only_enforce_if(gate)
                else:
                    ct = model.add(nv == 0)
                    if gate is not None:
                        ct.only_enforce_if(gate)

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
                                gate = reg.gate(
                                    category='sequence', staff_id=s.id, date=day.date,
                                    msg=f'{s.name} {day.date} N 後不可接 △',
                                )
                                ct = model.add(tri == 0).only_enforce_if(nv)
                                if gate is not None:
                                    ct.only_enforce_if(gate)

            # --- 自訂 allowedAfter ---
            if i < len(days) - 1:
                nxt = days[i + 1]
                nxt_locked = (s.id, nxt.date) in locked_holiday_cells
                if not (is_locked and nxt_locked):
                    for from_code, allowed_list in rr.sequence_rules.items():
                        if not allowed_list:
                            continue
                        src_codes = [
                            c for c in rr.all_codes
                            if rr.effective_work_code(c) == from_code
                        ]
                        for sc in src_codes:
                            sv = x.get(_key(s.id, day.date, sc))
                            if sv is None:
                                continue
                            for fc in rr.all_codes:
                                if rr.allowed_after(from_code, fc):
                                    continue
                                fv = x.get(_key(s.id, nxt.date, fc))
                                if fv is not None:
                                    gate = reg.gate(
                                        category='sequence', staff_id=s.id, date=day.date,
                                        msg=f'{s.name} {day.date} {sc} 後不可接 {fc}',
                                    )
                                    ct = model.add(fv == 0).only_enforce_if(sv)
                                    if gate is not None:
                                        ct.only_enforce_if(gate)


def _add_max_consecutive(
    model: cp_model.CpModel, x: Xmap, staff, days, rr: RuntimeRules,
    reg: ConstraintRegistry,
):
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
            if not work_vars:
                continue
            gate = reg.gate(
                category='max-consecutive', staff_id=s.id, date=window[0].date,
                msg=f'{s.name} {window[0].date}–{window[-1].date} 連續上班不可超過 6 天',
            )
            ct = model.add(sum(work_vars) <= 6)
            if gate is not None:
                ct.only_enforce_if(gate)


def _week_quota_category(week_idx: int, n_weeks: int, month_start_dow: int) -> str:
    """Return the constraint category for a given week index.

    week_idx=0 is the first (possibly partial) week.
    month_start_dow is the JS dow of the 1st day of the month (0=Sun…6=Sat).

    Week 1 is Hard unless the month starts on Thu(4)/Fri(5)/Sat(6)/Sun(0).
    The last week (if different from week 1) is always 'soft'.
    Middle weeks are 'mid'.
    """
    if week_idx == 0:
        soft_starts = {0, 4, 5, 6}  # Sun, Thu, Fri, Sat
        return 'weekly-quota-soft' if month_start_dow in soft_starts else 'weekly-quota-hard'
    if week_idx == n_weeks - 1:
        return 'weekly-quota-soft'
    return 'weekly-quota-mid'


def _add_weekly_quota(
    model: cp_model.CpModel, x: Xmap, staff, days, draft: Draft,
    rotation_holiday_locks: dict[str, dict[str, str]],
    rr: RuntimeRules,
    reg: ConstraintRegistry,
):
    """Weekly 休/例 quota per rotation staff member.

    Week 1 is Hard when month starts Mon–Wed; soft otherwise.
    Middle weeks: penalty=100. Last (partial) week: penalty=50.
    """
    month_start_dow = days[0].dow  # JS dow: 0=Sun … 6=Sat

    for s in staff:
        if is_fixed_staff(s):
            continue
        week_targets = compute_weekly_targets(days, draft, s.id)
        n_weeks = len(week_targets)

        for wi, wt in enumerate(week_targets):
            week_label = wt.days[0].date if wt.days else '?'
            category = _week_quota_category(wi, n_weeks, month_start_dow)

            # 休
            kyu_vars = []
            seen: set = set()
            for d in wt.days:
                for c in rr.all_codes:
                    k = _key(s.id, d.date, c)
                    v = x.get(k)
                    if v is None or k in seen:
                        continue
                    rq = rr.rest_quota_code(c)
                    if rq == '休':
                        kyu_vars.append(v); seen.add(k)
                    elif c == '國' and d.dow == 6:
                        kyu_vars.append(v); seen.add(k)
            if kyu_vars:
                gate = reg.gate(
                    category=category, staff_id=s.id, date=week_label,
                    msg=f'{s.name} 週 {week_label}起 休 配額需 {wt.target_kyu}',
                )
                ct = model.add(sum(kyu_vars) == wt.target_kyu)
                if gate is not None:
                    ct.only_enforce_if(gate)

            # 例
            rei_vars = []
            seen = set()
            for d in wt.days:
                k_rei = _key(s.id, d.date, '例')
                if k_rei in x and k_rei not in seen:
                    rei_vars.append(x[k_rei]); seen.add(k_rei)
                if d.dow == 0:
                    k_guo = _key(s.id, d.date, '國')
                    if k_guo in x and k_guo not in seen:
                        rei_vars.append(x[k_guo]); seen.add(k_guo)
            if rei_vars:
                gate = reg.gate(
                    category=category, staff_id=s.id, date=week_label,
                    msg=f'{s.name} 週 {week_label}起 例 配額需 {wt.target_rei}',
                )
                ct = model.add(sum(rei_vars) == wt.target_rei)
                if gate is not None:
                    ct.only_enforce_if(gate)


def _add_monthly_guo_quota(
    model: cp_model.CpModel, x: Xmap, staff, days,
    reg: ConstraintRegistry,
):
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
        if not guo_vars:
            continue
        gate = reg.gate(
            category='monthly-guo', staff_id=s.id,
            msg=f'{s.name} 本月 國 配額需 {n_holidays}',
        )
        ct = model.add(sum(guo_vars) == n_holidays)
        if gate is not None:
            ct.only_enforce_if(gate)


def _add_monthly_rest_quota(
    model: cp_model.CpModel, x: Xmap, staff, days, rr: RuntimeRules,
    reg: ConstraintRegistry,
):
    """Hard monthly totals for 休 and 例 (N1 + N2).

    整月 休+休* 總數 = 該月週六數；整月 例 總數 = 該月週日數。
    These are always hard — even in slack mode — and replace the strict
    per-week equality as the binding lower-level guarantee.
    """
    n_sat = sum(1 for d in days if d.dow == 6)
    n_sun = sum(1 for d in days if d.dow == 0)

    for s in staff:
        if is_fixed_staff(s):
            continue

        # 月休配額（N1）
        kyu_vars = []
        seen: set = set()
        for d in days:
            for c in rr.all_codes:
                k = _key(s.id, d.date, c)
                v = x.get(k)
                if v is None or k in seen:
                    continue
                rq = rr.rest_quota_code(c)
                if rq == '休':
                    kyu_vars.append(v); seen.add(k)
                elif c == '國' and d.dow == 6:
                    kyu_vars.append(v); seen.add(k)
        if kyu_vars:
            gate = reg.gate(
                category='monthly-rest', staff_id=s.id,
                msg=f'{s.name} 整月 休+休* 需 {n_sat}（週六數）',
            )
            ct = model.add(sum(kyu_vars) == n_sat)
            if gate is not None:
                ct.only_enforce_if(gate)

        # 月例配額（N2）
        rei_vars = []
        seen = set()
        for d in days:
            k_rei = _key(s.id, d.date, '例')
            if k_rei in x and k_rei not in seen:
                rei_vars.append(x[k_rei]); seen.add(k_rei)
            if d.dow == 0:
                k_guo = _key(s.id, d.date, '國')
                if k_guo in x and k_guo not in seen:
                    rei_vars.append(x[k_guo]); seen.add(k_guo)
        if rei_vars:
            gate = reg.gate(
                category='monthly-rest', staff_id=s.id,
                msg=f'{s.name} 整月 例 需 {n_sun}（週日數）',
            )
            ct = model.add(sum(rei_vars) == n_sun)
            if gate is not None:
                ct.only_enforce_if(gate)


def _add_daily_coverage(
    model: cp_model.CpModel, x: Xmap, staff, days, rr: RuntimeRules,
    reg: ConstraintRegistry,
):
    """Each required shift per day must be covered by exactly N people."""
    for day in days:
        req_count = rr.day_requirements_count(day.dow, day.isHoliday)
        for req_code, count in req_count.items():
            covering = [
                x[_key(s.id, day.date, c)]
                for s in staff
                for c in rr.all_codes
                if rr.effective_work_code(c) == req_code and _key(s.id, day.date, c) in x
            ]
            if not covering:
                continue
            msg = f'{day.date} 「{req_code}」班需要剛好 {count} 人'
            if count == 1:
                reg.add_exactly_one_tagged(
                    covering, category='daily-coverage', date=day.date, msg=msg,
                )
            else:
                gate = reg.gate(category='daily-coverage', date=day.date, msg=msg)
                ct = model.add(sum(covering) == count)
                if gate is not None:
                    ct.only_enforce_if(gate)


def _add_forbidden(
    model: cp_model.CpModel, x: Xmap, staff, days,
    locked_holiday_cells: set[tuple],
    rr: RuntimeRules,
    reg: ConstraintRegistry,
):
    """Staff cannot be assigned their forbidden codes."""
    for s in staff:
        if not s.forbidden:
            continue
        fset = set(s.forbidden)
        # one gate per staff to keep tag count manageable
        gate = reg.gate(
            category='forbidden', staff_id=s.id,
            msg=f'{s.name} 禁忌班：{",".join(sorted(fset))}',
        )
        for day in days:
            if (s.id, day.date) in locked_holiday_cells:
                continue
            for c in rr.all_codes:
                if c in fset or rr.effective_work_code(c) in fset:
                    v = x.get(_key(s.id, day.date, c))
                    if v is not None:
                        ct = model.add(v == 0)
                        if gate is not None:
                            ct.only_enforce_if(gate)


def _add_daily_limits(
    model: cp_model.CpModel, x: Xmap, rotation_staff, days,
    all_staff=None, draft: Draft | None = None, constraints: dict | None = None,
    rr: RuntimeRules | None = None,
    reg: ConstraintRegistry = None,
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
            gate = reg.gate(
                category='daily-limits', date=day.date,
                msg=f'{day.date} 請假總數不可超過 {MAX_DAILY_LEAVE} 人',
            )
            ct = model.add(sum(leave) + fixed_leave <= MAX_DAILY_LEAVE)
            if gate is not None:
                ct.only_enforce_if(gate)

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
                gate = reg.gate(
                    category='daily-limits', date=day.date,
                    msg=f'{day.date} 平日不上班人數不可超過 {MAX_DAILY_LEAVE} 人',
                )
                ct = model.add(sum(off_vars) + fixed_off <= MAX_DAILY_LEAVE)
                if gate is not None:
                    ct.only_enforce_if(gate)


def _add_holiday_no_white(
    model: cp_model.CpModel, x: Xmap, staff, days,
    locked_holiday_cells: set[tuple],
    rr: RuntimeRules,
    reg: ConstraintRegistry,
):
    """兜底班不可出現在假日，輪班人員限定。"""
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
                gate = reg.gate(
                    category='holiday-no-white', staff_id=s.id, date=day.date,
                    msg=f'{s.name} {day.date} 假日不可排 {fallback}',
                )
                ct = model.add(v == 0)
                if gate is not None:
                    ct.only_enforce_if(gate)


def _add_rest_star_sunday_only(
    model: cp_model.CpModel, x: Xmap, staff, days,
    locked_holiday_cells: set[tuple],
    reg: ConstraintRegistry,
):
    """'休*' can only appear on Sundays."""
    for s in staff:
        for day in days:
            if day.dow != 0:
                if (s.id, day.date) in locked_holiday_cells:
                    continue
                v = x.get(_key(s.id, day.date, '休*'))
                if v is not None:
                    gate = reg.gate(
                        category='rest-star-sunday', staff_id=s.id, date=day.date,
                        msg=f'{s.name} {day.date} 休* 僅可排於週日',
                    )
                    ct = model.add(v == 0)
                    if gate is not None:
                        ct.only_enforce_if(gate)


def _add_user_constraints(
    model: cp_model.CpModel, x: Xmap,
    constraints: dict[str, dict[str, str]],
    locked_holiday_cells: set[tuple],
    day_dow: dict[str, int],
    rr: RuntimeRules | None = None,
    reg: ConstraintRegistry = None,
    staff_name_lookup: dict[str, str] = None,
):
    """Lock user-specified preferences."""
    name_of = staff_name_lookup or {}
    for staff_id, date_map in constraints.items():
        for date, code in date_map.items():
            if (staff_id, date) in locked_holiday_cells:
                continue
            gate = reg.gate(
                category='user-lock', staff_id=staff_id, date=date,
                msg=f'{name_of.get(staff_id, staff_id)} {date} 使用者設定 = {code}',
            )
            if code == '請':
                dow = day_dow.get(date, -1)
                if dow == 6:
                    v = x.get(_key(staff_id, date, '休'))
                    if v is not None:
                        ct = model.add(v == 1)
                        if gate is not None:
                            ct.only_enforce_if(gate)
                elif dow == 0:
                    v = x.get(_key(staff_id, date, '例'))
                    if v is not None:
                        ct = model.add(v == 1)
                        if gate is not None:
                            ct.only_enforce_if(gate)
                else:
                    off_set = rr.off_set if rr else set()
                    off_vars = [
                        x[_key(staff_id, date, c)]
                        for c in off_set
                        if _key(staff_id, date, c) in x
                    ]
                    if off_vars:
                        ct = model.add(sum(off_vars) == 1)
                        if gate is not None:
                            ct.only_enforce_if(gate)
            else:
                v = x.get(_key(staff_id, date, code))
                if v is not None:
                    ct = model.add(v == 1)
                    if gate is not None:
                        ct.only_enforce_if(gate)


# ---------------------------------------------------------------------------
# Objective
# ---------------------------------------------------------------------------

def _build_objective(
    model: cp_model.CpModel, x: Xmap, staff, days,
    draft: Draft, user_locked: set[tuple],
    constraints: dict[str, dict[str, str]],
    locked_holiday_cells: set[tuple],
):
    """Minimise draft deviations + missing weekday N/E + weekday 請 substitutions."""
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

    day_dow = {d.date: d.dow for d in days}
    for staff_id, date_map in constraints.items():
        for date, code in date_map.items():
            if code != '請':
                continue
            if (staff_id, date) in locked_holiday_cells:
                continue
            if day_dow.get(date) in (0, 6):
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

    return penalties  # caller decides whether/how to minimize


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
# Shared model construction (mode-aware)
# ---------------------------------------------------------------------------

class _ModelCtx:
    """Bag of state returned by _build_model, used by both solve paths."""
    def __init__(self):
        self.model: cp_model.CpModel = None
        self.x: Xmap = {}
        self.reg: ConstraintRegistry = None
        self.staff = None
        self.rotation_staff = None
        self.days = None
        self.draft: Draft = None
        self.constraints: dict = None
        self.user_locked: set[tuple] = None
        self.locked_holiday_cells: set[tuple] = None
        self.rr: RuntimeRules = None
        self.objective_penalties: list = None


def _build_model(req: RepairRequest, mode: str = 'hard') -> _ModelCtx:
    ctx = _ModelCtx()
    schedule    = req.schedule
    staff       = req.staff
    constraints = req.constraints
    days        = schedule.days
    draft       = schedule.assignments

    rr = build_runtime_rules(req.shift_config)

    user_locked: set[tuple] = {
        (s_id, date)
        for s_id, d_map in constraints.items()
        for date in d_map
    }

    rotation_staff = [s for s in staff if not is_fixed_staff(s)]
    rotation_holiday_locks = _find_rotation_holiday_locks(draft, rotation_staff, days)
    locked_holiday_cells: set[tuple] = {
        (sid, date)
        for sid, d_map in rotation_holiday_locks.items()
        for date in d_map
    }

    day_dow: dict[str, int] = {d.date: d.dow for d in days}
    staff_name_lookup = {s.id: s.name for s in staff}

    model = cp_model.CpModel()
    reg = ConstraintRegistry(model, mode=mode)

    # ---- 1. Variables + structural per-day-per-staff exactly_one (always hard) ----
    x: Xmap = {}
    for s in rotation_staff:
        allowed = _allowed_codes_for(s, rr)
        for day in days:
            leave_requested = constraints.get(s.id, {}).get(day.date) == '請'
            domain = []
            for c in allowed:
                if c == '請' and not leave_requested:
                    continue
                v = model.new_bool_var(f'{s.id}_{day.date}_{c}')
                x[_key(s.id, day.date, c)] = v
                domain.append(v)
            if domain:
                model.add_exactly_one(domain)

    # ---- 2a. Holiday rotation lock cells (treated as user-lock category) ----
    for sid, d_map in rotation_holiday_locks.items():
        for date, code in d_map.items():
            v = x.get(_key(sid, date, code))
            if v is None:
                continue
            gate = reg.gate(
                category='user-lock', staff_id=sid, date=date,
                msg=f'{staff_name_lookup.get(sid, sid)} {date} 假日輪值鎖定 = {code}',
            )
            ct = model.add(v == 1)
            if gate is not None:
                ct.only_enforce_if(gate)

    # ---- 2b. Hard constraints ----
    _add_sequence_constraints(model, x, rotation_staff, days, locked_holiday_cells, rr, reg)
    _add_max_consecutive(model, x, rotation_staff, days, rr, reg)
    _add_monthly_rest_quota(model, x, rotation_staff, days, rr, reg)   # N1+N2: hard monthly 休/例
    _add_weekly_quota(model, x, rotation_staff, days, draft, rotation_holiday_locks, rr, reg)
    _add_monthly_guo_quota(model, x, rotation_staff, days, reg)        # S6: hard monthly 國
    _add_daily_coverage(model, x, rotation_staff, days, rr, reg)
    _add_forbidden(model, x, rotation_staff, days, locked_holiday_cells, rr, reg)
    _add_daily_limits(model, x, rotation_staff, days, staff, draft, constraints, rr, reg)
    _add_holiday_no_white(model, x, rotation_staff, days, locked_holiday_cells, rr, reg)
    _add_rest_star_sunday_only(model, x, rotation_staff, days, locked_holiday_cells, reg)
    _add_user_constraints(model, x, constraints, locked_holiday_cells, day_dow, rr, reg, staff_name_lookup)

    # ---- 3. Compose objective penalties (caller minimises) ----
    penalties = _build_objective(model, x, rotation_staff, days, draft, user_locked, constraints, locked_holiday_cells)

    ctx.model = model
    ctx.x = x
    ctx.reg = reg
    ctx.staff = staff
    ctx.rotation_staff = rotation_staff
    ctx.days = days
    ctx.draft = draft
    ctx.constraints = constraints
    ctx.user_locked = user_locked
    ctx.locked_holiday_cells = locked_holiday_cells
    ctx.rr = rr
    ctx.objective_penalties = penalties
    return ctx


# ---------------------------------------------------------------------------
# Status mapping + main entry points
# ---------------------------------------------------------------------------

STATUS_MAP = {
    cp_model.OPTIMAL:    'OPTIMAL',
    cp_model.FEASIBLE:   'FEASIBLE',
    cp_model.INFEASIBLE: 'INFEASIBLE',
    cp_model.UNKNOWN:    'TIMEOUT',
}


def _seed_draft_hints(model: cp_model.CpModel, x: Xmap, rotation_staff, days, draft: Draft, rr: RuntimeRules):
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


def _solve_with_assumptions(req: RepairRequest) -> list[dict]:
    """Second-pass solve in assumption mode. Returns IIS-style diagnostics."""
    ctx = _build_model(req, mode='assumption')
    # No objective in assumption mode — we only care about feasibility.
    ctx.model.add_assumptions(list(ctx.reg.assumption_lits.values()))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 15.0
    solver.parameters.num_search_workers = 4
    status_code = solver.solve(ctx.model)

    diagnostics: list[dict] = []
    if status_code != cp_model.INFEASIBLE:
        # Original solve was INFEASIBLE but assumption-mode came back feasible —
        # this can happen if the original hard model had truly unconditional
        # contradictions that the gating dissolved. Fall back to a generic note.
        diagnostics.append({
            'type': 'iis-unavailable', 'category': None,
            'staffId': None, 'name': None, 'date': None,
            'msg': '無法定位具體衝突來源（assumption pass 未回 INFEASIBLE）',
        })
        return diagnostics

    bad_lits = solver.sufficient_assumptions_for_infeasibility()
    if not bad_lits:
        diagnostics.append({
            'type': 'iis-unavailable', 'category': None,
            'staffId': None, 'name': None, 'date': None,
            'msg': 'CP-SAT 未能回傳衝突子集（可能 presolve 已判定空模型）',
        })
        return diagnostics

    # Map literal indices back to tags
    lit_to_tag: dict[int, str] = {
        lit.index: tag for tag, lit in ctx.reg.assumption_lits.items()
    }
    seen_msgs: set[str] = set()
    for li in bad_lits:
        tag = lit_to_tag.get(li)
        if tag is None:
            continue
        meta = ctx.reg.tag_meta.get(tag, {})
        msg = meta.get('msg', tag)
        if msg in seen_msgs:
            continue
        seen_msgs.add(msg)
        diagnostics.append({
            'type':     'iis-conflict',
            'category': meta.get('category'),
            'staffId':  meta.get('staffId'),
            'name':     None,
            'date':     meta.get('date'),
            'msg':      msg,
        })

    diagnostics.insert(0, {
        'type':     'solver-infeasible-iis',
        'category': None,
        'staffId':  None, 'name': None, 'date': None,
        'msg':      f'無解。下列 {len(diagnostics)} 條約束互相衝突，請考慮鬆開其中一條，或按下方按鈕強制排出鬆弛解。',
    })
    return diagnostics


def repair_schedule(req: RepairRequest) -> RepairResponse:
    """Primary entry point. Solves in hard mode; on INFEASIBLE, runs the
    assumption pass and returns IIS-style diagnostics for the UI."""
    t0 = time.monotonic()

    ctx = _build_model(req, mode='hard')

    if ctx.objective_penalties:
        ctx.model.minimize(sum(ctx.objective_penalties))
    _seed_draft_hints(ctx.model, ctx.x, ctx.rotation_staff, ctx.days, ctx.draft, ctx.rr)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 30.0
    solver.parameters.num_search_workers = 4
    status_code = solver.solve(ctx.model)

    status = STATUS_MAP.get(status_code, 'ERROR')
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    diagnostics: list[dict] = []
    if status_code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        assignments = _extract_solution(solver, ctx.x, ctx.staff, ctx.days, ctx.draft, ctx.rr, ctx.constraints)
        if status == 'TIMEOUT':
            diagnostics.append({
                'type': 'solver-timeout', 'staffId': None, 'name': None, 'date': None,
                'msg': f'CP-SAT 求解超時，回傳目前最佳可行解（{elapsed_ms} ms）',
            })
    else:
        assignments = {s.id: dict(ctx.draft.get(s.id, {})) for s in ctx.staff}
        # Try to identify the conflict subset.
        try:
            diagnostics = _solve_with_assumptions(req)
        except Exception as exc:  # never let IIS pass break the response
            diagnostics = [{
                'type': 'solver-infeasible', 'category': None,
                'staffId': None, 'name': None, 'date': None,
                'msg': f'無解，且 IIS 偵測失敗：{exc}',
            }]
        if not diagnostics:
            diagnostics = [{
                'type': 'solver-infeasible', 'category': None,
                'staffId': None, 'name': None, 'date': None,
                'msg': '約束條件互相衝突，CP-SAT 無法找到可行排班。',
            }]

    return RepairResponse(
        assignments=assignments,
        diagnostics=diagnostics,
        status=status,
        solve_time_ms=int((time.monotonic() - t0) * 1000),
    )


def repair_schedule_relaxed(req: RepairRequest) -> RepairResponse:
    """Slack-mode rescue: always returns an assignment, with diagnostics
    listing which rules had to be sacrificed."""
    t0 = time.monotonic()

    ctx = _build_model(req, mode='slack')

    # Big multiplier so slack penalties dominate draft-deviation penalties.
    BIG = 1_000
    slack_terms = []
    for tag, slack in ctx.reg.slacks.items():
        meta = ctx.reg.tag_meta.get(tag, {})
        weight = PENALTY.get(meta.get('category'), 10)
        slack_terms.append(weight * slack)

    obj = []
    if slack_terms:
        obj.append(BIG * sum(slack_terms))
    if ctx.objective_penalties:
        obj.append(sum(ctx.objective_penalties))
    if obj:
        ctx.model.minimize(sum(obj))

    _seed_draft_hints(ctx.model, ctx.x, ctx.rotation_staff, ctx.days, ctx.draft, ctx.rr)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 30.0
    solver.parameters.num_search_workers = 4
    status_code = solver.solve(ctx.model)

    status = STATUS_MAP.get(status_code, 'ERROR')
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    diagnostics: list[dict] = []
    if status_code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        assignments = _extract_solution(solver, ctx.x, ctx.staff, ctx.days, ctx.draft, ctx.rr, ctx.constraints)
        # Collect violated slacks
        violated: list[tuple[str, dict]] = []
        for tag, slack in ctx.reg.slacks.items():
            if solver.value(slack) == 1:
                meta = ctx.reg.tag_meta.get(tag, {})
                violated.append((tag, meta))

        if violated:
            diagnostics.append({
                'type': 'slack-rescue-summary',
                'category': None,
                'staffId': None, 'name': None, 'date': None,
                'msg':  f'鬆弛模式完成：被迫違反 {len(violated)} 條規則，請見下列項目。',
            })
            seen_msgs: set[str] = set()
            for tag, meta in violated:
                msg = meta.get('msg', tag) + '（鬆弛模式被迫違反）'
                if msg in seen_msgs:
                    continue
                seen_msgs.add(msg)
                diagnostics.append({
                    'type':     'slack-violated',
                    'category': meta.get('category'),
                    'staffId':  meta.get('staffId'),
                    'name':     None,
                    'date':     meta.get('date'),
                    'msg':      msg,
                })
        else:
            diagnostics.append({
                'type': 'slack-rescue-summary',
                'category': None,
                'staffId': None, 'name': None, 'date': None,
                'msg': '鬆弛模式找到不需要違反任何規則的解。',
            })
    else:
        assignments = {s.id: dict(ctx.draft.get(s.id, {})) for s in ctx.staff}
        diagnostics.append({
            'type': 'slack-infeasible',
            'category': None,
            'staffId': None, 'name': None, 'date': None,
            'msg': '鬆弛模式仍無解：使用者鎖定 / 禁忌班 / 假日白班 / 休* 限制等不可鬆弛規則已直接衝突。',
        })

    return RepairResponse(
        assignments=assignments,
        diagnostics=diagnostics,
        status=status,
        solve_time_ms=elapsed_ms,
    )
