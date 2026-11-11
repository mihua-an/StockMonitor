# 第三階段離線驗收入口

從專案根目錄執行：

```powershell
python scripts/diagnostics/check_offline.py --only load
python scripts/diagnostics/check_offline.py --only browser
# 同一環境與 harness 載入修改前 renderer，僅覆寫新建暫存副本：
python scripts/diagnostics/check_offline.py --only load --phase3-baseline
python scripts/diagnostics/check_offline.py --only browser --phase3-baseline
```

`load` 使用正式 RealtimeViewStore／共用 scheduler，12 商品 × 4 callback 消費者、合成 bounded queue、一次斷線重連與 gap resync，另測台股 canonical latest-state checkpoint 及 Futu Python native adapter（fake extension）→正式 DurableRecorder/Writer/SQLite。`offered` 是合成生產數、`accepted` 是測試佇列收件、`processed` 是 store 接受 delta 或 worker 完成的事件；不是券商收件／GPU 呈現。renderer 的 `rejected` 包括被新 snapshot 水位取代的舊 delta。末尾 12 個主動 snapshot reconciliation 另外記錄，不能當成所有漏資料都由自動 resync 即時恢復。

`browser` 使用正式 monitor HTML／dashboard component graph，但 API/IPC 都是假資料且 WebSocket 禁用；量測掛載、切離、返回、listener/timer/frame 與關閉中的初始化。這是正式元件的生命週期驗收，**不是帶完整行情的正式 dashboard 壓測**。renderer 的 `startupAcceptance` 在空行情 fixture 下可為 false，不能把本測試的 ok 誤當正式開盤驗收。

兩種入口都在新建 `%TEMP%/stockmonitor-check-*` source-only 副本執行，報告保留在該目錄。Python/Node guard 禁止回到原專案讀寫及網路／SDK；Chromium 封鎖網路且 profile 位於同一暫存根。sandbox 若使 Electron 未執行入口，缺少 `browser-result.json` 必須報 FAIL，不能只看 process exit 0。一般桌面環境需允許啟動這個獨立 Electron 測試程序。



舊的 loopback opening 實驗（`opening.html`／`opening_renderer.mjs`）在 2026-09-30 移除：它的 runner 早已不存在，US 路徑依賴已刪除的 `MoomooFocusedStore`。
