// The Futu US session as Rust A says it is (session.current `us`, native/market_runtime/src/us_session.rs):
// `{trading_date, phase, market_day, windows}` -- the New York session trading now and the windows 個股走勢's US tabs
// read (futu_us_trend_window.js). A is the one judge of US trading days, holidays and half days (user 11-10,
// decisions.md 美股假日) and pushes session.current again whenever the session moves, so no screen reads a weekday or a
// clock for it.
import { subscribeRealtimeSession } from "../../market_data/realtime.js";

let current = null;
const listeners = new Set();
subscribeRealtimeSession((session) => {
  const next = session?.us || null;
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const listener of [...listeners]) {
    try { listener(current); } catch (error) { console.warn("[Futu US session: a subscriber] failed", error); }
  }
});

/** The US session A last sent; null before the first one. */
export function usMarketSession() {
  return current;
}

/** Called with every new US session (not with the current one). */
export function subscribeUsMarketSession(callback) {
  if (typeof callback !== "function") return () => {};
  listeners.add(callback);
  return () => listeners.delete(callback);
}
