// The 即時報價 page's controllers (features/realtime/*) in node, on their REAL modules: the live socket is the fake one
// from realtime_socket_harness.mjs, connected, and a test serves the views it wants the page to read.
//
//   const page = await startRealtimePage({ tradingDate: "2026-10-27" });
//   await page.showProducts(["2330"]);          // the active product page: the view owner subscribes its views
//   page.serve(page.stockSpec("2330"), { summary: { current: 1105 }, signals: { chg_1m: 0.4 } });
//   page.delta(page.stockSpec("2330"), "signals.frame", { signals: { chg_1m: 0.5 } });
//
// serve() answers the view.subscribe the window sent for that view (the view owner's, or one serve() makes through the
// page's gateway when nothing subscribed it) with Market Runtime's accepted + snapshot; serving the same view again
// sends the next snapshot of that subscription, and delta() its next delta.
import { installRealtimeHarness } from "./realtime_socket_harness.mjs";

const PAGE = "../../ui/renderer/js/";

export async function startRealtimePage({ tradingDate = "2026-10-27", displayContext = null, harness = {} } = {}) {
  const live = installRealtimeHarness(harness);
  // In a browser globalThis is the window: the page's frames (view_resources.js) are scheduled on globalThis.
  Object.assign(globalThis, { requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame });
  globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
  const realtime = await import(`${PAGE}market_data/realtime.js`);
  realtime.startRealtimeStream();
  const socket = live.sockets.at(-1);
  socket.ready();

  const sessionState = await import(`${PAGE}features/realtime/session_state.js`);
  const pageState = await import(`${PAGE}features/realtime/live_page_state.js`);
  const owner = await import(`${PAGE}features/realtime/canonical_view_owner.js`);
  const productPages = await import(`${PAGE}features/realtime/product_pages.js`);
  // Market Runtime's session.current as the page holds it (session_controller.js applyRealtimeSession).
  sessionState.setRealtimeDisplayContext(displayContext || { equity: { trading_date: tradingDate, live: true } });

  const views = new Map();
  const answered = new Set();
  const codeBySubscription = new Map();
  let subscriptionSeq = 0;
  const keyOf = (spec) => JSON.stringify([spec.market, spec.code, spec.session, spec.trading_date]);
  const sameView = (payload, spec) => payload.market === spec.market && payload.code === spec.code
    && payload.session === spec.session && payload.trading_date === spec.trading_date;
  const pendingRequest = (spec) => socket.sentOfType("view.subscribe")
    .filter((message) => sameView(message.payload, spec) && !answered.has(message.payload.request_id)).at(-1);

  function bind(spec) {
    let request = pendingRequest(spec);
    let release = null;
    if (!request) {
      release = pageState.liveMarketDataGateway.subscribe(spec, () => {});
      request = pendingRequest(spec);
    }
    if (!request) throw new Error(`the page sent no view.subscribe for ${spec.code}`);
    answered.add(request.payload.request_id);
    subscriptionSeq += 1;
    const view = { spec, requestId: request.payload.request_id, subscriptionId: `sub-${subscriptionSeq}`, sequence: 0, release };
    codeBySubscription.set(view.subscriptionId, spec.code);
    socket.frame({ type: "view.subscription.accepted", payload: { request_id: view.requestId,
      subscription_id: view.subscriptionId, stream_id: view.subscriptionId, watermark: 0 } });
    return view;
  }

  const sessionKeyOf = (spec) => ({ market: spec.market, logical_code: spec.code, session: spec.session,
    trading_date: spec.trading_date });

  // The view store isolates a page consumer that throws (it records renderer.view_consumer_fault and carries on), so
  // a throw in the page's handler would otherwise pass unnoticed and leave the rest of that handler untested.
  let faultsSeen = 0;
  function throwOnConsumerFault(during) {
    const faults = live.remediations.filter((event) => event.mechanism_id === "renderer.view_consumer_fault");
    const fresh = faults.slice(faultsSeen);
    faultsSeen = faults.length;
    if (fresh.length) throw new Error(`a page consumer threw during ${during}: ${fresh[0].detail?.error || "(no detail)"}`);
  }

  function serve(spec, state = {}) {
    let view = views.get(keyOf(spec));
    if (!view) { view = bind(spec); views.set(keyOf(spec), view); }
    view.sequence += 1;
    socket.frame({ type: "view.snapshot", payload: { request_id: view.requestId, subscription_id: view.subscriptionId,
      stream_id: view.subscriptionId, watermark: view.sequence, session_key: sessionKeyOf(spec),
      summary: {}, trend: [], trades: [], orderbook: {}, ...state } });
    throwOnConsumerFault(`the ${spec.code} snapshot`);
    return view;
  }

  function delta(spec, deltaType, payload = {}) {
    const view = views.get(keyOf(spec));
    if (!view) throw new Error(`serve ${spec.code} before sending it a delta`);
    view.sequence += 1;
    socket.frame({ type: "view.delta", payload: { subscription_id: view.subscriptionId, stream_id: view.subscriptionId,
      sequence: view.sequence, session_key: sessionKeyOf(spec), delta_type: deltaType, payload } });
    throwOnConsumerFault(`the ${spec.code} ${deltaType} delta`);
  }

  /** Market Runtime accepts every view.subscribe still waiting (no snapshot yet). */
  function acceptPending() {
    for (const message of socket.sentOfType("view.subscribe")) {
      if (answered.has(message.payload.request_id)) continue;
      const { market, code, session, trading_date } = message.payload;
      const spec = { market, code, session, trading_date };
      views.set(keyOf(spec), bind(spec));
    }
  }

  return {
    live, socket, realtime, sessionState, pageState, owner, productPages, serve, delta, acceptPending,
    /** The codes of the views the window asked for, and of those it released, in order. */
    subscribedCodes: () => socket.sentOfType("view.subscribe").map((message) => message.payload.code),
    unsubscribedCodes: () => socket.sentOfType("view.unsubscribe").map((message) => codeBySubscription.get(message.payload.subscription_id)),
    /** The workspace (hot products) the window declared, each declaration as "code,code". */
    workspaceDeclarations: () => socket.sentOfType("workspace.replace").map((message) => message.payload.codes.join(",")),
    stockSpec: (code) => sessionState.stockCanonicalViewSpec(code),
    taiexSpec: () => sessionState.taiexCanonicalViewSpec(),
    /** The user's click on a product, through the page's own selection path (selection_controller.js). */
    async select(code) {
      const { publishSelectedSymbol } = await import(`${PAGE}features/realtime/selection_controller.js`);
      return publishSelectedSymbol(code, "USER_CLICK", "test", "product_selection");
    },
    /** The product page showing: these codes; the view owner declares their views. */
    showProducts(codes, { id = "test-page" } = {}) {
      productPages.setWatchPages([{ id, name: id, market: "tw", codes, items: codes.map((code) => ({ code })) }]);
      productPages.setActiveWatchPageId(id);
      owner.reconcileCanonicalViews("TEST");
    },
    /** Runs the page's queued frames and timers (requestAnimationFrame, setTimeout). */
    flush() { live.fireTimers(); throwOnConsumerFault("the queued frames"); },
  };
}
