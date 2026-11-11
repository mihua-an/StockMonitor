// Bounded selection-only timing. Epoch is correlation metadata; durations use performance.now().
const channels = ["summary", "orderbook", "trades", "trend", "price_volume", "tradeflow"];
const history = [];
let current = null, generation = 0;
const now = () => performance.now();
export function beginSelection(code, fromCode = "") {
  if (current?.to_code === code) return current;
  const previousCode = current?.to_code || fromCode;
  current = { selection_generation: ++generation, request_id: `selection-${Date.now()}-${generation}`,
    from_code: previousCode, to_code: code, selection_started_ns: String(BigInt(Date.now()) * 1000000n),
    started: now(), marks: { selection_intent: 0 }, stages: {}, channels: {}, requests: [] };
  history.push(current); if (history.length > 128) history.shift();
  return current;
}
export function selectionContext(code) { return current?.to_code === code ? current : null; }
export function selectionMark(code, mark, context = current) {
  if (!context || context !== current || context.to_code !== code) return;
  context.marks[mark] ??= now() - context.started;
}
export function selectionMarkAt(code, mark, absolutePerformanceMs, context = current) {
  if (!context || context !== current || context.to_code !== code) return;
  context.marks[mark] ??= Math.max(0, Number(absolutePerformanceMs) - context.started);
}
export function selectionPayload(code, channel, payload, context = current) {
  if (!context || context !== current || context.to_code !== code) return;
  context.channels[channel] = { rows: Array.isArray(payload) ? payload.length : null, available: payload != null };
  selectionMark(code, `${channel}_ready`, context);
  if (channels.every(c => context.channels[c])) selectionMark(code, "full_view_ready", context);
}
export function selectionStage(code, name, duration, context = current) {
  if (context && context === current && context.to_code === code) context.stages[name] = duration;
}
export function annotateSelection(code, values = {}, context = current) {
  if (context && context === current && context.to_code === code) Object.assign(context, values);
}
const scheduledPaints = new WeakMap();
export function selectionComponentPaint(code, component, host) {
  const context = selectionContext(code);
  if (!context || !host?.isConnected || context.marks[`${component}_painted`] != null || scheduledPaints.get(host) === context) return;
  scheduledPaints.set(host, context);
  // Two frame boundaries approximate paint opportunity, not compositor/GPU presentation.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (scheduledPaints.get(host) === context) scheduledPaints.delete(host);
    if (!host.isConnected || selectionContext(code) !== context) return;
    if (host.getClientRects && !host.getClientRects().length) return;
    selectionMark(code, "first_visible_paint", context);
    selectionMark(code, "first_meaningful_market_data", context);
    selectionMark(code, `${component}_painted`, context);
  }));
}
export function selectionTraceSnapshot(generations = null) {
  const wanted = generations == null ? null : new Set(generations);
  const rows = history.filter(row => !wanted || wanted.has(row.selection_generation)).map(row => ({...row, marks:{...row.marks}, stages:{...row.stages}, channels:{...row.channels}, requests:[...row.requests]}));
  const keys = new Set(rows.flatMap(row => Object.keys(row.marks)));
  const percentiles = Object.fromEntries([...keys].map(key => {
    const values = rows.map(row => row.marks[key]).filter(Number.isFinite).sort((a,b)=>a-b);
    const p = q => values[Math.max(0,Math.ceil(values.length*q)-1)] ?? null;
    return [key,{samples:values.length,p50:p(.5),p90:p(.9),p95:p(.95),p99:p(.99),max:values.at(-1)}];
  }));
  const stageSamples = {};
  const visit = (value, prefix = "") => {
    for (const [key, item] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (item && typeof item === "object") visit(item, name);
      else if (typeof item === "number" && Number.isFinite(item) && key.endsWith("_ms")) (stageSamples[name] ||= []).push(item);
    }
  };
  rows.forEach(row => visit(row.stages));
  const stagePercentiles = Object.fromEntries(Object.entries(stageSamples).map(([key, values]) => {
    values.sort((a,b)=>a-b);
    const p = q => values[Math.max(0,Math.ceil(values.length*q)-1)] ?? null;
    return [key,{samples:values.length,p50:p(.5),p90:p(.9),p95:p(.95),p99:p(.99),max:values.at(-1)}];
  }));
  return {rows,percentiles,stagePercentiles,paint_measurement:"double-rAF opportunity; not GPU presentation"};
}
if (typeof window !== "undefined") window.stockMonitorSelectionTrace = selectionTraceSnapshot;
