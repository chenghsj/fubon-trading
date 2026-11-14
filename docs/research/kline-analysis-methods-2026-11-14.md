# K 線分析方式整理

查證日期：2026-11-14。範圍：常見 K 棒、價格結構與搭配指標；供學習、規則設計與後續回測使用。

使用者已選定「台指期／小台／微台的當沖與日內短線」。針對此目標的本地判讀提案見[第 9 節](#9-本次目標台指期小台微台的日內判讀提案)；前八節保留為一般方法與實證背景。

建議先學「趨勢與位置 → K 棒觸發 → 量能或動能 → 風險與驗證」。這是依可解釋性與容易寫成規則提出的學習順序，並非已驗證的績效排名。本文區分交易所／券商的傳統判讀、原始研究結果與自行提出的示範規則；教學頁的看多／看空說法不能直接當成勝率。

## 1. 一根 K 棒實際提供什麼

K 棒記錄指定區間的開盤 O、最高 H、最低 L、收盤 C；成交量 V 通常另外顯示。實體是 O 與 C 之間的區間，影線延伸到 H 與 L。顏色依平台設定，判斷陽線／陰線應以 `C > O`／`C < O` 為準；「本根陽線」與「相較前收上漲」是不同條件。參考 [CME 圖表基礎](https://www.cmegroup.com/education/courses/technical-analysis/chart-types-candlestick-line-bar)。

程式化判讀可先定義：

```text
實體 body = abs(C - O)
全幅 range = H - L
上影線 upper = H - max(O, C)
下影線 lower = min(O, C) - L
收盤位置 closeLocation = (C - L) / (H - L)
```

`H = L` 時，比例需要另行處理。這些是 OHLC 的數學描述，不能據此識別交易者身分、主力意圖，或還原根內先漲後跌的路徑。後者也影響回測成交假設，見第 7 節。

## 2. 常見方法比較

下表的適用情境是方法設計用途與研究起點，並不表示在該情境已證明可獲利。

| 方法 | 主要回答的問題 | 常見工具或觀察 | 判讀方式與限制 |
|---|---|---|---|
| K 棒型態 | 這幾根的價格行為是否改變？ | 十字、錘子、吞噬、晨星 | 用形狀描述短期變化；必須保留前置趨勢與出現位置。[IG 型態教學](https://www.ig.com/uk/ig-academy/the-basics-of-technical-analysis/candlestick-patterns) |
| 趨勢、支撐與壓力 | 現在處在什麼位置？ | 前高前低、水平區、趨勢線、通道 | 觀察高低點是否上移／下移、突破後是否回測；支撐壓力應視為區域，可能失守。[CME 支撐壓力](https://www.cmegroup.com/education/courses/technical-analysis/support-and-resistance) |
| 多根圖形 | 整理後延續還是反轉？ | 雙底／雙頂、頭肩、三角、旗形、矩形 | 先定義頸線或邊界，等待突破條件；外觀相似不等於型態完成。[CME 反轉](https://www.cmegroup.com/education/courses/technical-analysis/technical-patterns-reversals)、[延續](https://www.cmegroup.com/education/courses/technical-analysis/trend-and-continuation-patterns) |
| 趨勢指標 | 價格方向及趨勢強度如何？ | MA、EMA、Donchian、DMI／ADX | 均線看方向與交叉；ADX 看強度，方向另看價格或 ±DI；平滑與確認會帶來延遲。[Fidelity SMA](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/sma)、[ADX](https://www.fidelity.com/viewpoints/active-investor/average-directional-index-ADX) |
| 動能指標 | 漲跌速度是否減弱或重新增強？ | RSI、KD、MACD、背離 | 比較指標交叉、區間與價格新高低；RSI 可長時間超買／超賣，MACD 在盤整可能反覆交叉。[RSI](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/rsi)、[KD](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/slow-stochastic)、[MACD](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/macd) |
| 量價分析 | 價格變化伴隨多少成交？ | 成交量、量均、OBV、VWAP | 看量能與價格是否配合；OBV 是依漲跌加減整根成交量，並非實際主動買賣差。VWAP 的起算點必須固定。[OBV](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/obv)、[VWAP](https://www.tradingview.com/support/solutions/43000502018-volume-weighted-average-price-vwap/) |
| 波動分析 | 市場正在收斂還是擴張？ | 布林通道、ATR、Keltner | 布林觀察相對位置與帶寬；ATR 衡量波動，沒有多空方向。強趨勢可沿布林外緣持續，觸軌不等於反轉。[布林](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/bollinger-bands)、[ATR](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/atr) |
| 多週期分析 | 大週期位置與小週期訊號是否一致？ | 日 K／60 分 K／5 分 K 對照 | 依持有時間分工觀察；回測只能使用當時已收盤的大週期資料，避免提前取得最終數值。[CME 週期選擇](https://www.cmegroup.com/education/courses/technical-analysis/chart-types-candlestick-line-bar)、[TradingView 重繪說明](https://www.tradingview.com/pine-script-docs/concepts/repainting/) |

### 指標數量與證據數量不同

MA、MACD、RSI 多由相同價格序列計算。本文的推論是：不能只因三個指標同時偏多，就把它們當成三份互相獨立的證據，更不能直接換算更高勝率。較容易解釋的研究組合是「一個位置條件＋一個觸發條件＋一個波動或成交量條件」，再用樣本外資料檢驗組合是否有增益。

## 3. 常見 K 棒型態速查

以下是傳統型態名稱與判讀語彙，沒有通用的固定勝率。分類依 K 棒的開收與影線，不依紅綠配色。

| 型態 | 外觀與出現背景 | 傳統解讀／容易誤用之處 |
|---|---|---|
| 十字 Doji | O 與 C 接近，實體很小 | 表示開收接近；單獨不能決定反轉方向 |
| 錘子 Hammer | 下跌後，小實體靠上、長下影 | 潛在止跌；同形若出現在上漲後，稱吊人，背景不同 |
| 倒錘子／流星 | 小實體靠下、長上影 | 下跌後是倒錘子；上漲後是流星，不能只看形狀就判空 |
| 多頭／空頭吞噬 | 第二根反向實體包住前一根實體 | 比較的是實體，並不要求第二根影線也包住第一根 |
| 紡錘 Spinning top | 小實體，上下影線較明顯 | 猶豫或整理；不能直接視為買賣點 |

以上定義參考 [IG Academy](https://www.ig.com/uk/ig-academy/the-basics-of-technical-analysis/candlestick-patterns)，僅採用形態與傳統解讀。

| 型態 | 外觀與出現背景 | 傳統解讀／容易誤用之處 |
|---|---|---|
| 母子線 Harami | 大實體後出現被其實體包含的小實體 | 動能可能減弱；與要求全高低區間包含的 inside bar 不同 |
| 內包線 Inside bar | 第二根 H、L 落在前根 H、L 內 | 壓縮或整理，方向仍待突破；相等邊界需自行定義 |
| 晨星／暮星 | 長實體、小實體、反向長實體三根組合 | 反轉候選；經典版本含跳空及第三根深入首根實體的條件，跨市場需明訂版本 |
| 紅三兵／黑三鴉 | 連續三根推進，後根開盤位於前根實體內，收盤逐根提高／降低 | 持續推進的描述；漲跌幅已大時也可能接近耗竭 |

以上定義參考 [IG 型態清單](https://www.ig.com/en/trading-strategies/16-candlestick-patterns-every-trader-should-know-180615)。該頁也包含行銷性可靠度敘述；本文沒有把它的高／中／低評級當成實證或採用其勝率暗示。

### 從名稱變成可測條件

例如可提出一個「錘子候選」的研究版本：`body > 0`、`lower >= 2 * body`、`upper <= 0.25 * body`、`closeLocation >= 0.6`。其中上影線與收盤位置門檻是本文示範值，不是公認唯一標準。前置下跌、支撐距離、確認根、交易時點與失效條件仍需另外定義；改動任何一項，都已是另一套待驗證規則。

## 4. 實際看圖的順序

這是一個研究工作流程示例，並非買賣建議：

1. **先選市場與持有時間。** 分清股票、期貨、日內或波段；指標的「20 期」是 20 根 K 棒，不一定是 20 天。
2. **看大週期位置。** 例如日 K 或 60 分 K 標記已知前高前低、整理範圍與均線方向。採用何種高低點確認法須固定。
3. **寫清楚情境。** 例如只研究向上突破，或只研究區間下緣反彈，避免同一條規則同時代表追勢與逆勢。
4. **等小週期觸發收盤。** 例如 5 分 K 收盤突破已知壓力，或支撐附近出現吞噬；盤中候選與收盤確認分開記錄。
5. **檢查量能與波幅。** 若使用量增，先決定與過去幾根或相同時段比較；ATR 可用於衡量停損距離是否與當前波動相稱。
6. **先定失效、出場與部位大小。** 不只描述何時進場；同時寫明何時不再符合假設、持有多久，以及計入成本後是否仍值得研究。

支撐壓力的區域概念來自 [CME](https://www.cmegroup.com/education/courses/technical-analysis/support-and-resistance)，ATR 的用途來自 [Fidelity](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/atr)；上述組合與週期搭配是本文的工作流程提案，尚未測試績效。

## 5. 可優先比較的三個研究題目

下列都是待回測假說，參數僅供讓規則具體化，沒有執行回測，也不代表最佳參數。共同先採「訊號於第 t 根收盤確認，最早於 t+1 根開盤成交」，交易成本另計。

| 題目 | 可重現的初始規格 | 需要回答的問題 |
|---|---|---|
| 趨勢突破 | 無持倉時，`C[t] > SMA20[t]` 且 `C[t] > max(H[t-20..t-1])`，隔根開盤做多；收盤跌破前 10 根低點後隔根開盤出場 | 排除當根高點後訊號是否成立？相比單純持有，成本後有無增益？ |
| 區間回歸 | 用前 20 根 H／L 定義區間，區間寬度不超過 `4 × ATR14[t-1]`；收盤位於下方 20% 區域且 RSI14 上穿 30，隔根開盤做多；後續收盤達凍結區間中點、低於凍結下緣，或持有滿 10 根，隔根開盤出場 | 在訊號收盤時凍結上下緣；區間轉成下跌趨勢時的損失是否抵消反彈收益？這是收盤出場，無法保證根內風險上限 |
| 型態的額外價值 | 先測「前 20 根低點附近的多頭吞噬」：前根陰、當根陽、當根實體包含前根；當根低點距前 20 根最低價不超過 `0.5 × ATR14[t-1]`；隔根開盤進，持有 5 根後的下一根開盤出 | 與只有位置條件、同樣持有期的基準相比，吞噬條件是否增加成本後期望值？ |

三者均先限定做多、單一部位、不加碼；有持倉時忽略其他進場訊號，出場後重新等候。暖身不足、零波幅區間或缺值時不產生訊號。此表讓題目可實作，成交跳空、期間末未平倉與資金配置仍須在回測規格中明訂。

## 6. 台股與台指期應先固定的資料定義

- **除權息與還原價格。** 證交所有獨立的除權息參考價計算。研究上應記錄是否使用還原價格，檢查機械性價差是否被誤認為跌破或缺口；若用還原資料產生訊號，成交與損益仍需按一致的實際價格／股利方式處理。[TWSE 官方計算表](https://www.twse.com.tw/zh/announcement/ex-right/twt49u.html)
- **日夜盤與交易日。** 期交所明訂盤後交易屬於次一一般交易時段。日 K、前日高低、日內量比與 VWAP 都要寫明採日盤、夜盤、完整交易日或另訂錨點，不能直接把午夜當成同一種交易日邊界。[TAIFEX 盤後交易制度](https://www.taifex.com.tw/cht/4/aHIntroduction)
- **成交量口徑。** 固定股／張／口、是否納入零股、以及比較的交易時段；缺資料不等於零成交。這是資料驗證要求，不是量價訊號本身。
- **期貨連續月。** 需記錄使用逐月合約還是連續月，以及換月與調整方法；另做換月前後敏感度檢查，才知道突破是否只是資料銜接造成。這是本文的研究設計要求，尚未核對本專案實際資料供應方式。

## 7. 實證與回測限制

### 原始研究並沒有一致支持「認出型態就能獲利」

| 研究 | 市場與樣本 | 能支持的結論 | 外推限制 |
|---|---|---|---|
| Lo、Mamaysky、Wang（2000） | 美國 NYSE／AMEX、Nasdaq 個股日資料，1962–1996 | 部分頭肩、雙底等圖型下的報酬條件分布有額外資訊 | 研究是圖型資訊含量檢驗，不是蠟燭勝率表；作者明確區分資訊與可獲利策略。[MIT 作者全文，§III](https://web.mit.edu/wangj/www/pap/LoMamayskyWang00.pdf) |
| Marshall（2005），博士論文 | DJIA 成分股，1992–2002 | 使用 OHLC bootstrap，未找到所測蠟燭策略的優越表現，扣成本前也沒有獲利證據 | 負面結果限定於該樣本與規則。本次引用 2005 學位論文，未將其冒充 2006 期刊全文。[Massey 作者論文，摘要與第 5 章](https://mro.massey.ac.nz/bitstreams/cf13fcfc-21d5-4e4b-89b6-d4f8cf347a84/download) |
| Lu、Chen、Hsu（2015），工作論文 | DJIA，1992–2012，保留全期存續的 26 檔 | 八種三日反轉型態搭配 CL 分批出場、來回成本 0.5% 並處理資料探勘偏誤後有正面結果；MYR 出場的多數型態／趨勢組合未呈現顯著正報酬 | 績效綁定出場方式、樣本與成本。依排除未存續股票的取樣方式，本文另推論存在存續樣本的外推限制。[中研院作者原稿，§2.3–3.1](https://www.econ.sinica.edu.tw/1/archives/af3c98d367060d77) |

這些研究檢驗的樣本、型態及持有方式不同，不能用正反篇數投票決定某方法是否有效，也不能從美股日資料直接推出目前台股分 K 的績效。三份原文都沒有驗證本專案策略。

### 回測至少要交代哪些假設

- **未來資訊與重繪。** 若高低點需要右側 K 棒才確認，訊號只能在確認時可用；不能畫回過去便當作當時已知。大週期最終值與未完成 K 棒的 H／L／C 也不能提前使用。[TradingView 重繪文件](https://www.tradingview.com/pine-script-docs/concepts/repainting/)
- **同根成交順序。** OHLC 無法知道先碰停利還是停損。TradingView 的模擬器以開盤距高低點的遠近假設根內路徑；這是該平台的模擬選擇，不是真實逐筆路徑。本研究建議雙觸價案例使用較細資料，或同時揭露保守與樂觀情境。[官方 Broker emulator](https://www.tradingview.com/pine-script-docs/concepts/strategies/#broker-emulator)
- **成本與可成交性。** 報告佣金、稅費、價差、滑價、跳空與未成交假設；不能只比較進出場圖上的標價。[TradingView 交易成本模擬](https://www.tradingview.com/pine-script-docs/concepts/strategies/#simulating-trading-costs)
- **嘗試過多少規則。** 挑出眾多參數中的最佳回測會造成過擬合。Bailey 等提出 PBO／CSCV，指出單一保留集無法自行反映搜尋過多少設定；應保留全部試驗與失敗結果。[作者原文](https://davidhbailey.com/dhbpapers/backtest-prob.pdf)
- **按時間檢驗。** Walk-forward 以當時可得的歷史視窗調參，再用於其後期間；需先固定搜尋範圍、視窗與更新頻率。本文建議另保留最後的未觸碰測試區間，並避免看到結果後反覆修改它。[QuantConnect 官方定義](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization)
- **基準與樣本選擇。** 不只挑成功股票、行情或週期。比較單純持有、只有位置條件等適當基準，才能分辨型態是否增加資訊。[TradingView 選擇偏誤](https://www.tradingview.com/pine-script-docs/concepts/strategies/#selection-bias)

建議報告淨報酬、最大回撤、交易筆數、勝率、平均獲利／虧損、成本占比、持倉時間及不同市況結果。每筆期望損益可描述為「勝率 × 平均獲利 − 敗率 × 平均虧損 − 平均成本」，所以高勝率本身不能證明策略賺錢。

## 8. 與本專案現有能力的對照

以下是對公開程式碼基準 `df786c562f24eeaa5d07f8b3cd66abad960ee9c2` 的靜態查閱，沒有操作 App 或驗證券商連線。

- [指標登錄](../../src/lib/indicator-defs.ts)已有 MA、EMA、WMA、BOLL、VWAP、SAR、SuperTrend、Donchian、Keltner、MACD、RSI、KD、StochRSI、CCI、ATR、OBV、MFI、W%R、DMI／ADX、ROC、BIAS，共 21 種。
- [版面設定](../../src/lib/workspace.ts)的 K 線面板可重複新增、每張保存自己的週期，選項為 `1m`、`3m`、`5m`、`15m`、`60m`、`1D`，可用來對照同商品的不同週期。
- [ta 參考](../backtest-ta-reference.md)與 [實作](../../src/lib/ta.ts)提供 SMA、EMA、RSI、ATR、極值、offset 等積木；做「突破前 N 根」要排除當根。不能假設存在 `ta.macd()` 等未提供的函式。閉源回測引擎的實際成交與風控行為本次未驗證。
- [VWAP 實作](../../src/lib/indicators.ts)使用 `floor(time / 86400)` 分組。它與上游時間戳、台灣日夜盤及預期錨點是否一致，仍需用真實資料另外驗證，不能僅憑「有 VWAP」宣稱符合交易時段需求。
- 成交量分布／Volume Profile 可作為後續延伸，但單根 OHLCV 不能唯一重建各價位成交量。TradingView 自家作法採較低週期資料，且其 up/down volume 不是實際 buy/sell volume；若要精確成交價分布或主動買賣差，需另具相應逐筆資料與明確分類方法。[TradingView 計算說明](https://www.tradingview.com/support/solutions/43000502040-volume-profile-indicators-basic-concepts/)

建議後續先固定資料與成交規格，再比較第 5 節三個題目。現階段成果是方法與證據整理，尚無台股／台指期樣本外績效可供選定策略。

## 9. 本次目標：台指期／小台／微台的日內判讀提案

此節是依使用者選定商品與操作期間收斂的規格草案。週期、型態及參數都是待驗證的起始配置，尚未開發判讀面板或執行回測。

### 商品與時段

| 商品 | 期交所代碼 | 每口每點金額 | 原始來源 |
|---|---|---|---|
| 臺股期貨（大台） | TX | 新臺幣 200 元 | [TAIFEX 契約規格](https://www.taifex.com.tw/cht/2/tX) |
| 小型臺指期貨（小台） | MTX | 新臺幣 50 元 | [TAIFEX 契約規格](https://www.taifex.com.tw/cht/2/mTX) |
| 微型臺指期貨（微台） | TMF | 新臺幣 10 元 | [TAIFEX 契約規格](https://www.taifex.com.tw/cht/2/tMF) |

期交所代碼與券商／本專案代碼可能不同，例如本專案小台 root 使用 `MXF`。以實際月份合約識別商品；連續月可作觀察資料，但下單與損益必須對應具體合約。

一般日盤為 08:45–13:45，夜盤為 15:00–次日 05:00；到期合約最後交易日日盤提早至 13:30，且無該到期合約夜盤。實際交易日與到期日須讀行事曆及合約資訊，不能只依星期推斷。三商品時間見上表契約規格。夜盤交易歸屬次一一般交易時段，見 [TAIFEX 盤後制度](https://www.taifex.com.tw/cht/4/aHIntroduction)。

本提案將「日內」定義為選定交易時段內進出，日盤與夜盤分開統計；夜盤跨午夜仍是同一夜盤。本提案沒有假設使用券商的減收保證金當沖制度。

### 本地判讀的起始配置

| 層級 | 起始配置 | 輸出 |
|---|---|---|
| 方向 | 已完成的 15 分 K；EMA20 斜率與價格相對位置 | 向上、向下、條件混合或資料不足 |
| 觸發 | 已完成的 5 分 K；區間突破或順勢回踩 | 訊號待確認、條件成立、已失效 |
| 輔助觀察 | 1 分 K 與報價 | 細部價格、價差、資料新鮮度；第一版不增加獨立的 1 分 K 進場策略 |
| 位置與風險 | 當盤 VWAP、開盤區間、前一日盤／前一夜盤高低及 ATR | 成立理由、阻力或支撐距離、失效參考與估計風險金額 |

EMA 必須先用足夠已完成歷史 K 棒暖身，不能每天開盤從零便當作穩定趨勢；第一版採全交易時段歷史序列作 EMA 暖身，日夜盤訊號分別標記。VWAP 與開盤區間則各盤重設，並對照前一盤資料。這是提案的指標口徑，並非宣稱優於其他口徑。

第一輪優先比較兩個假說，分別保存結果，避免混成一套無法解釋的分數：

1. **開盤區間突破。** 以選定時段開盤後首 15 分鐘的完整資料固定高低邊界；區間完成後，5 分 K 首次由區間內收盤突破上緣／下緣，且已完成 15 分 K 方向一致，產生多／空候選。需要定義聚合起點、同盤重複突破與再進場限制。
2. **順勢回踩。** 15 分 K 方向已成立，5 分 K 回到事先選定的 EMA20 或當盤 VWAP 附近，之後收盤重新站回／跌回該參考，產生候選。EMA 與 VWAP 分成不同設定，距離容許值以 ATR 比例明訂；吞噬等型態可另做額外條件的對照試驗。

量能先作解釋欄位，與同商品、同盤別及相近開盤後時間的歷史量比較。資料不足時明示不足；不把開盤與午間、或大台與微台的口數混合成同一門檻，也不把三商品的同向訊號視為三份獨立證據。

### 出場與驗證規格

- 每個假說均需獨立固定初始失效價、停損觸發方式、時間出場與獲利出場；第一輪可比較固定 R 倍數與時間出場，但搜尋範圍須事先記錄。這些規格尚未定稿，不能直接拿候選提示交易。
- 當盤結束前停止新進場，並設定早於該合約收盤的平倉期限；兩個提前量可配置。正常日、到期日及特殊休市須分開處理。提示時間與實際已平倉是不同狀態。
- 部位試算使用「停損點數 × 每點金額 × 口數＋估計交易成本」，另確認保證金及總曝險。跳空或滑價可能使實際損失超過試算；同標的三種規模的部位要合併檢視風險。
- 訊號時點採收盤確認；模擬成交從其後可執行時間開始。逐根回放結果必須與同時點批次判讀一致，並測未完成大週期 K 棒、跨午夜、換盤、歷史缺段及資料修訂。
- 日盤與夜盤、TX／MTX／TMF 分開報告淨損益、回撤、筆數、成本與滑價敏感度，再評估是否共用規則。以真實富邦行情／歷史資料做回放；合成 demo 僅驗證流程與介面。

### 本專案接續工作的邊界

現有 [富邦介接說明](../FUBON.md)與 [能力限制](../../src/lib/fubon-support.ts)顯示：自動停損停利、觸價與定時平倉尚未支援；手動交易與提示不能被描述為已有委託保護。第一階段可規劃本地判讀、提示記錄與歷史回放驗證，實際自動交易須另行完成成交回報與執行能力。

現有 [時段模組](../../src/lib/intraday-session.ts)使用台灣牆鐘編碼，與 [Candle 型別](../../src/lib/types/market.ts)註記的 Unix seconds 需要在資料邊界釐清；不可混用後再計算 VWAP 或當盤高低。實作前還需驗證資料來源、分鐘標籤起迄、盤別及合約可用性。此節為規格整理，尚未證明即時判讀速度或任何策略獲利能力。
