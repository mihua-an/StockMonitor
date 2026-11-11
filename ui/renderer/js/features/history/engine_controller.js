// 歷史回放: the page's side of Market Runtime's replay (features/history/engine_replay.js). One replay of the selected
// product and day is the page's only source of what the cursor shows: the time bar, « ‹ › », 播放 and every panel read
// it, and moving the bar is a seek of it (Market Runtime and Rust B restart from their nearest checkpoint).
import { marketPalette, themeColor } from "../../core/market_palette.js";
import { EngineReplay, isPermanentReplayOpenError, nsToTaipeiClock } from "./engine_replay.js";
import { historyHooks, historyPage, historyState } from "./history_state.js";
import { activeHistoryTradeForCurrent, getHistoryStockName, historyTradeEntryPrice, historyTradeInterval } from "./history_values.js";
import { buildHistoryTrendOverlaySeries } from "./replay_series.js";
import { buildHistoryEventMarkers, buildHistoryTradeEntryMarkers } from "./history_event_markers.js";
import { endOfSecondNs, setupHistoryTimeline, showHistoryTimelineBuffer, showHistoryTimelinePosition, taipeiSecondOfDay } from "./timeline.js";

// The replay panels and the view channels each draws (a snapshot redraws them all).
export const REPLAY_PANELS = ["trendChart", "orderbook", "tickDetails", "priceFlow", "tradeFlow", "eventFeed"];
export const PANELS_BY_CHANNEL = Object.freeze({
  trend: ["trendChart"], signals: ["trendChart"], summary: ["trendChart", "orderbook"], orderbook: ["orderbook"],
  price_volume: ["priceFlow", "orderbook"], day: ["priceFlow", "orderbook"], coverage: ["trendChart"],
  // 成交明細's 大單 badges are the tradeflow's large prints, which Rust B publishes after the prints themselves.
  tradeflow: ["tradeFlow", "tickDetails"], trades: ["tickDetails"], events: ["eventFeed"],
  // 大單流向's time windows (Rust B's windows block: its delta and a seek's diff name `windows`).
  windows: ["tradeFlow"],
});

// What Market Runtime's refusal of a product's replay means to the user.
const UNAVAILABLE_TEXT = Object.freeze({
  NOT_AVAILABLE: "這一天沒有這檔商品的回放資料",
  NOT_COMMITTED: "這一天的回放資料還在整理中",
  OLD_FORMAT: "這一天的回放資料是舊格式，無法回放",
  CORRUPT: "這一天的回放資料損毀，無法回放",
  TOO_LARGE: "這一天的回放資料太大，無法回放",
  NOT_CONFIGURED: "Market Runtime 沒有設定歷史資料目錄",
  INVALID_IDENTITY: "商品或日期不正確",
});

export function ensureHistoryEngine() {
  if (historyPage.engine) return historyPage.engine;
  historyPage.engine = new EngineReplay({
    onChange: (channels) => {
      const all = channels === "all";
      const redraw = new Set(all ? REPLAY_PANELS : [...channels].flatMap((channel) => PANELS_BY_CHANNEL[channel] || []));
      for (const id of redraw) historyHooks.invalidateReplayComponents(id);
    },
    onStatus: (status) => syncHistoryEngineStatus(status),
    onEnded: (reason) => {
      historyState.playing = false;
      // Market Runtime ends a replay with the connection that opened it: the next move of the bar, « ‹ › » or 播放 opens
      // it again where it stood.
      if (reason === "DISCONNECTED") console.warn("[HISTORY] the replay ended with its Market Runtime connection; the next move reopens it");
      historyHooks.updatePlayButton();
      historyHooks.invalidateReplayComponents();
    },
  });
  return historyPage.engine;
}

/** Market Runtime's status of the open replay (on open, every control reply, and about every 250 ms). */
export function syncHistoryEngineStatus(status) {
  if (!status) return;
  const wasComputing = historyState.replay?.analysis?.at_position === false;
  historyState.replay = status;
  // 大單流向 and 價量 say 計算中 by the status: redrawn when it changes, not only with the next data.
  if ((status.analysis?.at_position === false) !== wasComputing) historyPage.engine?.scheduleChange();
  const clock = nsToTaipeiClock(status.position_ns);
  // The page redraws what shows the time (事件 up to it, the chart's cut-off) once per frame (updateHistoryTimeLabel).
  if (clock && clock !== historyState.replayCurrentTime) historyHooks.updateHistoryTimeLabel(clock);
  if (!historyState.dragging) showHistoryTimelinePosition(taipeiSecondOfDay(status.position_ns));
  showHistoryTimelineBuffer(status.analysis?.buffered);
  if (Boolean(status.playing) !== Boolean(historyState.playing)) {
    historyState.playing = Boolean(status.playing);
    historyHooks.updatePlayButton();
  }
}

function selection() {
  return { code: String(historyState.selectedCode || "").trim().toUpperCase(), date: String(historyState.selectedDate || "").slice(0, 10) };
}

function engineShows({ code, date }) {
  const engine = historyPage.engine;
  return Boolean(engine?.active && engine.code === code && engine.spec?.trading_date === date);
}

/** Open the selected product's replay at `clock` ("HH:MM:SS"; its first print when empty). Resolves true when open. */
export async function openHistoryEngine(clock = "") {
  const { code, date } = selection();
  if (!code || !date) return false;
  historyState.replayUnavailable = "";
  const engine = ensureHistoryEngine();
  const opened = await engine.open({ code, tradingDate: date, clock, speed: historyState.speed });
  if (!opened.ok) {
    if (opened.error === "SUPERSEDED") return false;
    historyState.replay = null;
    historyState.replayUnavailable = UNAVAILABLE_TEXT[opened.error]
      || `回放開啟失敗（${opened.error}），請再選一次商品或時間`;
    if (!isPermanentReplayOpenError(opened.error)) console.warn("[HISTORY] replay not opened", { code, date, error: opened.error, detail: opened.detail });
    historyHooks.invalidateReplayComponents();
    return false;
  }
  syncHistoryEngineStatus(engine.status);
  setupHistoryTimeline(engine.status);
  historyHooks.invalidateReplayComponents();
  return true;
}

/** Leave the replay (another date or product, the page closing). */
export function endHistoryEngineReplay() {
  historyState.replay = null;
  if (!historyPage.engine) return;
  // close() drops a seek still waiting, settles with Market Runtime's reply and records a failure itself (EngineReplay.command).
  void historyPage.engine.close();
}

export function pauseHistoryEngineReplay() {
  if (historyPage.engine?.active && historyPage.engine.playing) void historyPage.engine.pause();
}

/** Move the replay to second `second` of the day (the bar, an event row, a trade jump). */
export function seekHistoryEngine(second) {
  ensureHistoryEngine().requestSeek(second, moveHistoryReplay);
}

async function moveHistoryReplay(second) {
  const target = selection();
  if (!target.code || !target.date) return;
  if (engineShows(target)) {
    const atNs = endOfSecondNs(target.date, second);
    if (atNs) await historyPage.engine.seek(atNs);
  } else {
    await openHistoryEngine(nsToTaipeiClock(endOfSecondNs(target.date, second)));
  }
}

export async function startHistoryEngineReplay() {
  const target = selection();
  if (!engineShows(target) && !(await openHistoryEngine(historyState.replayCurrentTime))) return false;
  historyState.playing = true;
  historyHooks.updatePlayButton();
  const reply = await historyPage.engine.play();
  if (!reply?.ok) {
    historyState.playing = false;
    historyHooks.updatePlayButton();
  }
  return Boolean(reply?.ok);
}

/** The replay chart: Market Runtime's trend with the page's benchmarks, 均價, events and the trade under review. */
export function historyEngineTrendViewModel() {
  const engine = historyPage.engine;
  const pair = activeHistoryTradeForCurrent();
  const base = engine.trendViewModel({ displayName: getHistoryStockName(historyState.selectedCode) });
  const cursor = { time: historyState.replayCurrentTime, reference: base.prevClose };
  return {
    ...base,
    options: {
      ...base.options,
      overlaySeries: buildHistoryTrendOverlaySeries(cursor, base.points),
      eventMarkers: [...buildHistoryTradeEntryMarkers(), ...buildHistoryEventMarkers(base.points)],
      ...(pair ? tradeReviewTrendOptions(pair) : {}),
    },
  };
}

/** A replay trend reviewing `pair`: its holding drawn in the market colours against its entry price, the rest of the
 * line muted (歷史回放's trade review and 帳務's 配對回放). */
export function tradeReviewTrendOptions(pair) {
  return {
    tradeInterval: historyTradeInterval(pair),
    tradeBasePrice: historyTradeEntryPrice(pair),
    mutedLineColor: themeColor("--chart-replay-muted-line"),
    tradeUpColor: marketPalette().up,
    tradeDownColor: marketPalette().down,
    tradeFlatColor: themeColor("--chart-trade-flat"),
  };
}
