// What 技術分析 reads. technicalViewService is the candles' service of both screens (the page's through
// live_view_models.js technicalAnalysisService); createTechnicalWindowService is the detached window's, its own views
// over the window's realtime connection -- the product list and the header read each product's summary view through it too.
import { apiGet } from "../../core/api.js";
import { MarketDataGateway } from "../../market_data/market_data_gateway.js";
import { stockCanonicalViewSpec } from "../../market_data/stock_view_spec.js";
import { getRealtimeViewSnapshot, subscribeRealtimeSession, subscribeRealtimeView } from "../../market_data/realtime.js";
import { loadTechnicalHistory, olderBarsApi } from "./technical_history_api.js";

/** What a 技術分析 panel reads, the page's and the detached window's: the view a code means (`baseSpec`, its session
 * authority's), the session today's bars belong to, the bars' history, and the candles' live view from `gateway`.
 * `onKeyChange(listener)` is called whenever the trading date behind key() changes and returns its unsubscribe. */
export function technicalViewService({ gateway, baseSpec, sessionDate, onKeyChange }) {
  return {
    // Which view a code means right now; "" until the session authority names a trading date (App start).
    key(code) { const base = baseSpec(code); return base.code && base.trading_date ? `${base.code}|${base.trading_date}` : ""; },
    // The session today's bars belong to: history is what came before it.
    sessionDate,
    history({ code, resolution, before, limit }) {
      const { code: canonical, market, session } = baseSpec(code);
      return loadTechnicalHistory({ code: canonical, market, session, resolution, before, limit });
    },
    older: olderBarsApi(),
    onKeyChange,
    subscribe(code, listener) {
      const base = baseSpec(code);
      if (!base.code || !base.trading_date) return null;
      const spec = { ...base, channels: ["trend", "day"] };
      let frame = 0;
      const deliver = () => { frame = 0; listener(gateway.snapshot(spec)); };
      // Read the cached view once here; the subscription reports only later changes.
      const unsubscribe = gateway.subscribe(spec, () => { if (!frame) frame = requestAnimationFrame(deliver); }, { replayCached: false });
      if (gateway.snapshot(spec)) deliver();
      return () => { if (frame) cancelAnimationFrame(frame); unsubscribe(); };
    },
  };
}

// `futuresPartition`: the futures session this window reads a futures month in (Workspace's dock); a window that shows
// only stocks has none.
export function createTechnicalWindowService({ subscribeSession = subscribeRealtimeSession, subscribeView = subscribeRealtimeView,
  getSnapshot = getRealtimeViewSnapshot, futuresPartition = () => null } = {}) {
  const gateway = new MarketDataGateway({ subscribeView, getSnapshot });
  const dateListeners = new Set();
  let tradingDate = "";
  const release = subscribeSession((payload) => {
    const date = String(payload?.equity?.trading_date || "").slice(0, 10);
    if (date === tradingDate) return;
    tradingDate = date;
    for (const listener of [...dateListeners]) listener();
  });
  const baseSpec = (code) => stockCanonicalViewSpec(code, tradingDate, futuresPartition());
  const summarySpec = (code) => ({ ...baseSpec(code), channels: ["summary"] });
  return {
    ...technicalViewService({
      gateway, baseSpec,
      sessionDate: () => tradingDate,
      onKeyChange(listener) { dateListeners.add(listener); return () => dateListeners.delete(listener); },
    }),
    // The API, not desktopAPI.loadWatchPagesLocal: that channel answers only the main window.
    watchPages: () => apiGet("/api/watch-pages"),
    /** One product's summary: `listener()` on every change; quoteRead(code) reads it. */
    subscribeQuote(code, listener) {
      const spec = summarySpec(code);
      if (!spec.code || !spec.trading_date) return null;
      return gateway.subscribe(spec, () => listener(), { replayCached: false });
    },
    quoteRead(code) { const spec = summarySpec(code); return spec.trading_date ? gateway.readSnapshot(spec) : null; },
    /** The summary's own fields a product row carries beside its read model: 漲跌, 漲幅, 漲跌停, 試撮 (displayQuote). */
    quoteFields(code) { const spec = summarySpec(code); return spec.trading_date ? gateway.snapshot(spec)?.summary || null : null; },
    dispose() { release?.(); dateListeners.clear(); },
  };
}
