# 富邦介接

瀏覽器保留上游 `/api/v1` DTO，由 `server/fubon_bridge` 提供本機服務。`src/lib/shioaji.ts` 保留相容層命名，不載入 Shioaji SDK 或登入永豐。

```text
React → 同來源 /api proxy → 127.0.0.1:21323
                           ├─ demo: 合成行情 + PaperBook
                           ├─ paper: Fubon 行情 + SQLite PaperBook + 可選策略面板
                           ├─ sandbox: 官方測試行情／委託 + 可選策略面板
                           └─ live: Fubon 行情／交易／帳務
```

## 本機登入與存取權限

- `pnpm credentials set/status/delete` 透過 Python 直接呼叫 macOS Security / CoreFoundation；不將秘密送入 shell、命令列參數或標準輸出。
- Keychain generic password 項目：service `tw.fubon-trading.credentials`、account `default`。登入 ID、API Key、憑證路徑與憑證密碼以同一項目保存；Keychain 不可用時拒絕登入，沒有明文 fallback。
- demo 不讀 Keychain；paper/live 僅在 Passkey 註冊或登入驗證成功後，才載入 Keychain 並呼叫 SDK。啟動服務與取得註冊能力不會讀取券商秘密。已填入的舊版 `.env` 登入欄位會使 paper/live 拒絕啟動。
- RP ID 固定 `localhost`，正規前端 origin 為 `http://localhost:5179`，獨立 bridge 則是 `http://localhost:<port>`。伺服器只驗證該次設定的精確 Origin，不接受其他 localhost 埠或 127.0.0.1 assertion。
- 使用 py_webauthn 驗證註冊與登入回應；兩種 ceremony 都要求 UV。resident key 為 required；伺服器核對 challenge、RP ID、Origin、簽章、已登錄 credential ID、userHandle（若有）與 sign counter；同步型 Passkey 的零計數器合法。
- 每個 challenge 兩分鐘內有效、驗證時即消耗；失敗也不能重放。未完成 challenge 上限 64 個，過期即清理。
- 首次啟動碼 256-bit、兩分鐘有效，只能交換一次十分鐘的註冊能力；該能力不能讀取交易 API。啟動碼經 URL fragment 交付，先清除網址再載入介面；Passkey 已存在時，啟動碼不會發出註冊或交易權限。
- WebAuthn 成功後才產生獨立交易 token，雜湊保存在程序記憶體、最多 32 個工作階段。瀏覽器存於分頁 sessionStorage，不進入 localStorage、Cookie、Git、建置常數或標準輸出。REST / SSE 僅同源 Authorization，禁止 redirect 轉送。
- logout 撤銷該 token，SSE 在送出前再次檢查；重啟失效全部工作階段。鎖定介面不取消或平倉既有委託。
- 公開 credential 資料持久保存在使用者 app-data 的 SQLite；單一 owner／credential，註冊 insert 唯一限制與計數器 compare-and-update 避免競態。資料庫和父目錄以 600／700 建立。
- `pnpm passkeys reset` 是本機互動式復原，需先停止服務並輸入確認文字；沒有 HTTP reset 或免驗證入口。Keychain 與裝置私鑰不在重設範圍。
- 未授權交易／行情／帳務／SSE 回 401；既有 Host、Origin 與 JSON Content-Type 檢查仍適用。授權不替代 paper/live 雙開關、單筆數量上限或券商金鑰權限。
- 保護範圍不包含已被惡意程式控制的作業系統使用者或瀏覽器；不把同一 OS 帳號視為可隔離的安全主體。

## 語意與邊界

- 倉別：New → New、Cover → Close、Auto → Auto、DayTrade → FdayTrade。
- 價別：LMT → Limit、MKT → Market、MKP → RangeMarket。市價類拒絕 ROD。
- 期權盤別預設 `FUBON_SESSION=auto`，也可在「交易模式設定」固定 `regular` 日盤／`afterhours` 夜盤；委託分別使用 Future／FutureNight。已保存的手動選擇保留，需選「自動」才恢復跟隨時段。
- 股票整股一張轉 1000 股；零股維持股數。委託回讀再轉回介面單位。
- `TXFR1` 轉富邦 `TXF1!`；`MTXR1`／`MXFR1` 轉 `MXF1!`。用 ticker 實際 symbol 解析合約，不信任瀏覽器的 target_code。
- 下單只接受具體月份；前端先將 R1/R2 轉 target_code，後端再次拒絕 alias。
- 帳務商品代號使用官方 `convert_symbol` 轉換。
- 改刪前執行 `get_order_results`；最新查詢沒有該單時拒絕，不使用舊快取。
- SDK 回報以 `fubon_reconcile_required` SSE 要求權威重讀，不偽裝成語意不同的 Shioaji 主動回報。
- 新正式單要求行情連線；斷線仍可查詢與撤單。訂閱重播時嘗試重連及重送全部訂閱。行情斷線時不發健康 heartbeat，前端 watchdog 會重連／重播。
- 未支援 API 回 501。查詢失敗不回假的零部位。
- 歷史分 K 單次區間約一年；連續月保留 `contractMonth=1!`，未調整換月價差。
- 行情訂閱保留至服務重啟，避免某面板取消另一個面板的共用訂閱；大量切換商品可能達券商訂閱上限。
- Fake SDK 與本機模擬驗證，不等同於真實帳號、行情權限或券商成交驗收。

### 自動盤別

自動模式逐商品查詢富邦 [Ticker](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/intraday/ticker/) 的日盤與夜盤 `openDatetime`／`closeDatetime`，選擇已開盤的最近一盤；休市保留最近一盤供查看，不依固定的 15:00 或自行推算的平日曆切換。夜盤回 404 才視為此商品沒有該盤資料，連線失敗或無法確認時段則回報錯誤，不默默替換來源。股票不查期權盤別。

報價、K 線、逐筆、分價量、五檔訂閱與一般期權委託共用該商品的判斷。服務持續檢查已訂閱商品，已知開盤邊界立即重查，其餘時段資料最多快取 30 秒；跨盤僅重連期權行情，保留 Passkey 工作階段、股票行情與既有委託，不自動取消或平倉。瀏覽器清除該商品前一盤的即時與歷史快取，重新取得資料；進行中的委託確認失效，需重新確認。資料更新或重連失敗期間暫停期權行情處理與新增委託，恢復後重送訂閱。

自動模式新增期權委託要求官方時段包含目前時間；Paper 的 ROD 到期沿用同一商品的官方收盤時間。微台自動策略仍只支援日盤，研究與原生歷史面板的明確盤別查詢維持原有行為。自動切換不改變 Paper／Sandbox／Live 模式與正式下單權限；手動變更盤別偏好仍套用既有閒置檢查與服務重啟流程。

## 上游圖表與條件單自動交易

富邦主動回報與 Shioaji 的成交明細、取消增量語意不同。目前僅用回報觸發帳務重讀，未產生經驗證的 Shioaji DealReport，因此停用括號停損停利、觸價、定時平倉與兩腳價差自動引擎。主要入口會拒絕建立，畫面停用保護按鈕。手動下單、改刪與平倉仍可用。

另提供限定微台單口的 [paper／sandbox 策略自動交易面板](design/sandbox-auto-trading.md)：sandbox 核對富邦權威委託與成交明細，paper 經持久本機帳簿核對。它不啟用上述相容層引擎；初始停用，需由使用者啟動。Paper 費稅、保存與恢復方式見 [操作規格](design/paper-trading.md)；本機輪詢退出並非券商端停損停利保護。

## Passkey 規格來源

- [py_webauthn registration](https://duo-labs.github.io/py_webauthn/registration.html)
- [py_webauthn authentication](https://duo-labs.github.io/py_webauthn/authentication.html)
- [WebAuthn](https://www.w3.org/TR/webauthn-3/)

## 官方規格（2026-11-13 核對）

- [SDK](https://www.fbs.com.tw/TradeAPI/docs/download/download-sdk/)
- [API Key 登入](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/login/loginAPIKey/)
- [期貨下單](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/PlaceOrder/)
- [期貨委託查詢](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/GetOrderResults/)
- [期貨部位](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/accountManagement/SinglePosition/)
- [期貨權益](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/accountManagement/QueryEquity/)
- [歷史 K 線](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/historical/candles/)
- [即時成交](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/websocket-api/market-data-channels/trades/)
- [股票下單](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/PlaceOrder/)
- [前置條件與測試環境](https://www.fbs.com.tw/TradeAPI/docs/welcome/)

## 官方測試環境

### 在介面選擇模式

以 `pnpm start` 啟動並解鎖後，點畫面上方「交易模式設定」。選單會分別說明正式行情／測試行情與委託去向；`paper` 已使用正式行情，本機模擬下單不需要開啟正式交易。

切入 `live` 必須開啟「允許正式下單」、輸入「確認啟用正式下單」，再按「確認並啟用正式下單」。正式模式的每筆手動委託都會顯示既有委託確認，無法關閉；環境尚未確認時也先取得最新模式並確認，不直接送單。這是介面的人工確認流程，不代表取得券商權限，也不是策略獲利驗證；自動策略仍僅支援 paper／sandbox。

套用前，後端會檢查目前服務版本、確認內容、策略監控／曝險、研究工作及委託／持倉。官方帳戶需成功讀取權威委託清單與空庫存，不能以查詢失敗當成空倉。通過後原子保存非秘密設定到此工作目錄的 `server/.mode-settings.json`，停止接受舊環境操作，優雅重建整個後端。原有工作階段失效，需沿用既有 Passkey 解鎖；策略不自動啟動，Paper 帳簿與研究資料保留。

保存後 UI 設定優先於 `.env` 的初始模式，其他 worktree 與 Keychain 不變。尚未在 UI 保存時仍依 `.env`；單純關閉設定視窗不保存。切換後重啟若超時，請重新整理核對目前模式，不要重複套用。Sandbox 的測試帳號與憑證仍需依下節預先配置；介面不顯示或保存登入秘密。

### 配置官方測試憑證

富邦目前提供證券、期貨測試帳戶，免申請。[官方下載入口](https://www.fbs.com.tw/TradeAPI/docs/welcome/#測試環境)。下載並解壓縮測試環境說明包，把測試憑證保存在本機（例如 worktree 的 `.sandbox/`，已排除 Git），不要使用正式憑證。

在隔離 worktree 的 `.env` 設定：

```dotenv
FUBON_MODE=sandbox
FUBON_ENABLE_LIVE_TRADING=false
FUBON_TEST_ID=<測試憑證上的ID>
FUBON_TEST_CERT_PATH=<測試憑證的完整路徑>
```

執行 `uv sync --directory server --extra fubon`、`pnpm start`，沿用既有 Passkey 解鎖。此模式固定使用官方測試主機與測試包的公開密碼，不讀取或變更正式 Keychain，不會因連線失敗改連正式主機。畫面標示「富邦測試環境」；帳戶、委託、改刪與回報均來自券商測試服務。

測試手冊限制：帳號多人共用，測試庫存每日重設，帳務數值不保證正確；手冊列出的開盤時間為 09:30–19:00。行情與測試中台參考價可能不同，交易價格限制依測試中台。不能據此評估策略績效或保證正式環境成交行為；僅操作自己建立且有識別標記的測試委託。

`/order/update_qty` 的 quantity 沿用前端「要減少的數量」，bridge 轉成富邦 SDK 的「修改後總量（含已成交）」。

### 2026-11-15 實際驗證

- 官方兩組公開測試憑證均登入成功，各回傳證券與期貨帳戶。
- bridge 成功取得台指期具體月報價及兩類帳戶委託查詢。
- 一筆帶唯一 `FW` 識別碼的期貨測試單完成：2 口下單 → 改價 → 減少 1 口（剩餘 1）→ 取消，最後狀態 `Cancelled`；沒有操作其他共用測試委託。
- 目前測試服務的證券持倉回覆「證券報表/表單定義資料不存在」、銀行餘額回覆交割銀行不在支援範圍，期貨持倉／權益回覆 `call id`。這些測試服務錯誤原樣顯示為失敗，不替換成零部位；仍需可用的券商帳務資料才能驗收映射。
- Web 介面已以既有 Passkey 工作階段開啟，顯示「富邦測試環境」與 SSE LIVE；休市報價仍標示上一交易日快照。
