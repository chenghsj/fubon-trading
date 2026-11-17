# 原生面板 API 接線瀏覽器驗收

**PASS：71/71 checks，2026-11-17。** 本輪以真 CLI／FastAPI／Broker／NativePanels／React／headless Chrome 驗收；SDK 行情及券商唯讀方法均為 whitelist fixture，沒有真人券商連線或交易。

## 結果與來源

- Runner：`scripts/verify-native-panels.mjs`，JS 與內嵌 Python 語法檢查、diff whitespace 通過。
- Source：`2ee196785e9cfdd58f489950018e21a3ddef6716` 加本輪 native API／UI、chips wrapper、夜盤歷史參數與 WatchlistStore 工作樹；artifact `source-sha256.json` 記錄 15 個產品／runner 來源檔。
- Artifact：`/var/folders/9p/y1z7d0wd4033k52mhtfk2trc0000gn/T/fubon-native-panels-DwBJEP/artifacts`，含 `summary.json`、來源 hashes、43 張截圖（30 頁籤、9 個窄版、夜盤參數、隱私及既有停用 gate）。
- SDK constructor、未知 SDK client、Keychain、outbound、native SDK writes、write DTO calls 全部 **0**。Paper orders／positions 為空，自選寫入及交易 request **0**，最終 index leases／native IDs 為空。
- Page errors、source HTTP errors、native routes 的 501 全部 **0**。預期的合成來源失敗回 502，畫面有 error alert、沒有敏感 fixture 字串，後續成功查詢能恢復。
- 6188／22988 已無 listeners，browser 與本次建立的程序已清理。未接手真人 5784／22584、5179／21323 或真人 Chrome。

## 9 面板／30 頁籤實際查詢

每個頁籤均實際填表、點查詢、經 `/api/v1/native/query` 到正確 fake vendor 方法，再由原始結果產生畫面；不是 mock 前端結果或 native routes。30 個頁籤均有非空、原生形狀的回應。

| 面板 | 頁籤／operation | 實測內容 |
| --- | --- | --- |
| 資券與當沖配額 | 2：credit_margin、credit_daytrade | quota null 顯示無上限、成數 null 顯示停資／停券；可用額度 0 保留 0；預收 null 顯示不需預收。 |
| 券商交割與損益 | 4：settlements、realized、close_records、maintenance | 交割日期分開；0 與 null 不混用；成交股數 500 不換成 0.5 張；平倉原始 2 口不捏造配對損益；維持率 summary 與明細保留。 |
| 富邦智慧條件單 | 4：conditions、conditions、trails、conditions | 原生狀態「未生效(W)」、parent_guid null、子條件紀錄保留；包含期貨帳戶路徑。Paper 送出與取消停用。 |
| 法人與股權分布 | 4：institutional、director、etf、tdcc | 法人股數、月份／日期保留；ETF weight 58.82、quantityChange null；集保 proportion 84.67 不補成零或誤轉單位。 |
| 股務行事曆 | 3：dividends、capital、listings | 股票／市場及日期查詢實際通過；來源事件資料保留，未查詢日期不宣稱沒有事件。 |
| 富邦指標與統計 | 6：sma、rsi、macd、kdj、bb、stats | 暖機 null 保留；原生曲線可見；依序查 2330／2454，metadata 與 SMA 101.25／201.25 正確更新。 |
| 期權歷史日行情 | 2：daily、option_candles | 商品、月份、履約價／買賣權、日期實際傳到 native adapter；夜盤與選擇權的 null OHLC／成交量 0 不造數。 |
| 富邦指數行情 | 2：indices、index_quote | 官方 INDEX 形狀清單與 quote；清單點「查看指數」帶入 IX0001；原生租約及 SSE 另見下節。 |
| 進階委託工作台 | 3：order_history、batch_lists、order_history | 用對應券商查詢帳戶讀紀錄；Paper 複式／批次只檢核草稿，不送出。 |

實際 HTTP：native/accounts 19 次 200、native/attempts 14 次 200、native/query 42 次 200 與預期的 1 次 502、draft/validate 6 次 200、index subscribe 3 次 200、unsubscribe 2 次 200。

## Paper、安全與帳戶區隔

券商查詢帳戶由真 `/native/accounts` 回傳 fake `NATIVE-S`／`NATIVE-F`，與 `/auth/accounts` 的 `LOCAL` Paper 下單帳戶分離。面板選擇正確 raw account 的唯讀 SDK 方法，不把 Paper 帳號當成真券商帳戶。

六個可送出表單（股票／期貨多條件、TPSL、移動鎖利、複式、批次）均在 Paper 顯示停用的核對送出按鈕，草稿驗證實際 200 且 submitted=false；取消條件單按鈕亦停用。沒有發 native/action、一般下單或策略啟動請求。券商送出／取消與不確定請求核對的真實交易流程未執行，這輪不宣稱驗收完成。

實際開啟「設定 → 音效與隱私」，切換帳號遮蔽與金額遮蔽；native account 選項不再顯示完整 NATIVE-S／QA-S，原生已實現表格中的 500 股與金額遮蔽，關閉後可恢復。此過程只改本次臨時 browser 設定。

## 指數租約與 SSE

1. 第一面板訂閱 IX0001：真 native subscribe route → fake WebSocket subscribed ACK／snapshot → 真 publisher／HTTP SSE → 畫面收到 41,123.5，再收到 41,234.5。
2. 第二面板訂閱相同商品：兩個 lease 共用一條 native channel，沒有重複 subscribe；停止第一面板後第二面板仍收到 41,333.25。
3. fixture 觸發 stock socket disconnect；瀏覽器時鐘推進 30 秒觸發真 UI renewal，native socket 重新連線及訂閱，畫面收到 41,444.5。
4. 停止最後一個面板，lease／native ID 清零；之後注入行情不再呈現。

瀏覽器 clock 只用於加速定時 renewal，fake SDK 的 ACK／斷線與行情 frame 皆從臨時 QA fixture 注入，沒有連外。後端舊 socket late ACK／expiry 等細部安全案例另由獨立 native action／lease 測試涵蓋。

## 版面與舊驗收銜接

1600×1100 的 30 頁籤逐一截圖；390×844 的 9 面板均確認容器無意外橫向溢位（資料表內允許自身水平捲動）。12 類既有 unsupported 面板繼續驗證 library disabled、滑鼠／Enter／Shift+Enter 無法新增、無 live preview；還原舊工作區並刻意延遲 info 500ms，沒有呼叫原本不支援的 routes。

`verify-panel-apis.mjs` 原有「新九面板沒有 query／所有遠端按鈕停用」是前一階段版面驗收，現已不符合新實作；本 runner 取代那部分。舊 53 項結果仍是當時版本證據，不能拿來證明目前 API 接通。這輪保留 12 類停用回歸與基本 bootstrap，不重跑其餘不相干的舊 53 項。

## 修復紀錄與邊界

本輪發現停損停利／移動鎖利缺有效結束日，真 UI 產生 NativeAction 有 start、無 end，draft 回 422。主代理已補 end 欄，最終六個 UI 草稿全部通過。缺陷證據保留於 `fubon-native-panels-tfc7Mk/artifacts`。另曾修正 QA native account label matcher，並把 error assertion 從指定中文文案改為 HTTP 狀態與敏感資料遮蔽，這些屬 harness。

目前證據是接線、資料語意及隔離 UI 驗收。真人 Passkey／券商權限、實際帳戶資料、正式或 Sandbox 送單，以及委託成交／條件單生效均未驗證。所有金額與帳戶資料都是明確 fixture，不代表真實交易觀測。


## Chips wrapper 與夜盤歷史追補（71 項最終版本）

- `chips` 現已啟用，已從原停用 gate 移除；其餘 12 類 gate 冷啟動／鍵盤回歸繼續通過。
- 實際從商品搜尋切換股票 2330 → 2454：先把欄位改寫成 2303，再換商品，確認新 initialSymbol 2454 與清空的舊結果；各自真正點查詢並核對 native metadata.symbol。
- ETF 成分分頁維持獨立預設 0050，不繼承股票 2454。
- CDFK6／DVFK6 經實際 Broker 的 Products 映射產生 `underlying_kind=S` 及 `underlying_code=2330/2454`，chips 查正確股票，而非拿期貨代碼查法人資料。沒有在前端 fixture 塞入假 metadata。
- TXFK6 指數期貨顯示選股票提示，沒有 native ownership query。另以明確合成的負向 Products 測 I 型＋數字 underlying、S 型＋非股票碼 underlying，均不得誤查；兩個合成商品只存在本次隔離 vendor fixture。
- 選擇權歷史 K 實際選夜盤、5 分 K、賣權 P，核對真正 vendor `historical.candles` 參數：`product=TXO`、指定 `contractMonth`、`strikePrice=40000`、`callPut=PUT`、`session=afterhours`、`timeframe=5`。
- 全輪沒有舊籌碼 `credit_enquire`／`short_stock_sources`／`regulatory_punish` 呼叫，native routes 501 為 0。交易、SDK 初始化、DTO、Keychain、外連均為 0；Paper 日盤設定未被切換，本輪只測歷史查詢自己的夜盤參數，不執行 mode settings POST／重啟。

最終 artifact 以本報告上方 `fubon-native-panels-DwBJEP` 為準；保留先前 63 項版本作歷史證據。沒有未解的本輪 confirmed 缺陷，亦沒有將 fake 行情視為真人券商驗證。

最終 source freeze 後再執行同一 runner，仍為 71/71 PASS。新 CLI WatchlistStore 路徑額外加上 exact assertion，確認只寫入本輪 temporary/server/.watchlists.json；未驗證真人清單持久化，也未操作真人重啟。
