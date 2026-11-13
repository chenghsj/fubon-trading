# 富邦介接

瀏覽器保留上游 `/api/v1` DTO，由 `server/fubon_bridge` 提供本機服務。`src/lib/shioaji.ts` 保留相容層命名，不載入 Shioaji SDK 或登入永豐。

```text
React → 同來源 /api proxy → 127.0.0.1:21323
                           ├─ demo: 合成行情 + PaperBook
                           ├─ paper: Fubon 行情 + PaperBook
                           └─ live: Fubon 行情／交易／帳務
```

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
