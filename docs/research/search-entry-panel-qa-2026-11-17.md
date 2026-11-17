# 商品搜尋入口與面板搜尋 QA

狀態：實測 PASS，54 項檢查，程序 exit 0。包含最後的「Escape 後同值點擊重開」修正。

最後 source 基準：`3962cfa76662531e27c00b2e37f3ce30b81cdc90` 加本輪工作樹變更（畫面識別 `3962cfa7+dirty`）。
完成驗收後 `git diff HEAD -- src` 的 SHA-256：`06dcb830f015037fb31cdde13a30d917748e2170958e6600253b386510079112`。

## 範圍與隔離

- 腳本：`node scripts/verify-futures-search.mjs`，延續原有六項股票／期貨搜尋驗收。
- 本輪 UI/API：`localhost:6190`／`127.0.0.1:22990`。啟動前確認 free，不接手既有端點。
- 實際 frontend、HTTP app 與 Broker；只有 vendor market client 和公開名稱來源使用 fixture。
- Passkey、SQLite、Paper 帳簿及 Vite cache/env 均位於臨時資料夾。
- SDK 建構、交易 client、Keychain 與 outbound socket 皆 sentinel；瀏覽器攔阻送單 mutation 與外網。
- 不操作真人瀏覽器，不讀寫 `localhost:5784`／API `22584`。

## 已通過的驗收矩陣

| 流程 | 預期結果 |
| --- | --- |
| 頂列「搜尋商品」 | 按鈕可見，開啟既有「搜尋商品與面板」dialog，焦點進入 combobox |
| 商品代號／中文名稱／股票代號 | 2330、聯發科、2454、CDFL6 可搜尋及選取；2454 能列出相關一般／小型近次月期貨 |
| 快速搜尋選取 | 只切換商品；每步 GET watchlists 完全不變，watchlist mutation 數不增加 |
| Modal 幾何 | 約 32rem 寬、水平置中，保留最多 18vh 的頂部間距；1440、390、320、640×320 視窗均不橫向溢出或跨滿畫面 |
| 暗／亮主題 | 上述四種視窗尺寸均能看見鍵盤選取列，Escape 關閉 |
| 搜尋欄位對齊 | 可見的股票／期貨 badge x 與寬度相同，右方 detail／月份欄 x 相同；窄版依法隱藏的 metadata 另行記錄 |
| Modal input 焦點 | 實際 focus 時 boxShadow 為 none、borderRadius 為 0；上／左／右無整圈 border，底部細線保留 |
| 鎖定面板搜尋 | 真正 inline combobox 可用中文名稱選取期貨，workspace pin 更新；一般寬度約 96–180px |
| 群組搜尋 | 兩個面板加入 A；用股票代號搜尋相關期貨，選取後兩者共用的新商品一致 |
| 建議 portal | popup 在 panel 外，320／240／200／135px 面板的建議不受 panel clipping，保持於 viewport |
| Ctrl+N／Ctrl+P | Palette、鎖定欄與自選三個入口逐列前後移動並繞回起點，aria-selected 與 aria-activedescendant 一致 |
| IME／Escape | composition 期間 Enter/Escape 不套用；Ctrl+N/P 不攔截、不換選取列；結束後 Escape 不更動目前商品、pin/group、workspace 或自選清單 |
| 交易隔離 | mutation requests 為空，Paper orders/positions 為空，SDK／Keychain／outbound 計數為 0 |

## 實際選擇器與 fixture 操作

- 頂列 button accessible name：`搜尋商品 ⌘K`，使用 `^搜尋商品(?:\s|$)` 選擇器。
- 既有 dialog accessible name：`搜尋商品與面板`。
- Palette input：combobox `搜尋商品或面板`。
- 一般鎖定使用 `data-block-id="chart-0"` 與 card header 內的 combobox；一般面板以直接的「連動／鎖定」按鈕切換。
- 群組只在實際支援群組的 flash 面板驗收：透過隔離 UI「新增面板」建立兩個 flash，記錄動態 block ID，以 header 的 `button[aria-haspopup="menu"]` 選擇群組 A；完成後移除本次建立的面板。
- Panel input：`搜尋鎖定商品`／`搜尋群組 A 商品`，placeholder `代碼／名稱`。
- Panel listbox：`${label}搜尋結果`。
- 建議列表透過 combobox 的 `aria-controls` 追蹤，不依賴生成 CSS class。

## 結果

最終 artifact 目錄：`/var/folders/9p/y1z7d0wd4033k52mhtfk2trc0000gn/T/fubon-futures-search-gzMjOP/artifacts`。

- `summary.json`：54 項檢查與幾何、CSS、HTTP、計數證據。
- `palette-深色-1440x1050.png` 等八張 modal 截圖：暗／亮各四種視窗大小。
- `inline-panel-320.png`、`inline-panel-240.png`、`inline-panel-200.png`、`inline-panel-135.png`：真實群組 combobox 與 portal。
- `watchlist-remove-深色.png`、`watchlist-remove-淺色.png`：僅 hover，不刪除資料。

實測補充：

- 頂列四次商品選取、pin 與 group 選取均只切換商品；GET watchlists 完全不變，沒有增加 watchlist mutation。
- Modal 使用真實 rem（18.4px），32rem 為 588.8px；水平置中，手機及短視窗均在邊界內。焦點輸入框 `boxShadow: none`、`borderRadius: 0px`，只有 1px 底線。
- 可見五列股票／期貨 badge x、badge width、detail x 一致；窄版依法隱藏的 metadata 記錄為隱藏，不誤判為視覺欄位。
- Pin 欄位一般寬度 147.2px；兩個 flash 的群組 A 透過股票代號搜尋並同步切換至 PUFK6。
- 三入口 Ctrl+N/P 每一步均核對 ARIA 並繞回；另外連續送出 N、P（中間不等待 DOM）也回到原列。
- IME 以瀏覽器 composition 事件 fixture 驗收：Ctrl+N/P 不攔截，Enter/Escape 不切換或送單；未把它當作實體輸入法驗收。
- 240／200／135px 群組欄位在 Escape 後保留 2330，直接點擊同一個仍 focused 的欄位即可 `aria-expanded=true`；沒有清空再填。
- 深色移除鈕底色 `rgb(61,61,58)`，淺色 `rgb(255,255,255)`；X 為 `lucide-x`、`fill:none`，stroke 與底色不同。沒有點擊移除鈕。

隔離結果：`sdkCalls=0`、`sdkTransactions=0`、`keychainCalls=0`、`outboundCalls=0`；交易 mutation requests 為空，Paper orders／positions 為空，pageErrors 為空。
本次允許的 vendor fixture 讀取為 Products 2、Tickers 3、Ticker 100、Quote 25，WebSocket fixture connect 2；不代表真實券商連線。

執行後隔離 Chrome、Vite 與 API 均已關閉；`6190`／`22990` 沒有 LISTEN 程序。未操作真人 Chrome、`5784`／`22584` 服務、帳簿或 session。
