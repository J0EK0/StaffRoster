# StaffRoster

醫院護理單位月排班工具，搭配 CP-SAT 最佳化自動修班。

## 下載與啟動

### Windows（一般使用者）

**第一次使用：**

1. 到本頁面右側找到 **Releases**，點最新版本
2. 下載 `StaffRoster-windows.zip`
3. 解壓縮到任意位置，雙擊 `StaffRoster.exe`
4. 若出現藍色警告視窗：點 **「其他資訊」→「仍要執行」**
5. 黑色視窗出現後等幾秒，瀏覽器會自動開啟排班系統

**之後每次使用：**直接雙擊 `StaffRoster.exe`。

> 關閉時記得把黑色視窗一起關掉。

### Mac（開發者）

```bash
cd StaffRoster
python3 launcher.py
```

瀏覽器自動開啟 `http://127.0.0.1:8000`。

---

## 使用流程

### ① 設定偏好

按上方 `① 設定偏好`，在表格中點某人某天設定請假或想上的班別。這些設定等按修班時才會套入。

### ② 產生底稿

按 `② 產生底稿`。系統依輪轉節奏鋪出初稿，此時出現紅字是正常的。

### ③ 下一步修班

按 `③ 下一步修班`。CP-SAT 求解器自動處理：

- 請假與偏好套入
- 禁忌班、N/E/3 接班規則
- 連續上班上限（≤ 6 天）
- 月休/例/國配額平衡
- 每日特殊班缺班補足

**若出現「無解」：** 右側 violations drawer 會自動展開，列出哪幾條規則互相衝突。可按 **「強制排出鬆弛解」** 讓系統犧牲部分軟性規則強制排出班表，並說明違反了哪些規則。

### ④ 手動微調

點格子可手動改班別。上方快速填入工具：先點班別 → 再點格子連續填入。

### ⑤ 匯出 Excel

按 `匯出 Excel`，下載帶有班別著色的 Excel 檔。

---

## 配額規則說明

| 配額 | 規則 |
|---|---|
| 月休配額 | 整月 `休 + 休*` 總數 = 該月週六數 |
| 月例配額 | 整月 `例` 總數 = 該月週日數 |
| 月國配額 | 整月 `國` 總數 = 國定假日數 |
| 週配額 | 第 1 週（月初 Mon–Wed 起）精確等量；其他週允許跨週挪動 |

週配額若有衝突（例如假日輪值鎖定），月配額保底仍須正確。

---

## 常見問題

- **瀏覽器沒自動開啟**：手動開 `http://127.0.0.1:8000`
- **資料不見了**：資料存在瀏覽器 localStorage，換瀏覽器或清除資料後會消失
- **紅字太多**：先按修班，修完再看剩下的紅字
- **出現「無解」**：看 violations drawer 的衝突清單，或按「強制排出鬆弛解」
- **Excel 沒下載**：確認瀏覽器沒有擋下載

---

## 開發資訊

**前端**：Vanilla JS，無 npm，無打包流程。

**後端**：Python FastAPI + Google OR-Tools CP-SAT。

```bash
# 安裝依賴
cd server
pip install -r requirements.txt

# 啟動後端
uvicorn main:app --reload --port 8000
```

主要檔案：

```
index.html             入口
css/style.css          樣式
js/data.js             班別定義、假日資料
js/scheduler.js        底稿生成
js/validator.js        前端規則檢查
js/app.js              UI 整合
server/solver.py       CP-SAT 求解器（Hard/IIS/Slack 三模式）
server/main.py         FastAPI server（/api/repair、/api/repair/relaxed）
```

詳細開發規則請見 [AGENTS.md](AGENTS.md)。
