// The canonical read model owns the quote and the book. TXFR1's 買賣報價 used to be built with an
// empty tick, so its header took Rust B's price-ladder price; that flat value then overwrote Market Runtime's newer
// quote inside the read model, and the empty flat book blanked the model's book.
import assert from "node:assert/strict";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";
import { FuturesOrderBookAdapter } from "../ui/renderer/js/core/orderbook_adapters.js";
import { orderBookReadView } from "../ui/renderer/js/core/market_read_model.js";

const channel = (data) => ({ state: data ? "available" : "missing", data });
const readModel = {
  identity: { source: "shioaji", code: "TXFR1", market: "FUT" },
  channels: {
    summary: channel({ code: "TXFR1", label: "台指期" }),
    quote: channel({ lastPrice: 23150, prevClose: 23000, totalVolume: 900 }),
    orderbook: channel({ bids: [{ price: 23149, volume: 3, quoteState: "PRICE" }], asks: [{ price: 23150, volume: 2, quoteState: "PRICE" }], depth: 5 }),
  },
};
const laggingAggregate = { currentPrice: 23100, byPrice: [] };   // B is behind A

// The view's quote and its model's are one: the header draws the model's quote, so a lagging price can reach it only
// through the view the builder hands the adapter -- which is why the live builder passes the canonical summary (below).
{
  const view = FuturesOrderBookAdapter.build({ tick: {}, aggregate: laggingAggregate, readModel });
  assert.equal(orderBookReadView(view).lastPrice, view.marketRead.channels.quote.data.lastPrice);
  assert.equal(view.marketRead.channels.quote.data.prevClose, 23000, "what the view lacks comes from the model");
}

// The live builder passes the view's own summary and book: header and model agree on A's price.
{
  const summary = { current: 23150, prev_close: 23000, reference_price: 23000, high: 23160, low: 22990, total_volume: 900, change: 150, change_pct: 0.65 };
  const tick = { ...summary, price_chg: summary.change, pct_chg: summary.change_pct };
  const book = { bid_prices: [23149], bid_volumes: [3], ask_prices: [23150], ask_volumes: [2] };
  const view = orderBookReadView(FuturesOrderBookAdapter.build({ tick, book, aggregate: laggingAggregate, readModel }));
  assert.equal(view.lastPrice, 23150, "買賣報價 header shows A's quote, not B's 23100");
  assert.equal(view.bidLevels[0].price, 23149, "the view's canonical book is shown");
  assert.equal(view.priceChange, 150);
}

// A model channel without data is still filled from the flat values.
{
  const empty = { ...readModel, channels: { ...readModel.channels, quote: channel(null) } };
  const view = FuturesOrderBookAdapter.build({ tick: { current: 23150, prev_close: 23000 }, aggregate: laggingAggregate, readModel: empty });
  assert.equal(view.marketRead.channels.quote.data.lastPrice, 23150);
  assert.equal(view.marketRead.channels.quote.state, "available");
}

// The live TXFR1 builder hands the adapter the canonical summary, never an empty tick.
{
  const FULL = { session: "full", trading_date: "2026-10-01", display_date: "2026-09-30",
    window_start: "2026-09-30T15:00:00+08:00", window_end: "2026-10-01T13:45:00+08:00",
    partitions: [{ trading_date: "2026-09-30", session: "NIGHT" }, { trading_date: "2026-10-01", session: "DAY" }] };
  const page = await startRealtimePage({ displayContext: { equity: { trading_date: "2026-10-01" }, futures: { FULL } } });
  const { registerLiveViewModelResolvers } = await import("../ui/renderer/js/features/realtime/live_view_models.js");
  const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
  registerLiveViewModelResolvers();
  page.sessionState.setActiveTxfSession("full");
  // 期貨走勢 owns the detail panels (the page writes this through the same selection authority).
  page.pageState.selectionIntentStore.setDetailCode("TXFR1", { reason: "INTERNAL_SYNC", source: "test", trigger: "futures_trend" });
  page.serve(page.sessionState.txfCanonicalViewSpec("full"), {
    summary: { current: 23150, prev_close: 23000, reference_price: 23000, change: 150, change_pct: 0.65 } });
  const view = orderBookReadView(realtimeContext.dataSource.resolve("orderbook", {}));
  assert.equal(view.lastPrice, 23150, "the page's 買賣報價 for TXFR1 is built from the view's own summary");
  assert.equal(view.priceChange, 150);
}
console.log("orderbook quote authority contract passed (CX-117)");
