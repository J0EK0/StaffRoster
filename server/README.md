# CP-SAT 排班後端

## 安裝

```bash
cd server
pip install -r requirements.txt
```

## 啟動（開發用）

```bash
cd server
uvicorn main:app --reload --port 8000
```

啟動後開瀏覽器 `http://localhost:8000`，前端與 API 都由同一個 server 提供。

## 一般使用者

請從 GitHub Releases 下載 `StaffRoster-windows.zip`，不需要手動啟動 server。

## API

`POST /api/repair`

```json
{
  "schedule": { "year": 2026, "month": 5, "days": [...], "assignments": {...} },
  "staff": [...],
  "constraints": {}
}
```

回傳：

```json
{
  "assignments": {...},
  "diagnostics": [],
  "status": "OPTIMAL",
  "solve_time_ms": 1234
}
```

`status` 可能值：
- `OPTIMAL`：有最優保證
- `FEASIBLE`：有解但未證最優
- `INFEASIBLE`：約束衝突，無可行解
- `TIMEOUT`：30 秒超時

## 效能說明

求解時間取決於底稿品質：
- 底稿已近乎合法（`initPatternDraft` 產生）：通常 1–5 秒 OPTIMAL
- 底稿有較多違規：可能到 30 秒 FEASIBLE（仍為合法排班）
