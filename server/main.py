"""
FastAPI server exposing the CP-SAT repair endpoint.

Start with:
    uvicorn main:app --reload --port 8000
"""
import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from models import RepairRequest, RepairResponse
from solver import repair_schedule

app = FastAPI(title="StaffRoster CP-SAT Solver")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # OK for local dev
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)


@app.post("/api/repair", response_model=RepairResponse)
async def repair(req: RepairRequest) -> RepairResponse:
    try:
        return repair_schedule(req)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/health")
async def health():
    return {"status": "ok"}


# Static files — mounted last so /api routes take priority.
# STAFFROSTER_BASE_DIR is set by launcher.py (frozen bundle) or falls back to
# the repo root when running with `uvicorn main:app` directly from server/.
_base = os.environ.get("STAFFROSTER_BASE_DIR") or os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
)
if os.path.isfile(os.path.join(_base, "index.html")):
    app.mount("/", StaticFiles(directory=_base, html=True), name="static")
