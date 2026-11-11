import { canonicalReadModel } from "../core/market_read_adapters.js";
import { realtimeViewSpecKey } from "./realtime_view_store.js";
import { annotateSelection, selectionContext, selectionMark, selectionPayload } from "../core/selection_latency_trace.js";

const CHANNEL_BY_DELTA = Object.freeze({
  "summary.updated": "summary", "trade.append": "trades",
  "trade.frame": "trades",
  "trend.append": "trend", "trend.upsert": "trend", "trend.updated": "trend",
  "orderbook.latest": "orderbook", "tradeflow.updated": "tradeflow",
  "price_volume.updated": "price_volume",
  "session.coverage.updated": "coverage", "session.completed": "coverage",
});

/**
 * Renderer boundary between reliable canonical transport and UI components.
 * It exposes which channel changed so callers do not redraw every widget for
 * every market event.
 */
export class MarketDataGateway {
  constructor({ subscribeView, getSnapshot } = {}) {
    this.subscribeCanonicalView = subscribeView;
    this.getCanonicalSnapshot = getSnapshot;
    this.entries = new Map();
  }

  _entry(spec) {
    const key = realtimeViewSpecKey(spec);
    if (!this.entries.has(key)) this.entries.set(key, {
      key, spec: { ...spec }, references: 0, lastState: null,
      received: 0,
    });
    return this.entries.get(key);
  }

  subscribe(spec, listener, options = {}) {
    const entry = this._entry(spec);
    const selection = selectionContext(spec.code);
    let subscriptionReturned = false, synchronousSnapshot = false;
    selectionMark(spec.code, "cache_lookup", selection);
    entry.references += 1;
    const unsubscribe = this.subscribeCanonicalView?.(spec, (event = {}) => {
      if (!subscriptionReturned && event.type === "snapshot") {
        synchronousSnapshot = true;
        selectionMark(spec.code, "cache_hit", selection);
      }
      entry.received += 1;
      const deltas=event.type === "batch" ? (event.deltas || []) : event.delta ? [event.delta] : [];
      const lastDelta=deltas.at(-1);
      if (["snapshot", "patch", "delta", "batch"].includes(event.type)) entry.lastWire = {
        kind:event.type, protocolVersion:lastDelta?.protocol_version ?? event.state?.protocol_version ?? null,
        sequence:event.sequence ?? event.watermark ?? lastDelta?.sequence ?? null,
        sequenceDomain:"canonical_stream", deltaType:lastDelta?.delta_type ?? null,
      };
      if (event.type === "snapshot") {
        entry.lastState = event.state || {};
        for (const channel of spec.channels || []) {
          if (Object.hasOwn(entry.lastState, channel)) selectionPayload(spec.code, channel, entry.lastState[channel], selection);
        }
        // Whether the selection's first snapshot came from the renderer's cache (no watermark) -- a flag, not a stage.
        annotateSelection(spec.code, { renderer_cache_hit: event.watermark == null }, selection);
      }
      const deltaType = String(lastDelta?.delta_type || "");
      const changed=event.type === "snapshot" ? ["snapshot"] : [...new Set((event.changedChannels?.length
        ? event.changedChannels : deltas.flatMap(delta=>delta.channels?.length?delta.channels:[delta.delta_type]))
        .map(channel=>CHANNEL_BY_DELTA[channel]||channel||"control"))];
      listener?.({
        // Preserve an ordered canonical batch all the way to the page. Turning
        // it into one synthetic delta silently exposed only the last item and
        // could omit trades even though the store had accepted every sequence.
        ...event, type:event.type, delta:lastDelta, deltas,
        changedChannel: event.type === "snapshot" ? "snapshot" : CHANNEL_BY_DELTA[deltaType] || "control",
        changedChannels: changed,
      });
    }, { stateDelivery: "snapshot-only", replayCached: options?.replayCached !== false }) || (() => {});
    subscriptionReturned = true;
    if (!synchronousSnapshot) selectionMark(spec.code, "cache_miss", selection);
    return () => {
      unsubscribe();
      entry.references = Math.max(0, entry.references - 1);
      if (!entry.references) this.entries.delete(entry.key);
    };
  }

  snapshot(spec) {
    const entry = this.entries.get(realtimeViewSpecKey(spec));
    // RealtimeViewStore continues applying deltas internally even when listeners
    // request snapshot-only state delivery. Prefer that current authoritative
    // state over the gateway's last hydration snapshot.
    return this.getCanonicalSnapshot?.(spec) || entry?.lastState || null;
  }

  readSnapshot(spec, overrides = {}) {
    const model = canonicalReadModel(this.snapshot(spec) || {}, spec, overrides);
    const lastWire = this.entries.get(realtimeViewSpecKey(spec))?.lastWire;
    return {...model, revision:{...model.revision,lastWire:lastWire ? {...lastWire} : null}};
  }

  diagnostics() { return [...this.entries.values()].map((entry) => ({
    key: entry.key,
    references: entry.references,
    received: entry.received,
  })); }
}
