# 面板 API 隔離瀏覽器驗收

**PASS：46/46 checks，2026-11-17。** 真正 CLI、FastAPI、Broker、市場 adapter、`shioaji.ts`、React 與 Chrome；只有 vendor 行情與公開名稱 feed 為合成 fixture。本報告不宣稱已接通真人富邦帳戶或新增面板的遠端 API。

## 結果與基準

- 腳本：`scripts/verify-panel-apis.mjs`；`node --check`、內嵌 Python compile、whitespace 檢查通過。
- Source 基準：`895949b2202ad25cda652fbdd1f855746982353d` 加本輪工作樹。最終 artifact 的 `source-sha256.json` 記錄 12 個產品來源檔雜湊。
- Artifact：`/var/folders/9p/y1z7d0wd4033k52mhtfk2trc0000gn/T/fubon-panel-apis-GcxgAR/artifacts`，包含 `summary.json`、18 張新功能面板桌面／窄版截圖、排行榜、股期分價量與停用提示截圖。
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
