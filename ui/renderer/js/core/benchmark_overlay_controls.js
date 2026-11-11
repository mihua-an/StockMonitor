export const BENCHMARK_OVERLAYS = Object.freeze(["taiex", "futures"]);
export const DEFAULT_BENCHMARK_OVERLAY_STATE = Object.freeze({ taiex: true, futures: false });

export function normalizeBenchmarkOverlayState(value = {}) {
  return value?.futures && !value?.taiex
    ? { taiex: false, futures: true }
    : { taiex: true, futures: false };
}

// The toolbar's one markup (個股走勢's control row, 歷史回放's chart); never carries an id.
export function benchmarkOverlayControlsMarkup() {
  return `<div class="pill-switch trend-session-control" data-role="trend-overlay-toolbar" role="group" aria-label="個股走勢比較線">
    <button type="button" class="pill-switch-btn" data-role="trend-overlay-taiex" aria-pressed="false">加權</button>
    <button type="button" class="pill-switch-btn" data-role="trend-overlay-futures" aria-pressed="false">期貨</button>
  </div>`;
}

export function syncBenchmarkOverlayControls(root, state = {}) {
  const normalized = normalizeBenchmarkOverlayState(state);
  for (const [role, key] of [["trend-overlay-taiex", "taiex"], ["trend-overlay-futures", "futures"]]) {
    const button = root?.querySelector?.(`[data-role="${role}"]`);
    const active = Boolean(normalized[key]);
    button?.classList?.toggle("active", active);
    button?.setAttribute?.("aria-pressed", String(active));
  }
  return normalized;
}

export function bindBenchmarkOverlayControls(root, { initialState = DEFAULT_BENCHMARK_OVERLAY_STATE, onSelect = null } = {}) {
  let state = syncBenchmarkOverlayControls(root, initialState);
  const cleanups = [];
  for (const [role, key] of [["trend-overlay-taiex", "taiex"], ["trend-overlay-futures", "futures"]]) {
    const button = root?.querySelector?.(`[data-role="${role}"]`);
    if (!button) continue;
    const handler = () => {
      if (state[key]) return;
      state = syncBenchmarkOverlayControls(root, { taiex: key === "taiex", futures: key === "futures" });
      onSelect?.(key, { ...state });
    };
    button.addEventListener("click", handler);
    cleanups.push(() => button.removeEventListener("click", handler));
  }
  return {
    getState: () => ({ ...state }),
    isSelected: (key) => Boolean(state[String(key || "")]),
    select: (key, { notify = false } = {}) => {
      const normalizedKey = key === "futures" ? "futures" : "taiex";
      state = syncBenchmarkOverlayControls(root, { taiex: normalizedKey === "taiex", futures: normalizedKey === "futures" });
      if (notify) onSelect?.(normalizedKey, { ...state });
      return { ...state };
    },
    destroy: () => cleanups.splice(0).forEach((cleanup) => cleanup()),
  };
}
