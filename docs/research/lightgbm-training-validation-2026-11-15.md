# LightGBM 微台日內研究：資料、標籤與時間驗證

查證日期：2026-11-15。本筆記依公開官方文件及本地實作提出研究規格；未登入券商、呼叫 SDK、下單或讀取個人帳務。本文的費用範例固定採公開通用假設 **20 元／口／單邊**，不代表任何帳戶費率。原始行情、帳戶、憑證、個人費率及模型檔不隨本文件提交。

**建議先做固定 ORB／ATR 的進場濾網，模型只決定保留或跳過訊號。** 停損、停利、單口限制與損失預算仍由既有版本規則決定。第一版完成資料稽核、可重現訓練、時間順序評估與版本保存；訓練完成不等於取得模擬候選資格，取得資格也不會自動啟動策略。以下規格是本案工程提案，沒有來源替本策略證明收益。

## 1. 官方歷史資料的實際邊界

### 期貨

富邦 `historical/candles/{product}` 自 SDK v2.4.0 提供期貨歷史 K 線；使用商品根代碼與獨立的 `contractMonth`。支援具體月 `yyyyMM` 及 `1!`／`2!`／`3!`，單次範圍須小於一年。分 K 自 2017-06 起提供是服務的最早覆蓋，並非每種商品都有那麼早的資料。查無資料回 404，不能一概當成網路失敗或補成空白交易日。[富邦期貨歷史 K 線](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/historical/candles/)、[SDK 版本紀錄](https://www.fbs.com.tw/TradeAPI/docs/download/download-sdk/)

連續月於到期後次一交易日換月，不作價差調整；頂層 `contractMonth=1!` 只是查詢別名，逐根 `data.contractMonth` 才是實際月份。分 K `date` 是帶時區的**起始時刻**；`volume` 是口數，`average` 是該棒 VWAP，無成交時 OHLC 可為 null、量為零。分 K 不含價差單兩腿及鉅額交易，不能強求其加總等於日 K 量。夜盤查詢日期是所屬的次一交易日。[富邦期貨欄位與換月說明](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/historical/candles/)

TMF 於 **2024-07-29** 上市，因此不能生成更早的「真實 TMF」樣本；TXF／MXF 只能另存為代理商品實驗。TMF 每點為新臺幣 10 元，不能套用 TXF 的乘數。[TAIFEX 上市公告](https://www.taifex.com.tw/file/taifex/CHINESE/11/attach/1130201393.pdf)、[TMF 契約規格](https://www.taifex.com.tw/cht/2/tMF)

本案推導的收集要求：

- 優先收同一實際月份的短區段，再按事先登記的近月規則組成多月份資料；不把今天的月份往前延伸成多年歷史。
- 若新增連續月下載，必須先保存逐根實際月份；目前只保存單一頂層月份的舊格式不能直接承接跨換月 `1!`。遇到未實作的模式應拒絕，不可猜月份。
- 價格、收益、ATR、開盤區間不得跨實際月份拼接。每個交易日的研究視窗只允許一個實際合約；換月／到期例外有明確處理及排除原因。
- 原始起始時刻只轉換一次為本地使用的分鐘收盤標籤，例如 09:00 → 09:01；保留原始時區、`barLabel` 與正規化版本。UTC 儲存與台北交易日判定分開處理。

### 股票及多資產同步

富邦股票歷史分 K 自 2023-05-23 起提供；單次同樣須小於一年，`adjusted` 僅適用日／週／月 K。整股股票分 K 的量為「張」，日 K 為「股」；指數分 K 的量為成交金額。股票 `average` 是**自開盤累積**均價，與期貨單棒 `average` 不同，不可套用同一累加公式。股票分 K 的日期欄位帶時區；該頁未像期貨頁明列「起始時刻」，應保存來源標籤證據並核對開盤樣本，避免僅憑欄位名稱猜測。[富邦股票歷史 K 線](https://www.fbs.com.tw/TradeAPI/docs/market-data/http-api/historical/candles/)

既有 SQLite 僅有 OHLCV 時，以 `((H+L+C)/3)×V` 累計的是價格近似，不是已取得的成交 VWAP；特徵名稱與 manifest 應標 `typical_price_vwap_proxy`。股票相對報酬可使用當日已完成的精確同步棒，不能把現有四檔股票宣稱為完整台指現貨複製組合；今日固定權重回看屬假設情境，不能標成歷史有效成分。

本地 `research.py` 將來源標成 `fubon-` 加 broker mode，因此 `fubon-sandbox` 表示取資料時的連線模式，單憑字串不能證明資料是合成行情，也不能證明它已核實為真實市場歷史。建議分存 `brokerEnvironment`、`marketDataOrigin`、來源驗證證據；未知時保留 `unverified`。本筆記未找到足以替該本地快照確認其市場真實性的官方說明。[本地來源與正規化實作](../../server/fubon_bridge/research.py)、[本地歷史查詢入口](../../server/fubon_bridge/broker.py)

## 2. 資料品質是可讀結果，不只通過或失敗

以下為本案資料契約；目前研究只取 09:01–13:20 的 260 根收盤標籤 1 分棒，不代表 TMF 完整日盤。[現有研究引擎](../../src/lib/intraday-research.ts)

1. 唯一鍵至少含來源、商品、實際月份、盤別、時間；多個快照重疊時先去重，不把同一天複製為更多訓練樣本。相同鍵但 OHLCV 不同是來源修正／衝突，要留版本，不能默默取最後一列。
2. 檢查分鐘網格、嚴格排序、非有限值、正價格、合法 OHLC、非負量、TMF 整數跳動。明確無成交的 null 棒與缺資料分別記錄；不回填未來價格，也不把 null 換成零價格。
3. 報告要求日期、觀測日期、完整日期、無資料日期及排除原因。僅計「觀測到的完整日」會漏掉整日停機；沒有交易所日曆驗證時，標明 calendar unverified。
4. 股票特徵使用決策時刻與其確切前一時間點的完整資料；任一來源延後、缺漏或早收盤則依固定政策跳過。不能以最近價無期限延用取代同步。
5. 每個特徵的 `max_input_time <= decision_time`；保留標籤起訖時間，特徵表與結果表分開。事後才能取得的進場開盤、最大有利／不利移動、離場原因與淨利不得進入特徵。
6. 以資料、設定與程式版本的 canonical hash 鎖定快照；重收資料產生新版本。模型與報告引用同一資料 ID，不以可變的「最新資料」路徑作依據。

歷史棒的整齊時間戳不能證明即時收到的時間；驗證實際延遲仍須接收時間證據。只有 OHLC 也不能還原根內先後順序、IOC、排隊與部分成交，模型不能消除這些成交假設。[TAIFEX 撮合原則](https://www.taifex.com.tw/cht/4/oamPrinciple)、[TradingView 官方模擬器限制](https://www.tradingview.com/pine-script-docs/concepts/strategies/#broker-emulator)

## 3. 最小可重現的 supervised label

這一節是設計提案，與官方 LightGBM 的功能能力分開。先使用既有 `orb_atr_v2` 規則，將 09:00–09:15 區間、09:20 起五分鐘收盤穿越、下一分鐘開盤假設成交、Wilder ATR14、不追價、預算與出場政策全部固定。ML 不修改這些距離或動態增減口數。[Python 風控政策](../../server/fubon_bridge/intraday_strategy.py)、[回測成交與成本政策](../../src/lib/intraday-research.ts)

每個訓練樣本是一個可重現的 ORB 交易事件，包含：

```text
decision_time       已完成棒確認訊號的時間
feature_schema      有序特徵名稱、單位、版本
side                ORB 已決定的 +1 / -1
label_end_time      按固定出場政策最後使用的結果棒時間
net                 方向 × (exit - entry) × multiplier - 雙邊費稅
y                   1 if net > 0 else 0
policy / cost IDs   產生該標籤的風控與成本版本
```

成交價已含不利滑價，不能在 `net` 再扣同一份滑價。稅額沿既有每口每邊取整政策；標籤的費率來源設為 `assumed`，不能因為數字合理便升為已核實成本。根內雙觸採固定保守政策，並另存 `ambiguous`；資料期間結尾無完整出場資訊的事件不能強制標虧損。

第一版應從**固定基準交易流**建立事件與標籤，濾網只能取其子集合：拒絕一筆後，不回頭新增另一個原本不會有的交易，不把同一事件重複成每分鐘多筆。這種估計的問題是「保留哪些基準交易」，不能冒稱已驗證完整動態策略。若下一版要因模型跳過而重新開放進場／改變剩餘預算，必須用該模型重新跑完整狀態機；不能僅刪除原始成交清單就宣稱等價。兩種樣本政策不得混在同一報告。

初始特徵可限制為已完成棒的方向、距開盤區間邊界／ATR、區間寬度／ATR、當日已完成的 5／15 分收益、決策分鐘、ATR／價格、成交量的歷史比率與 VWAP 近似偏離。股票加入時先以各檔同日已知報酬或事先固定的等權籃子作獨立版本；不以事後最佳權重取代來源證據。零分母、暖身不足或缺來源須拒絕該事件。日期、資料 ID、合約 ID 供稽核，不直接當作讓樹記住樣本的數值特徵。

`P(y=1)` 只估計這份政策與成本下「淨利為正」的標籤機率；不是預期淨利，更不是已校準的未來勝率。即使機率準確，平均虧損較大時高勝率仍可能負期望。第一版可預先固定 `p >= 0.5` 作研究濾網，但不能根據測試結果調高／調低門檻。需同時報告保留率、收益、虧損幅度與基準比較。官方也區分概率預測、決策門檻及校準，並未保證模型輸出自然具有這些性質。[scikit-learn 評分與決策](https://scikit-learn.org/stable/modules/model_evaluation.html)、[概率校準](https://scikit-learn.org/stable/modules/calibration.html)

## 4. 依交易日切分，依標籤區間排除洩漏

`TimeSeriesSplit` 說明一般交叉驗證可能用未來訓練、過去測試；其 `gap` 是排除的**樣本筆數**，等間隔條件才使各折涵蓋相同時間。ORB 事件稀疏且每天筆數不同，不能把 `gap=30` 解釋成 30 分鐘，也不能隨機分層抽樣讓同日多空分散於訓練和測試。[官方 TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html)

本案建議按排序後的交易日分配開發訓練、內部驗證、其後前推評估及最後鎖定測試；同一天的全部事件留在同一段。數字門檻由有版本的研究政策明訂，不存在 LightGBM 官方保證有效的最低天數／筆數。若本地只有少量已看過日期，維持流程診斷；再切成三段不會使最後一段重新變成未見資料。

對每個較早訓練事件 `i`，令其結果資訊區間為 `[decision_i, label_end_i]`。若下一評估段最早決策時刻為 `T`，採保守邊界：

```text
允許訓練：label_end_i < T
排除訓練：label_end_i >= T
```

這是本案由資訊可用性推導的 purge 規則：等號也排除，避免把評估邊界的價格同時用來決定訓練結果。訓練→內驗證、開發資料→鎖定測試均檢查；若採固定未來 H 分鐘標籤，須儲存真實時鐘的 horizon，不能以事件列數替代。日內強制平倉且按完整日期切段時通常不會跨界，仍要由 assertion 驗證而不是省略。未完成或超過資料視窗的標籤排除並報數；不以零報酬填補。

特徵選擇、缺值填補、量比基準、校準或任何學得的轉換都只能 fit 訓練資料，之後原樣 transform 驗證與測試；當日全日高低量或全期間百分位數會洩漏未來。跨界使用過去已知暖身資料本身不等同洩漏，關鍵在可用時點與是否把未來結果用於 fit。[scikit-learn 官方洩漏範例](https://scikit-learn.org/stable/common_pitfalls.html#data-leakage)

LightGBM `cv()` 預設 `stratified=True, shuffle=True`，本案不可直接沿用。最小版本可以逐段明確 `train()`，或自行提供已驗證的日期 splitter。early stopping 若採用，只能使用訓練之後、測試之前的內部驗證；最終測試不得傳入 `valid_sets` 選樹數，因為停止輪數也是模型選擇。最簡版本固定樹數並不作 early stopping，降低第一輪選擇自由度。[LightGBM CV API](https://lightgbm.readthedocs.io/en/stable/pythonapi/lightgbm.cv.html)、[early stopping API](https://lightgbm.readthedocs.io/en/stable/pythonapi/lightgbm.early_stopping.html)

重複看測試後改特徵、標籤、費率、門檻或風控，都形成新試驗。已看的測試只能降為開發資料，後續候選需新日期；把資料重新命名或換 seed 不能恢復獨立性。所有成功、失敗和不足樣本結果都要保存。[Bailey 等原始研究](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)

## 5. LightGBM 安裝與保存的工程選擇

官方 Python 套件文件要求 macOS 的 OpenMP runtime，命令為 `brew install libomp`；一般 CPU 安裝與自行編譯是不同路徑。官方 macOS 不支援其 GPU 版本。這是環境需求資訊，本研究未安裝系統套件。應在獨立虛擬環境固定可用版本，先驗證 import、極小資料 fit 與 save/load，再讓 Web 介面報告實際狀態。缺依賴時顯示 `unavailable`，不能改用別的模型仍顯示 LightGBM。[官方 Python 安裝說明](https://github.com/lightgbm-org/LightGBM/blob/main/python-package/README.rst)、[官方安裝指南](https://lightgbm.readthedocs.io/en/stable/Installation-Guide.html)

初始可用 CPU、少量葉節點／有限深度、固定 rounds、learning rate、min leaf、seed 與執行緒，不作參數搜尋。`deterministic=true` 只適用 CPU；官方建議同時指定 `force_col_wise` 或 `force_row_wise`。不同 LightGBM 版本、系統或 compiler 仍可能有差異，因此 seed 不能代替環境版本。若使用 `is_unbalance` 或 `scale_pos_weight`，官方提醒概率估計會受影響，第一輪不為追高分類分數自動開啟。[LightGBM 參數](https://lightgbm.readthedocs.io/en/stable/Parameters.html)

每一折從訓練陣列建立新的 `Dataset`，驗證用該訓練 Dataset 作 reference；不能先以全部資料建立分箱再切 fold。官方 Dataset 本身會作分箱，這也是需隔離的資料轉換。[LightGBM Dataset API](https://lightgbm.readthedocs.io/en/stable/pythonapi/lightgbm.Dataset.html)

模型使用官方 `Booster.save_model()` 文字格式保存，以 `Booster(model_file=...)` 重讀；另存 JSON manifest，勿把任意 pickle 當模型交換格式。保存後重讀同一批固定特徵，核對預測一致並保存 checksum。明確記錄 iteration；以 early stopping 訓練時保存採用的 `best_iteration`。[LightGBM Python 模型保存](https://lightgbm.readthedocs.io/en/stable/Python-Intro.html)

manifest 至少包含模型 ID／父模型、資料 hash、日期範圍、來源／實際月份清單、品質報告、時間標籤、特徵名稱與順序、label／風控／成本版本、全部參數、Python／LightGBM／NumPy 版本、程式 commit、每折日期與 purge 數、鎖定測試 ID、成本後結果及資格拒絕原因。推論先核對 schema、特徵順序、維度與有限值；`predict(validate_features=True)` 官方只對 pandas DataFrame 生效，不能用 NumPy 陣列便以為名稱已核對。[Booster predict API](https://lightgbm.readthedocs.io/en/stable/pythonapi/lightgbm.Booster.html#lightgbm.Booster.predict)

## 6. 模型產出與候選資格分開

以下為建議的 fail-closed 研究政策，並非學術顯著性保證。可保存 diagnostic 模型、錯誤與報告；任何不滿足項都不能因「已 fit」改成可採用：

| 情況 | 必要行為 |
|---|---|
| synthetic、來源混合或 market origin 未核實 | 流程展示／研究診斷；不取得市場候選資格，列出來源問題 |
| 同一快照重複、契約混接、時區／標籤錯誤、不可解衝突、特徵看見未來 | 拒絕該資料／訓練，明示原因 |
| 完整日、事件或各折類別不足；某折只有單一類別 | `insufficient_data`；不得補假資料／重複事件／取消測試段湊數，無法定義的 AUC 留 null |
| 費率僅 assumed；缺成交／延遲證據；固定事後權重 | 可報假設情境，但候選資格明列未通過項；不宣稱已驗證個人成本或可成交性 |
| 日期曾用來修正策略、門檻或挑模型 | `test_contaminated`；等待新增未見日期，不能用同一測試反覆選勝者 |
| 無鎖定測試、壓力成本後收益消失、樣本外未改善或幾乎無交易 | 不晉升；保存基準、濾網、保留率與原因，不用 accuracy 代替經濟結果 |
| 依賴不可用、訓練失敗、artifact hash／schema 不符 | `unavailable`／`failed`／`invalid_artifact`；保留原模型和既有執行狀態 |

數據報告至少包括每段天數／事件／多空／正負類、purge 數、保留與拒絕數、成本後總損益／平均每筆／每日損益差／回撤，以及固定較差滑價情境。概率診斷可報 log loss、Brier、AUC 與只用訓練正例率的常數基準，但單一類別或極少事件時必須承認無法可靠比較；不得輸出偽精確信賴區間。若估計不確定性，應保留交易日的整群相關性，別把高度相關的分鐘當成獨立抽樣。

重訓建立新候選與新 manifest，引用舊版本但不覆寫它。資料可用性檢查與排程訓練可自動執行；產生、通過檢查、選為研究模型、啟動 sandbox 是不同狀態。此階段**不自動切換、不自動 arm、不呼叫交易入口**；現有人工選定模型也不得因重訓失敗而失去紀錄。重新訓練的「新模型」若用到了過去的測試日期，必須以更晚未見日期重新取得資格。

第一階段可驗收的是：已知不足能明確顯示不足；資料、特徵與時間切分能重現；模型確實由 LightGBM 訓練並可驗證載入；版本及拒絕原因可追溯。這些工程結果仍不構成微台獲利證據。

## 本次落地選擇

實作採上述完整事件狀態機方式：每個原始穿越事件建立當時可見特徵，模型跳過後仍允許之後符合規則的新事件，驗證與測試各自重新模擬部位、方向額度與日損預算。並非只從基準已成交清單刪除交易。標籤出場上限固定20分鐘／13:20，與既有上方日內回測期限分開標示。

模型採50輪固定參數，直接以訓練陣列建 `Dataset`；驗證、測試只計結果，不選輪數或門檻。原生模型以 `model_to_string()`／`Booster(model_str=...)` 保存與重讀，並保存相關模組 source SHA256，修正公式會形成新版本。實際採用規格見[工程設計](../design/lightgbm-research.md)。
