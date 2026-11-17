# 面板 API 隔離瀏覽器驗收

**PASS：53/53 checks，2026-11-17。** 真正 CLI、FastAPI、Broker、市場 adapter、`shioaji.ts`、React 與 Chrome；只有 vendor 行情與公開名稱 feed 為合成 fixture。本報告不宣稱已接通真人富邦帳戶或新增面板的遠端 API。

## 結果與基準

- 腳本：`scripts/verify-panel-apis.mjs`；`node --check`、內嵌 Python compile、whitespace 檢查通過。
- Source 基準：`b7f1694acb129e502c84be7e13f98b10cb0121da` 加本次 Debug／權證搜尋 guard 工作樹。最終 artifact 的 `source-sha256.json` 記錄 14 個產品來源檔雜湊。
- Artifact：`/var/folders/9p/y1z7d0wd4033k52mhtfk2trc0000gn/T/fubon-panel-apis-7e1BnY/artifacts`，包含 `summary.json`、18 張新功能面板桌面／窄版截圖、排行榜、股期分價量與停用提示截圖。
- SDK constructor、交易／帳戶 client、Keychain、outbound socket 實測皆 **0**；Paper orders／positions 皆空，自選寫入及下單 request 皆 **0**。
- Browser page errors、source HTTP errors 皆空。外網全攔截；僅觀察到被攔的 Google Fonts 請求。
- 本次 `6189/22989` listeners 已清理，未接手或變更真人 `5784/22584`、`5179/21323`。

## 實測範圍

| 項目 | 實測結果 |
| --- | --- |
| 排行榜 | 六筆 TSE+OTC 合成價量，實際切換漲幅／跌幅／量／額／複選，逐列順序符合；複選做多／放空與量門檻切換正確。點列切換圖表商品，不新增自選。 |
| Scanner 邊界 | 指定歷史日期回 400；缺欄位資料不冒充 0 價候選；volume ratio、昨日量、tick_type、買賣價維持 null。 |
| 原生分價量 | 股票及期貨各 80 價位，HTTP 逐筆比對完整分布。股票未分類量保留；期貨 buy/sell 為 null，UI 顯示僅真實總量、兩側 bars 為 0，不補成 50/50。 |
| 選擇權 REST | Products+Tickers 合成月選兩到期、週選一到期，各 12 strikes × C/P；underlying、multiplier、currency 與 metadata 正確。month／C／strike range 交叉篩選五筆；未帶 security_type 的 code lookup 正確解析 OPT。 |
| 13 類停用 library | chips、warrants、combo、combolist、conditional、oddspread、heatmap、chainmap、holdingmap、pulse、signals、assistant、optchain。每類 disabled、有原因，滑鼠／Enter／Shift+Enter 均不能新增，無即時預覽按鈕或 live canvas。 |
| 舊工作區冷啟動 | 臨時保存 13 類舊面板，刻意延遲 `/info` 500ms 後 reload；所有 blocks 保留且顯示 gate，未發籌碼／權證／組合單／成分股／calculated index／scanner／option metadata 或 OPT 訂閱。基本主畫面的商品與 Paper bookkeeping 讀取另記錄於 artifact。 |
| 9 個新功能面板 | 全部可從 library 加入，reload 後九個 IDs／types 保留；所有功能頁籤、首次空白輸入、文字／數字／日期／select 可編輯；資料未知保留「—」，表格明示尚未接入。 |
| 條件單與月曆 | 條件列可新增、輸入、刪除第一列，第二列已輸入數值保留；僅一列時不能刪除。月曆為七欄，下月／上月切換可往返。 |
| 遠端停用與窄版 | 每個功能頁籤遠端按鈕 disabled，真滑鼠點擊不發送；互動期間 **0 data query、0 subscription start、0 submit**。1600×1100 與 390×844 均無面板或欄位橫向溢位。主畫面 `/info` 及既有 feed unsubscribe 清理保留於紀錄。 |

九個新面板：`fuboncredit`（2 頁）、`fubonaccount`（4 頁）、`fuboncondition`（4 頁）、`fubonownership`（4 頁）、`fuboncorporate`（3 頁）、`fubontechnical`（6 頁）、`fubonhistory`（2 頁）、`fubonindices`（2 頁）、`fubonadvanced`（3 頁），合計 30 個功能頁籤，兩種 viewport 均操作。

## Selectors 與隔離方式

新增面板 dialog「新增面板」、placeholder「搜尋面板（名稱或用途）」；library 卡片 `button[data-idx]`，停用需有 disabled 與 title「未支援：…」。面板 scope 取真 workspace 的 `data-block-id`。舊面板 gate 為 `[data-panel-unavailable="chips"]` 等各 type；新面板為 `[data-api-panel="fuboncredit"]` 等各 type，nav accessible name 為「面板名稱功能」，遠端按鈕 title 為「API 尚未接通」。條件區為 region「觸發條件草稿」，月曆為 region「股務月份行事曆」。

UI/API 使用獨立 `localhost:6189`／`127.0.0.1:22989`，占用即失敗。Virtual WebAuthn、Passkey、Research SQLite、Paper、mode settings、Vite cache 與 browser context 全部位於本次臨時目錄。環境只保留 PATH／暫存／locale；Config 直接建立，Vite 從空目錄讀設定，不載入使用者 `.env`。SDK constructor、Keychain、outbound、未知 SDK client 均 sentinel 禁止；Vite metadata 上游與 browser 外網及交易 mutation 另行攔截。finally 只停止本次建立的 process groups。

行情 fixture 參考經授權的公開 `/private/tmp/fubon-panel-market-probe-20261117.json` 原生欄位，腳本本身使用合成資料且不依賴該暫存檔；期貨 Products/Tickers 使用 repo 公開 fixture。沒有私人帳戶資料，到期日隨執行日產生。

## 曾發現並修復

1. CALL code 未帶型別時被當作 FUT，造成商品無法解析：父代理修正 inference；最終 REST resolve 回 OPT，回歸通過。最新範圍已停用整個 OptionChain，未再宣稱可用的完整 T 字面板。
2. server info 未就緒先掛載不支援面板，之後才顯示 gate：父代理加等待；最終強制 500ms 延遲冷啟動通過。
3. 新樣式 `& th` selector 使 vanilla-extract 失敗，月曆窄版溢位：父代理改正 globalStyle；最終確認 stylesheet 實際套用、七欄月曆與窄版幾何通過。

前期 artifact `OM6rBU`／`ublq9L`／`RU2aVo` 保留缺陷證據。QA 另外修正了空 trades fixture 的日期欄位，以及「切 tab 不應清空共用草稿」的驗收假設，這兩項屬 harness。

尚未驗收真人登入／券商資料、Paper PnL 全流程、Replay 大量分頁、個股即時分 K／產業資金流。新增九面板遠端功能仍明確停用，不能把本機表單通過算成 API 連接完成。


## 44 種面板 API 現況盤點（HEAD b7f1694a 加 follow-up 修正）

本節以 **2026-11-17 原始碼稽核** 起始，基準 `b7f1694acb129e502c84be7e13f98b10cb0121da` 加後續 Debug／權證搜尋 guard 修正；另完成 53 項隔離合成行情 E2E。只啟動自己的隔離 fixture，不讀 Keychain、不連券商、不啟策略或送單。53 項不能解讀為 44 個面板全部 API 已接通；目前真人 dev 仍待使用者 Passkey，沒有本次真人連線驗收。

分類共 44 種：**基本路徑齊備 3、部分接線 14、外部／本機 5、整體停用 13、新版面但遠端未接通 9**。「基本路徑齊備」只評現有正常 STK/FUT 市場的核心資料路徑，不表示全部商品、選項或真人券商操作已驗證。

證據代號：S＝目前原始碼連線與路由；I53＝本報告上方隔離 E2E；歷史實測不作當前真人連線證明。

### 基本 API 路徑齊備（3）

| BlockType／面板 | 依賴與證據 | 範圍 |
| --- | --- | --- |
| movers 排行榜 | `/data/scanner` → `MarketData.scan`；I53 五種模式與兩市場合併 | 僅最新快照，指定歷史日期明確拒絕。 |
| depth 五檔 | `/data/snapshots`、`/stream/subscribe` Tick/BidAsk → vendor quote/books → SSE；S | 一般 STK/FUT 五檔；不含獨立盤中零股市場。 |
| stockfutures 個股期選擇器 | FUT Products/Tickers、`/contracts/futures?underlying_code`、snapshots；S | 標的關係、月份與報價路徑已接；可選權證名稱來源已 guard。I53 重複共用目錄搜尋零 501，但非此專用面板全部操作實測。 |

### 部分接線（14）

| BlockType／面板 | 已接依賴 | 明確限制／缺口與證據 |
| --- | --- | --- |
| watchlist 自選清單 | `/watchlist` CRUD、商品解析、snapshots、Tick/BidAsk | 清單服務端在記憶體；共用搜尋的已知權證 501 已 guard。I53 選取不加自選及重複搜尋；前次自選 CRUD 隔離驗收。 |
| dock 持倉／委託／帳務 | `/order/trades`、`/portfolio/position_unit`、margin、account_balance；Paper 帳簿 | 銀行交割、交易額度、預收券款與圈存已停用；券商歷史 PnL 不完整。Paper 損益 routes 已接，非真實完整帳務。S。 |
| chart K 線圖 | `/data/kbars`、snapshots、Tick/BidAsk；本機指標 | 歷史轉換主要 STK／一般字母 root FUT；OPT 歷史、含數字 root 不完整；觸價／自動保護停用。S。 |
| intraday 當日走勢 | 相同 kbars + Tick 路徑 | 受歷史商品／日期／盤別能力限制；不能代表任意商品的完整歷史服務。S。 |
| intradaywall 當日走勢牆 | `/watchlist`、批次 snapshots、每檔 kbars + Tick | 同基本行情限制；不是 `/stream/subscribe/kbars` 能力訂閱。S。 |
| ticket 下單面板 | `/order/place_order`、trades、改價／減量／取消與帳戶、報價 | STK 現股／具體月 FUT；信用、OPT、成交後自動保護不支援。盤中零股選項仍會要求未接的零股行情（specific 501）。未真人下單。S。 |
| tape 成交明細 | `/data/ticks` LastCount + SSE Tick | 最新交易日最多 500 筆初載；不是個人券商成交，來源未提供完整買賣分類／掛單量。S。 |
| flash 閃電下單 | 同基本委託／五檔 routes | OPT 交易 gate；零股行情 specific 501；信用與本機觸價／保護能力不能視為已支援。未真人下單。S。 |
| volprofile 分價量表 | `/data/volumes` → vendor intraday.volumes；I53 股／期各 80 價位 | 原生全分布已接；期貨來源只有總量，buy/sell null，UI 正確揭露不分類。 |
| replay 行情回放 | `/data/ticks` AllDay → native 500 筆分頁 | 僅來源目前交易日，上限 50,000，含 complete／limited；不是任意日期歷史逐筆服務。S。 |
| depthmap 委託簿熱圖 | 收到的 BidAsk SSE、本機累積 | 自開啟起收集，沒有歷史委託簿回補。S。 |
| debug 診斷 Debug | info／health、前端 heartbeat／events | info/health 與本機連線診斷保留；未接的券商配額／ServerMonitor 已 guard 並提示停用。I53 真 Debug 冷／暖 info 均零 monitor query，仍不是完整 API 用量監控。 |
| grid 鋪單 | 多筆 `/order/place_order` 與一般委託查改撤 | 逐筆委託非原子批次；OPT gate，盤中零股仍要求未接行情。未執行鋪單或真人單。S。 |
| autotrade 自動交易 | `/automation/state/start/heartbeat/control`、Research、Paper ledger | 僅 Paper／Sandbox 可用；demo/live 停用；本次未啟策略，不能視為正式自動交易或績效證明。S。 |

### 外部資料／本機功能（5）

| BlockType／面板 | 實際來源 | API 判讀 |
| --- | --- | --- |
| pnl 損益分析 | `/portfolio/profit_loss` → durable Paper fills 平均成本損益 | Paper/demo 本機報表；live/sandbox 面板停用，不是完整券商歷史 PnL。S。 |
| company 公司資料 | 外部公開 company-data、metadata；基本報價共用 | 不是富邦公司財報 API，未重新驗證外部每檔資料。S。 |
| notices 通知中心 | 本機 notice log／事件 | 不需要富邦查詢，不代表所有券商回報均已轉接。S。 |
| optpnl 選擇權損益圖 | 本機 payoff + 持倉 + 合約 + TXFR1 quote | 到期試算，非官方損益 API；OPT 真實完整持倉未驗收。S。 |
| backtest 策略回測 | 此 Web 無私有模組時用 IntradayResearchPanel；`/research/*` + SQLite + 本機 worker | 歷史取得有行情依賴，研究／回測在本機；不能宣稱私有完整回測模組或績效有效。S。 |

### 整體停用（13）

共同證據：`src/lib/fubon-support.ts:11-24` 的 gate、`App.tsx:289-300` 啟動等待／placeholder、library activate 與 live preview guard；I53 已驗 mouse／Enter／Shift+Enter、還原冷啟動與無 unsupported request。

| BlockType／面板 | 未接依賴／停用原因 |
| --- | --- |
| chips 籌碼資訊 | credit_enquire、short_stock_sources、完整 regulatory_punish。 |
| warrants 權證篩選器 | 完整 warrants／underlyings。 |
| combo 組合單 | 組合解析、原子複式委託。 |
| combolist 組合商品 | combo/futures 列表及組合報價。 |
| conditional 條件單管理 | 富邦觸價、成交後停損停利／括號保護。 |
| oddspread 整零價差 | 盤中零股行情與兩腳自動執行。 |
| heatmap 產業全景 | 完整 index_components／contribution。 |
| chainmap 產業鏈資金流向 | 即時一分鐘 K 資金流訂閱；外部題材資料不能替代。 |
| holdingmap 持股族群 | 持倉已有路徑，但族群即時資金流未接。 |
| pulse 市場脈動 | calculated_index 與完整成分股貢獻。 |
| signals 即時訊號 | 市場 scanner 訊號訂閱。 |
| assistant AI Agent | 此 Web 沒有私有 Agent 模組。 |
| optchain 選擇權 T 字 | REST metadata 已接；完整即時 T 字訂閱釋放／速率／交易級距未完成。 |

### 新功能版面已建立、遠端 API 未接（9）

共同證據：`FubonApiPanel` 明確無 requests hooks，`fubon-api-panel.tsx:105-135` 的未知資料、停用 query／subscribe／submit；I53 只證實本機頁籤／表單／條件列／月曆與儲存，不是 API 開通。

| BlockType／面板 | 尚未接通的官方能力 |
| --- | --- |
| fuboncredit 資券與當沖配額 | MarginQuota、DaytradeAndStockInfo。 |
| fubonaccount 券商交割與損益 | QuerySettlement、完整證券損益、期權平倉紀錄與信用維持率。 |
| fuboncondition 富邦智慧條件單 | 多條件、TPSL、移動鎖利、期貨條件單。 |
| fubonownership 法人與股權分布 | 法人買賣、董監、ETF holdings、TDCC。 |
| fuboncorporate 股務行事曆 | 除權息、資本變動、上市櫃申請。 |
| fubontechnical 富邦指標與統計 | 官方 SMA／RSI／MACD／KDJ／BBANDS／統計，與本機圖表指標分開。 |
| fubonhistory 期權歷史日行情 | 原生跨月 daily／指定選擇權歷史 candles 查詢。 |
| fubonindices 富邦指數行情 | 官方 INDEX 清單／指數 WebSocket。現有 IND catalog 回空，不可當已支援。 |
| fubonadvanced 進階委託工作台 | 原生複式、批次委託、委託歷程。 |

### Confirmed 缺口修復與剩餘限制

1. **Debug 通用 501 已修復**：原先無條件 ServerMonitor 會查 auth/usage、monitor/metrics、monitor/subscriptions；現在已知 Fubon 顯示停用說明，未知 identity 等待。I53 真 Debug 面板包含冷 info 刷新，全輪對上述 routes **0 request**。
2. **共用商品目錄／權證搜尋通用 501 已修復**：原先 stock-index 可選名稱與 includeWarrants 分支會呼叫未轉接路由。現在 `fetchWarrants`／`fetchWarrantUnderlyings` 共用 identity-aware guard，未知 identity 先讀 info 並保留 AbortSignal；Fubon 返回空權證來源，不呼叫不存在的 route。I53 cold info + 四輪 palette（2330／2454／聯發科／2330）完整結束，全輪 `/contracts/warrants*` **0 request**，基本股票及期貨結果保留。
3. **仍保留：啟用交易面板的零股子選項**。`order-ticket.tsx:111-112`、`flash-order.tsx:697`、`grid-ticket.tsx:155` 仍可建立 oddLot quote；`app.py:508` 明確回「零股即時行情尚未轉接」501。這是 specific limitation，不是 generic route 缺失；停用整零價差不會停用這些子選項。依目前原始碼列為部分支援，沒有執行任何下單來驗證。

新增 I53 artifact：`/var/folders/9p/y1z7d0wd4033k52mhtfk2trc0000gn/T/fubon-panel-apis-7e1BnY/artifacts`。SDK constructor、交易 client、Keychain、outbound 皆 0；Paper orders／positions 皆空；source/page errors 皆空；只有本次隔離程序曾啟動且已清理。此 follow-up 只改 QA 腳本與報告，產品修正由主代理完成。
