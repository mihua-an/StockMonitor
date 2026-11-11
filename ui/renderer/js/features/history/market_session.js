// 歷史回放 大盤: the replayed day's TAIEX / TXF sessions the replay chart draws as its benchmark overlays (split out of
// pages/history.js).
import { subscribeRealtimeView } from "../../market_data/realtime.js";
import { historyHooks, historyQueries, historyState } from "./history_state.js";
import { historyDateStillSelected } from "./history_values.js";
import { displayQuote } from "../../core/auction_price.js";

// A day Market Runtime still holds: its TAIEX view as the replay's market session, in the stored session's shape (one
// `points` list of minute levels and the index's 昨收), which is all the replay chart's 加權 overlay reads.
export function marketSessionFromRuntimeView(normalizedDate, livePoints, summary) {
  const points = livePoints.map((point) => ({ time: point?.time, price: point?.price ?? point?.close }));
  return {
    ok: true,
    date: normalizedDate,
    count: points.length,
    points,
    prev_close: displayQuote(summary).reference,
    history_source: "market_runtime_view",
  };
}

export async function loadHistoryMarketSession(date) {
  const normalizedDate = String(date || "");
  if (!normalizedDate) {
    historyState.marketSession = null;
    historyState.marketDate = "";
    historyHooks.setHistoryChartLoading("market", false);
    historyHooks.rerenderHistoryCurrentChart();
    return;
  }

  if (historyState.marketDate === normalizedDate && historyState.marketSession) {
    historyHooks.setHistoryChartLoading("market", false);
    historyHooks.rerenderHistoryCurrentChart();
    return;
  }

  try {
    const result = await historyQueries.getHistoryMarketSessionCached(normalizedDate);
    if (!historyDateStillSelected(normalizedDate)) return;

    // The current session schema carries the minute `points`; a reply without them is a version mismatch, reported and
    // shown as no stored session (the renderer does not rebuild minutes from another shape).
    if (result?.ok && !Array.isArray(result.points)) {
      console.error("[HISTORY TAIEX] the stored session has no points: schema mismatch", { date: normalizedDate, keys: Object.keys(result) });
    }
    const hasHistoryData = Boolean(result?.ok && Array.isArray(result.points) && result.points.length);

    if (hasHistoryData) {
      historyState.marketSession = result;
      historyState.marketDate = normalizedDate;
      return;
    }

    // A day that is not stored yet (today, before the close is materialized) is still held by Market Runtime until
    // the next pre-open: its TAIEX view is read over the WS, never over FastAPI.
    const live = await readRuntimeTaiexDay(normalizedDate);
    if (!historyDateStillSelected(normalizedDate)) return;
    const livePoints = Array.isArray(live?.trend) ? live.trend : [];
    const summary = live?.summary || {};

    if (livePoints.length) {
      historyState.marketSession = marketSessionFromRuntimeView(normalizedDate, livePoints, summary);
    } else {
      historyState.marketSession = null;
    }
    historyState.marketDate = normalizedDate;
  } catch (error) {
    console.warn("[HISTORY TAIEX] load failed", error);
    if (historyDateStillSelected(normalizedDate)) {
      historyState.marketSession = null;
      historyState.marketDate = normalizedDate;
    }
  } finally {
    // The replay chart draws the 加權 overlay from the session just stored (or drops it for a day without one).
    if (historyDateStillSelected(normalizedDate)) {
      historyHooks.setHistoryChartLoading("market", false);
      historyHooks.rerenderHistoryCurrentChart();
    }
  }
}

export async function loadHistoryTxfSession(date) {
  const normalizedDate = String(date || "").slice(0, 10);
  if (!normalizedDate) {
    historyState.txfSession = null;
    historyState.txfDate = "";
    return;
  }
  if (historyState.txfDate === normalizedDate && historyState.txfSession) return;
  let session = null;
  try {
    const result = await historyQueries.getHistoryTxfSessionCached(normalizedDate);
    session = result?.ok && Array.isArray(result?.points) && result.points.length ? result : null;
  } catch (error) {
    console.warn("[HISTORY TXF] load failed", error);
  }
  if (!historyDateStillSelected(normalizedDate)) return;
  historyState.txfSession = session;
  historyState.txfDate = normalizedDate;
  historyHooks.rerenderHistoryCurrentChart();
}

// One read of Market Runtime's view of index `code` (TAIEX, or an 產業指數) for `date`: subscribe, take the first
// snapshot, release. Resolves to the snapshot's {summary, trend}, or null when A holds no such day (rolled over),
// answers with an error or does not answer in time; the error and the timeout are recorded.
export const RUNTIME_TAIEX_READ_TIMEOUT_MS = 8000;

export function readRuntimeTaiexDay(date) {
  return readRuntimeIndexDay(date, "TAIEX");
}

export function readRuntimeIndexDay(date, code) {
  return new Promise((resolve) => {
    let release = null;
    let settled = false;
    const releaseSafely = () => {
      try {
        release?.();
      } catch (error) {
        console.warn(`[HISTORY ${code}: releasing the ${date} view] failed`, error);
      }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      queueMicrotask(releaseSafely);
      resolve(value);
    };
    const timer = setTimeout(() => {
      console.warn(`[HISTORY ${code}: reading the ${date} view] failed`, `no snapshot within ${RUNTIME_TAIEX_READ_TIMEOUT_MS} ms`);
      finish(null);
    }, RUNTIME_TAIEX_READ_TIMEOUT_MS);
    release = subscribeRealtimeView({ market: "IDX", code, trading_date: date, session: "DAY",
      channels: ["summary", "trend"] }, (event) => {
      if (event?.type === "snapshot") {
        const state = event.state || {};
        const day = String(state?.session_key?.trading_date || state?.summary?.trading_date || "").slice(0, 10);
        finish(!day || day === date ? { summary: state.summary || {}, trend: state.trend || [] } : null);
      } else if (event?.type === "error") {
        console.warn(`[HISTORY ${code}: reading the ${date} view] failed`, event.error || event);
        finish(null);
      }
    }, { stateDelivery: "snapshot-only" });
    if (settled) queueMicrotask(releaseSafely);
  });
}
