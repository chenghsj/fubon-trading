# 方向競爭、持有延續與重新訓練（2026-11-18）

**完成進場方向與出場修正、正式重新訓練及固定120政策回測；仍沒有通過完整資格的獲利策略，Paper維持停止。**
新退出減少了部分原本贏家的收益截斷，但持有虧損的代價仍大；允許模型比較多空並擴大訓練後，也沒有驗出可採用的價格優勢。

## 先診斷方向與截斷贏家

只重播父版開發期校準日期，固定相同入場，再獨立比較舊timer出場。日盤51／夜盤61筆；起點後15分鐘的方向化價格變化，平均−.230R／−.014R、中位−.160R／−.188R。這是價格路徑診斷，可能包含原交易已退出後的價格，不是實際成交現金流或獨立方向命中率。

被no-progress提早結束且收益低於原固定退出的正淨額交易，日盤12筆／夜盤15筆；其中日12／夜13筆在決定收盤都尚未浮虧.5R。據此固定「有反向結構且浮虧才退出」假設，沒有把事後贏家標記放進特徵。

## 做了哪些實作

規格見 [protocol](tmf-direction-continuation-protocol-v1.md)。四版本為confirmed／paired各自搭配fixed／evidence。

- **方向競爭**：confirmed保留舊確認事件作對照；paired在每根完整3m、開盤90分鐘後同時建立Buy／Sell的range／trend候選，不先由突破規則鎖定方向。比較NTD價值與Wait=0，多空優勢不足30元等待；不因最佳方向已用或報價拒絕而強行改選較差方向。
- **進場與風險**：paired用最近五根完整1m的支撐／壓力加ATR緩衝，保留絕對整點停損。實際成交重新檢查距離與1000元估計預算；trend為2R、range為訊號前3m均值及至少1.3R，全部至少三倍成本空間。
- **出場證據**：取消新版本的單純12分鐘計時退出。至少六個完整分鐘、完整3m收盤、浮虧至少.5R，加兩根收盤在均值不利側且跌破／升破前根極值，才下一分鐘open退出。突破線排除判斷棒。
- **減少過早保護**：最佳收盤進展達1.5R後，只從下一棒跟隨已收完3m結構，不強制break-even、不放鬆已存在停損；仍可能負淨額或跳空損失。
- **資料配置**：half-pooled保留原前半fit作aux／後半fit金額模型。crossfit以40開盤日暖身、其後20日一塊，嚴格用全資產label_end早於塊首日零時的輔助預測，擴大金額fit；校準使用校準日前凍結的最新aux。缺aux不補零。

仍一口、每盤最多兩次、同側一次、10點偏離、費每邊20元、稅率.00002、滑價每邊2點；壓力另加兩點、延遲一分鐘不延長期限。沒有降費或提高風險來製造收益。新規則只供離線研究。

## 訓練規模與隔離

同一530個完整日盤／395夜盤，原60%／20%／20%不變；四檔股票仍是共同型態預訓練。81維加入微台內相對量、VWAP、五分鐘方向及通道位置，沒有跨資產比較原始量。

| 最終金額fit動作／有效開盤日 | half | crossfit |
|---|---:|---:|
| 日盤confirmed | 226／90 | 371／151 |
| 夜盤confirmed | 564／93 | 975／147 |
| 日盤paired | 10,275／127 | 17,422／214 |
| 夜盤paired | 29,996／95 | 47,035／149 |

fixed／evidence使用相同訊號集合、不同退出現金流。動作可能同時、重疊及同日，不等同獨立成交樣本。正式完成 **64金額bundle／192情境頭＋32輔助模型**；保存16個最終金額模型、全部aux與312個block引用。正常／壓力／延遲各自估計NTD條件平均，未成交0，預測後取低。

QA釐清首稿對aux推論版本的合寫：half保持早期aux，crossfit才更新至校準前。模型規則沒有改動；首輪在後段評估前中止，保留source及superseded紀錄於 `direction-continuation-v1/`，澄清後在新目錄完整重跑。沒有覆寫原結果或依績效改參數。

## 固定純規則hybrid對照

以下為**未套校準閘門**的研究診斷，正常欄為成交／淨額NTD。後段歷史已多輪使用，不是新樣本外；所有版本都列出。

| 盤別／版本 | 驗證正常 | 歷史正常 | 歷史加滑價 | 歷史晚一分鐘 |
|---|---:|---:|---:|---:|
| 日／confirmed-fixed | 53／+1,126 | 25／-13,594 | -12,966 | -5,129 |
| 日／confirmed-evidence | 55／+963 | 25／-12,324 | -11,886 | -4,329 |
| 日／paired-fixed | 179／-23,185 | 181／-29,926 | -32,792 | -24,116 |
| 日／paired-evidence | 180／-23,811 | 183／-34,074 | -39,480 | -22,562 |
| 夜／confirmed-fixed | 85／-3,384 | 88／-14,430 | -22,714 | -10,390 |
| 夜／confirmed-evidence | 84／-5,508 | 85／-19,307 | -24,679 | -11,751 |
| 夜／paired-fixed | 149／-33,560 | 148／-18,728 | -23,885 | -8,484 |
| 夜／paired-evidence | 151／-30,422 | 150／-20,506 | -25,463 | -12,194 |

純規則paired仍採預先定義的15m方向／range規則，分數100只是排序，不是100元期望。學習模型可改選另一方向或等待。上表不是把每個3m的全部多空候選都成交。

## 學習模型：paired、0元門檻

| 盤別／版本／訓練 | 驗證正常 | 歷史正常 | 歷史加滑價 | 歷史晚一分鐘 |
|---|---:|---:|---:|---:|
| 日／fixed／half | 1／+1,364 | 2／+586 | +566 | 0成交 |
| 日／fixed／crossfit | 0／0 | 0／0 | 0 | 0成交 |
| 日／evidence／half | 1／-636 | 4／-818 | -918 | -698 |
| 日／evidence／crossfit | 0／0 | 2／+1,824 | +1,302 | 0成交 |
| 夜／fixed／half | 3／-446 | 3／+220 | -340 | 0成交 |
| 夜／fixed／crossfit | 1／-926 | 0／0 | 0 | 0成交 |
| 夜／evidence／half | 1／-378 | 1／-438 | -478 | 0成交 |
| 夜／evidence／crossfit | 0／0 | 0／0 | 0 | 0成交 |

日盤crossfit evidence的+1824只來自兩筆Sell，驗證0成交、延遲也0成交；不能稱穩定獲利。half fixed日盤歷史去最佳日−896、夜盤−180，且夜盤加滑價轉負。
confirmed模型除日盤crossfit fixed的驗證2筆+114／歷史1筆−919，其餘0元hybrid多為0成交。完整120政策及30元／單分支結果也全部保存，沒有挑正收益片段晉升。

擴大訓練沒有只是被30元方向margin擋住：crossfit paired-fixed歷史日盤6461、夜盤18971個判斷時間全部是noPositiveScore；paired-evidence夜盤亦全部沒有正分數。零成交是模型選擇等待，不是獲利，也不是沒執行訓練。

## 截斷贏家減少，總獲利仍未改善

固定confirmed原入場，逐筆獨立比較原fixed、舊timer與新evidence；以下**不是可直接部署的投資組合損益**，因改退出會改變後續可交易時機與剩餘額度。

| 同入場診斷 | 日驗證 | 日歷史 | 夜驗證 | 夜歷史 |
|---|---:|---:|---:|---:|
| 入場筆數 | 53 | 25 | 85 | 88 |
| 原贏家收益被削減：timer→evidence | 13→0 | 4→1 | 24→10 | 17→7 |
| 原贏家變非正淨額：timer→evidence | 9→0 | 2→0 | 8→5 | 13→5 |
| 舊timer同入場淨額 | +607 | -11,444 | -6,514 | -19,621 |
| 新evidence同入場淨額 | +1,827 | -12,324 | -5,724 | -20,311 |

新退出在這項診斷保留了較多原贏家，但也讓部分虧損走得更遠。夜盤歷史少截斷贏家，整體同入場仍比舊timer少690元；不能只用「保住幾筆贏家」當採用依據。

再按實際投資組合的共同入場配對，新evidence對fixed的日盤歷史25筆改善1270元，但仍虧；夜盤84筆共同入場減少6061元、5筆原正淨額轉非正，另有4筆僅fixed／1筆僅evidence。完整投資組合與獨立反事實不混稱單一退出效果。

## 資格、追溯與驗證

- 兩盤開發selected=null、校準 **0／60**，完整原始最終資格亦 **0／60**。原三情境、成交數、分支及去最佳日標準都保留；套閘門後全數0成交。
- Frozen：`d7f698fbafc7175bde6b1316f95e6f0161a8385f0ac8a07550533edcee9ec3f2`；Parent：`797f570faf4be945735d319b12c8430d6dbd22a39b17cf554e55112388e6003f`。
- 正式產物：`.fubon-dev/reports/direction-continuation-v1-clarified/`，含模型／日期／每塊cutoff及最大label_end／權重／全部交易、區塊重抽樣與1440列raw／guarded對帳CSV。`loss-summary.json`記錄成本與相同入場退出診斷，工具拒絕覆寫。
- 重新載入父版structure-fixed／managed原生模型與純規則，兩盤×18政策×兩期×三情境，共 **216個完整重播相符**。
- 新14項測試通過，含方向可反選／等待／不fallback、反向線排除當棒、次棒跳空、1.5R保護不倒套且不強制BE、cutoff相等／未來標籤、缺aux排除、NTD三頭。完整180日合成OHLC／量管線擾動後40%，開發返回及保存模型hash不變；該整合測試以保存特徵與標籤統計的樹替身驗證管線，不冒稱已重訓原生模型。
- 最後全套後端 **1142 passed**；前端 **6076 passed／2 skipped**；tsc -b／Vite build通過。過程一次完整後端因既有NativeAttempts雙ResearchStore初始化WAL競態而1 failed／1141 passed，同命令重跑通過；原失敗日誌保留，未修改或宣稱修好該競態。
- QA核對32aux、64份metadata／312個block引用及16個最終81維NTD模型；所有截止符合規格、沒有缺aux補0。half與crossfit也改變fit範圍及aux版本，不能把差額單獨歸因一項。

來源未獨立核實、完整盤排除、假設費率、OHLC缺逐筆順序／真實價差、訓練與推論aux分布差異，以及已反覆使用的歷史仍是限制。依[原始data-snooping研究](https://onlinelibrary.wiley.com/doi/10.1111/0022-1082.00163)保留完整候選；本輪區塊重抽樣不能消除所有既往搜尋偏誤。[LightGBM參數文件](https://lightgbm.readthedocs.io/en/stable/Parameters.html)只用於核對估計工具。

```sh
PYTHONPATH=server server/.venv/bin/python scripts/diagnose-direction-exits.py
PYTHONPATH=server server/.venv/bin/python scripts/research-direction-continuation.py --stage development --output NEW-DIRECTORY
PYTHONPATH=server server/.venv/bin/python scripts/research-direction-continuation.py --stage evaluation --output NEW-DIRECTORY
PYTHONPATH=server server/.venv/bin/python scripts/summarize-direction-continuation.py
```

診斷／摘要預設本輪固定目錄且拒絕覆寫；重訓用新的output，需保留固定資料與父版模型。方向及出場修改已實作，穩定獲利目標仍未達成，沒有啟用或替換Paper策略。
