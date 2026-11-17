# K 棒主圖縮放修正驗證（2026-11-17）

主圖普通 Line／Area／Histogram 疊加序列原本參與共同價格軸縮放。當 MA200 遠離可見 K 棒，均線範圍會把 K 棒壓成一條窄帶。現在主圖價格範圍由可見 K 棒決定；疊加仍使用同一價格座標、保留數值，超出範圍時裁切。副圖與既有 band 專用尺度維持原本算法，不強制覆寫使用者手動價格範圍。

## 真元件重現與回歸

Runner：`node scripts/verify-chart-autoscale.mjs`；單一紅例命令為 `node scripts/verify-chart-autoscale.mjs --baseline`。使用真 CandleChart、lightweight-charts 及計算結果，只在測試 Vite transform 記錄 createChart 回傳值做座標量測，沒有替換 autoscale 公式。

| MA200 案例（1440 寬） | 修前 | 修後 |
| --- | --- | --- |
| 可見 K 棒 | 相同 61 根 | 相同 61 根 |
| K 棒最低／最高 | 39,850–40,449.64 | 相同 |
| K 棒占主圖高度 | 12.34% | 69.79% |
| 價格軸範圍 | 39,354.11–44,212.89 | 39,762.32–40,621.47 |

最終 **66／66 通過**：無疊加、MA200、MA5、Bollinger200、遠端 band、MA200 area、MA200 histogram、組合疊加；各測 1440／390 寬及 recent60、zoom40、pan60、older60 範圍。全部自動縮放案例占比為 69.76–69.80%。RSI／成交量的可見原始值與對照相等，保留各自的完整縮放。手動 39,000–45,000 在新增 EMA120 與平移後仍保留。

- 紅例 artifact：`/private/tmp/fubon-chart-autoscale-PdQ9cc`。
- 綠例 artifact：`/private/tmp/fubon-chart-autoscale-UilrrH`，含 66 張圖、summary、來源 hashes 與量測。
- 隔離 Vite 6192、fresh browser、全部 API fixture，外網請求 0；未使用真人 session、SDK 或交易。建立的 QA 程序均已清理。
- `tsc -b`、build 通過；完整前端 6,014 passed／2 skipped。獨立 Standards／Spec review 無未解 confirmed findings。

另於真人 5784 的夜盤兩張圖確認 K 棒比例恢復，原指標、數值與成交量保留。只改前端，沿用 Paper／afterhours 後端與既有 Passkey 工作階段，未執行委託。
