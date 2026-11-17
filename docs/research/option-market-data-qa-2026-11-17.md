# OptionCatalog／Scanner／分價量獨立 QA

驗證日期：2026-11-17。範圍為 `option_catalog.py`、`market_data.py` 及其 Broker／HTTP 接點；不驗仍施工中的 PortfolioData、Replay、市場概覽。已先完整閱讀 `docs/DEV.md`、`docs/RELEASE.md`。

## 來源與隔離

`server/tests/test_option_panel_integration.py` 內保留 2026-11-17 公開行情 probe 的小片段：TXO／TX4／TX1／DVO Products、TXO25200L6／TXO25200X6 Tickers、股票及微台分價量。來源檔為 `/private/tmp/fubon-panel-market-probe-20261117.json`。週契約／假日調整／個股 strike 及異常資料是明確標註的 mutation，不宣稱為當時實盤回傳。

全部測試使用假市場 client、固定臺北時鐘、臨時 SQLite／Passkey Store，以及本機 TestClient；未使用 SDK 登入、Keychain、真人服務、下單或帳務 RPC。

## 首輪結果

修正 fixture 覆寫寫法後執行 40 項：**28 passed，12 failed**。失敗均可由下方單一命令重現；沒有把 fixture 自身錯誤計入產品 findings。

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/server" server/.venv/bin/python -m pytest server/tests/test_option_panel_integration.py -q --tb=short -p no:cacheprovider
```

| Finding | 首輪證據 | 影響／接點 |
| --- | --- | --- |
| 冷查 option info 未將完整規格保留在 contract cache | `test_direct_option_info_leaves_complete_metadata_in_contract_cache`：info multiplier=50，但後續 `broker.contract()` 缺 multiplier | `broker.py` 冷路徑先快取、`contract_info()` 後載 Products；後續內部消費者拿到不完整規格 |
| 選擇權必要價位缺值被映射成 0 | 缺 referencePrice、limitUpPrice 或 limitDownPrice 的 3 個 mutation 均未拒絕，且發佈到 chain／catalog cache | `option_catalog.py` 批次轉換未檢查 mapping 前原始必要欄位 |
| HTTP 接受非有限／負履約價與不存在月份 | NaN、±inf、負下限，以及 202613／202600 等 6 個案例仍回 200 | `OptionCatalog.contracts()` 只檢查上下限順序與六位數格式 |
| 分價量缺少 contract 被當上游錯誤 | `{}` 回 502，預期為 400／422 | `app.py` `/api/v1/data/volumes` 直接讀 `body['contract']` |
| Scanner 混合不同交易日並快取 | TSE=2026-11-17、OTC=2026-11-16 仍合併且寫入 cache | `market_data.py` 僅解析日期，未驗證兩市場日期一致 |

## 已通過的邊界

- 月契約 C／P、strike、實際到期日、50 倍乘數與 standard metadata；缺 underlyingSymbol 保持未知，不猜成指數或期貨。
- 週 root 的數字代碼及 weekly metadata；假日調整後實際日期不被推成原定星期或週次。
- 個股選擇權採名稱中明示 strike，保留 Products 的 2000 倍乘數與股票 underlying；未知 scale 明確失敗。
- Options roots 排除 status U；hot chain 不重抓且回傳深複本；臺北換日重抓 Products／Tickers。
- 正常 HTTP filters、授權、無 vendor SDK 存取；非法 root／right／日期格式及不支援 weekday 篩選明確失敗。
- 期貨原生分價量沒有 bid／ask 時，兩者保留 null；絕不拆成 50/50。
- 股票 bid／ask 保留零值與未分類總量餘額；不強制填滿總量。
- 缺失、NaN、inf、負分價量與內外盤超過總量明確失敗。
- Scanner 先合併 TSE／OTC 再排序／limit，回傳不會修改快取；任一市場例外、缺 data 或日期格式失敗都不發佈／快取部分資料。

## 交付限制

此 QA 驗證 adapter 與 HTTP 邊界，不等於實體登入、完整商品 universe 覆蓋、盤中長時間前測或瀏覽器驗收。父代理負責產品修正與後續重跑；本 agent 僅新增本測試與報告，未修改產品檔案。

## 修正後最終複驗（2026-11-17）

父代理完成產品修正後，本 QA agent 獨立重跑兩份指定測試，結果為 **81 passed，0 failed**（40 項 Option／MarketData ＋ 41 項 Portfolio／Replay；0.48 秒）。這是本 agent 實際執行的結果，不以父代理的全套測試結果代替。

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/server" server/.venv/bin/python -m pytest server/tests/test_option_panel_integration.py server/tests/test_portfolio_replay_integration.py -q --tb=short -p no:cacheprovider
```

首輪 Option／MarketData 的 5 類 findings、12 個失敗案例全部修正：冷 contract cache 規格完整、缺必要價位明確拒絕、非有限／負 strike 與不存在月份拒絕、volumes 缺 contract 回輸入錯誤、scanner 不混合不同交易日。

後續獨立檢查 PortfolioData／Replay 的首輪結果是 32 passed／9 failed；以下 9 個失敗案例現均通過：

| 問題 | 失敗案例數 | 最終複驗 |
| --- | ---: | --- |
| 已設定成本的 Paper fill 缺 fee／tax 卻補 0 並宣稱完整 | 2 | 缺欄位明確失敗 |
| 期權缺 multiplier 卻默用 1 算損益 | 1 | 未知乘數明確失敗 |
| Native 股票損益缺代碼／負成交價仍回傳 | 2 | 身分與價格檢核通過 |
| AllDay 分頁部分重疊卻保留重複成交並宣稱完整 | 1 | 不再發佈重複完整逐筆 |
| Replay 接受 boolean price／size | 2 | 非數值成交欄位明確拒絕 |
| Demo 歷史日請求回當日逐筆並宣稱完整 | 1 | 日期不符明確拒絕 |

Portfolio／Replay 其餘已通過邊界包括：平均成本、部分平倉、反手費稅分攤、臺北跨日與期初成本延續、不同帳戶隔離、股票整股／零股成本基礎、native 損益來源日期涵蓋範圍誠實標示、501 筆 AllDay 分頁與 LastCount 分流、50,000 筆上限明確 limited／非完整、payload 日期／缺頁／重複頁不快取部分資料。

本輪未修改產品檔或測試斷言，只更新此 QA 報告。仍未執行實體 SDK 登入、Keychain、真人服務或交易；完整原生 API 面板鏈路不列為已驗收。父代理刻意保留的限速、WebSocket、逐筆來源缺口與停用狀態，不因隔離測試通過而視為已解決。
