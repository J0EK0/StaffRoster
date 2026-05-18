"""
FastAPI server exposing the CP-SAT repair endpoint.

Start with:
    uvicorn main:app --reload --port 8000
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

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
