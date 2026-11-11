// Futu 個股走勢's US tabs are windows over New York date partitions, as Rust A sends them in its US session
// (futu_us_market_session.js; native/market_runtime/src/us_session.rs). A tab's window is its parts
// `{trading_date, from, to}` -- a partition and minutes of it (`to` exclusive) -- in time order: 日盤 one day's
// 04:00 -> 20:00, 夜盤 20:00 -> 04:00 across midnight, 全日 20:00 the evening before -> 20:00. On a holiday 日盤 and
// 全日 keep the trading day before it. Nothing here reads a weekday or a clock.

/** The partitions and minutes a US tab reads in the session `us`: `{key, parts}`; no parts before A has said. */
export function usTrendWindow(tab, us) {
  const parts = (Array.isArray(us?.windows?.[tab]) ? us.windows[tab] : [])
    .map((part) => ({ trading_date: String(part.trading_date), from: Number(part.from), to: Number(part.to) }));
  return { key: `${tab}|${parts.map((p) => `${p.trading_date}:${p.from}-${p.to}`).join(",")}`, parts };
}

/** Every partition any US tab reads in the session `us`, oldest first. */
export function usTrendPartitionDates(us) {
  const dates = new Set(["day", "overnight", "full"].flatMap((tab) => usTrendWindow(tab, us).parts.map((p) => p.trading_date)));
  return [...dates].sort();
}

/** The rows (each `{trading_date, minute, ...}`) inside a window, in time order. */
export function rowsInUsTrendWindow(rows, window) {
  const out = [];
  for (const part of window.parts) {
    const inside = rows.filter((row) => row.trading_date === part.trading_date && row.minute >= part.from && row.minute < part.to);
    out.push(...inside.sort((a, b) => a.minute - b.minute));
  }
  return out;
}
