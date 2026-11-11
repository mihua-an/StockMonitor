import { $ } from "../../core/utility.js";
import { usMarketSession } from "../realtime/futu_us_market_session.js";

// 新增交易 opens the standalone trade window (Electron BrowserWindow) and refreshes the account page when that window
// reports a change. The in-page globalTradeModal it replaced had no way to be opened any more, yet its whole form,
// Enter navigation, submit and background-sync flow was still initialized on every start; it is removed (N04).
// The trade window owns submission and its own post-add sync (trade_window.js).
let initialized = false;
let onSubmittedCallback = null;

export function initGlobalTradeEntry(options = {}) {
  if (initialized) return;
  initialized = true;
  onSubmittedCallback = typeof options.onSubmitted === "function" ? options.onSubmitted : null;

  $("globalAddTradeBtn")?.addEventListener("click", () => {
    // A new trade starts in 美股 while Rust A says the US regular session is open (09:30-16:00 New York, 13:00 on a
    // half day, never on a holiday; user 11-10), else 台股. Only the last action is kept.
    const action = localStorage.getItem("globalTradeAction") === "賣出" ? "賣出" : "買進";
    const market = usMarketSession()?.phase === "regular" ? "美股" : "台股";
    window.desktopAPI?.openTradeWindow?.({ mode: "add", action, market }).catch((error) => {
      console.warn("[GLOBAL TRADE] standalone window open failed:", error);
    });
  });

  window.desktopAPI?.onTradeWindowChanged?.(async () => {
    if (typeof onSubmittedCallback === "function") {
      try { await onSubmittedCallback(); } catch (error) { console.warn("[GLOBAL TRADE] refresh callback failed:", error); }
    }
  });
}
