# Fubon Trading

[Shioaji Pro](https://github.com/Sinotrade/shioaji-pro-app) 的獨立 fork，保留開源交易介面，行情與交易服務改接 **富邦新一代 API（Fubon Neo 2.5.0）**。

本專案與永豐金、富邦均無官方合作或背書。授權維持 [AGPL-3.0](LICENSE)。[原始專案介紹](docs/UPSTREAM_README.md)。

![展示模式交易介面](docs/images/fubon-demo.jpg)

## 啟動

需要 Node.js 22.12+、pnpm、[uv](https://docs.astral.sh/uv/)。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm start
```

開啟 **http://127.0.0.1:5179**。僅綁定本機，API 使用 `21323` 埠；埠被占用時停止啟動，不會接手其他交易服務。

預設為 **展示模式**：合成行情、模擬帳戶與本機撮合，不需帳號、不登入券商。頂端持續標示模式。

pnpm 12 若阻擋 esbuild 安裝腳本，可執行 `pnpm approve-builds esbuild --yes`；專案只允許該項建置依賴。

## 使用富邦行情

```sh
uv sync --directory server --extra fubon
```

在本機 `.env` 填入 `FUBON_PERSONAL_ID`、`FUBON_API_KEY`、`FUBON_CERT_PATH`、`FUBON_CERT_PASSWORD`，將 `FUBON_MODE` 改為 `paper`，重啟 `pnpm start`。API Key、憑證與帳號需完成富邦規定的申請及權限設定。

- `paper`：富邦真實行情，委託只進本機模擬帳簿。
- `live`：必須同時設 `FUBON_MODE=live` 與 `FUBON_ENABLE_LIVE_TRADING=true` 才能發送正式委託。修改後需重啟。
- 夜盤另設 `FUBON_SESSION=afterhours`。
- 登入失敗時顯示錯誤，不會退回合成行情。
- 金鑰與憑證只在 Python 服務使用，不會送給瀏覽器。不要將秘密放進 `VITE_*`。

**尚未使用真實富邦帳號驗證登入、行情權限、改刪單或成交回報。** 富邦公開測試帳號目前僅提供證券；本機 paper 不是券商期貨測試環境。

## 功能範圍

| 功能 | 狀態 |
| --- | --- |
| K 線、均線、五檔、自選與可拖拉版面 | 沿用開源介面，改接本機富邦 bridge |
| 股票、期貨快照／即時行情／1 分 K | 已實作 SDK 轉接 |
| 期貨具體月、連續月看盤與歷史分 K | 已實作；未調整換月價差 |
| 股票現股整股／零股委託、期貨單式委託 | 已實作；整股張數轉成富邦股數 |
| 委託查詢、改價、取消、期貨減量 | 已實作；改刪前重新向券商查詢 |
| 股票部位、銀行餘額、期貨部位與權益 | 已實作 SDK 轉接；銀行餘額受交割銀行支援限制 |
| 本機模擬交易 | 已實作；不會呼叫券商下單 API |
| 複式單、信用下單、股票改量、零股即時行情 | 尚未支援，明確拒絕 |
| 選擇權篩選／歷史分 K、排行、指數成分與籌碼分析 | 尚未完成轉接 |
| 括號停損停利、觸價／定時／兩腳自動執行 | 停用，待成交回報與明細相容性驗證 |
| 自動產生策略、批次回測與樣本外驗證 | 後續工作，不包含在這次 API 遷移 |

上游 Tauri 外殼、AI Agent、策略回測是未公開的專屬模組，fork 不會取得；這裡交付 Web 交易終端。

模擬帳簿、自選清單存於服務記憶體，重啟即重設。撮合不模擬委託佇列、部分成交、手續費、稅或市場衝擊，不能用於評估策略績效。試撮或超過兩分鐘的舊報價不產生模擬成交。括號停損停利、觸價自動單、定時平倉與兩腳價差自動執行目前停用；不能視為部位已有自動保護。

## 開發與測試

```sh
pnpm server           # 只啟動 Python bridge
pnpm dev              # 只啟動前端
pnpm build            # TypeScript + 正式 Web build
pnpm test             # 既有前端測試
uv run --directory server --extra test --extra fubon pytest
```

建置後亦可執行 `pnpm server`，從 http://127.0.0.1:21323 使用 `dist/` 靜態終端。API 文件在 http://127.0.0.1:21323/docs。

介接與官方規格來源見 [FUBON.md](docs/FUBON.md)。上游私有桌面發佈 workflow 在此 fork 不執行。
