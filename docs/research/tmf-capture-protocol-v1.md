# API持續錄存與五檔成本研究 v1（2026-11-18）

使用者授權持續保存API逐筆與五檔、離線訓練回測；不購買資料，Paper維持停止。行情收集不送委託、不改計畫、不部署模型；關閉面板或鎖定不停止收集。服務重啟保留設定，仍須Passkey解鎖才能登入SDK。不能補回開始錄存以前的五檔。

## 錄存與研究資料

只保存既有Paper模式的正式富邦行情，TMFR1由官方有日期的交易窗口解析為實際月契約；用實際symbol、月份、開盤日與日夜盤標記，不靠星期推夜盤日期。別名只在訂閱時解析，跨盤／換月沿用broker的明確重訂閱。介面顯示收到兩個真正subscription ACK及新成交／五檔才稱收集；不能以socket.connect返回代替確認。舊epoch／window ACK不能確認新契約。

Broker原生回呼在解析、等待broker.lock及alias迴圈前取received_us／monotonic_ns，只將原JSON放入非阻塞佇列。行情data queue上限10,000及32MiB；連線控制另存，滿載亦保留遺失計數。寫入獨立SQLite WAL／FULL同步，保留原生event(data／snapshot)、序號、微秒來源與接收時間、packet SHA及試撮。不同價量但相同serial標衝突；沒有serial不靠時間價量去重。重連snapshot不當新成交；相同來源id／payload的重複仍保留原文而不重複統計新成交。

停止／重啟／錯誤、佇列或控制遺失、訂閱與窗口變動另留audit。writer失敗、磁碟不足512MiB、另一writer占用都停止接收並顯示錯誤；未能寫錯誤時，未正常結束run仍是持久缺口證據。正常關閉先停止接收再排空。沒有自動刪行情。這是盡力記錄，不能證明交易所沒有漏送；資料會隨時間增加。

研究只用已完成官方時段，且至少晚60秒；要求覆蓋90分暖身前一完整分鐘起至原退出期限後3秒（原盤尾前5分鐘）。這是研究決策區間覆蓋，不是整盤每筆都已驗證。已知停止、重連、失去訂閱、寫入、hook或未正常結束缺口與此區間重疊即不列有效日。後續另核對正式成交與官方1m，逐動作檢查BBO新鮮度，不因粗略coverage過關就准許成本績效。

queue／控制遺失與hook錯誤可能到writer flush／輪詢才記錄，不能把audit時間當實際缺口開始。這類沒有真實起點的marker，以該run開始至audit記錄的全部範圍保守排除；即使flush已跨研究／官方收盤邊界仍不能通過。可能多排除有效資料，不猜測不存在的drop時間。此reader規則兼容持續運作中的錄存，不需重啟才能使延後marker有效。

API資料量是單邊口數；不沿用公開CSV的B+S單位。多筆trades共用packet時間與serial，沒有每筆時間／順序真值；不偽造個別serial。秒級價量依max(exchange_us,received_us)分組，只用已完成的可用秒，因此晚到的舊成交不會進入早先特徵。保留原始來源時間供對帳；多筆packet在分鐘首秒可能跨界時，前後兩分鐘標記歸屬不明，不以猜測open／close修補。

官方1m快取每台北日18:00後由既有broker讀最近7個曆日之日夜盤（API公開說明約17:30才提供當日歷史），保留實際月份與物理時間；以前已保存的日快取不覆寫。同分鐘來源修正只在新的frozen版本生效。完整300／840分鐘與單月份仍用原learning_data.quality；研究週期仍為已完成1m／3m／15m。期間資料不足就保存insufficient，不假造秒棒或降低原交易採用門檻。

## 預先固定的訊號、特徵及模型

原direction_execution的confirmed-fixed／paired-fixed區間與順勢候選不改，hybrid兩方案皆保留。各source比較rule、coarse、micro三濾網，共6政策／盤。coarse為63維共同K棒＋side／plan／stopATR／targetATR／已知成本ATR／盤內比例／計畫風險／過去共同股票＋TMF方向，共71維；micro再加原17維秒價量與7維五檔，共95維。兩版本與rule使用同一可用特徵候選集合，另報被排除的原訊號數。秒特徵不足、決策時BBO或5秒前BBO過期時不補0。

五檔特徵固定為spreadATR、買一賣一量失衡、五檔量失衡、中價距最後可用秒VWAP／ATR、book age、5秒一檔失衡差與spread差／ATR。不稱完整OFI、主力意圖或心理真值。共同股票＋TMF輔助沿用父recovery-lock frozen中的過去模型，取截止最晚且訓練label_end早於本輪最早開盤日的版本；驗證父frozen、model hash、四股票＋TMF資產及截止，缺模型則不足，不以零代替。

分鐘訊號、ATR與63維亦須符合接收因果；不能只保護秒特徵。全部決策固定在完整分鐘收盤後5秒（原生有效訊息最長接受5秒延遲），逐動作再檢查使用過的分鐘packet最晚可用時間不晚於決策，否則排除並記診斷。秒特徵／五檔在同一延後時鐘計算，再等1秒執行，原持倉截止不延長。這是根據可對帳原生成交重建的離線資訊可得性假設，並未量測歷史K棒API實際發布延遲。

按有效開盤日60/20/20分development／validation／reused-history。development內30/40/50/60%三折，最後用development前80%fit、後20%calibration；所有fit標籤（含固定期限後4秒保守buffer）必須早於calibration首日台北零時，夜盤跨午夜要purge。每個source／filter分別三頭學normal／stress／delayed的NTD條件平均，再取最小；不直接學事後最差值、不當勝率或統計下界。未送出／無成交為0，持倉後未知退出為censored，不能當0或平倉。

至少100個動作／20個fit開盤日、五分鐘每側每plan保留最早候選，等日權重。因整個來源盤的品質檢查會使用盤尾資料，fit還要求該官方window完全結束於cutoff之前，避免夜盤截止後的品質資訊決定早期fit納入；比只purge跨界label更保守。LightGBM regression、7葉／depth3／leaf40／L2=100／learning_rate .03／max_bin63／150輪／seed42／單執行緒固定。不從後段改參數。paired模型兩側預估差至少30元；訊號閾值0。相同完整資料／程式／分鐘版本不反覆訓練；新來源版本保留全部前次結果。定期重用的歷史不能宣稱每次都是新樣本外。

fit只使用三個情境退出皆可驗證的complete-case標籤，另記censoredFitActions；這是完整退出樣本的條件平均，缺漏若非隨機可能有選擇偏差，不能當全部機會的期望。後段實際挑選的曝險若censored仍整個情境不合格，沒有把未知交易補0；採用仍關閉。

## 報價成交模擬

全為一口的條件模擬，五檔深度不能保證真實成交。只用可用時間已到、來源時間不來自未來且不超過1秒的雙邊報價。決策至少1秒後才執行，IOC觀察期限2秒；不可把被採用舊報價的原時間當成交時間。Buy使用ask再加2點，Sell使用bid再減2點；反向退出同理。每邊費20元（尚為假設）、稅率.00002逐口取整；stress每邊再加2點，delayed再晚60秒且不延長原持倉期限。

原結構stop／range中線target及trend R目標、每盤2次／每側1次、1000元估計預算與10點進場偏離限制保留。多單以bid觸發stop／target、空單以ask，觸發後仍等1秒才以當時新鮮報價模擬退出；到原期限同樣延遲後退出，不從後來最低價挑時點。進場沒有新鮮報價不送出；已持倉卻缺退出報價，該政策／情境後續曝險未知，淨額標null並阻擋資格，不能丟掉該虧損或假設之後已平倉。

在實際模擬entry重檢至少30點結構距離、range至少1.3R及3倍已知成本，trend以實際stop距離重新設2R。延遲／更好成交價也不能讓過窄stop通過；延後決策／IOC實際成交不得越過原last_entry。

逐筆對帳mid benchmark gross−spread−slippage−fees−tax＝net，同時實際模擬gross−fees−tax＝net；mid僅分解成本，不當成交價格。回撤用收到的五檔清算估值及其順序，不代表未觀測市場極值，也不模擬排隊、部分成交或衝擊。

觸發與回撤標價皆排除接收時已超過1秒的舊報價；缺段不當作可清算價格或未觀測市場極值。

資格沿用校準每情境20筆／每分支5筆及淨額與去最佳日為正；發展每折30筆、分支壓力合計20筆且正；validation30筆、reused-history100筆、歷史每分支30筆且正。無合格候選selected=null。費率與真實成交限制、重用歷史及新日期前測仍需核對；通過數值也保持executionAllowed／adoptionAllowed=false，不自動啟動Paper。

來源：[富邦期貨WebSocket／ACK與別名換月](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/websocket-api/getting-started/)、[逐筆](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/websocket-api/market-data-channels/trades/)、[五檔](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/websocket-api/market-data-channels/books/)、[歷史K棒](https://www.fbs.com.tw/TradeAPI/docs/market-data-future/http-api/historical/candles/)。
