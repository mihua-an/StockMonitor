// The 台股 trading day Market Runtime's session names, followed one way by every screen that keys its views on it
// (realtime.js subscribeRealtimeEquityDate; the 即時報價 session controller, 工作區, 庫存 marks, 技術分析 windows).
// Kept free of the transport so a module that only follows the day does not open the WebSocket by importing it.

/** The 台股 trading day a Market Runtime session names ("YYYY-MM-DD"), or "" when it names none (its equity is null). */
export function equityTradingDateOf(session) {
  const date = String(session?.equity?.trading_date || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

/**
 * `follow(session)` answers the new day when the session names a valid day other than the last one followed, else "".
 * A session that names no day (A's equity null) is no change: the day shown stays, it never becomes empty.
 */
export function createEquityDateFollower(initial = "") {
  let current = String(initial || "");
  return {
    follow(session) {
      const date = equityTradingDateOf(session);
      if (!date || date === current) return "";
      current = date;
      return date;
    },
    get current() { return current; },
  };
}

/** `callback(date, session)` with every valid 台股 trading day the sessions of `subscribeSession` move to (the first too). */
export function subscribeEquityDate(subscribeSession, callback) {
  if (typeof callback !== "function") return () => {};
  const follower = createEquityDateFollower();
  return subscribeSession((session) => {
    const date = follower.follow(session);
    if (date) callback(date, session);
  });
}
