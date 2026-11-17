# 富邦 API 支援與安全驗證盤點（2026-11-17）

本程式只轉接富邦 Neo SDK 的一部分，不能據此宣稱「富邦 API 全部正常」。初次驗證發現股票 Tick 映射遺漏、自選清單無 body 的 DELETE 回 415（也影響改名流程），以及股票 MKP 前置驗證缺口；後續另重現加入／移除清單商品回 501。這四項已修正並通過下方「修正後驗證」，原始失敗證據保留於「初次實測證據」。本報告以[官方交易簡介](https://www.fbs.com.tw/TradeAPI/docs/trading/introduction/)的交易、帳務、即時行情三類主要功能，補上官方 Python 股票／期權 SDK、條件單及行情文件，逐項對照本機 adapter 的路由與程式分支。

初次靜態盤點基準：`fix/sandbox-paper-switch`，HEAD `67769c19`；本次修正同時更新 T4、T5、R3、M5 與本機自選清單的狀態。文件查閱日期為 2026-11-17。程式碼連結以本報告所在位置為基準，`#L` 後為盤點時行號；後續修改可能使行號移動。

## 如何解讀結果

- **支援**：目前有明確的程式與路由；不代表券商端已驗收成功。
- **部分支援**：有路徑，但只涵蓋官方功能的一部分，或 Paper 與券商語意不同。
- **不支援**：沒有 SDK 轉接、HTTP 明確拒絕，或只有相容性占位回應。
- **待實測**：本次沒有對該功能取得執行證據。程式碼可讀、測試通過及 HTTP 200 都不能各自證明真實帳務／交易正常。

矩陣中的「Paper 行為」是**程式碼所定義的行為**；「驗證狀態」僅對本次明列的抽樣與模式成立。真實 SDK 只用於登入、行情 REST／WebSocket 讀取；所有下改刪操作都在臨時 Paper 資料庫完成，沒有對券商送出交易、圈存或匯撥要求。

## 模式與真實交易界線

| 模式 | 資料／執行來源 | 安全界線與限制 |
| --- | --- | --- |
| `demo` | 合成商品、合成報價；記憶體模擬帳簿 | 不建立 SDK；不能拿來驗收富邦連線。[broker.py:38](../../server/fubon_bridge/broker.py#L38)、[broker.py:147](../../server/fubon_bridge/broker.py#L147) |
| `paper` | API Key＋憑證登入取得富邦行情；委託、成交、部位與費稅寫入本機帳簿 | `broker_orders=False`，一般下單／改刪／帳務先走本機分支；帳戶顯示 `LOCAL/PAPER-*`。Paper 仍需要有效行情登入，不能將本機帳戶存在視為券商帳戶權限正常。[config.py:38](../../server/fubon_bridge/config.py#L38)、[broker.py:41](../../server/fubon_bridge/broker.py#L41)、[broker.py:112](../../server/fubon_bridge/broker.py#L112)、[broker.py:545](../../server/fubon_bridge/broker.py#L545) |
| `sandbox` | 官方測試連線與測試憑證；交易方法會呼叫測試 SDK | 並非本機 Paper。程式內確實有送出測試委託的能力；本次不以送單驗收。[config.py:10](../../server/fubon_bridge/config.py#L10)、[config.py:59](../../server/fubon_bridge/config.py#L59)、[broker.py:54](../../server/fubon_bridge/broker.py#L54) |
| `live` | 正式 API Key／憑證與正式券商交易 | 需明確啟用；不是本次驗收模式。不得由 Paper 成功推論 live 下單正常。[config.py:27](../../server/fubon_bridge/config.py#L27)、[app.py:321](../../server/fubon_bridge/app.py#L321)、[broker.py:548](../../server/fubon_bridge/broker.py#L548) |

官方提供[測試環境入口](https://www.fbs.com.tw/TradeAPI/docs/welcome/)；本報告對 `sandbox` 的「支援」僅指程式分支存在，不代表已登入該環境或已執行測試委託。

## 登入、帳戶與憑證

| ID／官方功能與來源 | 支援程度 | SDK 方法／本機 API 與實作 | Paper 行為 | 驗證狀態 |
| --- | --- | --- | --- | --- |
| A1 [一般憑證登入](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/login/loginPassword/) | 部分支援 | `sdk.login` 只用於 sandbox；一般 Paper/live 使用 API Key。Passkey 解鎖才觸發 `Broker.connect`。[broker.py:41](../../server/fubon_bridge/broker.py#L41)、[app.py:164](../../server/fubon_bridge/app.py#L164) | 不提供正式登入密碼方式的 UI；使用下列 A2 | 正式帳密登入未測；本次 Paper 使用 A2，亦未登入 Sandbox。 |
| A2 [API Key＋憑證登入](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/login/loginAPIKey/) | 支援 | `sdk.apikey_login`、`sdk.init_realtime`；`/api/v1/info`、`/health`、`/auth/accounts`。[broker.py:59](../../server/fubon_bridge/broker.py#L59)、[app.py:226](../../server/fubon_bridge/app.py#L226) | 登入成功且有帳戶後才標記本機模擬帳戶 signed；不把真實帳號送到 Paper 帳戶列表 | **正常（唯讀實測）**：正式 SDK 登入成功、回傳 3 個帳戶，股票／期貨／選擇權快照均回 200。 |
| A3 [API Key 權限、IP、撤銷](https://www.fbs.com.tw/TradeAPI/docs/trading/api-key-apply/) | 部分支援 | 僅使用既有 Key 登入；本機 `/settings/credentials` 儲存連線設定，沒有新增／調權／撤銷官方 Key 的轉接。[app.py:250](../../server/fubon_bridge/app.py#L250)、[broker.py:59](../../server/fubon_bridge/broker.py#L59) | 不會自動把 Key 限制成唯讀；本次測試應在 wrapper 阻擋所有券商寫入 | 既有 Key 登入與本機儲存狀態查詢正常；未檢查或調整官方 Key 權限。SDK wrapper 的交易／帳務 client 存取次數為 0。 |
| A4 [SDK 登入回傳多個證券／期貨帳戶](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/login/loginPassword/) | 部分支援 | 登入結果依 `account_type` 分成 S／F；`GET /auth/accounts`、明確帳戶 selector。[broker.py:60](../../server/fubon_bridge/broker.py#L60)、[broker.py:124](../../server/fubon_bridge/broker.py#L124) | 回傳 LOCAL 的證券、期貨及獨立策略模擬帳戶；不是券商帳戶清單 | **正常（本次範圍）**：SDK 回傳 3 個帳戶；Paper API 回 LOCAL 的 3 個模擬帳戶，沒有冒用券商帳號。 |
| A5 憑證效期／憑證管理 | 不支援 | `GET /api/v1/auth/ca_expiretime` 明確回 501，要求從富邦憑證管理查詢。[app.py:359](../../server/fubon_bridge/app.py#L359) | 不虛構效期；此為本機相容路由，不能視為官方 Python SDK 已提供同名方法 | **預期未支援**：實測 HTTP 501。 |
| A6 [登出](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/logout/) | 部分支援 | `/session/logout` 只撤銷本機 session；服務關閉時 `sdk.shutdown()`。[app.py:212](../../server/fubon_bridge/app.py#L212)、[broker.py:91](../../server/fubon_bridge/broker.py#L91) | 按本機登出不等於立即關閉 SDK 連線 | 本次未操作使用者的登出或中斷其券商 session；隔離測試關閉時有呼叫 SDK shutdown，不能當成 logout API 完整驗收。 |

## 股票與期權委託範圍

以下本機下單入口均為 `POST /api/v1/order/place_order`，實作在 [app.py:525](../../server/fubon_bridge/app.py#L525) 與 [broker.py:524](../../server/fubon_bridge/broker.py#L524)。有效數量另受本機 `max_quantity` 限制；連續月別名只准看盤，不准下單。

| ID／官方功能與來源 | 支援程度 | SDK 方法／程式限制 | Paper 行為 | 驗證狀態 |
| --- | --- | --- | --- | --- |
| T1 [現股整股、盤中零股、盤後零股](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/PlaceOrder/) | 部分支援 | `stock.place_order`＋`OrderType.Stock`；Common 數量由張轉股 ×1000，IntradayOdd／Odd 以股。[broker.py:560](../../server/fubon_bridge/broker.py#L560) | 可進本機帳簿，但整／零股使用同一一般報價撮合，沒有零股專用撮合機制。[paper.py:83](../../server/fubon_bridge/paper.py#L83) | **Paper 基本現股買賣正常**：臨時帳簿的 MKT/IOC 買入與賣出回 200/Filled；零股規則與券商執行未測。 |
| T2 [融資、融券、借券、現沖先賣](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/PlaceOrder/) | 不支援下單 | HTTP 模型只接受 `order_cond=Cash`、`daytrade_short=False`；券商分支也拒絕信用／先賣當沖。[models.py:22](../../server/fubon_bridge/models.py#L22)、[broker.py:562](../../server/fubon_bridge/broker.py#L562) | 不能據一般 Paper 的買賣結果推論信用額度或現沖權限 | 靜態確認限制；拒絕行為待實測 |
| T3 [股票定盤、興櫃與興櫃零股盤別](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/PlaceOrder/) | 不支援完整盤別 | `order_lot` 只收 Common／IntradayOdd／Odd；沒有 Fixing／Emg／EmgOdd。[models.py:21](../../server/fubon_bridge/models.py#L21) | 沒有這些獨立盤別與交易規則 | 靜態確認缺口 |
| T4 [股票價格別與 ROD／IOC／FOK](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/PlaceOrder/) | 部分支援；股票 MKP 明確拒絕 | 股票 SDK 映射只有 LMT→Limit、MKT→Market；未提供 LimitUp／LimitDown／Reference。共用模型要求市價使用 IOC/FOK。[models.py:27](../../server/fubon_bridge/models.py#L27)、[broker.py:565](../../server/fubon_bridge/broker.py#L565) | 不模擬排隊、部分成交、可用深度；能撮合即整筆成交，否則 IOC/FOK 取消。[paper.py:105](../../server/fubon_bridge/paper.py#L105) | Paper 股票 MKT/IOC 正常；修正後股票 MKP 在所有模式的 HTTP 輸入驗證回 422，直接 Broker 呼叫也拒絕；帳簿不變、SDK dispatch 0，見 D2。其他股票價格別／效期組合未逐一驗收。 |
| T5 [期貨／選擇權單式與日／夜盤](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/PlaceOrder/) | 部分支援 | `futopt.place_order`＋`FutOptOrder`；Future／Option 依商品分流，夜盤加 Night；LMT／MKT／MKP、New／Close／Auto／FdayTrade 有映射。[broker.py:570](../../server/fubon_bridge/broker.py#L570) | 同一本機撮合器；不模擬選擇權權利金、履約、到期結算或保證金；非指數商品乘數不完整，見 D3 | **Paper 微台單式正常**：LMT/ROD 掛單、MKT/IOC 與 MKP/IOC 本機買賣通過；選擇權交易、夜盤及券商實單未測。 |
| T6 [期權複式／價差委託](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/PlaceOrder/) | 不支援 | 模型沒有第二腿；商品代碼驗證與下單映射均為單式。[models.py:13](../../server/fubon_bridge/models.py#L13)、[broker.py:190](../../server/fubon_bridge/broker.py#L190) | 不建立多腿部位與風險 | 靜態確認缺口 |
| T7 [委託自訂欄位 user_def](https://www.fbs.com.tw/TradeAPI/docs/download/download-sdk/) | 部分支援 | SDK 使用程式產生的 `FubonWeb`／`FW…`／`FA…`，不直接傳 HTTP `custom_field`；策略 tag 有格式檢查。[broker.py:528](../../server/fubon_bridge/broker.py#L528)、[broker.py:557](../../server/fubon_bridge/broker.py#L557) | 手動 Paper 可保存本機欄位；不能據此推論券商 user_def 接受任意字串 | 待實測 |

## 下、改、刪、查、成交明細

| ID／官方功能與來源 | 支援程度 | SDK 方法／本機 API 與實作 | Paper 行為 | 驗證狀態 |
| --- | --- | --- | --- | --- |
| O1 [證券當日委託](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/GetOrderResults/)／[期權當日委託](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/GetOrderResults/) | 支援 | `stock/futopt.get_order_results`；`POST /order/trades`，預設 refresh；本地快取與 authoritative baseline 分開。[broker.py:507](../../server/fubon_bridge/broker.py#L507) | 只查本機帳簿，不查券商委託 | **Paper 查詢正常**：3 個 LOCAL 帳戶的 order list 回 200；未查詢券商真實委託。 |
| O2 [修改價格](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/ModifyPrice/) | 支援基本限價改價 | `make_modify_price_obj`→`modify_price`；`POST /order/update_price`。[broker.py:640](../../server/fubon_bridge/broker.py#L640) | 本機改價後用當前報價重做撮合 | **Paper 改價正常**：臨時微台限價單改價回 200；券商改價未測。 |
| O3 [股票改量](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/ModifyQuantity/) | 不支援券商股票改量 | 官方為 `make_modify_quantity_obj`→`modify_quantity`；本程式在 S 帳戶明確拒絕；`POST /order/update_qty` 的數量語意是「減少量」。[broker.py:676](../../server/fubon_bridge/broker.py#L676) | 本機允許減少量，小於剩餘未成交量；全部取消須走刪單。[paper.py:183](../../server/fubon_bridge/paper.py#L183) | 券商股票改量不支援；本次未單獨驗收股票 Paper 減量，不能以期貨的成功結果替代。 |
| O4 [期權改量](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/ModifyQuantity/) | 支援減量 | 將「目前有效總量－減少量」傳 `make_modify_lot_obj`→`modify_lot`，符合官方包含已成交部分的目標總量語意。[broker.py:675](../../server/fubon_bridge/broker.py#L675) | 同 O3 的本機減量規則 | **Paper 期貨減量正常**：臨時限價單減量回 200；券商改量未測。 |
| O5 [刪單](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/CancelOrder/) | 支援 | `stock/futopt.cancel_order`；`POST /order/cancel_order`；券商改刪先重查 baseline，缺單不使用舊快取操作。[broker.py:661](../../server/fubon_bridge/broker.py#L661) | 只取消本機活動委託 | **Paper 刪單正常**：臨時活動委託取消後回 200/Cancelled；券商刪單未測。 |
| O6 [含歷程結果](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/GetOrderResultsDetail/)／[歷史委託](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/OrderHistory/) | 不支援一般查詢 | 沒有公開路由呼叫 `order_result_detail`／`order_history`；未轉接的 `/api/*` 走 501。[app.py:608](../../server/fubon_bridge/app.py#L608) | Paper 持久帳簿保留自己的委託，並非券商歷史查詢 | 靜態確認缺口；HTTP 待實測 |
| O7 [股票歷史成交](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/FilledHistory/)／[期權歷史成交](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/FilledHistory/) | 部分支援 | 一般委託正規化的 `deals=[]`；只有 sandbox 自動策略用 `futopt.filled_history` 對齊日盤成交價，沒有通用成交查詢 API。[mapping.py:147](../../server/fubon_bridge/mapping.py#L147)、[broker.py:600](../../server/fubon_bridge/broker.py#L600) | 本機成交帶 `deals` 與費稅；不是券商成交紀錄 | Paper 股票／期貨的本機 IOC 成交通過；未向券商查個人成交明細，sandbox 策略成交對齊也未實測。 |
| O8 [批次委託](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/batchOrder/BatchPlaceOrder/) | 不支援 | 沒有 `batch_place_order` 等路由；只有單筆 PlaceOrder。[models.py:43](../../server/fubon_bridge/models.py#L43)、[app.py:608](../../server/fubon_bridge/app.py#L608) | 無批次 SDK 語意 | 靜態確認缺口 |

## 帳務、損益與保證金

| ID／官方功能與來源 | 支援程度 | SDK 方法／本機 API 與實作 | Paper 行為 | 驗證狀態 |
| --- | --- | --- | --- | --- |
| P1 [股票庫存](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/accountManagement/Inventories/)＋[未實現損益](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/accountManagement/UnrealizedPnLDetail/) | 部分支援 | `accounting.inventories`＋`unrealized_gains_and_loses` 合成 `POST /portfolio/position_unit`；支持讀取 Stock／Margin／Short／SBL 類別，未保留官方全部欄位。[broker.py:709](../../server/fubon_bridge/broker.py#L709) | 本機部位與簡化浮動損益；不查真實股票庫存 | **Paper 持倉 API 正常**：3 個 LOCAL 帳戶查詢回 200；真實股票庫存與損益未查詢。 |
| P2 [已實現彙總](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/accountManagement/RealizedPnLSum/)／[明細](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/accountManagement/RealizedPnLDetail/) | 不支援券商查詢 | 未呼叫 `realized_gains_and_loses_summary`／`realized_gains_and_loses`，未提供對應 portfolio 路由。[app.py:561](../../server/fubon_bridge/app.py#L561)、[app.py:608](../../server/fubon_bridge/app.py#L608) | `/paper/state` 回本機 gross／fee／tax／net，不能替代券商對帳。[app.py:417](../../server/fubon_bridge/app.py#L417)、[paper.py:204](../../server/fubon_bridge/paper.py#L204) | 本機 /paper/state 回 200；完整費稅會計未在本次實測逐項驗收，券商已實現損益查詢未轉接。 |
| P3 [維持率](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/accountManagement/Maintenance/)／[交割款](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/accountManagement/QuerySettlement/) | 不支援 | 未轉接 `accounting.maintenance`／`query_settlement`。[app.py:608](../../server/fubon_bridge/app.py#L608) | 不模擬融資維持率與交割收付 | 靜態確認缺口 |
| P4 [銀行餘額](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/accountManagement/Balance/) | 支援基本餘額 | `accounting.bank_remain`；`POST /portfolio/account_balance` 僅 S 帳戶。[broker.py:760](../../server/fubon_bridge/broker.py#L760)、[app.py:572](../../server/fubon_bridge/app.py#L572) | 回傳初始 100 萬＋本機累積已實現淨損益；不代表實際銀行餘額或可買額度 | **Paper 本機餘額正常**：回 200；真實銀行餘額未查詢。 |
| P5 [期權單式部位](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/accountManagement/SinglePosition/) | 支援摘要 | `futopt_accounting.query_single_position`；`POST /portfolio/position_unit`，只映射代碼、方向、數量、成本、市價、損益。[broker.py:733](../../server/fubon_bridge/broker.py#L733) | 僅自己的模擬部位 | **Paper 期貨部位 API 正常**：本機查詢回 200；真實期權部位未查詢。 |
| P6 [期權混合部位](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/accountManagement/HybridPosition/)／[平倉紀錄](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/accountManagement/ClosePositionRecord/) | 不支援 | 未呼叫 `query_hybrid_position`／`close_position_record`，沒有一般查詢路由。[app.py:608](../../server/fubon_bridge/app.py#L608) | 本機平倉損益不含券商混合部位與平倉紀錄 | 靜態確認缺口 |
| P7 [期權權益數](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/accountManagement/QueryEquity/) | 部分支援 | `query_margin_equity`；`POST /portfolio/margin` 僅 F 帳戶，先取 NTD、缺少時取 TWD 一筆，並映射部分欄位。[broker.py:738](../../server/fubon_bridge/broker.py#L738) | 權益＝模擬現金＋浮動損益；原始／維持保證金固定 0，可動用保證金未扣占用；不能用來判斷真實可下單量 | **Paper 權益 API 正常**：兩個本機 F 帳戶回 200，仍是簡化模型；真實券商權益／保證金未查詢。 |
| P8 [下單商品保證金試算](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/EstimateMargin/) | 不支援 | 未轉接 `futopt.query_estimate_margin`。[app.py:608](../../server/fubon_bridge/app.py#L608) | 不做官方商品保證金與追繳模擬 | 靜態確認缺口 |

## 回報、連線恢復及進階交易

| ID／官方功能與來源 | 支援程度 | SDK 方法／本機 API 與實作 | Paper 行為 | 驗證狀態 |
| --- | --- | --- | --- | --- |
| R1 [主動委託／成交回報](https://www.fbs.com.tw/TradeAPI/docs/trading/guide/report_example/) | 部分支援 | 股票與期權 `set_on_*order/filled/changed` 註冊後使快取失效，送 SSE `fubon_reconcile_required`；由查詢建立權威基線。`/auth/subscribe_trade` 僅驗證帳戶並回 success，不額外建立券商訂閱。[broker.py:69](../../server/fubon_bridge/broker.py#L69)、[broker.py:381](../../server/fubon_bridge/broker.py#L381)、[app.py:354](../../server/fubon_bridge/app.py#L354) | 本機帳簿自己送回報；不能取代券商回報驗收 | 本機 subscribe_trade 與 cache health 回 200/Healthy；真實券商委託／成交回報未做實單驗收。 |
| R2 [交易斷線重登](https://www.fbs.com.tw/TradeAPI/docs/trading/guide/advance/reconnect/) | 部分支援 | 接到 300/301/302/303/304/500 會標記錯誤、失效快取並要求人工重啟／重新登入；沒有官方範例的自動 logout/login 重連流程。[broker.py:372](../../server/fubon_bridge/broker.py#L372) | 帳簿仍在；不應把舊畫面或健康回應當作交易連線已恢復 | 未對使用者的正式連線做斷線注入；真實故障後重登／回報恢復待驗收。 |
| R3 [行情訂閱／重連](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/websocket-api/getting-started/) | 部分支援 | disconnect/error 移除連線標記；重新訂閱時 connect＋重播該市場訂閱；SSE 斷線與 10 秒 heartbeat 輔助偵測。[broker.py:399](../../server/fubon_bridge/broker.py#L399)、[app.py:493](../../server/fubon_bridge/app.py#L493) | 只有收到適當新報價才撮合；未以心跳當行情 | 修正後股票／期貨 Tick 與五檔四種 SSE 事件均取得；未做外部斷線／重連故障注入。 |
| R4 [非阻塞委託／改刪](https://www.fbs.com.tw/TradeAPI/docs/trading/guide/advance/asyn_order/) | 不支援選項 | 官方支援 `unblock`，本程式所有 SDK 呼叫未傳，採預設阻塞。HTTP 在 threadpool 執行不等於官方非阻塞交易。[broker.py:568](../../server/fubon_bridge/broker.py#L568)、[broker.py:575](../../server/fubon_bridge/broker.py#L575)、[broker.py:668](../../server/fubon_bridge/broker.py#L668) | 僅本機同步帳簿操作 | 靜態確認缺口 |
| R5 [證券條件單](https://www.fbs.com.tw/TradeAPI/docs/smart-condition/introduction/)／[期貨條件單](https://www.fbs.com.tw/TradeAPI/docs/smart-condition-future/introduction/) | 不支援官方條件單 | 未轉接單／多條件、停損停利、移動鎖利、分時分量等 SDK；一般未實作 API 回 501。[app.py:608](../../server/fubon_bridge/app.py#L608) | 本機自動策略是另外的功能，不能當成券商條件單 | 靜態確認缺口 |
| R6 本機微台自動策略（非官方通用 API） | 部分支援 | 僅 sandbox/paper 日盤、未到期具體 TMF、單口限價 IOC；策略下單走同一 Broker。[auto_gateway.py:17](../../server/fubon_bridge/auto_gateway.py#L17)、[auto_gateway.py:60](../../server/fubon_bridge/auto_gateway.py#L60) | 強制 `PAPER-AUTO-F` 獨立帳簿，策略 tag／持倉核對；不能接正式 live。[auto_gateway.py:72](../../server/fubon_bridge/auto_gateway.py#L72) | automation/state 回 200；未啟動使用者策略。既有隔離測試通過不代表策略真實成交或獲利驗收。 |

## 圈存、匯撥與其他證券功能

| ID／官方功能與來源 | 支援程度 | 官方 SDK／本機缺口 | Paper 行為 | 驗證狀態 |
| --- | --- | --- | --- | --- |
| X1 [圈款申請](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/reserveTransfer/ReserveCash/)／[查詢](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/reserveTransfer/QueryReserves/) | 不支援 | `stock.reserve_cash`／`query_reserves` 未轉接；無路由。[app.py:608](../../server/fubon_bridge/app.py#L608) | 不發生圈款，也不模擬預收手續費 | 靜態確認缺口；不得為驗收送申請 |
| X2 [圈券申請](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/reserveTransfer/ReserveStock/)／[查詢](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/reserveTransfer/QueryReservedStocks/) | 不支援 | `reserve_stock`／`query_reserved_stocks` 未轉接。[app.py:608](../../server/fubon_bridge/app.py#L608) | 無圈券 | 靜態確認缺口 |
| X3 [可匯撥庫存](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/reserveTransfer/QueryTransferInventory/)／[匯撥申請](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/reserveTransfer/TransferStock/)／[紀錄](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/reserveTransfer/QueryTransfers/) | 不支援 | `query_transfer_inventory`／`transfer_stock`／`query_transfers` 未轉接。[app.py:608](../../server/fubon_bridge/app.py#L608) | 無真實或模擬匯撥 | 靜態確認缺口；不得為驗收送申請 |
| X4 [資券配額](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/MarginQuota/)／[現沖券配額](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/DaytradeAndStockInfo/) | 不支援 | `stock.margin_quota`／`daytrade_and_stock_info` 未轉接。商品欄位的 margin/short balance 固定 0，不是官方額度。[mapping.py:66](../../server/fubon_bridge/mapping.py#L66)、[app.py:608](../../server/fubon_bridge/app.py#L608) | 不檢核真實額度 | 靜態確認缺口 |

## 行情與商品資料

後續已補齊期貨商品中文名稱與股票代號關聯篩選（M2），`2330`／`2454` 的一般與小型期貨唯讀驗證通過。詳細來源與冷啟查詢、瀏覽器測試範圍見 [K 棒標籤與期貨搜尋修正](chart-search-fixes-2026-11-17.md)。

| ID／官方功能與來源 | 支援程度 | SDK 方法／本機 API 與實作 | Paper 行為 | 驗證狀態 |
| --- | --- | --- | --- | --- |
| M1 [股票列表／基本資料](https://www.fbs.com.tw/TradeAPI/docs/market-data/http-api/getting-started/) | 部分支援 | `stock.intraday.tickers(type=EQUITY,market=TSE/OTC)`、`ticker`；`GET /data/contracts`、`/data/contracts/{code}`。[broker.py:165](../../server/fubon_bridge/broker.py#L165) | 使用富邦行情，不是合成商品 | **抽樣正常**：股票目錄、2330 基本資料與快照回 200；不涵蓋所有商品。 |
| M2 [期權列表／基本資料／連續月](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/getting-started/) | 部分支援 | `futopt.intraday.tickers/ticker`；FUT／OPT 目錄，排除 isSpread；`R1/R2/R3` 轉 `1!/2!/3!`；單一 ticker 解析實際合約。[broker.py:178](../../server/fubon_bridge/broker.py#L178)、[mapping.py:43](../../server/fubon_bridge/mapping.py#L43) | 別名可看盤、禁止送入本機及券商下單 | **抽樣正常**：FUT/OPT 目錄、期貨 roots、TMF 篩選及 TMFR1→具體合約解析回 200。 |
| M3 [選擇權商品鏈與歷史所需月份／履約價／買賣權](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/historical/candles/) | 部分支援；篩選不支援 | 通用 contracts 可列 OPT、已知代碼可讀行情；`/contracts/options/roots` 固定 TXO；`/contracts/options` 明確 501；未完成篩選與完整 metadata。[app.py:379](../../server/fubon_bridge/app.py#L379)、[mapping.py:51](../../server/fubon_bridge/mapping.py#L51) | 不提供完整選擇權交易鏈／風險模型 | OPT 通用目錄與抽樣快照回 200；完整商品鏈篩選實測回 **501**。 |
| M4 [股票即時報價](https://www.fbs.com.tw/TradeAPI/docs/market-data/http-api/intraday/quote/)／[期權即時報價](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/intraday/quote/) | 部分支援 | `intraday.quote`；`POST /data/snapshots` 最多 100 筆，逐檔請求而非官方全市場 snapshot；映射部分欄位。[broker.py:218](../../server/fubon_bridge/broker.py#L218)、[mapping.py:74](../../server/fubon_bridge/mapping.py#L74)、[app.py:398](../../server/fubon_bridge/app.py#L398) | 用 quote 的成交時買賣價／成交價撮合；不是委託簿深度撮合 | **抽樣正常**：股票／微台／一檔選擇權快照回 200；非全市場、全商品與所有欄位驗收。 |
| M5 [股票 Tick WebSocket](https://www.fbs.com.tw/TradeAPI/docs/market-data/websocket-api/market-data-channels/trades/) | 支援基本平面 trades；**已修正** | `stock.subscribe(channel=trades)`→SSE `tick_stk`；`market_trades` 分別處理股票平面與期權陣列，股票累計量取 `volume`。[mapping.py](../../server/fubon_bridge/mapping.py)、[broker.py](../../server/fubon_bridge/broker.py) | 非試撮 trade 更新快取並觸發 Paper 撮合；試撮僅發出 simtrade 事件 | **修正後抽樣正常**：真實 SDK 行情取得 tick_stk；捕捉 frame 重放到瀏覽器 store 與臨時 Paper 掛單成交皆通過，試撮不成交。 |
| M6 [期權 Tick WebSocket](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/websocket-api/market-data-channels/trades/) | 支援基本 trades | `websocket_client.futopt`，日／夜盤 afterHours，SSE `tick_fop`；試撮旗標映射且不拿試撮撮合。[broker.py:443](../../server/fubon_bridge/broker.py#L443)、[broker.py:470](../../server/fubon_bridge/broker.py#L470)、[mapping.py:94](../../server/fubon_bridge/mapping.py#L94) | 非試撮、有有效時價才嘗試撮合；沒有真實排隊、部分成交或市場衝擊 | **微台真實即時 Tick 正常**：SSE 取得 tick_fop；選擇權 Tick 與夜盤未另外測。 |
| M7 [股票五檔／零股](https://www.fbs.com.tw/TradeAPI/docs/market-data/websocket-api/market-data-channels/books/)／[期權五檔](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/websocket-api/getting-started/) | 部分支援 | `books`→SSE `bidask_stk/fop`；只映射 bids/asks；`intraday_odd=true` 明確 501，未轉接官方 intradayOddLot；衍生一檔未映射。[app.py:483](../../server/fubon_bridge/app.py#L483)、[mapping.py:100](../../server/fubon_bridge/mapping.py#L100) | 五檔顯示不等於模擬成交消耗深度；不做零股專用撮合 | **抽樣五檔正常（2330／微台）**：SSE 取得 bidask_stk、bidask_fop；零股即時行情為未轉接限制。 |
| M8 [股票當日逐筆](https://www.fbs.com.tw/TradeAPI/docs/market-data/http-api/intraday/trades/)／[期權當日逐筆](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/intraday/trades/) | 部分支援 | `intraday.trades`；`POST /data/ticks` 僅當日、最多 500 筆，未開放 offset／試撮查詢；部分缺失欄位補 0。[broker.py:354](../../server/fubon_bridge/broker.py#L354)、[app.py:479](../../server/fubon_bridge/app.py#L479) | 讀真行情，不讀券商個人成交 | **股票／期貨當日抽樣正常**：各取最近 5 筆回 200 且有資料；歷史逐筆不在支援範圍。 |
| M9 [股票歷史 K](https://www.fbs.com.tw/TradeAPI/docs/market-data/http-api/historical/candles/) | 部分支援 | `historical.candles(timeframe=1)`＋今日 `intraday.candles`；`POST /data/kbars`，日期差檢核 0–365 天；分 K 時標轉成收線時間 +1 分，Amount 補 0。[broker.py:236](../../server/fubon_bridge/broker.py#L236) | 真行情；不提供官方所有週期、還原價與欄位選項 | **抽樣正常**：2330 當日及前一完成交易日 K 棒回 200，OHLCV 欄位長度一致且非空；其他區間／邊界未測。 |
| M10 [期貨／選擇權歷史 K](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/historical/candles/) | 部分支援 | FUT 月契約／連續月可換算 product＋contractMonth；目前通用 kbars 正則僅接受字母根＋A–L＋年碼，沒有選擇權 strikePrice/callPut 或週契約換算。[broker.py:268](../../server/fubon_bridge/broker.py#L268) | FUT 讀真歷史；OPT 過去日期查詢多半因不支援轉換而拒絕，不可宣稱完整 OPT history | **微台抽樣正常**：當日／前一交易日 K 棒回 200 且非空；選擇權歷史 K 未驗收。 |
| M11 研究／學習歷史（使用[官方期權歷史 K](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/historical/candles/)） | 部分支援 | `/research/history` 可讀明確到期月；`research_candles`／`learning_candles` 使用 1 分 K，FUT 研究固定日盤，學習使用 `1!`。[broker.py:303](../../server/fubon_bridge/broker.py#L303)、[app.py:409](../../server/fubon_bridge/app.py#L409) | 只讀市場資料；不因下載／訓練直接變成券商交易 | **歷史研究讀取正常**：前一交易日 TMF＋2330 下載／暫存回 200；有效 dataset 的 latest 回 200，空 DB 回 400 為合理拒絕。未啟動 collect/train。 |
| M12 [市場快照、排行、分價量、52 週統計、技術指標、股務及籌碼](https://www.fbs.com.tw/TradeAPI/docs/market-data/http-api/getting-started/) | 不支援官方 API 轉接 | 沒有 intraday.volumes／snapshot.quotes,movers,actives／historical.stats／technical／corporate-actions／ownership 等路由；本地圖表指標不能等同官方 API。[app.py:608](../../server/fubon_bridge/app.py#L608) | 無這些富邦 API 轉接 | 靜態確認缺口 |
| M13 [期權歷史日行情、完整選擇權鏈與價差](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/historical/daily/) | 不支援 | 未呼叫 historical.daily；價差目錄被排除。[broker.py:182](../../server/fubon_bridge/broker.py#L182)、[app.py:608](../../server/fubon_bridge/app.py#L608) | 無日行情鏈／價差回放 | 靜態確認缺口 |
| M14 [WebSocket 其他頻道、模式與取消訂閱](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/websocket-api/getting-started/) | 部分支援 | 只允許 Tick/trades、BidAsk/books；無 aggregates／candles／模式切換入口。`/stream/unsubscribe` 回 success 但 `Broker.unsubscribe` 是刻意 no-op，直到服務重啟才釋放共用訂閱。[broker.py:402](../../server/fubon_bridge/broker.py#L402)、[broker.py:451](../../server/fubon_bridge/broker.py#L451) | 本機持續接行情；取消面板訂閱不表示取消富邦 upstream 訂閱 | 訂閱／取消訂閱 HTTP 回 200；取消是刻意 no-op，沒有真正釋放 upstream。其餘頻道與模式不支援。 |

## 文件與程式碼對照發現

### D1：股票 Tick 與期權 Tick payload 不同（已修正）

官方[股票 Trades](https://www.fbs.com.tw/TradeAPI/docs/market-data/websocket-api/market-data-channels/trades/)的 `data` 直接提供 `price/size/bid/ask/volume/time`；[期權 Trades](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/websocket-api/market-data-channels/trades/)則提供 `trades[]` 與 `total`。修正前 [mapping.py:108](../../server/fubon_bridge/mapping.py#L108) 與 [broker.py:470](../../server/fubon_bridge/broker.py#L470) 共同假設 `trades[]`。

**已確認映射錯誤**。本次驗證取得的真實 SDK `stock:trades` frame 同樣是平面資料，沒有 `trades[]`；SSE 觀察期間出現 `bidask_stk`，但未出現 `tick_stk`。把該 frame 離線重放至 `Broker._on_market` 後，`events=[]`、`paper.tick_calls=0`。因此修正前股票 Tick 與依賴該事件的後續 Paper 撮合不正常；此結論同時有官方介面、真實 frame 及離線重放證據，並非只因短時間沒等到行情。

修正後使用同一個 `market_trades` 正規化來源；已新增真實公開股票 frame 的回歸 fixture。真實行情再驗證與 browser/Paper 重放均通過，詳見修正後證據。

### D2：股票 MKP 在共用模型中可通過，但券商映射不完整（已修正）

修正前 [models.py:18](../../server/fubon_bridge/models.py#L18) 接受股票 MKP；[broker.py:567](../../server/fubon_bridge/broker.py#L567) 的股票映射只有 LMT/MKT。Paper 撮合僅對 LMT 檢查限價，[paper.py:127](../../server/fubon_bridge/paper.py#L127) 會把其他價格別作為非限價處理。官方[股票價格別](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/trade/PlaceOrder/)與[期權範圍市價](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/PlaceOrder/)應分開。

本次驗證另以完全離線 fake SDK HTTP app 重現：股票 MKP 通過模型後回 502，`order dispatch attempts=0`；沒有初始化真實 SDK 或登入。此項屬於**不支援組合的前置驗證缺口（已離線重現）**，與真實行情、HTTP 自選清單的兩項實測異常分開記錄。Paper 接受它不能當成官方支援；應在進入 SDK 前明確拒絕不適用組合，並使 Paper 規則一致。

修正後 `PlaceOrder` 在 HTTP 回 422，`Broker.place` 也在 Paper 或 SDK 執行前拒絕股票 MKP。期貨 MKP 仍可通過並在臨時 Paper 撮合；未進行真實委託驗收。

### D3：Paper 的多商品損益與成本模型有限

[mapping.py:69](../../server/fubon_bridge/mapping.py#L69) 只為 TXF/MXF/TMF 填已知乘數，其他商品未填；[paper.py:140](../../server/fubon_bridge/paper.py#L140) 回退乘數 1。預設成本只替已知指數期貨標記 configured，[paper.py:68](../../server/fubon_bridge/paper.py#L68)；股票與選擇權沒有完整費稅／權利金／履約模型。這是程式碼已確認的模擬範圍，不是官方對所有商品採用相同乘數或費率。使用其他商品的 Paper 數字前須另外定義商品規格與會計語意。

### D4：歷史 K 日期上限的邊界語意

官方[股票歷史 K](https://www.fbs.com.tw/TradeAPI/docs/market-data/http-api/historical/candles/)及[期權歷史 K](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/historical/candles/)要求單次區間**小於一年**。本機 [broker.py:239](../../server/fubon_bridge/broker.py#L239) 只拒絕日期差 `>365`，若全為過去日期，某些「恰好一年」的要求可能通過本機檢核後由官方拒絕。這不會產生交易，但不應把此邊界回應稱為 API 全面正常。

### D5：成功回應與實際完成的語意

`/auth/subscribe_trade` 只確認本機帳戶；`/stream/unsubscribe` 不向 upstream 取消；options roots 固定 TXO；`health.session_recovering` 固定 false。參見 [app.py:344](../../server/fubon_bridge/app.py#L344)、[app.py:354](../../server/fubon_bridge/app.py#L354)、[app.py:379](../../server/fubon_bridge/app.py#L379)、[broker.py:451](../../server/fubon_bridge/broker.py#L451)。這些回應只描述 adapter 行為；驗收應核對新行情、查詢資料來源與明確錯誤，不能以 HTTP 200 推論官方全部功能正常。

### D6：自選清單刪除與改名受 DELETE Content-Type 阻擋（已修正）

這是本機產品 API，不是富邦官方 SDK 功能。前端 [shioaji.ts:1641](../../src/lib/shioaji.ts#L1641) 呼叫無 body 的 `apiDelete`，[api.ts:444](../../src/lib/api.ts#L444) 修正前因而不送 Content-Type；後端 [app.py:134](../../server/fubon_bridge/app.py#L134) 對所有 DELETE 要求 `application/json`。本次驗證以相同請求方式確認回 415。

| 本機功能 | 支援程度 | 目前結果 |
| --- | --- | --- |
| 自選清單讀取／建立／同步 | 已有 GET／POST／PUT 轉接 | 實測範圍見下節；資料只存在記憶體。[app.py:579](../../server/fubon_bridge/app.py#L579) |
| 自選清單刪除 | 支援；已修正 | `apiDelete` 現在固定送 JSON Content-Type，無 body 仍可刪除。HTTP 與實際清單 UI 均通過；後端無 JSON 標頭仍回 415。 |
| 自選清單改名 | 支援；已修正 | 仍採建立新名稱再刪舊清單。瀏覽器以實際 client 與 UI 驗證：合約保留，舊 ID 刪除，新名稱唯一；隔離資料，無真人清單改動。 |

### D7：加入／移除自選商品缺少路由（已修正）

使用者補報 1802 加入失敗；`addWatchlistContracts`／`removeWatchlistContracts` 呼叫 `/watchlist/{id}/contracts`，修正前未提供 POST／DELETE 子路由而回 501。現已補齊 typed request、整批商品解析、去重與保序；清單變更共用鎖，移除不依賴行情可連線。HTTP 回歸確認無效批次不會留下部分新增，缺少清單回 404。真實 1802 商品在臨時清單加入／移除回 200；隔離實際 UI 新增、重新讀取、移除、再讀取亦通過。清單仍只存在服務記憶體，服務重啟不保留。

## 明確的 501 與拒絕分類

| 本機 API／請求 | 程式所定義的結果 |
| --- | --- |
| `GET /api/v1/auth/ca_expiretime` | 501：憑證效期不轉接 |
| `GET /api/v1/data/contracts/options` | 501：選擇權篩選不轉接 |
| `GET /api/v1/data/contracts/tick-bands/{rule}`，非 FUT/index | 501：商品跳動級距不轉接 |
| `POST /api/v1/stream/subscribe` 或 unsubscribe，`intraday_odd=true` | 501：零股即時行情不轉接 |
| 其他沒有明確路由的 `/api/*`（已授權且格式正確） | 501：一般 unsupported handler |
| 已知路由但模式、帳戶、日期或欄位不合法 | 可能是 400／422／409；不應統稱 501 或券商故障 |
| SDK／服務例外 | 通用 502；不暴露憑證與帳號細節；不代表可以直接重送未知結果的交易 |

來源：[app.py:217](../../server/fubon_bridge/app.py#L217)、[app.py:359](../../server/fubon_bridge/app.py#L359)、[app.py:383](../../server/fubon_bridge/app.py#L383)、[app.py:387](../../server/fubon_bridge/app.py#L387)、[app.py:485](../../server/fubon_bridge/app.py#L485)、[app.py:608](../../server/fubon_bridge/app.py#L608)。

## 初次實測證據（修正前）

測試時間：`2026-11-17T12:40:44.083636+08:00`（Asia/Taipei）。來源版本：`67769c19`。使用中的 Web dev App 為 `http://localhost:5784`／API `127.0.0.1:22584`，公開狀態確認 `mode=paper`；沒有切換成 live。

### 安全界線

- 真實富邦 SDK 只允許 `apikey_login`、行情初始化、callback 註冊、關閉及 `marketdata`。`stock`、`futopt`、`accounting`、`futopt_accounting` 等其他 SDK client 存取一律由 wrapper 攔截；本次攔截／嘗試存取清單為空，**券商交易呼叫為 0**。
- HTTP 功能檢查使用同版本程式建立的獨立本機 app、臨時 PasskeyStore 與臨時 ResearchStore／PaperStore。測試 session 僅屬此隔離 app；未繞過使用者目前服務的 Passkey。
- 股票與期貨的下單、改價、減量、取消及買賣平倉只改臨時 SQLite 帳簿，未向使用者的既有 Paper 帳簿送測試單。策略執行、訓練、收集、連線資料修改與模式切換不在本次線上操作範圍。
- 本次未呼叫真實帳務 client，因此股票庫存、銀行餘額、期貨權益與成交紀錄在矩陣中都明確區分「Paper 正常」與「券商未驗收」。

### 結果

共 **85 個測項：83 符合預期、2 個異常**。測項包含同一路由的不同市場／資料條件，以及預期的 401、403、400、501；這不是 85 個不同官方 API 的支援數。

| 類別 | 結果 | 實際證據 |
| --- | --- | --- |
| API Key／憑證登入 | 正常 | 正式 SDK 登入成功，回傳 3 個帳戶；無帳號個資存入本報告 |
| Paper 與授權邊界 | 正常 | `mode=paper`、`live_enabled=false`、`trading_environment=local`；無授權 401、外部 Origin 403 |
| 商品／報價 | 抽樣正常 | FUT/STK/OPT 目錄、TMF roots/filter、具體合約解析、三類快照 200 |
| 當日逐筆／K 棒／歷史研究 | 抽樣正常 | 股票與期貨最近逐筆、當日與前一完成交易日 K 棒、歷史研究下載與 latest 200 |
| 微台即時成交及五檔 | 抽樣正常 | 收到新 `tick_fop`、`bidask_fop` |
| 股票五檔（2330） | 抽樣正常 | 收到新 `bidask_stk` |
| 股票即時成交 | **異常** | 原始股票 frame 已到達，但沒有 `tick_stk`；離線重放為 `events=[]`、`paper.tick_calls=0`，見 D1 |
| Paper 下改刪、股票／期貨模擬買賣 | 正常 | 所有本機操作回 200；掛單取消為 Cancelled，IOC 買賣為 Filled，臨時帳簿最後無部位 |
| Paper 帳務與本機狀態查詢 | 正常 | 本機持倉、委託、餘額、權益、策略／研究／學習總覽可讀；不代表真實券商帳務 |
| 自選清單刪除 | **異常** | 與前端一致的 bodyless DELETE 回 415；加 JSON Content-Type／body 的對照請求回 200，見 D6 |
| 憑證效期、選擇權篩選、股票跳動級距 | 預期未支援 | 三項實測 501，沒有偽裝成成功 |

另有兩項集中重放，不計入上面的 85 個線上／HTTP 測項：

1. **股票 frame 離線重放**確認 D1 的映射與後續 Paper tick 遺漏，排除只因短時間無成交而未觀察到事件的解釋。
2. **完全離線 fake SDK 的股票 MKP 測試**回 502，`order_dispatch_attempts=0`，確認 D2 的前置驗證缺口；沒有真實 SDK 初始化或登入。

所有機器可讀狀態與測項列在 [api-health-check-2026-11-17.json](api-health-check-2026-11-17.json)。另外執行 `server/.venv/bin/python -m pytest server/tests -q`，結果 **276 passed**；此套隔離測試通過仍不能替代上述真實 payload 驗證。

## 修正後驗證

同日修正後重新執行 **90 個隔離 HTTP／真實唯讀行情檢查，90 通過、0 失敗**。新增 1802 加入／移除、股票 MKP 422、期貨 MKP 本機買賣與無 JSON 標頭 DELETE 415 的負向驗證；不能將數量解讀為 90 個官方 API。真實股票與期貨 Tick／五檔四種 SSE 都收到；SDK 交易／帳務 client 存取為 0。原始 85 項結果未覆寫。

另以 `scripts/verify-api-fixes.mjs` 啟動隔離真實 CLI 與瀏覽器，用臨時 Passkey／SQLite、虛擬驗證器及假行情，驗證：

- 實際 `useWatchlist` UI 建清單、加入 1802、重新讀取保留、移除、再讀取為空、改名及刪除；POST／DELETE 均回 200。
- 捕捉的公開股票平面 frame 經真正 Broker、SSE、瀏覽器 store；僅臨時 Paper 掛單成交，試撮不成交。期貨 trades 陣列與 MKP 保持正常。
- 股票 MKP 回 422，直接 Broker 也拒絕且帳簿不變；SDK constructor／交易 client／主機 Keychain／對外 socket 呼叫全為 0。
- 真實 CLI 經 Paper→demo→Paper 重啟三次；臨時 Passkey 重新解鎖成功，舊 session 回 401，瀏覽器 pageErrors 為空。QA 服務與瀏覽器已關閉。

完整 Python **287 passed**；前端 **5,953 passed、2 skipped**，`tsc -b` 與 Vite build 成功。獨立 QA 與兩軸程式審查結果另見修正證據。機器可讀結果：[api-fix-verification-2026-11-17.json](api-fix-verification-2026-11-17.json)。

## 可下的結論與保留事項

已修正股票 Tick、自選清單刪除／改名／新增／移除與股票 MKP 驗證；以上範圍在唯讀真實行情及隔離 Paper／瀏覽器均通過。其他矩陣中未支援或未驗收項目維持原分類；**不能宣稱全部富邦 API 正常**。真實下單、改刪、實際成交、券商帳務、圈存與匯撥仍未驗收，本次真實交易呼叫為 0。
