// 技術分析 on a replay: the replayed stock's minute trend and fixed K bars at the replay time, as the technical-analysis
// component's service. One service per replay owner -- 歷史回放 (this module's own) and 帳務's 配對回放
// (features/account/pair_replay_session.js) -- each reading its own replay.
import { historyPage, historyState } from "./history_state.js";
import { loadTechnicalHistory } from "../realtime/technical_history_api.js";
import { stockCanonicalViewSpec } from "../../market_data/stock_view_spec.js";

// Every notice reaches every listener: one that throws is recorded and the rest are still told.
function emitSafely(listeners, kind, ...args) {
  for (const listener of [...listeners]) {
    try { listener(...args); } catch (error) { console.warn(`[REPLAY TA] ${kind} listener failed`, error); }
  }
}

/**
 * The service over one replay: `engine()` is the open replay (an EngineReplay) or null, `key(code)` names the
 * replay a code belongs to ("" when the code is not the replay's). Technical analysis reads what live 技術分析 reads:
 * Market Runtime's replayed minute trend and Rust B's fixed K (`day`), both as of the replay time, and the local days
 * before the replayed one.
 */
export function createReplayTechnicalService({ engine, key }) {
  const listeners = new Set();
  // Told when the replay changes: what key() means then changes too (the TA tab's readiness transition).
  const keyListeners = new Set();
  let frame = 0;
  const state = () => {
    const read = engine()?.active ? (engine().state() || {}) : {};
    return { trend: Array.isArray(read.trend) ? read.trend : [], day: read.day && typeof read.day === "object" ? read.day : { fixed_k: {} } };
  };
  const service = {
    key,
    sessionDate: (code) => String(key(code) || "").split("|")[1] || "",
    history({ code, resolution, before }) {
      const { code: canonical, market, session } = stockCanonicalViewSpec(code, before);
      return loadTechnicalHistory({ code: canonical, market, session, resolution, before });
    },
    onKeyChange(listener) {
      keyListeners.add(listener);
      return () => keyListeners.delete(listener);
    },
    subscribe(code, listener) {
      if (!key(code)) return null;
      listeners.add(listener);
      emitSafely([listener], "state", state());
      return () => listeners.delete(listener);
    },
  };
  return {
    service,
    state,
    /** The replay's trend moved: listeners are told once per frame. */
    notify() {
      if (!listeners.size || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        emitSafely(listeners, "state", state());
      });
    },
    notifyKeyChange() { emitSafely(keyListeners, "key-change"); },
    /** The owner is leaving: a notice still waiting for its frame is dropped. */
    cancel() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

// 歷史回放's: the selected product's replay on the selected day.
const history = createReplayTechnicalService({
  engine: () => historyPage.engine,
  key(code) {
    const target = String(code || "").trim().toUpperCase();
    const date = String(historyState.selectedDate || "").slice(0, 10);
    return target && date && target === String(historyState.selectedCode || "").trim().toUpperCase() ? `${target}|${date}` : "";
  },
});

export const replayTechnicalService = history.service;
export const replayTechnicalState = history.state;
export const scheduleReplayTechnicalNotify = history.notify;
export const notifyReplayTechnicalKeyChange = history.notifyKeyChange;
export const cancelReplayTechnicalNotify = history.cancel;
