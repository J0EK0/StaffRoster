# CP-SAT 排班修復後端

## 安裝

```bash
cd server
pip install -r requirements.txt
```

## 啟動

```bash
cd server
uvicorn main:app --reload --port 8000
```

## 使用方式

啟動後，在瀏覽器開 `index.html`（建議用 `python -m http.server` 避免 CORS）：

```bash
# 在 repo 根目錄
python -m http.server 3000
# 開瀏覽器 http://localhost:3000
```

流程：
1. 點「② 產生底稿」— JS 執行（保持規律性）
2. 點「③ 下一步修班」— 呼叫 CP-SAT server，回傳無違規排班

若 server 未啟動，③ 會自動 fallback 到原本的 JS greedy repair。

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

`status` 可能值：`OPTIMAL`（有最優保證）、`FEASIBLE`（有解但未證最優）、`INFEASIBLE`（約束衝突）、`TIMEOUT`（30 秒超時）

## 效能說明

求解時間取決於底稿品質：
- 底稿已近乎合法（`initPatternDraft` 產生）：通常 1–5 秒 OPTIMAL
- 底稿有較多違規：可能到 30 秒 FEASIBLE（仍為合法排班）
