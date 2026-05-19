# StaffRoster 排班系統架構說明

## 系統概覽

護理排班系統，支援輪班制員工（rotation staff）與固定班制員工（fixed staff）。
使用者透過瀏覽器操作，後端使用 Python CP-SAT solver 進行最佳化修班。

---

## 排班流程

```
1. 使用者設定 rotation（假日/平日輪班表）
           ↓
2. 按「鋪底稿」→ JS fillPatternDraft
   產生初始班表（含 rotation 工班、預設休假碼）
           ↓
3. 使用者填寫偏好（請假、指定班別）
           ↓
4. 按「自動排班」→ CP-SAT solver（Python 後端）
   輸入：底稿 + 偏好約束
   輸出：滿足所有硬性規則的最終班表
```

後端連線失敗時顯示錯誤訊息，**不再 fallback 到舊 JS 修班引擎**。

---

## 前端（js/）

### `scheduler.js`（~707 行）

純底稿生成，**不含修班邏輯**。

| 函式 | 功能 |
|---|---|
| `initPatternDraft(schedule, staff, constraints, rotation)` | 公開 API：鋪底稿入口 |
| `fillPatternDraft(assignments, staff, days, locked, rotation)` | 依 rotation 填工班與預設休假碼 |
| `clearAssignments(schedule, staff)` | 清空班表 |

輪班底稿來源分三組：
- `weekday`：平日 rotation（N/E/7/3/A/... 依序循環）
- `regular`：假日 rotation（週六/週日/國定假日特殊安排）
- `national`：國定假日排序

### `verify.js`（~174 行）

底稿品質驗證腳本（`node js/verify.js`）。

測試項目：
- 各月底稿每日特殊班無缺/重複（coverage）
- 假日底稿格子不被 `initPatternDraft` 修改
- N/E 班別驗證行為正確

> 底稿本身預期有 hard violations（N前置、週配額等），
> 這些由 CP-SAT solver 修補，不在 JS 層驗證。

### `app.js`

- `btn-init-draft`：呼叫 `Scheduler.initPatternDraft`
- `btn-auto-fill`：POST 到 `http://localhost:8000/api/repair`
- `btn-clear-schedule`：呼叫 `Scheduler.clearAssignments`

---

## 後端（server/）

### `main.py`

FastAPI app，唯一路由：`POST /api/repair`

### `solver.py`

CP-SAT 修班引擎（Google OR-Tools）。

**核心流程：**

1. 從底稿偵測 `rotation_holiday_locks`
   - 假日（週六/週日/國定）上有非預設碼（非 休/例/國）→ hard-lock
   - 這些格子不可被修改，且豁免禁忌班與接序約束

2. 建立 CP-SAT 變數
   - 每個 `(輪班員工, 日期)` 有一組布林變數（每種班別一個）
   - `請` 僅在使用者有請假申請的格子才建立變數

3. 套用硬性約束：
   - `_add_sequence_constraints`：N前置、N不接△、E/3接続
   - `_add_max_consecutive`：連續工班 ≤ 6 天
   - `_add_weekly_quota`：每週需滿足 休/例 目標數
     - 週六鎖到工班時，休補到同週平日
     - 週日鎖到工班時，例補到同週平日
   - `_add_monthly_guo_quota`：月 國 數 = 該月國定假日數
   - `_add_daily_coverage`：每日特殊班人數需求
   - `_add_forbidden_shift`：豁免 rotation-locked 格子
   - `_add_user_constraints`：使用者申請（請假/指定班）

4. 最小化目標函式：偏離底稿的格子數 + 平日缺 N/E 懲罰

### `rules.py`

排班規則定義：
- `compute_weekly_targets`：計算每週應有的 休/例 目標
- `allowed_after_e` / `allowed_after_3`：接序規則
- `is_work` / `is_off` / `is_holiday_like`：班別分類

### `test_july.py`

7月 2026 端對端迴歸測試（最難案例，含大量請假 + rotation locks）。

執行：`python test_july.py`（需後端在 :8000 執行）

驗證：
- Constraint violations = 0（硬性規則全無違規）
- Coverage violations = 0
- 週配額 OK（休補到平日）

---

## CP-SAT Solver 設計重點

### Rotation Holiday Lock

假日出現非預設班別（如週六排 `中`、週日排 `N`）視為 rotation 預排，CP-SAT hard-lock 不可更動。

預設碼：
- 週六 → `休`
- 週日 → `例`
- 國定假日 → `國`

非預設 → lock，並豁免：禁忌班約束、接序約束（僅當兩側都 locked 時跳過）。

### 補休機制

週六 rotation 鎖到工班時：
- `target_kyu` 維持 1（不減少）
- Solver 在同週其他平日放 `休` 作補休

### 禁止 Solver 自行使用「請」

`請` 的 CP-SAT 變數只在使用者有對應請假申請時才建立。
Solver 不能自行在任意格子使用 `請` 作 OFF 碼填充。

---

## 開發指令

```bash
# 啟動後端
cd server && uvicorn main:app --port 8000

# 執行底稿驗證（JS）
node js/verify.js

# 執行 CP-SAT 迴歸測試（Python，需後端在線）
cd server && python test_july.py

# 前端
# 用 Live Server 開 index.html
```
