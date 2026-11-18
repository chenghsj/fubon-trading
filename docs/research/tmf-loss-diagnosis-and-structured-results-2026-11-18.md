# TMF 主要虧損原因與結構訊號重測（2026-11-18）

**完成虧損歸因、調整訊號與模型並重跑；沒有找到通過穩健性門檻的獲利策略。**
Paper持續停止，無新策略委託或曝險。正式研究日／夜盤各27政策，開發合格0、
最終校準閘門通過0、後段通過0，`selected=null`。未從後段另挑勝者。

## 主要虧損原因

### 1. 短方案的價格邊際不足以支付成本

以舊動作研究日盤flexible、0元門檻、短方案歷史測試50筆為例：

| 固定成交路徑的會計拆解 | NTD |
|---|---:|
| 還原顯式滑價前的固定路徑毛利 | +3,060 |
| 手續費 | −2,000 |
| 交易稅 | −892 |
| 入出場滑價 | −2,000 |
| 保存的淨利 | **−1,832** |

均假設每邊費20元、滑價2點、點值10元、稅率0.00002，未用降低成本來製造獲利。
這是同一批保存成交的成本還原，並不是重新跑一個無成本策略；
改費率／成交價亦可能改變入場與出場順序，不能將此毛利當成可實現利潤。

### 2. 長方案不只是被成本吃掉，方向／時機本身缺乏優勢

同一舊模型長方案，日盤測試27筆：19筆停損、7筆正淨額，固定路徑毛損4550元，淨損7192元；
夜盤23筆：18筆停損、5筆正淨額，固定路徑毛損5200元，淨損7447元。
因此只降低費率不能解決這部分虧損。

另按原始45分鐘期限檢查停損後路徑：日盤19筆停損中只有3筆後來碰回原2R目標，
夜盤18筆只有2筆。日盤停損前最大有利幅度平均0.51R、中位0.38R（四分位0.10～0.73R）；
若停損後繼續等到原期限，最大不利幅度平均2.63R、中位2.52R，
夜盤平均3.25R、中位3.20R。這不支持單純扛更大停損就能恢復原目標。
事後路徑只用來診斷，沒有放進特徵、挑選當下訊號或改標籤。停損棒本身的高低順序未知，排除該棒。

### 3. 模型訓練時的正分數尾端沒有可靠泛化

日盤flexible原模型在fit段挑出871個正分數動作／24日，平均實現+407.25元；
獨立校準段僅15個／4日、平均−96.27元。全部動作的預測／報酬相關由0.280降到0.041，
R²由0.0404降到0.0012。這是泛化不足的證據，可能包含過度配適及狀態變化，
不能只憑這個對照認定某一指標或月份特徵是單獨原因。重疊動作數也不能充當獨立成交樣本。

### 4. 延遲損益差常來自「選到另一批交易」

舊日盤small混合方案測試正常24筆、晚一分鐘17筆，只有2筆是相同訊號／方向／方案，
這2筆在兩情境都是+1324元。其餘總損益差主要伴隨偏離價格拒絕、進場時機及單方向額度改變，
不能將整體+5488→−926全部叫作同筆交易滑價。診斷工具用唯一動作鍵分開比較相同與新增／消失成交。

## 根據原因做的修改

- 每個完整1分棒判斷，但只有15分區間／方向、先前3分結構及1分回撤恢復一致時才成為機會。
- 區間用固定訊號時均值目標，至少1.3R、三倍估計成本；順勢回撤用2R及三倍成本。停損改3分ATR尺度，原單口、1000元估計預算及每盤兩次限制維持。
- 每方向／方案每5分鐘只取最早訓練訊號；各日總權重相等，移除星期／月份特徵。
- 比較一般Ridge、同訊號正常／額外滑價／晚一分鐘最差標籤的Ridge、強正則LightGBM，以及最近120日模型。無法成交情境記0，不事後只挑都能成交的資料。
- 直接用實際政策回放作獨立校準閘門；校準各情境至少20筆、各發展折各情境至少30筆且淨利／去最佳日皆正。後段測試各情境至少100筆。失敗保持等待，原始診斷完整保留。

門檻、模型、成本及日期皆預先固定，見[研究規格](tmf-structured-protocol-v1.md)。
訊號、停損、持有期限等一起改動，不能將差異獨立歸因於其中一個參數。

## 正式重跑結果

同一530個完整日盤／395個完整夜盤，318／237日開發、106／79日驗證及106／79日重用歷史測試。
正式開發訊號日盤7198（區間512、順勢6686），夜盤16500（區間1089、順勢15411）。
這些是訊號數，不是成交數。最終一般Ridge實際fit日盤4220、夜盤9796個標籤；
穩健標籤分別4248、9856個，近期模型各96日fit、24日校準。

下表是**未套用校準閘門的原始診斷**，用來判斷是否只因篩選過嚴而錯失盈利。
實際套閘門版本在兩盤後段全數0成交／0淨額，零成交沒有被當成勝出策略。

| 盤別／原始政策 | 驗證成交／淨利 | 測試成交／淨利 | 測試壓力／延遲 |
|---|---:|---:|---:|
| regular／rule-range | 101／-12,204 | 115／-1,826 | -6,798／+3,878 |
| regular／rule-trend | 148／-25,579 | 102／-32,415 | -23,851／-25,874 |
| regular／rule-hybrid | 159／-35,416 | 126／-17,561 | -16,065／-7,196 |
| regular／ridge-normal-0-hybrid | 9／-974 | 2／-1,926 | -978／-958 |
| regular／tree-robust-0-hybrid | 0／+0 | 1／-598 | -618／-598 |
| afterhours／rule-range | 139／-16,580 | 141／-13,866 | -19,526／-22,818 |
| afterhours／rule-trend | 136／-22,590 | 140／-19,661 | -24,451／-15,044 |
| afterhours／rule-hybrid | 143／-16,144 | 146／-14,859 | -21,609／-17,139 |
| afterhours／ridge-normal-0-hybrid | 29／-3,790 | 25／-6,290 | -6,442／-4,168 |
| afterhours／tree-robust-0-hybrid | 0／+0 | 0／+0 | +0／+0 |

兩盤沒有任何原始政策在驗證與測試的正常成本下都正收益；
因此不能說只要拿掉校準閘門就有可用策略。穩健標籤模型多數預測不交易，
表示這些訊號尚未展現足以承受執行變動的正邊際，不代表模型已經獲利。

日盤純規則混合測試126筆，單筆淨利平均−139.37、中位−714，四分位−918～843；
夜盤146筆，平均−101.77、中位−389，四分位−488～521.5。
日盤純區間測試115筆淨損1826，但驗證淨損12204；不能挑後段延遲+3878元來翻案。

## 全部54項政策

以下仍為原始、未過校準的正常情境診斷；全部校準與正式資格皆未通過。
原始／套閘門、兩期、三情境的648列完整結果在本機 `all-policies.csv`；交易明細在JSON。

| 盤別 | 原始政策 | 驗證筆數／淨利 | 測試筆數／淨利 |
|---|---|---:|---:|
| regular | rule-hybrid | 159／-35,416 | 126／-17,561 |
| regular | rule-range | 101／-12,204 | 115／-1,826 |
| regular | rule-trend | 148／-25,579 | 102／-32,415 |
| regular | ridge-normal-0-hybrid | 9／-974 | 2／-1,926 |
| regular | ridge-normal-0-range | 3／-420 | 2／-1,926 |
| regular | ridge-normal-0-trend | 6／-554 | 0／+0 |
| regular | ridge-normal-30-hybrid | 7／-1,668 | 2／-1,926 |
| regular | ridge-normal-30-range | 3／-420 | 2／-1,926 |
| regular | ridge-normal-30-trend | 4／-1,248 | 0／+0 |
| regular | ridge-robust-0-hybrid | 0／+0 | 0／+0 |
| regular | ridge-robust-0-range | 0／+0 | 0／+0 |
| regular | ridge-robust-0-trend | 0／+0 | 0／+0 |
| regular | ridge-robust-30-hybrid | 0／+0 | 0／+0 |
| regular | ridge-robust-30-range | 0／+0 | 0／+0 |
| regular | ridge-robust-30-trend | 0／+0 | 0／+0 |
| regular | tree-robust-0-hybrid | 0／+0 | 1／-598 |
| regular | tree-robust-0-range | 0／+0 | 0／+0 |
| regular | tree-robust-0-trend | 0／+0 | 1／-598 |
| regular | tree-robust-30-hybrid | 0／+0 | 0／+0 |
| regular | tree-robust-30-range | 0／+0 | 0／+0 |
| regular | tree-robust-30-trend | 0／+0 | 0／+0 |
| regular | tree-recent-0-hybrid | 0／+0 | 0／+0 |
| regular | tree-recent-0-range | 0／+0 | 0／+0 |
| regular | tree-recent-0-trend | 0／+0 | 0／+0 |
| regular | tree-recent-30-hybrid | 0／+0 | 0／+0 |
| regular | tree-recent-30-range | 0／+0 | 0／+0 |
| regular | tree-recent-30-trend | 0／+0 | 0／+0 |
| afterhours | rule-hybrid | 143／-16,144 | 146／-14,859 |
| afterhours | rule-range | 139／-16,580 | 141／-13,866 |
| afterhours | rule-trend | 136／-22,590 | 140／-19,661 |
| afterhours | ridge-normal-0-hybrid | 29／-3,790 | 25／-6,290 |
| afterhours | ridge-normal-0-range | 0／+0 | 0／+0 |
| afterhours | ridge-normal-0-trend | 29／-3,790 | 25／-6,290 |
| afterhours | ridge-normal-30-hybrid | 17／-708 | 10／-3,586 |
| afterhours | ridge-normal-30-range | 0／+0 | 0／+0 |
| afterhours | ridge-normal-30-trend | 17／-708 | 10／-3,586 |
| afterhours | ridge-robust-0-hybrid | 0／+0 | 0／+0 |
| afterhours | ridge-robust-0-range | 0／+0 | 0／+0 |
| afterhours | ridge-robust-0-trend | 0／+0 | 0／+0 |
| afterhours | ridge-robust-30-hybrid | 0／+0 | 0／+0 |
| afterhours | ridge-robust-30-range | 0／+0 | 0／+0 |
| afterhours | ridge-robust-30-trend | 0／+0 | 0／+0 |
| afterhours | tree-robust-0-hybrid | 0／+0 | 0／+0 |
| afterhours | tree-robust-0-range | 0／+0 | 0／+0 |
| afterhours | tree-robust-0-trend | 0／+0 | 0／+0 |
| afterhours | tree-robust-30-hybrid | 0／+0 | 0／+0 |
| afterhours | tree-robust-30-range | 0／+0 | 0／+0 |
| afterhours | tree-robust-30-trend | 0／+0 | 0／+0 |
| afterhours | tree-recent-0-hybrid | 0／+0 | 0／+0 |
| afterhours | tree-recent-0-range | 0／+0 | 0／+0 |
| afterhours | tree-recent-0-trend | 0／+0 | 0／+0 |
| afterhours | tree-recent-30-hybrid | 0／+0 | 0／+0 |
| afterhours | tree-recent-30-range | 0／+0 | 0／+0 |
| afterhours | tree-recent-30-trend | 0／+0 | 0／+0 |

## QA、失敗版本與重現

第一次完整32次擬合與54政策評估已保留於 `structured-confirmation-v1`，
QA發現3分結構與ATR背景邊界不一致：改訊號棒高點即可讓停損31→38、風險380→450。
這不是前視，但不符預先規格；回歸測試先重現失敗，再改用push前ATR3。
原版本標為superseded，未刪除結果；正式版在新目錄再做32次擬合與全套評估，
本輪共64次擬合，沒有選擇性隱藏首次嘗試。

- 正式目錄：`.fubon-dev/reports/structured-confirmation-v1-verified/`。
- Frozen ID：`a7cf4390ee2e54cf28841acc27b5f5a7b3e04b442ef8ce3d34095eecae35d639`。
- 新增11項測試通過；QA關閉ATR問題，核對模型、原始碼、日期隔離、27政策／盤、648情境數字及selected=null。
- 最後全套後端1093 passed；前端6076 passed、2 skipped，tsc -b及Vite build通過。
- 過程中既有NativeAttempts雙Store初始化WAL鎖競態在一次全套與一次孤立測試失敗；該模組、ResearchStore與其測試未修改。最終同命令全套通過，保留所有失敗日誌，沒有宣稱競態已修正。

```sh
PYTHONPATH=server server/.venv/bin/python scripts/diagnose-opportunity-losses.py
PYTHONPATH=server server/.venv/bin/python scripts/diagnose-opportunity-scores.py
PYTHONPATH=server server/.venv/bin/python scripts/diagnose-stop-paths.py
PYTHONPATH=server server/.venv/bin/python scripts/research-structured.py --stage development
PYTHONPATH=server server/.venv/bin/python scripts/research-structured.py --stage evaluation
```

診斷與研究拒絕覆寫既有輸出；新研究可用 `--output` 指定新目錄並保存先前結果。
原始快照、套件、精確日期、政策、預先文件、程式與模型均納入凍結核對。

## 結論與限制

虧損的實際問題是訊號價格邊際不足、方向與時機不可靠、正分數尾端泛化差，以及
進場限制使執行變動改變成交組合。這不是單純增加同類指標或放大停損就能修好的證據。
本輪明確否決這些新候選，穩定獲利的研究目標尚未達成。

成本仍是假設；分鐘OHLC成交及回撤是近似，不含真實買賣價差、排隊與市場衝擊。
完整性規則另排除29個日盤、163個夜盤；各有42個未核對是否休市的缺席平日。
可能包括缺分鐘、換月或短盤，未填成虛構行情；結果不代表這些被排除日期的表現。
已查看過多輪歷史，重新切分無法變成全新樣本外；沒有以收益片段保證未來。
後續需可驗證的成交與流動性資訊及未見日期，才能檢查新的價格邊際；本輪不啟動Paper，
不因沒有獲利模型而放寬成本、樣本或風險門檻。
