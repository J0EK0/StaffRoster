from __future__ import annotations
from typing import Optional
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# ShiftConfig — 使用者自訂班別設定（由前端 localStorage 產生，隨 RepairRequest 傳入）
# ---------------------------------------------------------------------------

class ShiftDefConfig(BaseModel):
    code: str
    label: str
    kind: str                       # 'work' | 'off'
    restQuota: Optional[str] = None # 複合班消耗的休假種類：'休'|'例'|'國'
    workCode: Optional[str] = None  # 複合班的實際工作碼（如 '休N' → 'N'）
    circle: bool = False
    isDefault: bool = True          # 內建班別不可刪除
    isFallback: bool = False        # 兜底班（全域只能一個，現為「白」）


class DailyReqEntry(BaseModel):
    code: str
    count: int = 1                  # 每日需要幾人（預設 1）


class SequenceRule(BaseModel):
    allowedAfter: list[str] = []    # 上這個班後，隔天允許的 work code 白名單
                                    # 空 = 無限制；off codes 永遠允許（不需列出）


class ShiftConfig(BaseModel):
    shifts: list[ShiftDefConfig] = []
    dailyReqs: dict[str, list[DailyReqEntry]] = {}
    # keys: 'weekday' | 'saturday' | 'sunday' | 'holiday'
    sequenceRules: dict[str, SequenceRule] = {}
    draftPriority: list[str] = []


# ---------------------------------------------------------------------------
# 原有 model
# ---------------------------------------------------------------------------

class StaffMember(BaseModel):
    id: str
    name: str
    fixedShift: Optional[str] = None
    forbidden: list[str] = []
    note: Optional[str] = None


class DayInfo(BaseModel):
    date: str          # YYYY-MM-DD
    day: int           # 1–31
    dow: int           # 0=Sun … 6=Sat
    isHoliday: bool
    holidayName: Optional[str] = None
    rotationGroup: Optional[str] = None


class Schedule(BaseModel):
    year: int
    month: int
    days: list[DayInfo]
    # staffId -> dateKey -> code | None
    assignments: dict[str, dict[str, Optional[str]]]
    diagnostics: list[dict] = []


class RepairRequest(BaseModel):
    schedule: Schedule
    staff: list[StaffMember]
    # staffId -> dateKey -> code  (user preferences / locks)
    constraints: dict[str, dict[str, str]] = {}
    # 使用者自訂班別設定；None = 使用 rules.py 的內建預設值
    shift_config: Optional[ShiftConfig] = None


class RepairResponse(BaseModel):
    assignments: dict[str, dict[str, Optional[str]]]
    diagnostics: list[dict]
    status: str        # OPTIMAL | FEASIBLE | INFEASIBLE | TIMEOUT | ERROR
    solve_time_ms: int
