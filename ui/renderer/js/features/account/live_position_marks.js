import { positiveNumberOrNull as positiveNumber, numberOrNull as finiteNumber } from "../../core/numbers.js";
import { buyCost, sellProceeds } from "../../core/trade_costs.js";
// 庫存's 未實現損益 -- the one projection every screen showing a holding's P&L uses (帳務 庫存, 即時報價's 實際／模擬
// 庫存 rows, 模擬帳務's 未實現). The positions (code, qty, cost_amount and their closing_terms) are the account
// ledger's and come from FastAPI; the current price is Market Runtime's and comes over the WS -- FastAPI does not read
// A once per holding for it. A price that is not there is shown as "-", never as a fabricated 0.
//
// 未實現 is net of what closing costs (user 11-02): a long (qty > 0, cost_amount = what was paid with the buy fee)
// against what selling it at the price brings in after fee and tax; a short (qty < 0, cost_amount = what the sell
// brought in after its fee and tax) against what buying it back costs with the fee. The fee and tax are the ledger's
// own (the position's closing_terms, core/trade_costs.js).
//
// On the 帳務 庫存 page only Taiwan stocks are priced (no arbitrary-code US price lane there).

const SUPPORTED_MARKETS = new Set(["台股"]);
const UNAVAILABLE = Object.freeze({ mark_price: null, mark_price_available: false, unrealized_pnl: null, unrealized_pnl_pct: null });

/** One position's net unrealized P&L at `markPrice`; a missing price, cost or terms is "unavailable", never 0. The
 * percent is the P&L on cost_amount. */
export function computeUnrealizedPnl({ qty, costAmount, markPrice, closingTerms }) {
  const mark = positiveNumber(markPrice);
  const cost = finiteNumber(costAmount);
  const quantity = finiteNumber(qty) ?? 0;
  if (mark === null || cost === null || !closingTerms || quantity === 0) return { ...UNAVAILABLE };
  const held = Math.abs(quantity);
  const pnl = quantity > 0 ? sellProceeds(closingTerms, held, mark) - cost : cost - buyCost(closingTerms, held, mark);
  return { mark_price: mark, mark_price_available: true, unrealized_pnl: pnl, unrealized_pnl_pct: cost > 0 ? (pnl / cost) * 100 : null };
}

/** A ledger position row's P&L at `markPrice` (its qty or position_qty, cost_amount and closing_terms). */
export function positionUnrealizedPnl(position, markPrice) {
  return computeUnrealizedPnl({ qty: position?.position_qty ?? position?.qty, costAmount: position?.cost_amount,
    markPrice, closingTerms: position?.closing_terms });
}

/** The price a canonical summary marks a holding at: the last trade, else the current quote. */
export function markPriceFromSummary(summary = {}) {
  return positiveNumber(summary?.last_price) ?? positiveNumber(summary?.current) ?? positiveNumber(summary?.close);
}

/** New position rows with the P&L fields filled from `markOf(code)`; the ledger rows are never mutated. */
export function withUnrealizedPnl(positions, markOf) {
  return (Array.isArray(positions) ? positions : []).map((position) => {
    if (!SUPPORTED_MARKETS.has(String(position?.market || ""))) {
      return { ...position, ...UNAVAILABLE, mark_price_source: "UNSUPPORTED_MARKET" };
    }
    const code = String(position?.code || "").trim().toUpperCase();
    const fields = positionUnrealizedPnl(position, markOf(code));
    return { ...position, ...fields, mark_price_source: fields.mark_price_available ? "market_runtime" : "UNAVAILABLE" };
  });
}

/**
 * Keeps one summary-only canonical view per Taiwan holding while the 庫存 view is shown, and calls `onChange` (at
 * most once per animation frame) when a price moves. `sync(positions)` adds and releases views to match the
 * holdings; `dispose()` releases them all. The trading date is the session Market Runtime pushes (`subscribeSession`,
 * on every connection and rollover): a new date drops every view and subscribes the holdings on it.
 */
export function createPositionMarkTracker({ subscribeView, subscribeSession, onChange, schedule = (fn) => requestAnimationFrame(fn) }) {
  const views = new Map();   // code -> release()
  const marks = new Map();   // code -> price
  let tradingDate = "";
  let generation = 0;
  let pending = false;
  let disposed = false;
  let positionsNow = [];

  function changed() {
    if (pending || disposed) return;
    pending = true;
    schedule(() => { pending = false; if (!disposed) onChange(); });
  }

  function watch(code, generationAtStart) {
    const release = subscribeView({ market: "STK", code, trading_date: tradingDate, session: "DAY", channels: ["summary"] }, (event) => {
      if (disposed || generationAtStart !== generation) return;
      let frames;
      switch (event?.type) {
        case "snapshot": frames = [event.state?.summary]; break;
        case "delta": frames = [event.delta?.payload?.summary ?? event.delta?.payload]; break;
        case "batch": frames = (event.deltas || []).map((delta) => delta?.payload?.summary ?? delta?.payload); break;
        case "error":
          // The view is failing: the held price is no longer current, so the holding shows "-" until a snapshot
          // (the store re-binds the view itself).
          console.warn("[holdings marks] price view error", { code, error: event.error || event.entry?.last_error || "" });
          if (marks.delete(code)) changed();
          return;
        case "gap":
          return;  // the store's own resync; its snapshot follows
        default:
          console.error("[holdings marks] unknown view event", { code, type: event?.type });
          return;
      }
      for (const summary of frames) {
        const price = markPriceFromSummary(summary || {});
        if (price !== null && price !== marks.get(code)) {
          marks.set(code, price);
          changed();
        }
      }
    }, { stateDelivery: "snapshot-only" });
    views.set(code, release);
  }

  function sync(positions) {
    if (disposed) return;
    positionsNow = Array.isArray(positions) ? positions : [];
    const wanted = new Set((Array.isArray(positions) ? positions : [])
      .filter((p) => SUPPORTED_MARKETS.has(String(p?.market || "")) && Number(p?.qty || 0) !== 0)
      .map((p) => String(p?.code || "").trim().toUpperCase()).filter(Boolean));
    for (const [code, release] of views) {
      if (!wanted.has(code)) { release(); views.delete(code); marks.delete(code); }
    }
    if (![...wanted].some((code) => !views.has(code))) return;
    if (!tradingDate) return;  // no session pushed yet: the holdings stay "-" until it arrives
    const atStart = generation;
    for (const code of wanted) if (!views.has(code)) watch(code, atStart);
  }

  const releaseSession = subscribeSession((session) => {
    const date = String(session?.equity?.trading_date || "").slice(0, 10);
    if (disposed || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date === tradingDate) return;
    // A new trading day (or the first session): every view is dropped and the holdings subscribe on it.
    generation += 1;
    for (const release of views.values()) release();
    views.clear();
    marks.clear();
    tradingDate = date;
    changed();
    sync(positionsNow);
  });

  return {
    sync,
    mark: (code) => marks.get(String(code || "").trim().toUpperCase()) ?? null,
    dispose() {
      disposed = true;
      releaseSession?.();
      for (const release of views.values()) release();
      views.clear();
      marks.clear();
    },
  };
}
