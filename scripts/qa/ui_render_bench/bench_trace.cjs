// The UI render benchmarks' trace and profile reducers (run.cjs, history_run.cjs): the renderer main thread's time in
// the measured window by Chromium phase, and a V8 CPU profile as self / inclusive time per function and file.

// Renderer main-thread time inside the measured window (between the page's two console.timeStamp marks), split into
// the Chromium phases. Totals are of top-level task time; the phase rows are inclusive durations of those events.
function mainThreadBreakdown(trace, wallMs) {
  const events = Array.isArray(trace) ? trace : trace.traceEvents || [];
  const mainThreads = new Set(events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
  const marks = events.filter((e) => e.name === "TimeStamp" && String(e.args?.data?.message || "").startsWith("bench-measure-"));
  const start = marks.find((e) => e.args.data.message === "bench-measure-start")?.ts;
  const end = marks.find((e) => e.args.data.message === "bench-measure-end")?.ts;
  if (!start || !end) return { error: "measure marks missing from trace" };
  const markThread = `${marks[0].pid}:${marks[0].tid}`;
  const inside = events.filter((e) => e.ph === "X" && `${e.pid}:${e.tid}` === markThread && e.ts >= start && e.ts + (e.dur || 0) <= end);
  // Union of the events' intervals: nested events (a task inside a task, FunctionCall inside EventDispatch) count once.
  const sum = (names) => {
    const spans = inside.filter((e) => names.includes(e.name)).map((e) => [e.ts, e.ts + (e.dur || 0)]).sort((a, b) => a[0] - b[0]);
    let total = 0, from = -1, to = -1;
    for (const [a, b] of spans) { if (a > to) { if (to > from) total += to - from; from = a; to = b; } else if (b > to) to = b; }
    if (to > from) total += to - from;
    return total / 1000;
  };
  const windowMs = (end - start) / 1000;
  const task = sum(["ThreadControllerImpl::RunTask", "RunTask"]);
  const phases = {
    script_ms: sum(["FunctionCall", "EvaluateScript", "v8.compile", "TimerFire", "FireAnimationFrame", "EventDispatch"]),
    style_ms: sum(["UpdateLayoutTree", "RecalculateStyles"]),
    layout_ms: sum(["Layout"]),
    prepaint_paint_ms: sum(["PrePaint", "Paint", "PaintImage", "Layerize", "UpdateLayer", "CompositeLayers"]),
    gc_ms: sum(["MinorGC", "MajorGC", "V8.GC_SCAVENGER", "V8.GCScavenger", "V8.GCFinalizeMC", "BlinkGC.AtomicPhase", "ThreadState::performIdleLazySweep"]),
    parse_html_ms: sum(["ParseHTML", "ParseFragment"]),
  };
  void mainThreads; void wallMs;
  return { window_ms: Math.round(windowMs), busy_ms: Math.round(task), busy_percent: Number((100 * task / windowMs).toFixed(1)),
    ...Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, Math.round(v)])) };
}

function selfTimes(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const deltas = profile.timeDeltas || [];
  profile.samples.forEach((id, i) => { self.set(id, (self.get(id) || 0) + (deltas[i] || 0)); });
  const fn = new Map(), file = new Map();
  let total = 0;
  for (const [id, us] of self) {
    const f = byId.get(id).callFrame;
    total += us;
    const where = (f.url || "").split("/ui/renderer/").pop() || `(${f.functionName || "native"})`;
    const key = `${f.functionName || "(anonymous)"} ${where}:${f.lineNumber + 1}`;
    fn.set(key, (fn.get(key) || 0) + us);
    file.set(where.split(":")[0], (file.get(where.split(":")[0]) || 0) + us);
  }
  // Who calls the expensive natives (a forced layout is paid by whoever reads geometry first).
  const parentOf = new Map();
  for (const n of profile.nodes) for (const child of n.children || []) parentOf.set(child, n.id);
  const callers = {};
  for (const [id, us] of self) {
    const f = byId.get(id).callFrame;
    if (!["getBoundingClientRect", "drawImage", "getComputedStyle", "offsetWidth", "scrollHeight", "clientWidth", "measureText"].includes(f.functionName)) continue;
    const chain = [];
    for (let p = parentOf.get(id); p && chain.length < 3; p = parentOf.get(p)) {
      const c = byId.get(p).callFrame;
      chain.push(`${c.functionName || "(anon)"} ${(c.url || "").split("/ui/renderer/").pop()}:${c.lineNumber + 1}`);
    }
    const key = `${f.functionName} <- ${chain.join(" <- ")}`;
    callers[key] = (callers[key] || 0) + us;
  }
  // Inclusive time (self + everything it called) of the functions that own a stage of the pipeline.
  const inclusiveOf = new Map();
  const STAGES = ["handleMessage", "parseFrame", "handleDeltaBatch", "renderTrendCanvas", "renderProductListRows", "renderRealtimeQuoteTable",
    "invalidate", "buildLiveTickDetailsViewModel", "_render", "presentBackBuffer", "drawVolumeBars", "drawPriceLine", "drawEventMarkers",
    "resolvePriceScale", "minutePoints", "update", "componentUpdated", "updatePriceVolumeInPlace", "renderOrderbookTitle"];
  const totalOfNode = new Map();
  const inclusive = (id) => {
    if (totalOfNode.has(id)) return totalOfNode.get(id);
    const node = byId.get(id);
    let total = self.get(id) || 0;
    for (const child of node.children || []) total += inclusive(child);
    totalOfNode.set(id, total);
    return total;
  };
  for (const n of profile.nodes) {
    const name = n.callFrame.functionName;
    if (!STAGES.includes(name)) continue;
    // Count a stage once per call chain: skip a node whose ancestor is the same function (recursion).
    let nested = false;
    for (let p = parentOf.get(n.id); p; p = parentOf.get(p)) if (byId.get(p).callFrame.functionName === name && byId.get(p).callFrame.url === n.callFrame.url) { nested = true; break; }
    if (nested) continue;
    const key = `${name} ${(n.callFrame.url || "").split("/ui/renderer/").pop()}:${n.callFrame.lineNumber + 1}`;
    inclusiveOf.set(key, (inclusiveOf.get(key) || 0) + inclusive(n.id));
  }
  // Hot lines inside each function (V8 positionTicks), for functions whose helpers were inlined into them.
  const lines = new Map();
  const tickTotal = profile.samples.length || 1;
  for (const n of profile.nodes) {
    const f = n.callFrame;
    if (!f.url || !n.positionTicks) continue;
    const where = f.url.split("/ui/renderer/").pop();
    for (const { line, ticks } of n.positionTicks) {
      const key = `${where}:${line} (${f.functionName || "anon"})`;
      lines.set(key, (lines.get(key) || 0) + ticks);
    }
  }
  const hotLines = [...lines].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, t]) => [k, Number((100 * t / tickTotal).toFixed(2))]);
  const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => [k, Math.round(us / 1000), Number((100 * us / total).toFixed(1))]);
  return { total_ms: Math.round(total / 1000), functions: top(fn, 60), files: top(file, 40), native_callers: top(new Map(Object.entries(callers)), 25), hot_lines: hotLines, inclusive: top(inclusiveOf, 30) };
}

function median(values) { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

// What asked for paint, layout and style in the measured window (Chromium's invalidation tracking, run.cjs --paint):
// per kind, the elements (tag and class as Chromium names them) by how often they were invalidated, with the reasons.
function invalidations(trace) {
  const events = Array.isArray(trace) ? trace : trace.traceEvents || [];
  const marks = events.filter((e) => e.name === "TimeStamp" && String(e.args?.data?.message || "").startsWith("bench-measure-"));
  const start = marks.find((e) => e.args.data.message === "bench-measure-start")?.ts;
  const end = marks.find((e) => e.args.data.message === "bench-measure-end")?.ts;
  if (!start || !end) return { error: "measure marks missing from trace" };
  const kinds = {};
  for (const e of events) {
    if (!/InvalidationTracking$/.test(e.name) || e.ts < start || e.ts > end) continue;
    const data = e.args?.data || {};
    const node = String(data.nodeName || "(none)").replace(/\s+id='[^']*'/, "").slice(0, 120);
    const reason = String(data.reason || data.invalidationSet?.[0]?.type || data.changedClass || data.changedAttribute || "").slice(0, 60);
    const kind = (kinds[e.name] ||= new Map());
    const row = kind.get(node) || { count: 0, reasons: {} };
    row.count += 1;
    if (reason) row.reasons[reason] = (row.reasons[reason] || 0) + 1;
    kind.set(node, row);
  }
  return Object.fromEntries(Object.entries(kinds).map(([name, map]) => [name, {
    total: [...map.values()].reduce((s, r) => s + r.count, 0),
    top: [...map].sort((a, b) => b[1].count - a[1].count).slice(0, 25)
      .map(([node, r]) => ({ node, count: r.count, reasons: Object.entries(r.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3) })),
  }]));
}

// The measured window's Paint events by where they painted: each event's clip (a quad, page coordinates for the root
// layer) goes to the smallest component box holding its middle, "(other)" when none does; per component the paint
// time, the count and the painted area (px², summed). Chromium's per-frame Paint covers the whole frame (it lands on
// the box in the middle of the page) and the paints nested in it carry no usable clip: this says how much paint there
// is per frame, invalidations() says what caused it.
function paintByComponent(trace, boxes) {
  const events = Array.isArray(trace) ? trace : trace.traceEvents || [];
  const marks = events.filter((e) => e.name === "TimeStamp" && String(e.args?.data?.message || "").startsWith("bench-measure-"));
  const start = marks.find((e) => e.args.data.message === "bench-measure-start")?.ts;
  const end = marks.find((e) => e.args.data.message === "bench-measure-end")?.ts;
  if (!start || !end) return { error: "measure marks missing from trace" };
  const thread = `${marks[0].pid}:${marks[0].tid}`;
  const paints = events.filter((e) => e.name === "Paint" && e.ph === "X" && `${e.pid}:${e.tid}` === thread && e.ts >= start && e.ts <= end);
  const holder = (x, y) => boxes.filter((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
    .sort((a, b) => a.w * a.h - b.w * b.h)[0]?.id || "(other)";
  const by = new Map(), layers = new Map();
  for (const e of paints) {
    const clip = e.args?.data?.clip || [];
    const xs = [clip[0], clip[2], clip[4], clip[6]].map(Number), ys = [clip[1], clip[3], clip[5], clip[7]].map(Number);
    const ok = xs.every(Number.isFinite) && ys.every(Number.isFinite);
    const w = ok ? Math.max(...xs) - Math.min(...xs) : 0, h = ok ? Math.max(...ys) - Math.min(...ys) : 0;
    const id = ok ? holder(Math.min(...xs) + w / 2, Math.min(...ys) + h / 2) : "(no clip)";
    const row = by.get(id) || { ms: 0, count: 0, area: 0 };
    row.ms += (e.dur || 0) / 1000; row.count += 1; row.area += w * h;
    by.set(id, row);
    const layer = `${e.args?.data?.layerId ?? "-"}`;
    const lrow = layers.get(layer) || { ms: 0, count: 0, area: 0, sample: id };
    lrow.ms += (e.dur || 0) / 1000; lrow.count += 1; lrow.area += w * h;
    layers.set(layer, lrow);
  }
  const rows = (map) => [...map].map(([k, v]) => ({ id: k, ms: Math.round(v.ms), count: v.count, mpx: Number((v.area / 1e6).toFixed(1)), ...(v.sample ? { sample: v.sample } : {}) }))
    .sort((a, b) => b.ms - a.ms);
  return { paints: paints.length, total_ms: Math.round(paints.reduce((s, e) => s + (e.dur || 0), 0) / 1000), by_component: rows(by), by_layer: rows(layers).slice(0, 12) };
}

module.exports = { invalidations, mainThreadBreakdown, paintByComponent, selfTimes, median };
