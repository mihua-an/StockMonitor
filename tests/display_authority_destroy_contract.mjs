// Behavioral replacement for
// test_frontend_display_authority.py::
//   test_moomoo_components_cancel_scheduler_and_unsubscribe_on_destroy
//
// Invariant under test: MoomooTrendComponent / MoomooTradesComponent /
// MoomooOrderBookComponent (ui/renderer/js/features/realtime/components/futu/)
// each own a shared sub-component (sharedTrend / sharedTicks / sharedBook)
// and, on destroy(), must actually (a) cancel their scheduled render via
// realtimeRenderScheduler, (b) drain and run every queued cleanup callback,
// and (c) destroy + release their shared sub-component, via the inherited
// base destroy(). The real classes are imported (with the few browser globals
// their modules read at load); an instance is made without running its
// constructor (which mounts DOM), given the fields destroy() releases, and
// destroyed -- the scheduler is the real shared one, observed.
import assert from "node:assert/strict";

globalThis.window ??= { desktopAPI: {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { realtimeRenderScheduler } = await import("../ui/renderer/js/features/realtime/realtime_render_scheduler.js");
const FUTU = "../ui/renderer/js/features/realtime/components/futu/";
const CLASSES = {
  MoomooTrendComponent: (await import(`${FUTU}trend_component.js`)).MoomooTrendComponent,
  MoomooTradesComponent: (await import(`${FUTU}trade_pager.js`)).MoomooTradesComponent,
  MoomooOrderBookComponent: (await import(`${FUTU}orderbook_component.js`)).MoomooOrderBookComponent,
};
const cases = [
  { className: "MoomooTrendComponent", sharedField: "sharedTrend" },
  { className: "MoomooTradesComponent", sharedField: "sharedTicks" },
  { className: "MoomooOrderBookComponent", sharedField: "sharedBook" },
];
const cancel = realtimeRenderScheduler.cancel.bind(realtimeRenderScheduler);
let cancelCalls = [];
realtimeRenderScheduler.cancel = (key) => { cancelCalls.push(key); return cancel(key); };

for (const { className, sharedField } of cases) {
  cancelCalls = [];
  const cleanupCalls = [];
  const sharedDestroyCalls = [];
  const instance = Object.create(CLASSES[className].prototype);
  instance.renderKey = `render-key-${className}`;
  instance.cleanup = [() => cleanupCalls.push("a"), () => cleanupCalls.push("b")];
  instance.host = {};
  instance[sharedField] = { destroy: () => sharedDestroyCalls.push(sharedField) };
  const pageCountResets = [];
  if (className === "MoomooTradesComponent") instance.pageCount = { reset: () => pageCountResets.push(true) };

  instance.destroy();

  assert.deepEqual(cancelCalls, [`render-key-${className}`],
    `${className}.destroy() must cancel its own scheduled render via realtimeRenderScheduler.cancel(this.renderKey)`);
  assert.deepEqual(cleanupCalls, ["a", "b"],
    `${className}.destroy() must drain and run every queued cleanup callback`);
  assert.deepEqual(sharedDestroyCalls, [sharedField],
    `${className}.destroy() must destroy its shared ${sharedField} sub-component`);
  if (className === "MoomooTradesComponent") assert.equal(pageCountResets.length, 1, "the trade list forgets its page-count read");
  assert.equal(instance[sharedField], null, `${className}.destroy() must release its ${sharedField} reference`);
  assert.equal(instance.host, null, `${className}.destroy() must release its host reference`);

  // cleanup must actually be drained (emptied), not just iterated -- a second
  // destroy() call must not re-run the same callbacks.
  instance.cleanup = instance.cleanup || [];
  const before = cleanupCalls.length;
  instance.destroy();
  assert.equal(cleanupCalls.length, before, `${className}.destroy() must be safe to call again without re-running cleanup`);
}

console.log("moomoo component destroy() cleanup contract passed");
