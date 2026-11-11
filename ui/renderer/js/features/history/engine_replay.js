// 歷史回放 through Market Runtime. Market Runtime plays the recorded day through the live engine (each
// print at its own exchange time, 1/2/5/10x) and Rust B analyses it like the live market; this runtime holds the
// replay's view and turns it into the same view models the live page's components draw. Nothing is computed here.
import { MarketDataGateway } from "../../market_data/market_data_gateway.js";
import { StockOrderBookAdapter } from "../../core/orderbook_adapters.js";
import {
  subscribeRealtimeView, getRealtimeViewSnapshot, openRealtimeReplay, controlRealtimeReplay, closeRealtimeReplay,
  subscribeRealtimeReplayStatus, subscribeRealtimeConnectionState, REALTIME_CONNECTION_STATE,
} from "../../market_data/realtime.js";
import { normalizeRustTradeFlow, normalizeDaemonPriceVolume } from "../../market_data/realtime_market_math.js";
import { isTapePrint, largeOrderDefinition, largePrintMatcher, tapeRow } from "../../market_data/trade_detail/tape_rows.js";
import { numberOrNull, positiveNumberOrNull } from "../../core/numbers.js";
import { displayQuote } from "../../core/auction_price.js";
import { modelPredictionMetrics } from "../../core/model_predictions.js";
import { trendMetrics } from "../../core/trend_metrics.js";
import { withMarketRead } from "../../core/market_read_adapters.js";
import { bigOrderFlowWindowsFromRust } from "../../core/big_order_flow.js";
import { parseTaipeiTimestampMs, taipeiClockText } from "../../market_data/taipei_time.js";

export const REPLAY_SPEEDS = Object.freeze([1, 2, 5, 10]);
const CHANNELS = ["summary", "trend", "trades", "orderbook", "tradeflow", "price_volume", "events", "signals"];

// What Market Runtime answers when the partition itself cannot be replayed (replay_open / replay::load): asking again
// for the same day and product gets the same answer until the recording changes. Every other refusal -- TIMEOUT,
// DISCONNECTED, REPLAY_BUSY, a superseded open -- is about this moment, not the recording.
const PERMANENT_OPEN_ERRORS = new Set(["NOT_CONFIGURED", "INVALID_IDENTITY", "NOT_AVAILABLE", "OLD_FORMAT", "CORRUPT", "TOO_LARGE"]);
export function isPermanentReplayOpenError(error) {
  return PERMANENT_OPEN_ERRORS.has(String(error || ""));
}

/** "2026-09-29" + "09:31:05" (Asia/Taipei) -> epoch ns as a decimal string (exact; ns exceed Number precision). */
export function taipeiTimeToNs(tradingDate, clock) {
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(tradingDate || ""));
  const time = /(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?/.exec(String(clock || ""));
  if (!date || !time) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const ms = parseTaipeiTimestampMs(`${date[1]}-${date[2]}-${date[3]}T${pad(time[1])}:${time[2]}:${pad(time[3] || 0)}`);
  if (ms == null) return null;
  const micros = Number(String(time[4] || "").padEnd(6, "0").slice(0, 6) || 0);
  return (BigInt(ms) * 1_000_000n + BigInt(micros) * 1_000n).toString();
}

/** Epoch ns (string or number) -> "HH:MM:SS" in Asia/Taipei. */
export function nsToTaipeiClock(ns) {
  let ms;
  try { ms = Number(BigInt(String(ns)) / 1_000_000n); } catch (_error) { /* not an error: a value that is not an integer nanosecond time has no clock text by contract */ return ""; }
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return taipeiClockText(ms, { seconds: true });
}

export class EngineReplay {
  constructor({ onChange = () => {}, onStatus = () => {}, onEnded = () => {}, onConnected = () => {} } = {}) {
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.onEnded = onEnded;
    this.gateway = new MarketDataGateway({ subscribeView: subscribeRealtimeView, getSnapshot: getRealtimeViewSnapshot });
    this.replayId = null;
    this.spec = null;
    this.status = null;
    this.code = "";
    this.unsubscribeView = null;
    this.frame = 0;
    this.openGeneration = 0;
    this.pendingSeek = null;
    this.seeking = false;
    this.unsubscribeStatus = subscribeRealtimeReplayStatus((status) => {
      if (!this.replayId || status.replay_id !== this.replayId) return;
      this.status = status;
      this.onStatus(status);
    });
    // Market Runtime ends a replay with the connection that opened it: after a reconnect it no longer exists.
    this.unsubscribeConnection = subscribeRealtimeConnectionState((state) => {
      if (state === REALTIME_CONNECTION_STATE.CONNECTED) onConnected();
      else if (this.replayId) this.end("DISCONNECTED");
    });
  }

  get active() { return Boolean(this.replayId); }
  get playing() { return Boolean(this.status?.playing); }
  /** Rust B's analysis of the step the replay stands on is not built yet: its panels say 計算中, never another step's. */
  get computing() { return this.status?.analysis?.at_position === false; }

  /** Open (replacing any open replay) at `clock` of `tradingDate`. Resolves {ok, error?}. */
  async open({ code, tradingDate, clock, speed = 1 }) {
    const generation = ++this.openGeneration;
    await this.closeCurrent();
    const atNs = clock ? taipeiTimeToNs(tradingDate, clock) : null;
    const reply = await openRealtimeReplay({ source: "shioaji", market: "STK", code, tradingDate, session: "DAY" },
      { atNs, speed: REPLAY_SPEEDS.includes(Number(speed)) ? Number(speed) : 1 });
    if (generation !== this.openGeneration) {
      if (reply?.ok) void this.command("close", reply.replay_id, () => closeRealtimeReplay(reply.replay_id));
      return { ok: false, error: "SUPERSEDED" };
    }
    if (!reply?.ok) return { ok: false, error: reply?.error || "OPEN_FAILED", detail: reply?.detail || "" };
    this.replayId = reply.replay_id;
    this.status = reply.status || null;
    this.code = String(code || "").toUpperCase();
    this.spec = { source: "shioaji", market: "STK", code: this.code, trading_date: tradingDate, session: "DAY", channels: CHANNELS,
      replay_id: this.replayId };
    this.unsubscribeView = this.gateway.subscribe(this.spec, (event) => this.scheduleChange(event));
    this.onStatus(this.status);
    return { ok: true };
  }

  // The changed channels since the last frame go to onChange once per frame: a snapshot (or any notice that names
  // none) is "all"; a delta, a batch or a seek's diff (patch) names its own, so only the panels drawing them redraw.
  scheduleChange(event = {}) {
    const named = ["delta", "batch", "patch"].includes(event?.type) && Array.isArray(event.changedChannels) ? event.changedChannels : null;
    if (!named) this.pendingChannels = "all";
    else if (this.pendingChannels !== "all") this.pendingChannels = new Set([...(this.pendingChannels || []), ...named]);
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const channels = this.pendingChannels;
      this.pendingChannels = null;
      if (this.active && channels) this.onChange(channels);
    });
  }

  /** Every replay command goes through here: a refusal or a failure is recorded with the action and the replay id, and
   * the promise always settles with a reply ({ok:false, error} for a failure), so a caller that does not wait leaves
   * no unhandled rejection. */
  command(action, replayId, send) {
    return Promise.resolve().then(send).then((reply) => {
      if (!reply?.ok) console.warn(`[history replay: ${action}] refused`, { replayId, error: reply?.error, detail: reply?.detail });
      return reply;
    }, (error) => {
      console.error(`[history replay: ${action}] failed`, { replayId }, error);
      return { ok: false, error: "FAILED", detail: String(error?.message || error) };
    });
  }

  control(action, options = {}) {
    const id = this.replayId;
    if (!id) return Promise.resolve({ ok: false, error: "NOT_OPEN" });
    return this.command(action, id, () => controlRealtimeReplay(id, action, options)).then((reply) => {
      // A reply for a replay this engine no longer shows (closed, or replaced by another product's) changes nothing.
      if (this.replayId !== id) return { ok: false, error: "SUPERSEDED", replay_id: id };
      if (reply?.status) {
        this.status = reply.status;
        this.onStatus(reply.status);
      }
      return reply;
    });
  }

  play() { return this.control("play"); }
  pause() { return this.control("pause"); }
  setSpeed(speed) { return this.control("speed", { speed: Number(speed) }); }
  seek(atNs) { return this.control("seek", { atNs }); }

  /** A move while a bar is dragged: one in flight, and only the newest `target` waits behind it (a drag asks for many
   * seconds per frame; the ones passed over are never sent). `move(target)` does one: a seek, or opening the replay
   * again when Market Runtime has ended it. close() drops what waits. */
  requestSeek(target, move) {
    this.pendingSeek = { target, move };
    if (!this.seeking) void this.drainSeeks();
  }

  async drainSeeks() {
    this.seeking = true;
    try {
      while (this.pendingSeek) {
        const { target, move } = this.pendingSeek;
        this.pendingSeek = null;
        await move(target);
      }
    } catch (error) {
      console.error("[history replay: seek] failed", { replayId: this.replayId }, error);
    } finally {
      this.seeking = false;
    }
  }

  end(reason) {
    const wasActive = this.active;
    this.unsubscribeView?.();
    this.unsubscribeView = null;
    this.replayId = null;
    this.spec = null;
    this.status = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pendingChannels = null;
    if (wasActive) {
      this.onEnded(reason);
    }
  }

  /** Close what is open. It supersedes an open still in flight: that reply must not install a replay after this
   * (not only dispose()). */
  async close() {
    this.openGeneration += 1;
    this.pendingSeek = null;
    await this.closeCurrent();
  }

  async closeCurrent() {
    const id = this.replayId;
    this.end("CLOSED");
    if (id) await this.command("close", id, () => closeRealtimeReplay(id));
  }

  /** Stops listening at once; the returned promise settles when Market Runtime has answered the close. */
  dispose() {
    this.unsubscribeStatus?.();
    this.unsubscribeConnection?.();
    return this.close();
  }

  state() {
    return this.spec ? (this.gateway.snapshot(this.spec) || {}) : {};
  }

  // 漲停/跌停: the replayed day's official ones (Market Runtime's summary), or none.
  limits(summary) {
    return { up: positiveNumberOrNull(summary?.limit_up), down: positiveNumberOrNull(summary?.limit_down) };
  }

  // ------------------------------------------------------------------ view models (the live page's shapes)

  trendViewModel({ displayName = "", options = {} } = {}) {
    const state = this.state();
    const summary = state.summary || {};
    const prevClose = displayQuote(summary).reference;
    const current = positiveNumberOrNull(summary.current ?? summary.price);
    const high = numberOrNull(summary.high);
    const low = numberOrNull(summary.low);
    const limits = this.limits(summary);
    const predictions = modelPredictionMetrics(state.signals);
    return withMarketRead({
      availability: "AVAILABLE",
      points: Array.isArray(state.trend) ? state.trend : [],
      prevClose,
      openPrice: numberOrNull(summary.open),
      currentPrice: current,
      displayName: displayName || summary.name || this.code,
      displayCode: this.code,
      symbol: this.code,
      metrics: {
        limitUp: limits.up,
        limitDown: limits.down,
        ...trendMetrics({ change: summary.change, changePct: summary.change_pct, amplitude: summary.amplitude }),
        // The replay's own model predictions (Rust B inference -> producer -> Market Runtime, phase 3).
        ...predictions.metrics,
        predictionNotes: predictions.notes,
      },
      options: { adapterType: "replay", ...options },
    }, this.gateway.readSnapshot(this.spec));
  }

  orderbookViewModel({ displayName = "" } = {}) {
    const state = this.state();
    const summary = state.summary || {};
    // 逐價內外盤 beside the book is the replay view's own price_volume, as on the live page.
    const priceVolume = state.price_volume && typeof state.price_volume === "object" ? state.price_volume : {};
    const view = StockOrderBookAdapter.build({ code: this.code, signal: summary, book: { ...(state.orderbook || {}), diff_renderable: true },
      aggregate: normalizeDaemonPriceVolume(priceVolume),
      readModel: this.gateway.readSnapshot(this.spec) });
    const limits = this.limits(summary);
    return { ...view, limitUp: view.limitUp ?? limits.up, limitDown: view.limitDown ?? limits.down,
      titlePrimary: displayName || view.titlePrimary, titleSecondary: this.code, displayLabel: this.code };
  }

  tickDetailsViewModel() {
    const state = this.state();
    const summary = state.summary || {};
    const trades = Array.isArray(state.trades) ? state.trades : [];
    // The live tape's rules (tape_rows.js): no 試撮 print, and the 大單 badge from this view's own tradeflow.
    const flow = normalizeRustTradeFlow(state.tradeflow || {});
    const isLarge = largePrintMatcher(flow);
    // Newest first, as the live page lists them, each row its print's durable sequence: these rows are the read
    // model's trades channel (the list reads that channel, not `rows`), so a print new to the replay tops the list
    // and washes.
    const rows = trades.filter(isTapePrint).slice(-120).reverse().map((tick) => tapeRow(tick, isLarge(tick)));
    const referencePrice = displayQuote(summary).reference;
    const limits = this.limits(summary);
    return withMarketRead({
      availability: rows.length ? "AVAILABLE" : "UNAVAILABLE",
      logicalCode: this.code,
      rows,
      referencePrice, limitUp: limits.up, limitDown: limits.down,
      largeOrderDefinition: largeOrderDefinition(flow),
      emptyText: "回放尚未播到成交",
    }, this.gateway.readSnapshot(this.spec, { trades: rows }));
  }

  // 價量: the replay view's price ladder with Rust B's per-price 大單／小單 split (the live page's priceFlow shape).
  priceFlowViewModel() {
    if (this.computing) return { availability: "UNAVAILABLE", message: "計算中", code: this.code, identity: `replay|${this.replayId || ""}|${this.code}`, priceVolume: {} };
    const state = this.state();
    const summary = state.summary || {};
    const priceVolume = state.price_volume && typeof state.price_volume === "object" ? state.price_volume : {};
    return {
      availability: Array.isArray(priceVolume.buckets) && priceVolume.buckets.length ? "AVAILABLE" : "UNAVAILABLE",
      message: "回放尚未播到成交",
      code: this.code,
      identity: `replay|${this.replayId || ""}|${this.code}`,
      priceVolume,
      currentPrice: positiveNumberOrNull(summary.current ?? priceVolume.current_price),
      referencePrice: displayQuote(summary).reference,
    };
  }

  tradeFlowViewModel() {
    if (this.computing) {
      return { availability: "UNAVAILABLE", pending: true, message: "計算中", flow: { available: false, sample_count: 0 }, scopeLabel: "回放時間以前",
        logicalCode: this.code, notePrefix: "Canonical LargeOrderPolicy（回放）", flowSource: [null, null] };
    }
    const state = this.state();
    const flow = normalizeRustTradeFlow(state.tradeflow || {});
    if (flow) flow.windows = bigOrderFlowWindowsFromRust(state.windows);
    const available = Boolean(flow?.available);
    return {
      availability: available ? "AVAILABLE" : "UNAVAILABLE",
      message: available ? "" : "等待 Rust B 計算回放的大單流向",
      flow: flow || { available: false, sample_count: 0 },
      scopeLabel: "回放時間以前",
      logicalCode: this.code,
      notePrefix: "Canonical LargeOrderPolicy（回放）",
      // The immutable state objects `flow` was derived from: the component skips rebuilding when they are unchanged.
      flowSource: [state.tradeflow, state.windows],
    };
  }
}
