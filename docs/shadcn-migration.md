# shadcn/ui 元件遷移

本專案的共用介面控制改用官方 shadcn/ui（Radix、new-york），來源放在
`src/components/ui/`，設定在根目錄 `components.json`。行情 Canvas、五檔／閃電
梯形、grid 面板與交易專用布局仍由原本的程式及 vanilla-extract 負責。

## 元件與主題

- 按鈕、文字／數字／日期／色彩輸入、多行輸入、原生選單、Checkbox、Switch、
  Slider、RadioGroup、Label、Field 與 Table 皆使用共用元件；非 UI 基礎層不再
  直接宣告這些原生 JSX 控制項。
- Passkey 頁面使用 Card、Button、Alert、Separator；驗證成功後與交易介面共用
  React root，原先的工作階段與首次註冊授權流程不變。
- 設定、版面庫、面板庫、技術指標、自訂指標、繪圖物件設定與委託確認使用
  `TerminalDialog` 組合 shadcn Dialog。它保留 Escape stack、忙碌鎖定、IME
  與焦點返回；繪圖輸入框的 Escape 還原保留專用處理。
- 設定、指標及繪圖分頁使用 Tabs；報價欄設定使用 Popover + Tabs；面板連動
  選單使用 DropdownMenu；條件單選項使用 ToggleGroup。
- 通知改用 Sonner；通知內容持續訂閱隱私與大小設定，已出現的文字也會即時遮蔽。
- 行情／交易專用浮層仍保留原有定位及狀態邏輯，其內部共用控制項使用 shadcn。

shadcn 語意 CSS 變數接到既有 `theme.css.ts` palette，支援深色、淺色、
自訂配色及台股／國際漲跌慣例。延續舊 WebView 的建置目標，使用 Tailwind 3
與 tailwind-merge 2；透明色使用既有 Dim 語意 token，不依賴 Tailwind 4 或
新的 color-mix 語法。舊版 Safari／原生 WebView 仍需實機驗收。

`NativeSelect` 的 `wrapperClassName` 負責外框的 flex／grid 尺寸；透明疊在帳號
標籤上的選單使用全尺寸外框與 `showIcon={false}`，原生 ref 仍傳給 select。

Radix 控制項可能輸出 button／span，因此共用 `keyboard-target.ts` 同時供交易
與圖表快捷鍵使用，避免勾選框或滑桿上的按鍵變成下單方向、繪圖或全部刪單指令。
React、React DOM 與 scheduler 固定在同一 bundle chunk，避免 vendor 尺寸拆分
與 Radix scroll-lock 相依形成 CommonJS 初始化循環。

## 驗證與試用

```bash
pnpm build
pnpm test
pnpm test:ui
```

`test:ui` 需要 uv 與 Chrome（可用 `PLAYWRIGHT_CHANNEL` 指定已安裝的 Playwright
瀏覽器 channel）。它建置正式前端 bundle，另啟展示後端與 preview，使用臨時
Passkey 資料庫和虛擬驗證器；不讀 Keychain、不連富邦、不確認送出委託。預設
測試埠是 5186／21426，已占用會拒絕啟動，也可用 `SHADCN_UI_PORT`／
`SHADCN_API_PORT` 指定。正常結束或 SIGINT／SIGTERM 都會清理本次子程序。
截圖留在輸出的臨時資料夾，可用 `SHADCN_ARTIFACT_DIR` 指定位置。

此次驗證結果：

- TypeScript project build 通過。
- Vitest：350 個測試檔、5,526 項測試通過；原有 1 檔／2 項略過。
- CI 的 Python release-notes 工具測試：10 項通過。
- 正式 bundle 的 Chrome 驗收：Passkey 註冊／解鎖、展示行情 LIVE、深淺及自訂
  主題、焦點返回、分頁鍵盤、連動選單、報價欄設定、開啟並取消委託確認、390px
  窄視窗均通過。SIGTERM 中斷後兩個測試埠確實釋放。
- AI review 找出的快捷鍵、分頁高度、選單外框與語意色問題已修復並重驗。

此 fork 未含 `src-tauri/` 與私有原生 shell，因此上述是 Web／正式前端 bundle
驗收；未宣稱原生 App、實機 Touch ID、舊 WebView 或真實券商交易已驗收。
一般開發與使用仍沿用 README 的 `pnpm start` 流程。

## 畫面（展示資料）

![Passkey 登入](images/shadcn-passkey.png)

![淺色設定](images/shadcn-settings-light.png)

![窄視窗設定](images/shadcn-settings-narrow.png)
