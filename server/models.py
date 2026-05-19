from __future__ import annotations
from typing import Optional
from pydantic import BaseModel


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


class RepairResponse(BaseModel):
    assignments: dict[str, dict[str, Optional[str]]]
    diagnostics: list[dict]
    status: str        # OPTIMAL | FEASIBLE | INFEASIBLE | TIMEOUT | ERROR
    solve_time_ms: int
