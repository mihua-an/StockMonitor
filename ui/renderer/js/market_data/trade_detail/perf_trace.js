// The developer's paging trace (not shown on any page): printed as [TRADE PAGE PERF], and the newest few kept for the
// renderer health report beside the selection trace (renderer_runtime_health.js trade_pages_recent).
const RECENT_LIMIT = 8;
const recent = [];
function remember(entry) {
  recent.push(entry);
  if (recent.length > RECENT_LIMIT) recent.shift();
}
// Page-count reads (metadata_only) in their own ring, so user page reads never push them out: what each one ended as
// (applied / dropped and why / failed) and the page count the pager then held.
const countReads = [];
export function tradePageTraceSnapshot() {
  return [...recent, ...countReads].map((entry) => ({ ...entry }));
}

export function recordPageCountRead(entry) {
  countReads.push({ kind: "page_count", at: new Date().toISOString(), ...entry });
  if (countReads.length > RECENT_LIMIT) countReads.shift();
  if (entry.outcome !== "applied") console.warn("[TRADE PAGE COUNT]", entry);
}

export function logTradePagePerfTrace({ target, identityKey, page, rowsCount, result,
  perfStartedAt, perfApiDoneAt, perfMapDoneAt, perfInvalidateAt, traceFrame }) {
  const trace = {
    target, identity_key: identityKey, page, rows: rowsCount,
    total_rows: Number(result?.total_rows) || 0,
    total_pages: Number(result?.total_pages) || 1,
    parts_opened: Number(result?.parts_opened) || 0,
    backend_latency_ms: Number(result?.latency_ms) || 0,
    api_ms: Math.round(perfApiDoneAt - perfStartedAt),
    map_state_ms: Math.round(perfMapDoneAt - perfApiDoneAt),
    invalidate_js_ms: Math.round(perfInvalidateAt - perfMapDoneAt),
  };
  // Two animation frames approximate "DOM work scheduled + browser paint".
  // This makes API latency and renderer latency independently visible.
  traceFrame(() => {
    traceFrame(() => {
      const paintedAt = performance.now();
      const entry = {
        ...trace,
        render_paint_ms: Math.round(paintedAt - perfInvalidateAt),
        ui_after_api_ms: Math.round(paintedAt - perfApiDoneAt),
        total_ms: Math.round(paintedAt - perfStartedAt),
      };
      remember(entry);
      console.log("[TRADE PAGE PERF]", entry);
    });
  });
}

export function logTradePagePerfFailure({ target, page, perfStartedAt, error }) {
  const failedAt = performance.now();
  const entry = { target, page, api_ms: Math.round(failedAt - perfStartedAt), error: error?.message || String(error) };
  remember(entry);
  console.warn("[TRADE PAGE PERF][API FAILED]", entry);
}
