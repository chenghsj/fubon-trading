# K 棒高低標籤與期貨搜尋修正（2026-11-17）

## 行為

- 最高／最低標籤的底框放在可見 K 棒價格範圍之外，連線仍指向原影線。自動縮放保留標籤留白；手動縮放後沒有空間時略過標籤，避免夾回圖中。倒置價格軸也依實際軸設定處理，包含完全平坦的 K 棒。
- 名稱片段（如「聯」）搜尋同時顯示股票與期貨，股票結果過多時仍為期貨保留最多四個位置。分批回傳的結果維持穩定前綴。
- 輸入股票代號（如 `2330`、`2454`）或完整名稱，可找到該股票相關的一般／小型個股期貨，依既有規則排列近月、次月；期貨根代碼與具體契約代碼也可搜尋。

## 資料來源與修正原因

富邦 [Products](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/intraday/products/) 提供商品中文名稱、`underlyingSymbol`、`contractSize` 與 `tradingCurrency`；[Tickers](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/intraday/tickers/) 提供各月份契約與最後結算日。現以商品根連接兩者，不從股票或期貨名稱猜測關聯。

修正前 roots 回應只有代碼名稱、`underlying_code` 篩選參數被忽略，且一般搜尋的前十筆可能全被股票占滿。修正後保留官方中文名稱、套用股票關聯篩選與契約規格；數字商品根（如 `JZ1`）也保留完整身分。無相關期貨的股票回空陣列，不混入其他標的。

## 證據

最小回歸先重現：標籤底框侵入 K 棒價格範圍、倒置平坦 K 棒方向錯誤、「聯」結果中期貨為零、股票篩選回傳所有期貨。修正後通過。

使用真實唯讀 SDK 及獨立臨時 HTTP app 驗證 **12/12**：`2330`→CDF/QFF、`2454`→DVF/PUF、`2303`→CCF；首次直接查 `DVFK6`（未先搜尋）及暖快取後，關聯與乘數一致；`IX0001` 保留 TXF/MXF/TMF 相容分組；未知股票回空陣列。所有 SDK 交易及帳務 client 存取由 wrapper 禁止，實際存取為零。沒有對使用者的 Paper 帳簿送測試單。

- [唯讀 HTTP 驗證結果](future-search-verification-2026-11-17.json)
- [捕捉的公開 Products／Tickers fixture](../../server/tests/fixtures/future-search-2026-11-17.json)
- [圖表隔離瀏覽器驗收](../../scripts/verify-chart-highlow.mjs)
- [期貨搜尋隔離瀏覽器驗收](../../scripts/verify-futures-search.mjs)

搜尋結果與讀取行情成功不代表券商實單驗收；本次未進行真實交易。

完整檢查：Python 295 passed；前端 5,955 passed、2 skipped；`tsc -b` 與 Vite build 通過。另以 fake SDK 與不可用的 Products sentinel 驗證，既有快取委託仍可重新對帳、取消，不因新增商品資料查詢而依賴行情 REST。

隔離瀏覽器已完成 35 個圖表情境（包含修正前遮擋重現）、冷啟及六種搜尋輸入，共 7 個搜尋情境；實際選取一般／小型期貨加入清單後重讀保存。原 API 修正驗收也重新通過。所有隔離服務均已關閉；兩軸獨立 review 無未解 confirmed findings。機器可讀摘要見 [瀏覽器 QA 結果](chart-search-browser-qa-2026-11-17.json)。
