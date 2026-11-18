# TMF 指標用途與暖身來源（2026-11-18）

研究問題：MACD、RSI、KD／Stochastic、Bollinger、ADX/DMI、當盤 VWAP 能提供哪些不同資訊，適合如何放入 1m／3m／15m 的「區間價差＋順勢」候選模型？本筆記只界定特徵與限制；未證實任何組合能獲利，也不構成啟動 Paper／Live 的依據。

## 指標分工：來源事實與本輪研究假設

| 指標 | 官方說明與限制 | 本輪可檢驗的用途（研究假設） |
| --- | --- | --- |
| **1m／3m MACD(12,26,9)** | MACD 為快慢 EMA 差，signal 為 MACD 的 9 期 EMA；hist = MACD − signal。它衡量趨勢動能，區間行情容易反覆交叉。不能把零軸或交叉本身視為獲利證據。[Fidelity MACD](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/macd)、[TA-Lib MACD](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_MACD.c#L391-L496) | 3m 描述方向與動能；1m 描述進場時機。分別比較 hist 符號、hist 變化，避免把「仍為負但回升」誤寫成已轉多。**本輪不加 15m MACD，15m 保留既有 ER8。** |
| **RSI14** | 0–100 的動能指標；傳統 70／30 是超買／超賣參考，但強趨勢可以長時間停留在極端區。[Fidelity RSI](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI) | 在已辨識的區間內研究極端後回復；順勢模式研究回檔後恢復。70 就放空、30 就做多不應成為無條件規則。 |
| **1m／3m KD(9,3,3)，遞迴版** | Stochastic 衡量 close 在近期 high–low 區間的位置，常見 80／20 是超買／超賣參考；Fidelity 描述其較適用於寬幅區間或緩慢趨勢。富邦期貨也提醒高低檔鈍化及過度震盪時頻繁訊號的問題。[Fidelity Stochastic](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/fast-stochastic)、[富邦期貨 KD](https://www.fubon.com/futures/home/teaching/program/08c87b26-4bbe-4721-88c7-5fce90aefcb8) | 區間模式比較極端區的 K／D 交叉或回復；順勢模式比較順向回檔後的交叉。盤整內仍可能反覆交叉；強趨勢的高 K 不能直接作放空理由、低 K 不能直接作做多理由。與 RSI 分別測試，再問合用是否提供增量。 |
| **3m Bollinger(20,2σ)** | SMA20 上下加減 2 個標準差，帶寬隨波動改變；價格可沿帶或越帶持續，收窄後也可能出現假突破。[Fidelity Bollinger](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/bollinger-bands) | 區間模式描述相對位置及回到帶內；順勢模式描述壓縮後擴張。觸帶不能單獨判斷反轉。固定 close、SMA、母體標準差的計算約定；TA-Lib 方差以 N 為分母。[TA-Lib VAR](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_VAR.c) |
| **3m ADX／DMI14** | ADX 描述強度，+DI／−DI 描述方向。常見 ADX >25／<20 的解讀是強趨勢／弱趨勢，20–25 沒有明確解讀；這是一般圖表慣例，來源沒有驗證為 TMF 3m 最佳門檻。[Fidelity ADX](https://www.fidelity.com/viewpoints/active-investor/average-directional-index-ADX) | 用作區間／順勢的候選 gate；高 ADX 不能直接推論上漲。固定門檻後比較增量效果，避免看完結果反覆挑門檻。 |
| **當盤 VWAP** | 精確定義為逐筆 Σ(成交價 × 成交量)／Σ成交量，自盤初累計；來源將其用作盤內價格基準。[Schwab VWAP](https://www.schwab.com/learn/story/how-to-use-volume-weighted-indicators-trading) | 研究相對當盤成交重心的位置與回歸。若資料只有 minute OHLCV，使用 Σ(HLC3 × minute volume)／Σminute volume 必須標 **VWAP 近似值**：每分鐘代表價替代全部逐筆價，不能聲稱等同逐筆精確 VWAP（由前述公式推得）。 |

**重複資訊（依公式的推論）**：MACD、RSI、KD 都是價格動能的不同轉換；RSI 比較漲跌幅，KD 比較 high–low 區間位置，兩者有差異但不能當獨立證據。MACD 的快慢均線、Bollinger 中線和價格相對 VWAP 也都含平滑價格／相對位置。ADX／DI 增加高低價方向與平滑強度，Bollinger 帶寬增加離散程度，VWAP 增加成交量權重；仍非互相獨立的證據。不能把多項同向當成多張獨立選票。公式來源：[MACD](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/macd)、[RSI](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI)、[KD](https://www.fubon.com/futures/home/teaching/program/08c87b26-4bbe-4721-88c7-5fce90aefcb8)、[Bollinger](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/bollinger-bands)、[DMI](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/dmi)、[VWAP](https://www.schwab.com/learn/story/how-to-use-volume-weighted-indicators-trading)。

## KD 的公式必須明定

本輪 1m／3m 都只使用完整棒，固定以下 **研究定義**，不把「KD(9,3,3)」當作所有平台唯一公式：

```text
H9 = 最近 9 根完整棒（含本棒）的最高 high
L9 = 最近 9 根完整棒（含本棒）的最低 low
RSV = 100 × (close − L9) / (H9 − L9)
K = (2 × prevK + RSV) / 3
D = (2 × prevD + K) / 3
```

RSV、K、D 的遞迴公式有 [富邦期貨公式段](https://www.fubon.com/futures/home/teaching/program/08c87b26-4bbe-4721-88c7-5fce90aefcb8) 支持；該頁敘述另稱 D 通常是三日 SMA，與其公式段不同，因此本輪以**上列公式**為準。**初始 prevK=prevD=50，H9=L9 時 RSV=50** 是本輪明定的邊界選擇；第 9 棒首次算 RSV 並更新 K、D，第 10 棒才有兩組有效 K、D 可比較變化／交叉。初始 50 是種子，不能當成第 8 棒已觀察到的 KD。

**這不等於 TA-Lib `STOCH(9,3,SMA,3,SMA)`。** 後者將 RSV 做三期 SMA 得 slow K，再將 slow K 做三期 SMA 得 slow D；兩者輸出對齊的最低完整棒數是 (9−1)+(3−1)+(3−1)+1 = **13**，且零 high–low 差時其原始值設為 0，而本輪設為 50。SMA 與係數 1/3 的遞迴、種子及零區間處理都不同，不能用相同參數名稱宣稱逐點相容。[TA-Lib STOCH lookback](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_STOCH.c#L140-L151)、[原始值及兩段平滑](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_STOCH.c#L472-L509)、[SMA lookback](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_SMA.c#L104-L106)。

## 完整棒最低數量

下表除 KD／VWAP 的本輪定義外，以 **TA-Lib 官方 v0.6.4、default compatibility、unstable period = 0** 的 lookback 為可重現參照；lookback 是零起算的首個可輸出 index，所以所需棒數 = lookback + 1。這是最低可計算量，不代表遞迴指標已消除 seed 影響；EMA 種子依賴、可丟棄額外暖身期的問題見 [TA-Lib EMA 原始碼](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_EMA.c#L278-L337)。本輪研究須以自己的明定種子、平盤及缺值規則為準，不能只因最低棒數相同就宣稱逐點 TA-Lib 相容。

| 輸出 | 首值需完整棒 | 若用本次 − 上次值 | 推導與直接來源 |
| --- | ---: | ---: | --- |
| MACD(12,26,9) 含 signal／hist | **34** | **35** | (26−1)+(9−1)=33 lookback；差分再需一個有效前值。[MACD](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_MACD.c#L391-L400)、[EMA lookback](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_EMA.c#L104-L105) |
| RSI14 | **15** | **16** | 14 次 close 差需要 15 個 close。[RSI lookback](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_RSI.c#L105-L111) |
| KD(9,3,3)，本輪遞迴版 | **9** | **10** | 依上節的 seed 及完整 9 棒 RSV 定義推得；交叉也需第 10 棒。首值可算不等於種子影響已消除，亦不是 TA-Lib SMA 版的 13 棒。 |
| Bollinger SMA20／2σ | **20** | **21** | SMA lookback = 19；帶寬變化也需前一個有效帶寬。[BBANDS](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_BBANDS.c#L129-L134)、[SMA](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_SMA.c#L104-L106) |
| +DI／−DI14 | **15** | **16** | 各自 lookback = 14；不能據此推論 ADX 也只需 15 棒。[+DI](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_PLUS_DI.c#L108-L113)、[−DI](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_MINUS_DI.c#L108-L113) |
| ADX14 | **28** | **29** | lookback = 2×14−1 = 27。[ADX](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_ADX.c#L108-L109) |
| 當盤 minute VWAP 近似 | 第一個完整且累計量 >0 的 1m 棒 | 需前一有效值 | 無固定 14／20／26 棒窗；盤初基準只有少量累計成交量，資料缺失不能用未發生的量補齊。[Schwab 定義](https://www.schwab.com/learn/story/how-to-use-volume-weighted-indicators-trading) |

**15m MACD 的當盤暖身陷阱**：TMF 一般盤 08:45–13:45 共 300 分鐘，只能形成 **20 根完整 15m 棒**；到期契約最後交易日提早至 13:30，更少。因此當盤重設的 15m MACD 一整個日盤都達不到 34／35 棒。用第一筆 EMA seed 很快產生數值，不能寫成已完成上述暖身。本輪僅比較 1m／3m MACD，15m 不加入 MACD。[期交所 TMF 規格](https://www.taifex.com.tw/cht/2/tMF)、[MACD lookback](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_MACD.c#L391-L400)。若 session-reset 且無缺棒，3m MACD 的首值／hist 變化最早分別在 102／105 分鐘後，ADX14 首值／變化在 84／87 分鐘後（以上棒數 ×3 推得）。

## 因果接續與比較約定

以下是本輪研究的資料規則，不是官方來源保證有效的交易規則：

1. **只吃已完成棒。** 在 1m 決策時間 t，3m／15m 特徵的 `available_at` 必須 ≤t；未完成聚合棒不得提前提供最終 high／low／close。依這些 OHLC 公式推論，提前取得最終值即引入未來資訊。[ADX 輸入與計算](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_ADX.c)、[MACD 輸入與計算](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_MACD.c)
2. **seed、暖身和持倉時段分開定義。** Session-reset 每盤重新暖身；跨盤延續只能引用決策前真實歷史，訓練／驗證邊界可以接續既有過去狀態。不得以驗證未來資料回補 seed，也不能跨缺資料區間假裝連續。EMA 遞迴及 seed 選擇會改變初期輸出，故需固定並記錄。[TA-Lib EMA](https://github.com/TA-Lib/ta-lib/blob/v0.6.4/src/ta_func/ta_EMA.c#L278-L337)
3. **VWAP 的「當盤」明確固定。** 本輪若採日盤與夜盤各自重設，應在 08:45／15:00 重設；夜盤跨午夜仍延續同盤。這是研究的 anchor 約定；期交所規格為日盤 08:45–13:45、夜盤 15:00–次日 05:00。[期交所 TMF 規格](https://www.taifex.com.tw/cht/2/tMF)。若盤中才開始有資料，標記「盤中起算近似」，不能稱完整當盤 VWAP。
4. **逐項比較增量效果。** 以固定基準先加單一資訊類別，再比較有限組合；暖身不全時標不可用，保留共同可用期間與全期間覆蓋率。來源只支持指標定義／一般用途，沒有提供 TMF 此組時框、成本與執行條件下的獲利證據；績效必須由事先固定規則的樣本外研究另行回答。
