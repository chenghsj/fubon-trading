# 富邦 fork 驗證紀錄

日期：2026-11-13，macOS arm64，Node 22.20.0、pnpm 12.18.0、Python 3.12.16、Fubon Neo 2.5.0。

- `pnpm build`：TypeScript 與 Vite build 通過。保留上游的 BigInt target／動態匯入建置警告。
- `pnpm test`：5,503 passed、2 skipped，345 個測試檔通過、1 個跳過。
- `uv run --directory server --extra test --extra fubon pytest -q`：39 passed。
- `python3 -m unittest discover -s scripts -p 'test_*.py'`：10 passed。
- 程式審查三輪，已修正期貨與股票單位、連續月歷史、過期／試撮模擬撮合、Cover 反開倉、減量回增、券商狀態 40、稀疏商品資訊、斷線市場與回報語意問題。

## 實際介面操作（展示模式）

使用 `pnpm start` 啟動新程序，Chrome 開啟 http://127.0.0.1:5179：

1. 確認合成行情與本機模擬提示、手動交易與自動停損尚未支援提示。
2. 切換 3 分 K，確認五檔與逐筆行情持續更新。
3. 微型臺指具體月模擬限價買單 24,000，改價至 24,100；介面重讀後顯示新價格。
4. 取消該單，介面顯示已確認取消、有效委託 0。
5. 模擬市價買進 1 口，確認期貨部位與損益，不會顯示成股票股數。
6. 以平倉倉別模擬賣出 1 口，重讀後顯示無持倉。
7. 確認主要圖表停損／停利／警示與下單面板括號保護已停用。

[實際畫面](images/fubon-demo.jpg)。

## 未驗證

沒有讀取或使用真實富邦帳號、API Key 或憑證，沒有登入券商或送出真單。Fake SDK 測試使用官方原生 Order 型別核對參數，不能證明真實權限、成交回報、券商改刪單或正式帳務驗收已通過。公開 fork 不含上游私有桌面、Agent 或回測模組；此處未建置原生 App。
