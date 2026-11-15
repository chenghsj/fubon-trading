# 微台 ORB 修正：波動風控與成交一致性的驗證邊界

查證日期：2026-11-15。本筆記僅查公開官方文件、原始碼及原始研究；未讀取憑證、登入券商、呼叫 SDK、下單或使用付費資料。

本次工作輸入為「自有 sandbox 策略尚無成交；7 日歷史近似共 10 筆，其中 5 筆虧損皆於首分鐘觸及 30 點停損」。這些數字由主工作提供，本筆記未重跑。它們可提出「固定距離、追價及成交錨點是否合理」的工程假說，不能證明把停損放寬就會改善未來淨報酬。

## ATR 的算法與可用時點

TA-Lib 官方實作以 `TR[t] = max(H[t]−L[t], abs(H[t]−C[t−1]), abs(L[t]−C[t−1]))` 計算真實波幅；前 `n` 個 TR 取簡單平均作種子，之後採 Wilder 平滑：`ATR[t] = ((n−1)×ATR[t−1]+TR[t])/n`，並明示初始值的影響期。因此「每次取最近 14 個 TR 的簡單平均」與 Wilder ATR14 並不相同。[TA-Lib v0.6.4 原始碼](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_ATR.c#L213-L299)

本地既有[候選研究筆記](intraday-strategy-candidates-2026-11-15.md)採滾動簡單平均。修正版應明記算法、棒週期、前收定義與暖身，不應只稱「ATR14」。以下是由算法推導的實作要求：

- 僅使用訊號確認當刻已完成且已收到的棒；不足暖身或缺值時跳過，不能暗中回退至 30 點。
- 若只從當日 09:00 收集 5 分棒，09:20 尚不足 14 棒；若需要早盤訊號，須預先選定其他週期或合法的較早暖身資料。是否跨日／夜盤、如何處理休市缺口，必須在回測與執行一致。
- ATR 是歷史價格距離的平滑值，公式不提供方向、成交機率或下一次最大損失。跳價和送單延遲仍可能使實際損失超過停損距離。

## 停損、預算與不追價：作為固定假說

Kaminski、Lo 的原始研究分析停損政策對任意組合報酬與波動的增減，實證為日頻指數期貨的買進持有，並指出較長取樣週期的部分政策有正面結果；其研究不是微台日內 ORB、ATR 停損或本案參數的驗證。[MIT 原始論文紀錄與摘要](https://dspace.mit.edu/entities/publication/bb69ca4b-0cdc-487f-831d-63b2e84fafee)

以下是研究設計推論，應先固定規則再測，未指定個人適用的金額、口數或倍數：

1. 將候選距離明確定義為某種 `k×ATR`／結構失效距離，凍結於訊號時刻；若包含底限或上限，也要留存原始值、最終值與拒絕原因。不能只因過去 5 筆被掃便逐筆放寬。
2. 把「預計停損損失＋來回成本預留」與設定的單筆研究預算比較，超出便跳過；單口不符合亦跳過。預算是送單前的估計門檻，無法保證最大實損。微台每點新臺幣 10 元，須以貨幣單位比較，不能把點數直接當金額。[TAIFEX TMF 契約規格](https://www.taifex.com.tw/cht/2/tMF)
3. 收盤確認後，以送單前可用買賣價檢查相對訊號價的偏離；超過預先固定門檻即取消，留下價格、時刻與原因。限價可約束可接受價格，但會增加未成交；不能在事後看到結果後補選進場價。

## 成交錨點、IOC 與成本

富邦期貨 `PlaceOrder` 將 `status=10` 定義為委託成功、`status=50` 為完全成交，並分列委託價與 `filled_lot`；送單成功不等於持有部位。`FilledHistory` 提供 `filled_avg_price`、`filled_price`、`filled_lot`、`filled_time`、`filled_no`，且文件限制最近兩日。工程上應以已確認成交及其數量建立／更新保護價與損益，保留逐筆成交供對帳，不能沿用訊號收盤價當成交錨點。[富邦期貨 PlaceOrder](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/PlaceOrder/)、[富邦期貨 FilledHistory](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/FilledHistory/)

IOC 是立即成交否則取消；市價的實際成交價可能偏離當時揭示行情。期交所盤中採逐筆撮合，成交價由撮合當時相對方委託價格決定。因此，只有 1 分 OHLC 的回測無法重現抵達順序、當刻深度、部分成交與 IOC 未成交取消；將下一棒開盤直接全數成交只能標示為假設。跳空跨停損、同分鐘雙觸停損／停利，均須另外標記保守成交政策。[TAIFEX 委託單種](https://www.taifex.com.tw/cht/4/oamIntroduction)、[TAIFEX 撮合原則](https://www.taifex.com.tw/cht/4/oamPrinciple)

成本應分列成交價所含的買賣價差／滑價、雙邊手續費與雙邊期交稅，避免滑價重複扣除。期交所目前列 TMF 稅率 `0.00002`，按契約金額計算；交易所費率不是帳戶實付手續費，實際費用由期貨商與交易人議定。sandbox 未扣費不表示真實交易免費。[TAIFEX 費率表與註 1、2](https://www.taifex.com.tw/cht/4/feeSchedules)

## 後續驗證與證據分層

Bailey 等指出，反覆比較多組策略再選最佳會產生回測過度配適；單一留置樣本也未計入已嘗試的配置數，且小樣本難以作可靠判斷。因此，這 7 日 10 筆應視為已用於設計的樣本，不能改參數後再稱同段結果為樣本外。[作者原始論文，§2](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)

本案的驗證建議是保留固定距離基準，只增加一個有版本的修正版，記錄所有試驗與被拒訊號；在新增、未用於修正的日期持續前測，再依時間順序擴充樣本外比較。不進行 30 種參數搜尋，也不把測試筆數門檻當成獲利保證。報告成本後期望損益、每日損益／回撤、成交與未成交、首分鐘停損、實際距離及延遲，而非只看勝率。

| 證據 | 可支持 | 尚不能支持 |
| --- | --- | --- |
| 7 日歷史 OHLC 近似 | 重現訊號、檢查邊界與成交假設 | 真實 IOC 可成交性、穩定收益 |
| 自有 sandbox／本地 paper 成交 | 該模擬器的訊號、狀態與風控流程 | 券商或交易所實際撮合品質；0 成交更沒有策略實績 |
| 富邦／交易所真實成交回報 | 該筆真實成交的價格、時間、數量 | 長期策略有效；仍須對帳與足夠樣本 |

上述界線是依資料粒度與官方撮合／成交欄位作出的研究判斷。本筆記未替任何候選證明收益，也未以真實下單驗證。

## 追加：能否取得個人微台手續費並帶入

**公開 API 可查已發生的帳務費用；本次查核的期貨 SDK 帳務目錄未見「依商品查單口單邊約定費率」介面。** 兩者應分開處理。[官方期貨帳務目錄](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/accountManagement/HybridPosition/) 依主工作確認，目前 App 使用官方共用 sandbox，並非使用者個人帳戶；其費用、成交口數與範例數字均不能成為個人費率證據。本筆記未連線驗證帳戶。

| 官方介面 | 可取得的欄位與用途 | 不可直接推定 |
| --- | --- | --- |
| `query_margin_equity` | `date`、`currency`、`today_trading_fee`、`today_trading_tax`、`buy_lot`、`sell_lot`；可供帳戶當日總額對帳。`NTD` 是約當台幣，`TWD` 是新台幣，不可將兩列相加重複計算。[QueryEquity](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/accountManagement/QueryEquity/) | 未提供商品／月份維度；今日手續費除以總口數，不能直接當 TMF 約定費率。 |
| `close_position_record` | `date`、`order_no`、`market`、`symbol`、`expiry_date`、`buy_sell`、`orig_lots`、`transaction_fee`、`tax`；比總額更適合核對指定商品的已發生費用。[ClosePositionRecord](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/accountManagement/ClosePositionRecord/) | 文件只稱交易手續費，未交代單邊／來回歸屬、折讓時點及約定費率；不能未對帳便把 `transaction_fee / orig_lots` 寫成單口單邊設定。 |
| `filled_history` | 成交識別、日期／時間、商品、月份、價格、口數，可與帳務紀錄核對；公開欄位表未列手續費。[FilledHistory](https://www.fbs.com.tw/TradeAPI/docs/trading-future/library/python/trade/FilledHistory/) | 缺費用欄位不表示免手續費，也不能單靠成交價格反推費率。 |

帶入規則屬本案工程推論：取得**個人真實帳戶**的資料後，優先把已核對商品、日期與委託的原始 `transaction_fee`／`tax` 帶入對應歷史成本，保留來源與時間。欲轉為未來回測使用的「單口單邊」參數，仍須以個人約定資料／對帳單確認計費範圍及生效日；在此之前保留「假設／待確認」，不得自動覆蓋成已驗證費率。

若僅有當日總額，至少須驗證相同帳戶、交易日期、幣別、完整日／夜盤及全部相關市場成交、全數均為 TMF、無其他費用／折讓混入，且去重後成交口數與費用涵蓋範圍一致，才可記為「該日觀察到的每成交口成本」；即使成立，仍不是官方約定費率查詢。沒有個人紀錄時，可由個人約定費率資料確認，不需要為取得樣本另下真實交易。


## 指數期貨稅額取整

[財政部臺北國稅局期貨交易稅問答](https://www.ntbt.gov.tw/singlehtml/0baa381b53034993a08862dfde2243b9?cntId=19482419d564471a80a2462ea28085e4) 說明指數期貨稅額按每口計算，元以下四捨五入。模型改為每口、每邊先取整，再乘口數；Python 使用正數 half-up，不能使用銀行家取整的內建 `round`。舊保存結果不重寫，新回測保存 `taxRounding` 版本。個人費率僅保存在本機瀏覽器與當次本機回測結果，不把帳戶、對帳圖或個人費率寫入公開文件。
