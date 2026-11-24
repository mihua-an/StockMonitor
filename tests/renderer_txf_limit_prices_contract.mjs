// 期貨走勢 at 漲停: the price is marked 紅底白字 from the contract's official limits Market Runtime holds for the
// partition the price is from (11-23 night: TXF limit-up at 40324 and the header showed no mark, because the futures
// view model carried no limits). The 成交明細 tape reads the same limits.
import assert from "node:assert/strict";
import { startRealtimePage } from "./support/realtime_page_harness.mjs";

const NIGHT = { trading_date: "2026-11-24", session: "night", live: true, actual_contract: "TXFL6",
  window_start: "2026-11-23T15:00:00+08:00", window_end: "2026-11-24T05:00:00+08:00",
  partitions: [{ trading_date: "2026-11-23", session: "NIGHT" }] };
const page = await startRealtimePage({ tradingDate: "2026-11-23", displayContext: {
  equity: { trading_date: "2026-11-23", live: false }, taiex: { trading_date: "2026-11-23", live: false }, futures: { NIGHT } } });
page.sessionState.setActiveTxfSession("night");
page.sessionState.commitTxfDisplayContext({ futures: { NIGHT } });
const { registerLiveViewModelResolvers } = await import("../ui/renderer/js/features/realtime/live_view_models.js");
const { realtimeContext } = await import("../ui/renderer/js/core/dashboard_context.js");
const { limitPriceClass } = await import("../ui/renderer/js/core/components/orderbook_depth_table.js");
registerLiveViewModelResolvers();
const resolve = () => realtimeContext.dataSource.resolve("futuresTrend", {});

const summary = { current: 40324, reference_price: 36659, reference_source: "shioaji.quote.close_minus_price_chg", change: 3665,
  change_pct: 9.9975, open: 36671, high: 40324, low: 36280, session: "NIGHT", contract_code: "TXFL6",
  price_exchange_ts_ns: "1795449600000000000" };
page.serve(page.sessionState.txfCanonicalViewSpec("night"), { summary });
let vm = resolve();
assert.deepEqual([vm.metrics.limitUp, vm.metrics.limitDown], [null, null], "no official limits held yet: none shown, never derived");

page.serve(page.sessionState.txfCanonicalViewSpec("night"), { summary: { ...summary, limit_up: 40324, limit_down: 32994 } });
vm = resolve();
assert.deepEqual([vm.metrics.limitUp, vm.metrics.limitDown], [40324, 32994], "the contract's limits, as Market Runtime holds them");
assert.equal(limitPriceClass(vm.currentPrice, vm.metrics.limitUp, vm.metrics.limitDown), "limit-up-price", "40324 is 漲停: 紅底白字");

console.log("renderer TXF limit prices contract passed");
