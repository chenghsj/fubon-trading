# 富邦介接

瀏覽器保留上游 `/api/v1` DTO，由 `server/fubon_bridge` 提供本機服務。`src/lib/shioaji.ts` 保留相容層命名，不載入 Shioaji SDK 或登入永豐。

```text
React → 同來源 /api proxy → 127.0.0.1:21323
                           ├─ demo: 合成行情 + PaperBook
                           ├─ paper: Fubon 行情 + PaperBook
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
- 日夜盤由 `FUBON_SESSION` 選擇，分別使用 Future／FutureNight。
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

## 尚未啟用的自動交易

富邦主動回報與 Shioaji 的成交明細、取消增量語意不同。目前僅用回報觸發帳務重讀，未產生經驗證的 Shioaji DealReport，因此停用括號停損停利、觸價、定時平倉與兩腳價差自動引擎。主要入口會拒絕建立，畫面停用保護按鈕。手動下單、改刪與平倉仍可用。

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
