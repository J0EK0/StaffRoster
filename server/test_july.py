"""
Test: July 2026 tough case with real rotation data + heavy leave constraints.
Run from server/ directory:
    python test_july.py
"""
import json, datetime, requests

# ── Staff list (from data.js DEFAULT_STAFF) ──────────────────────────────────
STAFF = [
    {"id": "n01",    "name": "護理師 01", "fixedShift": "白"},
    {"id": "n02",    "name": "護理師 02", "fixedShift": "白"},
    {"id": "n03",   "name": "護理師 03"},
    {"id": "n04",     "name": "護理師 04",  "forbidden": ["N", "E"]},
    {"id": "n05",     "name": "護理師 05"},
    {"id": "n06",    "name": "護理師 06"},
    {"id": "n07",    "name": "護理師 07"},
    {"id": "n08",  "name": "護理師 08",  "forbidden": ["N", "E"]},
    {"id": "n09",    "name": "護理師 09"},
    {"id": "n10",   "name": "護理師 10"},
    {"id": "n11",    "name": "護理師 11"},
    {"id": "n12",     "name": "護理師 12"},
    {"id": "n13",   "name": "護理師 13"},
    {"id": "n14",    "name": "護理師 14"},
    {"id": "n15",    "name": "護理師 15",  "forbidden": ["N", "E"]},
    {"id": "n16",    "name": "護理師 16"},
    {"id": "n17",  "name": "護理師 17"},
    {"id": "n18",  "name": "護理師 18",  "forbidden": ["N", "E"]},
    {"id": "n19",     "name": "護理師 19"},
    {"id": "n20",   "name": "護理師 20"},
    {"id": "n21", "name": "護理師 21",  "fixedShift": "R"},
    {"id": "n22", "name": "護理師 22",  "fixedShift": "門"},
]

# ── July 2026 days ────────────────────────────────────────────────────────────
# July 1 = Wednesday (dow=3), no national holidays in July 2026
def build_days():
    days = []
    for d in range(1, 32):
        dt = datetime.date(2026, 7, d)
        dow = dt.weekday()          # Python: 0=Mon … 6=Sun
        dow_js = (dow + 1) % 7     # JS: 0=Sun … 6=Sat
        days.append({
            "date": dt.strftime("%Y-%m-%d"),
            "day": d,
            "dow": dow_js,
            "isHoliday": False,
            "holidayName": None,
            "rotationGroup": None,
        })
    return days

DAYS = build_days()
DOW = {d["date"]: d["dow"] for d in DAYS}   # date -> JS dow

# ── Rotation data from localStorage (rot) ────────────────────────────────────
WEEKDAY_ROT = {
    "n04":    {"2026-07-01":"中","2026-07-02":"1","2026-07-06":"△","2026-07-09":"N","2026-07-10":"E","2026-07-13":"7","2026-07-14":"3","2026-07-17":"A","2026-07-22":"2","2026-07-23":"中","2026-07-24":"1","2026-07-28":"△","2026-07-31":"N"},
    "n03":  {"2026-07-01":"1","2026-07-03":"△","2026-07-08":"N","2026-07-09":"E","2026-07-10":"7","2026-07-13":"3","2026-07-16":"A","2026-07-21":"2","2026-07-22":"中","2026-07-23":"1","2026-07-27":"△","2026-07-30":"N","2026-07-31":"E"},
    "n05":    {"2026-07-01":"2","2026-07-02":"中","2026-07-03":"1","2026-07-07":"△","2026-07-10":"N","2026-07-13":"E","2026-07-14":"7","2026-07-15":"3","2026-07-20":"A","2026-07-23":"2","2026-07-24":"中","2026-07-27":"1","2026-07-29":"△"},
    "n08": {"2026-07-01":"A","2026-07-06":"2","2026-07-07":"中","2026-07-08":"1","2026-07-10":"△","2026-07-15":"N","2026-07-16":"E","2026-07-17":"7","2026-07-20":"3","2026-07-23":"A","2026-07-28":"2","2026-07-29":"中","2026-07-30":"1"},
    "n11":   {"2026-07-01":"3","2026-07-06":"A","2026-07-09":"2","2026-07-10":"中","2026-07-13":"1","2026-07-15":"△","2026-07-20":"N","2026-07-21":"E","2026-07-22":"7","2026-07-23":"3","2026-07-28":"A","2026-07-31":"2"},
    "n12":    {"2026-07-01":"7","2026-07-02":"3","2026-07-07":"A","2026-07-10":"2","2026-07-13":"中","2026-07-14":"1","2026-07-16":"△","2026-07-21":"N","2026-07-22":"E","2026-07-23":"7","2026-07-24":"3","2026-07-29":"A"},
    "n13":  {"2026-07-01":"E","2026-07-02":"7","2026-07-03":"3","2026-07-08":"A","2026-07-13":"2","2026-07-14":"中","2026-07-15":"1","2026-07-17":"△","2026-07-22":"N","2026-07-23":"E","2026-07-24":"7","2026-07-27":"3","2026-07-30":"A"},
    "n14":   {"2026-07-01":"N","2026-07-02":"E","2026-07-03":"7","2026-07-06":"3","2026-07-09":"A","2026-07-14":"2","2026-07-15":"中","2026-07-16":"1","2026-07-20":"△","2026-07-23":"N","2026-07-24":"E","2026-07-27":"7","2026-07-28":"3","2026-07-31":"A"},
    "n17": {"2026-07-01":"△","2026-07-06":"N","2026-07-07":"E","2026-07-08":"7","2026-07-09":"3","2026-07-14":"A","2026-07-17":"2","2026-07-20":"中","2026-07-21":"1","2026-07-23":"△","2026-07-28":"N","2026-07-29":"E","2026-07-30":"7","2026-07-31":"3"},
    "n06":   {"2026-07-02":"2","2026-07-03":"中","2026-07-06":"1","2026-07-08":"△","2026-07-13":"N","2026-07-14":"E","2026-07-15":"7","2026-07-16":"3","2026-07-21":"A","2026-07-24":"2","2026-07-27":"中","2026-07-28":"1","2026-07-30":"△"},
    "n09":   {"2026-07-02":"A","2026-07-07":"2","2026-07-08":"中","2026-07-09":"1","2026-07-13":"△","2026-07-16":"N","2026-07-17":"E","2026-07-20":"7","2026-07-21":"3","2026-07-24":"A","2026-07-29":"2","2026-07-30":"中","2026-07-31":"1"},
    "n15":   {"2026-07-02":"N","2026-07-03":"E","2026-07-06":"7","2026-07-07":"3","2026-07-10":"A","2026-07-15":"2","2026-07-16":"中","2026-07-17":"1","2026-07-21":"△","2026-07-24":"N","2026-07-27":"E","2026-07-28":"7","2026-07-29":"3"},
    "n18": {"2026-07-02":"△","2026-07-07":"N","2026-07-08":"E","2026-07-09":"7","2026-07-10":"3","2026-07-15":"A","2026-07-20":"2","2026-07-21":"中","2026-07-22":"1","2026-07-24":"△","2026-07-29":"N","2026-07-30":"E","2026-07-31":"7"},
    "n07":   {"2026-07-03":"2","2026-07-06":"中","2026-07-07":"1","2026-07-09":"△","2026-07-14":"N","2026-07-15":"E","2026-07-16":"7","2026-07-17":"3","2026-07-22":"A","2026-07-27":"2","2026-07-28":"中","2026-07-29":"1","2026-07-31":"△"},
    "n10":  {"2026-07-03":"A","2026-07-08":"2","2026-07-09":"中","2026-07-10":"1","2026-07-14":"△","2026-07-17":"N","2026-07-20":"E","2026-07-21":"7","2026-07-22":"3","2026-07-27":"A","2026-07-30":"2","2026-07-31":"中"},
    "n16":   {"2026-07-03":"N","2026-07-06":"E","2026-07-07":"7","2026-07-08":"3","2026-07-13":"A","2026-07-16":"2","2026-07-17":"中","2026-07-20":"1","2026-07-22":"△","2026-07-27":"N","2026-07-28":"E","2026-07-29":"7","2026-07-30":"3"},
}

REGULAR_ROT = {
    "n04":    {"2026-07-11":"E"},
    "n05":    {"2026-07-11":"N","2026-07-19":"休*"},
    "n11":   {"2026-07-04":"1","2026-07-18":"E"},
    "n14":   {"2026-07-05":"休*","2026-07-18":"1"},
    "n15":   {"2026-07-05":"E","2026-07-26":"N"},
    "n18": {"2026-07-05":"N","2026-07-11":"中","2026-07-26":"1"},
    "n13":  {"2026-07-05":"1","2026-07-11":"2","2026-07-19":"E"},
    "n06":   {"2026-07-11":"1","2026-07-25":"E"},
    "n17": {"2026-07-12":"N","2026-07-18":"中"},
    "n16":   {"2026-07-12":"1","2026-07-18":"2","2026-07-26":"E"},
    "n03":  {"2026-07-18":"N","2026-07-26":"休*"},
    "n07":   {"2026-07-19":"N","2026-07-25":"中"},
    "n08": {"2026-07-04":"中","2026-07-19":"1","2026-07-25":"2"},
    "n10":  {"2026-07-04":"N","2026-07-12":"休*","2026-07-25":"1"},
    "n09":   {"2026-07-04":"E","2026-07-25":"N"},
    "n12":    {"2026-07-04":"2","2026-07-12":"E"},
}

# ── Build draft assignments ───────────────────────────────────────────────────
def build_draft():
    assignments = {}
    for s in STAFF:
        sid = s["id"]
        row = {}
        fixed = s.get("fixedShift")
        for d in DAYS:
            date = d["date"]
            dow = d["dow"]   # JS: 0=Sun, 6=Sat
            if fixed:
                if dow == 6:   row[date] = "休"
                elif dow == 0: row[date] = "例"
                else:          row[date] = fixed
            else:
                # weekday (Mon-Fri, non-holiday): default 白, override with weekday rot
                if 1 <= dow <= 5:
                    code = WEEKDAY_ROT.get(sid, {}).get(date, "白")
                    row[date] = code
                elif dow == 6:  # Saturday
                    code = REGULAR_ROT.get(sid, {}).get(date, "休")
                    row[date] = code
                else:           # Sunday (dow=0)
                    code = REGULAR_ROT.get(sid, {}).get(date, "例")
                    row[date] = code
        assignments[sid] = row
    return assignments

# ── Constraints (from localStorage constr) ───────────────────────────────────
CONSTRAINTS = {
    "n01":   {"2026-07-17":"請","2026-07-16":"請","2026-07-18":"請"},
    "n02":   {"2026-07-01":"請"},
    "n04":    {"2026-07-02":"請","2026-07-03":"請","2026-07-29":"請"},
    "n05":    {"2026-07-10":"請","2026-07-17":"請","2026-07-20":"請"},
    "n07":   {f"2026-07-{d:02d}":"請" for d in range(5,28)},
    "n08": {"2026-07-24":"請","2026-07-13":"請","2026-07-03":"請"},
    "n09":   {"2026-07-24":"請","2026-07-26":"請","2026-07-27":"請","2026-07-25":"請"},
    "n10":  {"2026-07-20":"請","2026-07-21":"請"},
    "n14":   {"2026-07-06":"請"},
    "n15":   {f"2026-07-{d:02d}":"請" for d in range(17, 32)},
}

# ── Build & send payload ──────────────────────────────────────────────────────
draft = build_draft()

payload = {
    "schedule": {
        "year": 2026,
        "month": 7,
        "days": DAYS,
        "assignments": draft,
        "diagnostics": [],
    },
    "staff": STAFF,
    "constraints": CONSTRAINTS,
}

print("Sending July 2026 tough case to CP-SAT solver...")
print(f"  Rotation staff: {sum(1 for s in STAFF if not s.get('fixedShift'))}")
print(f"  Constraints applied: {sum(len(v) for v in CONSTRAINTS.values())} cells locked")

resp = requests.post("http://localhost:8000/api/repair", json=payload, timeout=120)
resp.raise_for_status()
data = resp.json()

print(f"\nResult:")
print(f"  Status:    {data['status']}")
print(f"  Solve time: {data['solve_time_ms']} ms")
print(f"  Diagnostics: {len(data.get('diagnostics', []))}")

# ── Quick validation: count violations in result ──────────────────────────────
assignments = data["assignments"]

# Check daily coverage (use effective_work_code matching like the solver does)
EFFECTIVE = {
    'N':'N','E':'E','3':'3','7':'7','1':'1','2':'2','中':'中','△':'△','A':'A',
    'R':'R','門':'門','白':'白','休N':'N','休E':'E','◎':'◎','休':'休',
    '休*':'休*','例':'例','國':'國','請':'請',
}
DAILY_REQS = {
    1: ['2','△','N','E','7','1','中','3','A'],
    2: ['2','△','N','E','7','1','中','3','A'],
    3: ['2','△','N','E','7','1','中','3','A'],
    4: ['2','△','N','E','7','1','中','3','A'],
    5: ['2','△','N','E','7','1','中','3','A'],
    6: ['E','中','N','1','2'],
    0: ['N','E','1','休*'],
}

violations = []
for d in DAYS:
    date = d["date"]
    dow = d["dow"]
    reqs = DAILY_REQS[dow]
    # use effective codes so 休N counts as N, 休E counts as E
    effective_present = {EFFECTIVE.get(assignments[s["id"]][date], assignments[s["id"]][date])
                         for s in STAFF if assignments.get(s["id"],{}).get(date)}
    for req in reqs:
        if req not in effective_present:
            violations.append(f"  Missing {req} on {date} (dow={dow})")

print(f"\nCoverage violations (missing required shifts): {len(violations)}")
for v in violations[:20]:
    print(v)
if len(violations) > 20:
    print(f"  ... and {len(violations)-20} more")

# ── Build rotation holiday locks (mirror solver logic) ────────────────────────
OFF_SET = {'休', '休*', '例', '國', '請'}

def get_rotation_holiday_locks(draft_a, rotation_sids, day_list):
    locks = {}
    for sid in rotation_sids:
        row = draft_a.get(sid, {})
        for d in day_list:
            dow = d["dow"]
            is_hol = d["isHoliday"]
            if dow != 0 and dow != 6 and not is_hol:
                continue  # weekday, not holiday
            code = row.get(d["date"])
            if code is None:
                continue
            if is_hol:     default = '國'
            elif dow == 6: default = '休'
            else:          default = '例'  # Sunday
            if code != default:
                locks.setdefault(sid, {})[d["date"]] = code
    return locks

rotation_sids = {s["id"] for s in STAFF if not s.get("fixedShift")}
rot_locks = get_rotation_holiday_locks(draft, rotation_sids, DAYS)
locked_cells = {(sid, date) for sid, dm in rot_locks.items() for date in dm}

# Check constraints respected (with Method B: 請 = any OFF code; rotation lock wins)
constraint_violations = []
rotation_lock_overrides = []
off_substitutions = []

for sid, dates in CONSTRAINTS.items():
    for date, code in dates.items():
        actual = assignments.get(sid, {}).get(date)
        is_locked = (sid, date) in locked_cells
        if is_locked:
            # Rotation lock wins; record for info but not a violation
            rotation_lock_overrides.append(f"  {sid} {date}: rotation lock {rot_locks[sid][date]} overrides {code}")
        elif code == '請':
            # Method B: any OFF code is acceptable
            if actual not in OFF_SET:
                constraint_violations.append(f"  {sid} {date}: 請 → expected any OFF, got WORK code {actual}")
            elif actual != '請':
                off_substitutions.append(f"  {sid} {date}: 請 → compensated with {actual}")
        else:
            if actual != code:
                constraint_violations.append(f"  {sid} {date}: expected {code}, got {actual}")

print(f"\nConstraint violations (real problems): {len(constraint_violations)}")
for v in constraint_violations[:10]:
    print(v)

print(f"\nRotation lock overrides (expected, rotation wins over leave): {len(rotation_lock_overrides)}")
for v in rotation_lock_overrides[:10]:
    print(v)

print(f"\nOFF-code compensations (請 → 例/休 for quota balance): {len(off_substitutions)}")
for v in off_substitutions[:10]:
    print(v)

# ── Weekly 休/例 quota check for leave-heavy staff ───────────────────────────
import math

def get_weeks(day_list):
    weeks, cur = [], []
    for d in day_list:
        cur.append(d)
        if d["dow"] == 0:
            weeks.append(cur); cur = []
    if cur:
        weeks.append(cur)
    return weeks

def check_weekly_quota(sid, day_list, asgn):
    """Mirror solver's _add_weekly_quota: count all Sat/Sun as needing 休/例 regardless of locks.
    When Saturday is locked to work the solver places 休 on a weekday instead."""
    row = asgn.get(sid, {})
    weeks = get_weeks(day_list)
    issues = []
    for i, week in enumerate(weeks):
        target_kyu = sum(1 for d in week if d["dow"] == 6)
        target_rei = sum(1 for d in week if d["dow"] == 0)
        kyu = 0; rei = 0
        for d in week:
            c = row.get(d["date"])
            if c in ('休', '休N', '休E', '休*') or (c in ('國', '請') and d["dow"] == 6):
                kyu += 1
            elif c == '例' or (c in ('國', '請') and d["dow"] == 0):
                rei += 1
        if kyu != target_kyu or rei != target_rei:
            issues.append(f"    week {i+1} ({week[0]['date']}–{week[-1]['date']}): kyu={kyu}/{target_kyu}  rei={rei}/{target_rei}")
    return issues

print("\n── Weekly quota check for leave-heavy staff ──")
for sid in ("n07", "n15", "n09"):
    issues = check_weekly_quota(sid, DAYS, assignments)
    if issues:
        print(f"  {sid}: QUOTA MISMATCH")
        for line in issues:
            print(line)
    else:
        print(f"  {sid}: quota OK")
