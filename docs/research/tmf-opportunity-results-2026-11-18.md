# TMF 每分鐘動作價值研究結果（2026-11-18）

**已改善訊號與模型篩選並完成歷史訓練／回測；本輪沒有通過條件的獲利策略。**
日／夜盤各36項政策，開發與後段資格通過皆0；`selected=null`。
所有模型均為離線診斷，Paper維持停止，未啟動／替換計畫或送出委託。

## 本輪改進

- 從必須突破／邊緣返回的稀疏事件，改成第66分鐘起每分鐘四個多空／退出方案動作，另可等待。
- 加入MACD、RSI、KD、布林帶、VWAP與已收盤1／3／15分鐘結構；不使用未收盤較大週期或未來行情。
- 直接預測扣費稅滑價後淨收益；各開盤日訓練總權重相等，避免重疊分鐘誤當獨立樣本。
- 每次fit的晚20%獨立校準，日群聚計算平均淨利減一個標準誤；沒有足夠日數或正邊際便拒絕。
- 每分鐘只按當時預測排序，同分鐘四動作鍵與特徵均不同；延遲不換訊號、不延長期限。
- 零交易與不合格候選不再能被選為模型；資格只看開發折，後段無法翻案。

完整預先規格見 [凍結研究規格](tmf-opportunity-protocol-v1.md)。
scalp／swing指短／長退出方案，並不等於已辨認出盤整／趨勢的市場狀態。

## 日期與真實訓練量

| 盤別 | 開發 | 驗證 | 已重用歷史測試 | 最終訓練／校準動作標籤 |
|---|---|---|---|---|
| regular | 2024-07-29～2025-12-10（318日） | 2025-12-11～2026-06-03（106日） | 2026-06-04～2026-11-16（106日） | 213,098／53,760 |
| afterhours | 2024-07-31～2026-03-18（237日） | 2026-03-19～2026-07-15（79日） | 2026-07-16～2026-11-13（79日） | 566,382／143,601 |

此處標籤是重疊的反事實動作，不是成交數；兩個複雜度各用同一組標籤訓練。
三個發展折、各折兩模型，以及每盤最終兩模型，共完成16次LightGBM擬合；
最終模型保持訓練時的booster，沒有在校準後重新fit。
所有歷史已被前幾輪研究看過，這次切分仍不是全新樣本外證據。

## 固定0元門檻的混合方案

表內均扣每口每邊20元費用、2點滑價、逐邊交易稅；金額為NTD。
壓力情境每邊額外2點；延遲情境下一分鐘再晚1分鐘進場。

| 盤別／模型 | 驗證成交／淨利 | 驗證壓力／延遲 | 測試成交／淨利 | 測試壓力／延遲 |
|---|---:|---:|---:|---:|
| regular／small | 16／-3,501 | -3,841／-3,791 | 24／+5,488 | +5,208／-926 |
| regular／flexible | 32／+3,518 | +1,958／-2,860 | 50／-4,682 | -7,224／-2,330 |
| afterhours／small | 6／-228 | -368／-1,856 | 8／+1,362 | +2,218／+2,256 |
| afterhours／flexible | 31／+1,396 | -3,926／-2,036 | 24／-2,324 | -2,814／-3,434 |

所有校準政策在後段均0成交；最終兩盤、兩模型各有12個足夠日數的校準箱，
但沒有任何箱的保守淨收益大於0。等待不算獲利策略，也沒有被選中。

## 正收益為何仍不能採用

- 日盤small原始分數0元混合：測試24筆 **+5,488**、壓力 **+5,208**，但驗證 **−3,501**、測試延遲 **−926**，開發亦未通過。
- 夜盤flexible原始分數30元短方案：驗證13筆 **+2,030**、測試11筆 **+170**；測試壓力 **−50**、延遲 **−942**、移除最佳日 **−402**。
- 夜盤flexible原始分數60元短方案：驗證6筆 **+736**、測試8筆 **+62**；測試壓力 **−98**、移除最佳日 **−302**。

後兩項只是完整診斷中看見的正收益，沒有據此選取門檻或晉升模型。
模型的訊號邊際仍不足以穩定支付成本；不是因為沒有歷史資料可供訓練。
把不合格分數放寬成更多委託不能改善這個證據。

## 全部72項政策摘要

正常成本下的驗證與測試全部列出；三情境、交易明細與失敗原因保存在本機完整JSON，
平面432列結果在 `.fubon-dev/reports/opportunity-actions-v1/all-policies.csv`。

| 盤別 | 政策 | 開發合格 | 驗證筆數／淨利 | 測試筆數／淨利 | 後段門檻通過 |
|---|---|---|---:|---:|---|
| regular | small-raw-0-hybrid | 否 | 16／-3,501 | 24／+5,488 | 否 |
| regular | small-raw-0-scalp | 否 | 16／-2,786 | 29／-5,860 | 否 |
| regular | small-raw-0-swing | 否 | 13／-1,023 | 11／+2,636 | 否 |
| regular | small-raw-30-hybrid | 否 | 7／-3,863 | 9／-1,274 | 否 |
| regular | small-raw-30-scalp | 否 | 6／-3,048 | 17／-810 | 否 |
| regular | small-raw-30-swing | 否 | 5／-2,033 | 7／-1,132 | 否 |
| regular | small-raw-60-hybrid | 否 | 2／-1,498 | 3／-2 | 否 |
| regular | small-raw-60-scalp | 否 | 3／-2,374 | 8／+64 | 否 |
| regular | small-raw-60-swing | 否 | 2／+22 | 3／-2 | 否 |
| regular | small-calibrated-0-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| regular | small-calibrated-0-scalp | 否 | 0／+0 | 0／+0 | 否 |
| regular | small-calibrated-0-swing | 否 | 0／+0 | 0／+0 | 否 |
| regular | small-calibrated-30-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| regular | small-calibrated-30-scalp | 否 | 0／+0 | 0／+0 | 否 |
| regular | small-calibrated-30-swing | 否 | 0／+0 | 0／+0 | 否 |
| regular | small-calibrated-60-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| regular | small-calibrated-60-scalp | 否 | 0／+0 | 0／+0 | 否 |
| regular | small-calibrated-60-swing | 否 | 0／+0 | 0／+0 | 否 |
| regular | flexible-raw-0-hybrid | 否 | 32／+3,518 | 50／-4,682 | 否 |
| regular | flexible-raw-0-scalp | 否 | 31／+1,248 | 50／-1,832 | 否 |
| regular | flexible-raw-0-swing | 否 | 25／-7,034 | 27／-7,192 | 否 |
| regular | flexible-raw-30-hybrid | 否 | 20／-2,087 | 27／-3,106 | 否 |
| regular | flexible-raw-30-scalp | 否 | 19／-3,016 | 27／-7,392 | 否 |
| regular | flexible-raw-30-swing | 否 | 14／-6,143 | 13／+3,660 | 否 |
| regular | flexible-raw-60-hybrid | 否 | 10／-2,961 | 15／-920 | 否 |
| regular | flexible-raw-60-scalp | 否 | 11／-1,986 | 20／-5,026 | 否 |
| regular | flexible-raw-60-swing | 否 | 6／-2,849 | 7／+1,470 | 否 |
| regular | flexible-calibrated-0-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| regular | flexible-calibrated-0-scalp | 否 | 0／+0 | 0／+0 | 否 |
| regular | flexible-calibrated-0-swing | 否 | 0／+0 | 0／+0 | 否 |
| regular | flexible-calibrated-30-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| regular | flexible-calibrated-30-scalp | 否 | 0／+0 | 0／+0 | 否 |
| regular | flexible-calibrated-30-swing | 否 | 0／+0 | 0／+0 | 否 |
| regular | flexible-calibrated-60-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| regular | flexible-calibrated-60-scalp | 否 | 0／+0 | 0／+0 | 否 |
| regular | flexible-calibrated-60-swing | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-raw-0-hybrid | 否 | 6／-228 | 8／+1,362 | 否 |
| afterhours | small-raw-0-scalp | 否 | 6／-408 | 10／+1,448 | 否 |
| afterhours | small-raw-0-swing | 否 | 5／-780 | 8／-1,768 | 否 |
| afterhours | small-raw-30-hybrid | 否 | 0／+0 | 3／-2,052 | 否 |
| afterhours | small-raw-30-scalp | 否 | 1／-798 | 1／-558 | 否 |
| afterhours | small-raw-30-swing | 否 | 0／+0 | 3／-2,292 | 否 |
| afterhours | small-raw-60-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-raw-60-scalp | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-raw-60-swing | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-calibrated-0-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-calibrated-0-scalp | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-calibrated-0-swing | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-calibrated-30-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-calibrated-30-scalp | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-calibrated-30-swing | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-calibrated-60-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-calibrated-60-scalp | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | small-calibrated-60-swing | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | flexible-raw-0-hybrid | 否 | 31／+1,396 | 24／-2,324 | 否 |
| afterhours | flexible-raw-0-scalp | 否 | 32／+848 | 25／-1,892 | 否 |
| afterhours | flexible-raw-0-swing | 否 | 23／+76 | 23／-7,447 | 否 |
| afterhours | flexible-raw-30-hybrid | 否 | 10／-336 | 10／+148 | 否 |
| afterhours | flexible-raw-30-scalp | 否 | 13／+2,030 | 11／+170 | 否 |
| afterhours | flexible-raw-30-swing | 否 | 3／-1,166 | 9／-86 | 否 |
| afterhours | flexible-raw-60-hybrid | 否 | 4／+672 | 5／-426 | 否 |
| afterhours | flexible-raw-60-scalp | 否 | 6／+736 | 8／+62 | 否 |
| afterhours | flexible-raw-60-swing | 否 | 1／-574 | 5／-1,656 | 否 |
| afterhours | flexible-calibrated-0-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | flexible-calibrated-0-scalp | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | flexible-calibrated-0-swing | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | flexible-calibrated-30-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | flexible-calibrated-30-scalp | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | flexible-calibrated-30-swing | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | flexible-calibrated-60-hybrid | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | flexible-calibrated-60-scalp | 否 | 0／+0 | 0／+0 | 否 |
| afterhours | flexible-calibrated-60-swing | 否 | 0／+0 | 0／+0 | 否 |

## 重現與稽核

研究快照為既有 `server/.research.sqlite3`，以SQLite唯讀方式載入並核對原始資料雜湊；
未將私人行情資料或模型上傳GitHub。下列指令在已安裝learning相依的本機環境執行：

```sh
PYTHONPATH=server server/.venv/bin/python scripts/research-opportunities.py --stage development
PYTHONPATH=server server/.venv/bin/python scripts/research-opportunities.py --stage evaluation
```

工具拒絕覆寫既有結果；重跑需保留舊目錄並指定新研究版本，不能悄悄覆蓋失敗嘗試。
資料、精確日期、程式、預先規格、套件、原生模型及校準表均凍結：

- Frozen ID：`03f7b51ee3632976c091b7ed4560784803de2766b45ed46f47e5083147e0f4b4`。
- regular dataset：`174c84f706de0f6682f92c14a6bb15bb80943713c1090438994cafc2a19295df`。
  - small 原生模型 SHA256：`a0e14d488648579ee0edc68f44105bc585fc73a9ad02b09681d39430fc8c6c14`。
  - flexible 原生模型 SHA256：`8b3228f562d2cab6c5f9d0fed889e33bd042ddc1e9bb916af3a5f67978db4ec7`。
- afterhours dataset：`fbdbf1af1eacfb4e6c3b083b15b548e0de3caa0437e3da26227625248107e6a2`。
  - small 原生模型 SHA256：`b51a1a3ce98446f6bc2cbf74215a33d3e0c73aee9d74a8ca4eb58d9986c2ea39`。
  - flexible 原生模型 SHA256：`9f507b10e9420c5a6af8b552f8728ccef568ba2e8b62b1e9368d68cd6ed0622f`。

## 驗證與限制

- 新增9個功能測試通過：完整棒／因果特徵、四動作唯一鍵、成本與跳空、延遲期限、虧損預算、按當刻分數選擇、日校準、原生模型重載、不合格不選與後40%改價量不影響開發。
- 獨立QA通過；另驗證只改校準段時booster位元組不變、校準表改變。
- 最後全套後端1082通過；前端6076通過、2略過；tsc -b與Vite build通過。
- 前端HTTP測試需本機監聽權限；沙箱初跑失敗後在允許本機測試連線的環境全套通過。
- 首次後端全套遇既有NativeAttempts雙Store初始化WAL競態；該模組未修改，單獨23項與最後全套均通過，保留失敗日誌。
- 本輪僅改離線工具與文件，沒有將動作價值模型接進Paper引擎。
- 交易費用為假設，歷史來源尚未與第二資料源核對；分鐘OHLC無法證明逐筆可成交價。
- 最大回撤以分鐘收盤估值，不代表盤中最低浮虧；跳空可超過估計風險。
- 校準日數與標準誤不能消除序列相關、多重嘗試及市場變化；沒有報稱找到可保證獲利的模型。

後續有價值的研究方向是補齊可驗證的買賣價差／深度與逐筆成交資料、
檢查不同波動／流動性時段的可成交邊際，再另行預先凍結新假設；
本輪結果不支持繼續堆相同價格指標或放寬閾值就啟動交易。
