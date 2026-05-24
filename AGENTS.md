# StaffRoster — 醫院護理單位排班系統

## 專案性質

醫院護理單位月排班工具。前端 Vanilla JS + 後端 Python CP-SAT 求解器。

開發測試：

```bash
# 後端（必須先啟動）
cd server
python3 -m uvicorn main:app --reload --port 8000

# 前端（後端起來後，直接開 index.html 或用 http.server）
python3 -m http.server 8765
```

或直接用 `python3 launcher.py` 一鍵啟動（含打包版）。

## 技術棧

- 前端：Vanilla JS、CSS Grid、HTML5
- 狀態保存：`localStorage`
- Excel 匯出：`xlsx-js-style` CDN；`lib/xlsx.full.min.js` 為本地備份
- 後端：Python FastAPI + Google OR-Tools CP-SAT

## 檔案分工

```text
index.html             入口，按順序載入 js/*.js
css/style.css          全部樣式、班別配色、表格、modal
js/data.js             班別常數、預設員工、假日資料、localStorage key
js/calendar.js         月份 / 日期 / 星期 / 假日分組運算
js/staff.js            員工 CRUD + 拖曳排序 + 持久化
js/constraints.js      個人限制 / 偏好 / 請假資料
js/validator.js        規則檢查（前端）
js/scheduler.js        底稿生成引擎（JS 修班已廢棄，由 CP-SAT 取代）
js/export.js           Excel 匯出
js/app.js              UI 整合、render、事件綁定
js/ui-extras.js        Stepper 進度、violations drawer、rule chip

server/main.py         FastAPI server，兩個 endpoint：
                         POST /api/repair          → 正常求解 + IIS 診斷
                         POST /api/repair/relaxed  → 鬆弛解（B 路徑）
server/solver.py       CP-SAT 求解器主體
server/models.py       Pydantic request/response 型別
server/rules.py        RuntimeRules、班別邏輯、compute_weekly_targets
launcher.py            一鍵啟動（pyinstaller 打包入口）
```

## 班別代碼

工作班別：`N` / `E` / `3` / `7` / `1` / `2` / `中` / `△` / `A` / `R` / `門` / `白`

休假類型：`休` / `休*` / `例` / `國` / `請`

`休*` 是週日需要的 `休 + *` 呈現，不是獨立配額。`restQuotaCode('休*') === '休'`。

## 每日特殊班別需求

來源：`js/data.js` 的 `DAILY_REQS`

- 平日：`2 △ N E 7 1 中 3 A`
- 週六：`E 中 N 1 2`
- 週日：`N E 1 休*`
- 國定假日：`E 中 N 1 2`

`dayRequirements(dow, isHoliday)` 目前先判斷週日，所以落在週日的國定日仍用週日需求。

## 國定假日與連假資料

- `HOLIDAYS`：只放真正國定假日，會影響 `isHoliday` 與每人 `國` 配額。
- `HOLIDAY_LABELS`：只用於顯示與「國定/連假」底稿分組，不影響 `國` 配額。

## 規則檢查（前端 validator.js）

1. `N` 前一天必須是 off 或 `N`
2. `N` 後一天不可接 `△`
3. `E` 後只能接 `休/休*/例/國/請/7/E`
4. `3` 後只能接 `休/休*/例/國/請/7/3`
5. 非固定班員工連續上班不可超過 6 天
6. 每人月配額：`休 + 休* = 週六數`、`例 = 週日數`、`國 = 真正國定假日數`
7. 每日特殊班別必須剛好 1 人，不可缺也不可重複
8. 個人禁忌班不可排
9. 每日 `請` 最多 4 人
10. 平日不上班最多 4 人
11. 假日不可排 `白`，固定班員工豁免

`N/E` 平均是軟性目標，排班引擎會嘗試，但驗證器不當成違規。

## CP-SAT 求解器限制（server/solver.py）

### Hard（永遠不可違反）

| 分類 | 規則 |
|---|---|
| 禁忌班 | 個人禁忌班不可排 |
| 假日不可白班 | 輪班人員假日不可排 `白` |
| 休* 限週日 | `休*` 只能排在 dow==0 |
| 使用者鎖定 | 手動偏好 / 請假格子不可覆蓋 |
| 假日輪值鎖定 | 底稿指定的假日特殊班 |
| 月休配額 N1 | 整月 `休+休*` = 週六總數 |
| 月例配額 N2 | 整月 `例` = 週日總數 |
| 月國定配額 | 整月 `國` = 國定假日數 |
| 週配額 W1-hard | 第 1 週休/例精確等量（月 1 日為 Mon–Wed 時） |

### Slackable（penalty 越高越不容易被犧牲）

| Penalty | 分類 | 規則 |
|---|---|---|
| 1000 | 每日特殊班覆蓋 | 每天特殊班各剛好 1 人 |
| 300 | 接班規則 | N前置、E後/3後限定接班 |
| 300 | 每日請假/休假上限 | 每日 `請` ≤ 4、平日 off ≤ 4 |
| 200 | 連續上班上限 | 不可連續上班超過 6 天 |
| 100 | 週配額（中間週） | 第 2–4 週休/例盡量等量 |
| 50 | 週配額（彈性週） | 月初 Thu–Sun 開始的第 1 週 / 最後零散週 |

週配額 W1 判斷：月 1 日為 Thu(4)/Fri(5)/Sat(6)/Sun(0) 開始 → penalty=50；其餘 → hard。

### IIS 衝突診斷（A 路徑）

`POST /api/repair` 在 INFEASIBLE 時自動觸發 assumption pass：
- 用 `SufficientAssumptionsForInfeasibility()` 回傳最小衝突子集
- diagnostics 含 `iis-conflict` / `solver-infeasible-iis` 類型
- 前端 violations drawer 自動展開顯示衝突清單

### 鬆弛解（B 路徑）

`POST /api/repair/relaxed`：使用者看完 IIS 後按「強制排出鬆弛解」觸發
- 所有 slackable 規則加 slack 變數，目標函數重罰違反
- 一定有解（除非 hard 規則本身衝突）
- diagnostics 含 `slack-violated` 說明被犧牲哪些規則

### ConstraintRegistry

`solver.py` 的核心包裝類別，支援三種 mode：
- `'hard'`：直接 `model.add()`，正常求解路徑
- `'assumption'`：每條規則包一個 assumption literal，用於 IIS
- `'slack'`：slackable 規則加 slack BoolVar，用於鬆弛解

## 預設員工限制

來源：`js/data.js` 的 `DEFAULT_STAFF`

- 固定班：蔡美華、謝淑娟（`白`）、黃文伶（`R`）、莊筑琪（`門`）
- 禁忌班 `N/E`：李文君、黃月美、黃丸玲、邱珮茹

固定班員工不參與輪班與一般休例國配額檢查。

## UI 工作流

四步驟：

1. **設定偏好**（`PrefsStage`）：填請假與偏好班別
2. **產生底稿**（`btn-init-draft`）：呼叫 `Scheduler.initPatternDraft(...)`
3. **下一步修班**（`btn-auto-fill`）：POST /api/repair → CP-SAT 求解
4. **匯出 Excel**（`btn-export`）

修班 INFEASIBLE → violations drawer 自動展開 → 顯示衝突清單 + 「強制排出鬆弛解」按鈕 → 按鈕觸發 POST /api/repair/relaxed。

## 底稿設定

底稿 localStorage key：`sr_rot_${year}_v1`

```js
{
  weekday: {},
  regular:  { _order: [], _inactive: {} },
  national: { _order: [], _inactive: {} }
}
```

假日底稿填入順序：
- 非週日：`中 → E → N → 1 → 2`
- 週日：`休* → N → E → 1`

底稿指定的假日非預設值（非 `休`/`例`/`國`）會被 CP-SAT 識別為「假日輪值鎖定」，solver 不可改動。

## 統計口徑

- `花花`：平日一到五，工作班且不是 `白` 的班別（含 `R`、`門`）
- `OC`：平日 `7/E/N/△`；假日 `1/2/E/N/休*`

## 改規則去哪

| 想改的東西 | 檔案 |
|---|---|
| 班別、預設人員、假日資料 | `js/data.js` |
| 日期、假日判斷、連假分組 | `js/calendar.js` |
| 前端規則檢查 | `js/validator.js` |
| 底稿生成 | `js/scheduler.js` |
| CP-SAT 限制 / penalty / IIS | `server/solver.py` |
| API endpoint | `server/main.py` |
| UI 與互動 | `js/app.js` |
| 樣式與班別配色 | `css/style.css` |
| Excel 匯出 | `js/export.js` |

## 基本驗證

```bash
# 前端語法
node --check js/app.js
node --check js/scheduler.js

# 後端語法
python3 -m py_compile server/solver.py server/main.py

# 後端 smoke test（需在 server/ 目錄）
cd server && python3 test_july.py
```

建議手動檢查：

- 2026/7：產生底稿 → 修班（正常應 OPTIMAL 無違規）
- 2026/7 鎖假日輪值後加請假：應回 INFEASIBLE + IIS 衝突清單
- 按「強制排出鬆弛解」：應回 FEASIBLE + slack-violated 清單

## 已知未做事項

- 蔡瓊慧的「平日 15 天 E*」特殊配額規則
- 多月份歷史版本切換 UI
- 印表機友善排版
- 內建假日資料需隨年份持續維護
- CP-SAT 鬆弛解的可選犧牲規則 UI（目前固定由 PENALTY 決定順序）
