// At startup the selected stock is set before Market Runtime's session has named the trading day. A page-count read
// then named no day and FastAPI refused it (HTTP 400 "trading_date is required for STK trades"); nothing read again
// when the day arrived, so 成交明細 stayed at 1 / 1 until the user switched stocks. The pager waits for the day, and
// the session naming it resets the selected stock's pager, which reads the count then.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLiveTradePager } from "../ui/renderer/js/market_data/live_trade_pager.js";

globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const pending = [];
let query = { target: "2330", market: "STK", session: "DAY", tradingDate: "", actualContract: "2330", requestIdentityKey: "STK|2330||DAY|2330" };
const pager = createLiveTradePager({
  apiGet: (url, options) => new Promise((resolve) => pending.push({ url, options, resolve })),
  getQuery: () => query, getEquityDate: () => query.tradingDate, futuresIdentityMatches: () => true, invalidateDetails: () => {},
});

// No day yet: the reset asks nothing, and an older page asks nothing either.
pager.reset("2330");
await Promise.resolve();
assert.equal(pending.length, 0, "no read names no day");
assert.equal(await pager.load({ page: 3 }), null);
assert.equal(pending.length, 0);
assert.equal(pager.state.loading, false, "a read not sent leaves nothing loading");

// The session names the day and resets the pager: one count read, of that day.
query = { ...query, tradingDate: "2026-11-11", requestIdentityKey: "STK|2330|2026-11-11|DAY|2330" };
pager.reset("2330");
await Promise.resolve();
assert.equal(pending.length, 1, "the day's count is read once");
const params = new URL(pending[0].url, "http://offline").searchParams;
assert.equal(params.get("trading_date"), "2026-11-11");
assert.equal(params.get("metadata_only"), "true");
pending[0].resolve({ ok: true, page: 1, total_rows: 4210, total_pages: 43, snapshot_watermark: 4210, rows: [] });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pager.state.totalPages, 43);

// A futures read names its contract's session, not the stock day: it is not held back.
pending.length = 0;
query = { target: "TXFR1", market: "FUT", session: "DAY", tradingDate: "", actualContract: "TXFL6", requestIdentityKey: "FUT|TXFR1" };
pager.reset("TXFR1");
await Promise.resolve();
assert.equal(pending.length, 1);

// Where the day arrives: the session's date moving -- the first one named included -- resets the selected stock's
// pager, not only a rollover from an earlier day.
const controller = readFileSync(new URL("../ui/renderer/js/features/realtime/session_controller.js", import.meta.url), "utf8");
const apply = controller.slice(controller.indexOf("function applyRealtimeSession("));
const moved = apply.slice(apply.indexOf("if (dateMoved) {"), apply.indexOf("if (previousEquityDate) clearEquitySessionEphemeralState"));
assert.match(moved, /resetLiveTickPageState\(shown\)/, "the date naming the day resets the selected stock's pager");
console.log("renderer trade pager awaits trading date contract passed");
