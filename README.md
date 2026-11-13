# 體重進度 · Weight Progress

安靜、不評價的體重紀錄工具。純前端、零後端、零外部 API，所有資料只存在你的瀏覽器。

## 功能

- 紀錄每日體重，自動算出起始 / 目標 / 已減 / 還差
- BMI 分級（亞洲標準：18.5 / 24 / 27）
- 走勢圖，支援 1 週 / 1 月 / 3 月 / 自動範圍，可平移縮放
- 資料全部存在本機瀏覽器（localStorage），不上傳任何伺服器

## 本地使用

直接用瀏覽器開 `index.html` 即可，不需要任何建置步驟或套件。

## 資料儲存說明（重要）

這是一個**單機**工具：資料只存在你當下的瀏覽器。

- 換瀏覽器、換裝置、清快取，資料都不會跟著走。
- 不提供多裝置同步——這是刻意設計（隱私、零後端），不是 bug。
- 想備份：可在「設定」裡匯出 / 匯入（若已實作），或手動備份瀏覽器資料。

## 部署到 GitHub Pages

本專案是純靜態檔案，不需要建置。兩步即可上線：

1. **推送程式碼**（在本地 repo 根目錄執行）：

   ```bash
   git add -A
   git commit -m "feat: 體重追蹤器靜態站"
   git push origin main
   ```

2. **在 GitHub 開啟 Pages**：
   - 開 `https://github.com/DearNoodle/weight-progress-tracker`
   - 進 **Settings → Pages**
   - Source 選 **Deploy from a branch**
   - Branch 選 **main**，資料夾選 **/(root)**
   - 按 Save

   幾分鐘後即可在 `https://DearNoodle.github.io/weight-progress-tracker/` 打開。

### 為什麼有 `.nojekyll`

GitHub Pages 預設會用 Jekyll 處理檔案，這個空檔案會關掉它，確保 `styles.css`、`app.js` 等原樣提供、不被當成範本解析。

## 注意

- 因為沒有後端，GitHub Pages 只負責「把檔案給瀏覽器」，紀錄行為完全在訪客自己的裝置上發生。
- 若未來想要多裝置同步，才需要引入後端 / 雲端儲存服務。
