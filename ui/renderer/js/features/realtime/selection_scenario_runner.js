import { annotateSelection, selectionContext, selectionTraceSnapshot } from "../../core/selection_latency_trace.js";

export const SELECTION_SCENARIOS = Object.freeze({
  SINGLE_POPULAR: ["2330"],
  SINGLE_THIN: ["8271"],
  A_B_A: ["2330", "2317", "2330"],
  RAPID_FIVE: ["2330", "2317", "2454", "2303", "2881"],
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Renderer scenario driver: it invokes the production selection owner and only observes trace state. */
export function installSelectionScenarioRunner({ select, cacheProbe = () => false } = {}) {
  const seen = new Set();
  let lastResult = null;
  const api = {
    scenarios: SELECTION_SCENARIOS,
    async run({ scenario = "A_B_A", codes = null, intervalMs = 500, settleMs = 5000,
                loadProfile = "UNSPECIFIED", runId = `selection-run-${Date.now()}` } = {}) {
      const sequence = (Array.isArray(codes) ? codes : SELECTION_SCENARIOS[scenario])?.map(code => String(code).trim().toUpperCase()).filter(Boolean);
      if (!sequence?.length || typeof select !== "function") throw new Error("selection scenario/callback unavailable");
      if (![100, 250, 500, 1000].includes(Number(intervalMs))) throw new Error("intervalMs must be 100/250/500/1000");
      const generations = [];
      const skipped = [];
      for (const code of sequence) {
        const resident = Boolean(cacheProbe(code));
        const rendererCacheClass = resident ? (seen.has(code) ? "HOT" : "WARM") : "COLD";
        const previousGeneration = selectionContext(code)?.selection_generation;
        select(code);
        const trace = selectionContext(code);
        if (trace && trace.selection_generation !== previousGeneration) {
          annotateSelection(code, {run_id:runId, scenario, load_profile:loadProfile,
            renderer_cache_class:rendererCacheClass}, trace);
          generations.push(trace.selection_generation);
        } else skipped.push({code, reason:"no_new_selection_generation"});
        seen.add(code);
        await delay(Number(intervalMs));
      }
      // Keep observing the entire settling interval: first meaningful content
      // can precede bootstrap and the slower component frame opportunities.
      await delay(Math.max(0, Number(settleMs)));
      const snapshot = selectionTraceSnapshot(generations);
      lastResult = {evidence_class:"selection_scenario",run_id:runId,scenario,load_profile:loadProfile,
        interval_ms:Number(intervalMs),skipped,rows:snapshot.rows,
        percentiles:snapshot.percentiles,stage_percentiles:snapshot.stagePercentiles,
        measurement_note:snapshot.paint_measurement};
      return lastResult;
    },
    resetCacheClassification() { seen.clear(); },
    lastResult() { return lastResult ? JSON.parse(JSON.stringify(lastResult)) : null; },
    downloadLast(filename = "selection-trace.json") {
      if (!lastResult || typeof document === "undefined" || typeof URL === "undefined") return false;
      const url = URL.createObjectURL(new Blob([JSON.stringify(lastResult, null, 2)], {type:"application/json"}));
      const link = document.createElement("a");
      link.href = url; link.download = String(filename || "selection-trace.json");
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return true;
    },
  };
  if (typeof window !== "undefined") window.stockMonitorSelectionBenchmark = api;
  return api;
}
