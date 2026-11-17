# K 棒主圖縮放修正驗證（2026-11-17）

主圖普通 Line／Area／Histogram 疊加序列原本參與共同價格軸縮放。當 MA200 遠離可見 K 棒，均線範圍會把 K 棒壓成一條窄帶。現在預設由可見 K 棒決定主圖價格範圍；疊加仍使用同一價格座標、保留數值，超出範圍時裁切。需要查看遠處均線時可開啟工具列「含指標」，把可見時間範圍內的主圖指標一起納入價格軸。副圖維持自己的縮放。

「含指標」是單張圖表的暫時視圖選項，不改指標參數、隱藏狀態或其他圖表。切換時重新啟用價格軸自動縮放，保留目前時間視窗；關閉會恢復 K 棒範圍。重設視圖沿用此選項並重設兩軸。平時新增指標或平移仍保留既有的手動價格範圍。

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

## MA200 畫面外的顯示操作

新增回歸命令：`node scripts/verify-chart-autoscale.mjs --indicator-scale`。修前可重現 MA200 已有 61 個可見時段數值、全部高於價格軸上限，而且沒有可納入指標的按鈕；紅例 artifact 為 `/private/tmp/fubon-chart-autoscale-nf4Wf1`。

修後 **41／41 通過**，artifact `/private/tmp/fubon-chart-autoscale-SzBUVO`。1440 寬 MA200 案例在相同 logical range 299–359 下，預設 K 棒占主圖 69.79%，開啟「含指標」後占 12.34% 且 MA200 完整進入範圍，關閉回到 69.79%。計算資料、成交量與 RSI 保持相同。另涵蓋明暗 1440／390 寬、Bollinger 與 80,000 價格帶的上下緣、手動縮放後切換會重新校準、重設視圖沿用選項、鍵盤切換及兩張圖表各自獨立。

原本的預設縮放案例也以最新來源再跑 **66／66 通過**（artifact `/private/tmp/fubon-chart-autoscale-2o1bJ4`），合計 107 項；獨立 Standards／Spec review 無未解 confirmed findings。全部隔離 QA 程序已清理。

真人 Paper／夜盤的第二張 3 分 K 圖已開啟「含指標」，實際看到 MA200 位於 K 棒上方，第一張圖維持預設。截圖 `/private/tmp/fubon-ma200-visible-20261117.jpg`；沒有變更交易模式、重啟後端或送出委託。完整前端 6,028 passed／2 skipped，型別與 build 通過。
