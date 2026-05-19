"""
Test: July 2026 tough case with real rotation data + heavy leave constraints.
Run from server/ directory:
    python test_july.py
"""
import json, datetime, requests

# ── Staff list (from data.js DEFAULT_STAFF) ──────────────────────────────────
STAFF = [
    {"id": "caimh",    "name": "蔡美華", "fixedShift": "白"},
    {"id": "sjuan",    "name": "謝淑娟", "fixedShift": "白"},
    {"id": "chenyt",   "name": "陳玥彤"},
    {"id": "liwj",     "name": "李文君",  "forbidden": ["N", "E"]},
    {"id": "lixf",     "name": "李秀芳"},
    {"id": "linyy",    "name": "林妍堉"},
    {"id": "laiyh",    "name": "賴鈺函"},
    {"id": "huangym",  "name": "黃月美",  "forbidden": ["N", "E"]},
    {"id": "caicc",    "name": "蔡瓊慧"},
    {"id": "chenye",   "name": "陳妍恩"},
    {"id": "xiemq",    "name": "謝沐騏"},
    {"id": "wupc",     "name": "吳沛宸"},
    {"id": "yangyy",   "name": "楊于瑩"},
    {"id": "linyh",    "name": "林意惠"},
    {"id": "qiupr",    "name": "邱珮茹",  "forbidden": ["N", "E"]},
    {"id": "linzt",    "name": "林子庭"},
    {"id": "huangyy",  "name": "黃有玉"},
    {"id": "huangwl",  "name": "黃丸玲",  "forbidden": ["N", "E"]},
    {"id": "linc",     "name": "李唸慈"},
    {"id": "liaosq",   "name": "廖紹琪"},
    {"id": "huangwl2", "name": "黃文伶",  "fixedShift": "R"},
    {"id": "zhuangcq", "name": "莊筑琪",  "fixedShift": "門"},
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
    "liwj":    {"2026-07-01":"中","2026-07-02":"1","2026-07-06":"△","2026-07-09":"N","2026-07-10":"E","2026-07-13":"7","2026-07-14":"3","2026-07-17":"A","2026-07-22":"2","2026-07-23":"中","2026-07-24":"1","2026-07-28":"△","2026-07-31":"N"},
    "chenyt":  {"2026-07-01":"1","2026-07-03":"△","2026-07-08":"N","2026-07-09":"E","2026-07-10":"7","2026-07-13":"3","2026-07-16":"A","2026-07-21":"2","2026-07-22":"中","2026-07-23":"1","2026-07-27":"△","2026-07-30":"N","2026-07-31":"E"},
    "lixf":    {"2026-07-01":"2","2026-07-02":"中","2026-07-03":"1","2026-07-07":"△","2026-07-10":"N","2026-07-13":"E","2026-07-14":"7","2026-07-15":"3","2026-07-20":"A","2026-07-23":"2","2026-07-24":"中","2026-07-27":"1","2026-07-29":"△"},
    "huangym": {"2026-07-01":"A","2026-07-06":"2","2026-07-07":"中","2026-07-08":"1","2026-07-10":"△","2026-07-15":"N","2026-07-16":"E","2026-07-17":"7","2026-07-20":"3","2026-07-23":"A","2026-07-28":"2","2026-07-29":"中","2026-07-30":"1"},
    "xiemq":   {"2026-07-01":"3","2026-07-06":"A","2026-07-09":"2","2026-07-10":"中","2026-07-13":"1","2026-07-15":"△","2026-07-20":"N","2026-07-21":"E","2026-07-22":"7","2026-07-23":"3","2026-07-28":"A","2026-07-31":"2"},
    "wupc":    {"2026-07-01":"7","2026-07-02":"3","2026-07-07":"A","2026-07-10":"2","2026-07-13":"中","2026-07-14":"1","2026-07-16":"△","2026-07-21":"N","2026-07-22":"E","2026-07-23":"7","2026-07-24":"3","2026-07-29":"A"},
    "yangyy":  {"2026-07-01":"E","2026-07-02":"7","2026-07-03":"3","2026-07-08":"A","2026-07-13":"2","2026-07-14":"中","2026-07-15":"1","2026-07-17":"△","2026-07-22":"N","2026-07-23":"E","2026-07-24":"7","2026-07-27":"3","2026-07-30":"A"},
    "linyh":   {"2026-07-01":"N","2026-07-02":"E","2026-07-03":"7","2026-07-06":"3","2026-07-09":"A","2026-07-14":"2","2026-07-15":"中","2026-07-16":"1","2026-07-20":"△","2026-07-23":"N","2026-07-24":"E","2026-07-27":"7","2026-07-28":"3","2026-07-31":"A"},
    "huangyy": {"2026-07-01":"△","2026-07-06":"N","2026-07-07":"E","2026-07-08":"7","2026-07-09":"3","2026-07-14":"A","2026-07-17":"2","2026-07-20":"中","2026-07-21":"1","2026-07-23":"△","2026-07-28":"N","2026-07-29":"E","2026-07-30":"7","2026-07-31":"3"},
    "linyy":   {"2026-07-02":"2","2026-07-03":"中","2026-07-06":"1","2026-07-08":"△","2026-07-13":"N","2026-07-14":"E","2026-07-15":"7","2026-07-16":"3","2026-07-21":"A","2026-07-24":"2","2026-07-27":"中","2026-07-28":"1","2026-07-30":"△"},
    "caicc":   {"2026-07-02":"A","2026-07-07":"2","2026-07-08":"中","2026-07-09":"1","2026-07-13":"△","2026-07-16":"N","2026-07-17":"E","2026-07-20":"7","2026-07-21":"3","2026-07-24":"A","2026-07-29":"2","2026-07-30":"中","2026-07-31":"1"},
    "qiupr":   {"2026-07-02":"N","2026-07-03":"E","2026-07-06":"7","2026-07-07":"3","2026-07-10":"A","2026-07-15":"2","2026-07-16":"中","2026-07-17":"1","2026-07-21":"△","2026-07-24":"N","2026-07-27":"E","2026-07-28":"7","2026-07-29":"3"},
    "huangwl": {"2026-07-02":"△","2026-07-07":"N","2026-07-08":"E","2026-07-09":"7","2026-07-10":"3","2026-07-15":"A","2026-07-20":"2","2026-07-21":"中","2026-07-22":"1","2026-07-24":"△","2026-07-29":"N","2026-07-30":"E","2026-07-31":"7"},
    "laiyh":   {"2026-07-03":"2","2026-07-06":"中","2026-07-07":"1","2026-07-09":"△","2026-07-14":"N","2026-07-15":"E","2026-07-16":"7","2026-07-17":"3","2026-07-22":"A","2026-07-27":"2","2026-07-28":"中","2026-07-29":"1","2026-07-31":"△"},
    "chenye":  {"2026-07-03":"A","2026-07-08":"2","2026-07-09":"中","2026-07-10":"1","2026-07-14":"△","2026-07-17":"N","2026-07-20":"E","2026-07-21":"7","2026-07-22":"3","2026-07-27":"A","2026-07-30":"2","2026-07-31":"中"},
    "linzt":   {"2026-07-03":"N","2026-07-06":"E","2026-07-07":"7","2026-07-08":"3","2026-07-13":"A","2026-07-16":"2","2026-07-17":"中","2026-07-20":"1","2026-07-22":"△","2026-07-27":"N","2026-07-28":"E","2026-07-29":"7","2026-07-30":"3"},
}

REGULAR_ROT = {
    "liwj":    {"2026-07-11":"E"},
    "lixf":    {"2026-07-11":"N","2026-07-19":"休*"},
    "xiemq":   {"2026-07-04":"1","2026-07-18":"E"},
    "linyh":   {"2026-07-05":"休*","2026-07-18":"1"},
    "qiupr":   {"2026-07-05":"E","2026-07-26":"N"},
    "huangwl": {"2026-07-05":"N","2026-07-11":"中","2026-07-26":"1"},
    "yangyy":  {"2026-07-05":"1","2026-07-11":"2","2026-07-19":"E"},
    "linyy":   {"2026-07-11":"1","2026-07-25":"E"},
    "huangyy": {"2026-07-12":"N","2026-07-18":"中"},
    "linzt":   {"2026-07-12":"1","2026-07-18":"2","2026-07-26":"E"},
    "chenyt":  {"2026-07-18":"N","2026-07-26":"休*"},
    "laiyh":   {"2026-07-19":"N","2026-07-25":"中"},
    "huangym": {"2026-07-04":"中","2026-07-19":"1","2026-07-25":"2"},
    "chenye":  {"2026-07-04":"N","2026-07-12":"休*","2026-07-25":"1"},
    "caicc":   {"2026-07-04":"E","2026-07-25":"N"},
    "wupc":    {"2026-07-04":"2","2026-07-12":"E"},
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
    "caimh":   {"2026-07-17":"請","2026-07-16":"請","2026-07-18":"請"},
    "sjuan":   {"2026-07-01":"請"},
    "liwj":    {"2026-07-02":"請","2026-07-03":"請","2026-07-29":"請"},
    "lixf":    {"2026-07-10":"請","2026-07-17":"請","2026-07-20":"請"},
    "laiyh":   {f"2026-07-{d:02d}":"請" for d in range(5,28)},
    "huangym": {"2026-07-24":"請","2026-07-13":"請","2026-07-03":"請"},
    "caicc":   {"2026-07-24":"請","2026-07-26":"請","2026-07-27":"請","2026-07-25":"請"},
    "chenye":  {"2026-07-20":"請","2026-07-21":"請"},
    "linyh":   {"2026-07-06":"請"},
    "qiupr":   {f"2026-07-{d:02d}":"請" for d in range(17, 32)},
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

IS_WORK = lambda c: c not in ('休', '休N', '休E', '休*', '例', '國', '請', None)

def check_weekly_quota(sid, day_list, asgn):
    """Mirror solver's _add_weekly_quota exactly — including rotation-lock target reduction."""
    row = asgn.get(sid, {})
    s_locks = rot_locks.get(sid, {})
    weeks = get_weeks(day_list)
    issues = []
    for i, week in enumerate(weeks):
        target_kyu = sum(1 for d in week if d["dow"] == 6)
        target_rei = sum(1 for d in week if d["dow"] == 0)
        # Reduce targets for rotation-locked work shifts (mirrors solver fix)
        for d in week:
            locked_code = s_locks.get(d["date"])
            if locked_code and d["dow"] == 6 and IS_WORK(locked_code):
                target_kyu = max(0, target_kyu - 1)
            elif locked_code and d["dow"] == 0 and IS_WORK(locked_code):
                target_rei = max(0, target_rei - 1)
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
for sid in ("laiyh", "qiupr", "caicc"):
    issues = check_weekly_quota(sid, DAYS, assignments)
    if issues:
        print(f"  {sid}: QUOTA MISMATCH")
        for line in issues:
            print(line)
    else:
        print(f"  {sid}: quota OK")
