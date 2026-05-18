"""
Pure Python helpers that mirror the logic in data.js / calendar.js / validator.js.
No OR-Tools dependency — only standard library.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Shift code catalogue (mirrors SHIFT_DEFS in data.js)
# ---------------------------------------------------------------------------

@dataclass
class ShiftDef:
    code: str
    label: str
    kind: str          # 'work' | 'off'
    rest_quota: Optional[str] = None   # e.g. '休' for 休N/休E/休*
    work_code: Optional[str] = None    # underlying work code for 休N → 'N'
    circle: bool = False

_SHIFT_DEFS_RAW: list[ShiftDef] = [
    ShiftDef('N',  '大夜N',        'work'),
    ShiftDef('E',  '小夜E',        'work'),
    ShiftDef('3',  '3-11',         'work'),
    ShiftDef('7',  '11-7',         'work'),
    ShiftDef('1',  '1班',          'work'),
    ShiftDef('2',  '2班',          'work'),
    ShiftDef('中', '中班',         'work'),
    ShiftDef('△', '三角',          'work'),
    ShiftDef('A',  'PCA',          'work'),
    ShiftDef('R',  'PAR',          'work'),
    ShiftDef('門', '門診',         'work'),
    ShiftDef('白', '白斑',         'work'),
    ShiftDef('休N','休假上N',      'work', rest_quota='休', work_code='N'),
    ShiftDef('休E','休假上E',      'work', rest_quota='休', work_code='E'),
    ShiftDef('◎', '圈圈班',        'work', circle=True),
    ShiftDef('休', '休',           'off'),
    ShiftDef('休*','休(週日加班)', 'off'),
    ShiftDef('例', '例',           'off'),
    ShiftDef('國', '國',           'off'),
    ShiftDef('請', '請',           'off'),
]

SHIFT_MAP: dict[str, ShiftDef] = {s.code: s for s in _SHIFT_DEFS_RAW}
ALL_CODES = [s.code for s in _SHIFT_DEFS_RAW]
WORK_CODES = [s.code for s in _SHIFT_DEFS_RAW if s.kind == 'work']
OFF_CODES  = [s.code for s in _SHIFT_DEFS_RAW if s.kind == 'off']
OFF_SET    = set(OFF_CODES)

MAX_DAILY_LEAVE = 4

DAILY_REQS = {
    'weekday' : ['2', '△', 'N', 'E', '7', '1', '中', '3', 'A'],
    'saturday': ['E', '中', 'N', '1', '2'],
    'sunday'  : ['N', 'E', '1', '休*'],
    'holiday' : ['E', '中', 'N', '1', '2'],
}


# ---------------------------------------------------------------------------
# Code helper functions (mirrors data.js)
# ---------------------------------------------------------------------------

def is_work(code: Optional[str]) -> bool:
    return bool(code and code not in OFF_SET)

def is_off(code: Optional[str]) -> bool:
    return bool(code and code in OFF_SET)

def effective_work_code(code: Optional[str]) -> Optional[str]:
    """Returns the underlying work code (e.g. '休N' → 'N', 'N' → 'N')."""
    if code is None:
        return None
    d = SHIFT_MAP.get(code)
    return d.work_code if (d and d.work_code) else code

def rest_quota_code(code: Optional[str]) -> Optional[str]:
    """Returns the rest-quota bucket for a code (mirrors restQuotaCode in data.js)."""
    if code is None:
        return None
    d = SHIFT_MAP.get(code)
    if d and d.rest_quota:
        return d.rest_quota
    if code == '休*':
        return '休'
    return code

def is_circle_shift(code: Optional[str]) -> bool:
    return code == '◎'


# ---------------------------------------------------------------------------
# Day classification helpers (mirrors data.js / calendar.js)
# ---------------------------------------------------------------------------

def day_requirements(dow: int, is_holiday: bool) -> list[str]:
    """Returns the list of required shift codes for a day type."""
    if dow == 0:
        return DAILY_REQS['sunday']
    if is_holiday:
        return DAILY_REQS['holiday']
    if dow == 6:
        return DAILY_REQS['saturday']
    return DAILY_REQS['weekday']

def is_holiday_like(day) -> bool:
    """True for Sat/Sun/holidays — same check as 'isHolidayLike' in JS."""
    return day.dow == 0 or day.dow == 6 or day.isHoliday

def is_true_weekday(day) -> bool:
    """Mon–Fri, non-holiday (mirrors isTrueWeekday in calendar.js)."""
    return 1 <= day.dow <= 5 and not day.isHoliday

def is_circle_staff(s) -> bool:
    return s.fixedShift in ('R', '門')

def is_circle_day(day) -> bool:
    return day.isHoliday or day.dow == 0 or day.dow == 6 or day.rotationGroup == 'national'

def is_fixed_staff(s) -> bool:
    return bool(s.fixedShift)

def is_rotation_staff(s) -> bool:
    return not s.fixedShift


# ---------------------------------------------------------------------------
# Weekly rest quota targets  (mirrors buildWeeklyRestState / carryBoundaryShortfall)
# ---------------------------------------------------------------------------

@dataclass
class WeekTarget:
    days: list        # DayInfo objects in this week
    target_kyu: int   # 休 target
    target_rei: int   # 例 target


def _count_rest_in_days(day_list, assignments: dict[str, Optional[str]], staff_id: str) -> dict[str, int]:
    """Count how many 休 / 例 a staff member has in a list of days (from draft assignments)."""
    count = {'休': 0, '例': 0}
    row = assignments.get(staff_id, {})
    for d in day_list:
        c = row.get(d.date)
        rq = rest_quota_code(c)
        # '國' on Saturday counts as 休; '國' on Sunday counts as 例
        if rq == '國' and d.dow == 6:
            rq = '休'
        elif rq == '國' and d.dow == 0:
            rq = '例'
        if rq == '休':
            count['休'] += 1
        elif rq == '例':
            count['例'] += 1
    return count


def get_month_weeks(days) -> list[list]:
    """Split month days into Mon-Sun weeks (mirrors getMonthWeeks in calendar.js)."""
    weeks: list[list] = []
    current: list = []
    for d in days:
        current.append(d)
        if d.dow == 0:   # Sunday ends a week
            weeks.append(current)
            current = []
    if current:
        weeks.append(current)
    return weeks


def compute_weekly_targets(
    days,
    draft_assignments: dict[str, dict[str, Optional[str]]],
    staff_id: str,
) -> list[WeekTarget]:
    """
    Compute per-week 休/例 targets for one staff member, applying the
    boundary-carry logic from calendar.js carryBoundaryShortfall.

    draft_assignments is used only for the boundary-week carry check.
    """
    weeks = get_month_weeks(days)
    targets = [
        {
            '休': sum(1 for d in w if d.dow == 6),
            '例': sum(1 for d in w if d.dow == 0),
        }
        for w in weeks
    ]

    def carry(from_idx: int, to_idx: int) -> None:
        week = weeks[from_idx]
        # Only apply to boundary weeks that have NO true weekday
        if any(is_true_weekday(d) for d in week):
            return
        count = _count_rest_in_days(week, draft_assignments, staff_id)
        for code in ('休', '例'):
            short = max(0, targets[from_idx][code] - count[code])
            if short > 0:
                targets[from_idx][code] -= short
                targets[to_idx][code] += short
            else:
                over = max(0, count[code] - targets[from_idx][code])
                if over > 0:
                    targets[from_idx][code] += over

    n = len(weeks)
    if n >= 2:
        carry(0, 1)
        if n > 2:
            carry(n - 1, n - 2)

    return [
        WeekTarget(
            days=weeks[i],
            target_kyu=targets[i]['休'],
            target_rei=targets[i]['例'],
        )
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# Sequence constraint helpers
# ---------------------------------------------------------------------------

def allowed_after_e(next_code: Optional[str]) -> bool:
    if not next_code:
        return True
    if is_off(next_code):
        return True
    return effective_work_code(next_code) in ('7', 'E')

def allowed_after_3(next_code: Optional[str]) -> bool:
    if not next_code:
        return True
    if is_off(next_code):
        return True
    return effective_work_code(next_code) in ('7', '3')
