// Offline UI render benchmark: mounts the real 即時報價 page in a hidden Electron window against a fixture WebSocket
// (page.js) and reports renderer CPU, synchronous dispatch cost, frame intervals, long tasks, heap growth and the
// arrival -> component latency the app itself measures. Never starts Health, Market Runtime or any service.
//
//   node_modules/electron/dist/electron.exe scripts/qa/ui_render_bench/run.cjs [--runs 3] [--seconds 20] [--out file.json]
const { app, BrowserWindow, contentTracing } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const runs = Number(arg("runs", 3));
const options = {
  seconds: Number(arg("seconds", 20)), codes: Number(arg("codes", 83)),
  // Diagnostic only: with every CSS animation off, how much of the frame the animations cost.
  noAnimations: args.includes("--no-animations"),
  // Diagnostic only: the trend canvases draw nothing (what the charts cost in total, raster included).
  noTrend: args.includes("--no-trend"),
  // Diagnostic only: CSS rules added to the page (what a containment or layer rule would change, before writing it).
  extraCss: arg("css", ""),
  watchRate: Number(arg("watch-rate", 300)), selectedTradeRate: Number(arg("trade-rate", 30)), selectedBookRate: Number(arg("book-rate", 20)),
};
const out = arg("out", "");
const profileOut = arg("profile", "");
const repo = path.resolve(__dirname, "../../..");
// The caller (a shell, ab.sh, a tool that timed out) may close the pipe before the run ends; the next console line
// would then be an uncaught EPIPE dialog. The loss is written to a file instead, and --out still gets the result.
const stdioLostLog = path.join(os.tmpdir(), "stockmonitor-ui-bench-stdio.log");
require(path.join(repo, "service/platform/js/stdio_guard.js")).installStdioGuard({
  onLost: (stream, error) => fs.appendFileSync(stdioLostLog, `[${new Date().toISOString()}] pid ${process.pid} ${stream} reader is gone (${error?.code || error?.message || error})\n`, "utf8"),
});

app.commandLine.appendSwitch("js-flags", "--expose-gc");
app.commandLine.appendSwitch("enable-precise-memory-info");
// --software: CPU raster (the default is the GPU, as the App runs).
if (args.includes("--software")) app.disableHardwareAcceleration();
// --blink-features A,B: runtime Blink features to try against the default (e.g. CompositeBGColorAnimation).
// --reduced-motion: the page sees prefers-reduced-motion (no new-row wash), to measure what the wash costs.
if (args.includes("--reduced-motion")) app.commandLine.appendSwitch("force-prefers-reduced-motion");
if (arg("blink-features", "")) app.commandLine.appendSwitch("enable-blink-features", arg("blink-features", ""));
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stockmonitor-ui-bench-")));
app.on("window-all-closed", () => {});

const { invalidations, mainThreadBreakdown, paintByComponent, selfTimes, median } = require("./bench_trace.cjs");

// Renderer CPU over the whole run (mount + warm-up + measured window), sampled from the main process.
async function oneRunWithCpu() {
  const win = new BrowserWindow({ show: false, width: 1920, height: 1000, webPreferences: { backgroundThrottling: false, offscreen: true } });
  win.webContents.setFrameRate(60);
  win.webContents.on("console-message", (event) => { if (event.level === "error" || event.level === "warning" || event.message.startsWith("[bench]")) console.error(`[renderer] ${event.message.slice(0, 400)} @${event.sourceId?.split("/").pop()}:${event.lineNumber}`); });
  await win.loadFile(path.join(repo, "tests/fixtures/renderer_ui_geometry.html"));
  const base = pathToFileURL(path.join(repo, "ui/renderer/")).href;
  const realtimeHtml = fs.readFileSync(path.join(repo, "ui/renderer/pages/realtime.html"), "utf8");
  const moduleUrl = pathToFileURL(path.join(__dirname, "page.js")).href;
  const pid = win.webContents.getOSProcessId();
  const samples = [];
  const sampler = setInterval(() => {
    const metric = app.getAppMetrics().find((m) => m.pid === pid);
    if (metric) samples.push({ t: Date.now(), cpu: metric.cpu.percentCPUUsage });
  }, 1000);
  // --profile: a V8 CPU profile of the measured window (CDP), reduced to self time per function and per file.
  let profiling = null;
  if (profileOut) {
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Profiler.enable");
    await win.webContents.debugger.sendCommand("Profiler.setSamplingInterval", { interval: 200 });
    win.webContents.on("console-message", (event) => {
      if (event.message === "[bench] measure-start") profiling = win.webContents.debugger.sendCommand("Profiler.start");
      if (event.message === "[bench] measure-end" && profiling) profiling = profiling.then(() => win.webContents.debugger.sendCommand("Profiler.stop"));
    });
  }
  const traceFile = path.join(os.tmpdir(), `stockmonitor-ui-bench-${process.pid}-${Date.now()}.json`);
  // --paint adds Chromium's invalidation tracking: which element asked for paint, layout or style, and why.
  const categories = ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "blink.user_timing"];
  if (args.includes("--paint")) categories.push("disabled-by-default-devtools.timeline.invalidationTracking");
  await contentTracing.startRecording({ included_categories: categories });
  try {
    const result = await win.webContents.executeJavaScript(`import(${JSON.stringify(moduleUrl)}).then(m => m.runBench(${JSON.stringify(base)},${JSON.stringify(realtimeHtml)},${JSON.stringify(options)}))`);
    // percentCPUUsage is the usage since the previous getAppMetrics() call; the last `seconds` samples cover the
    // measured window (warm-up and mount came before it).
    const window = samples.slice(-Math.max(1, options.seconds - 1)).map((s) => s.cpu);
    result.renderer_cpu_percent = Number((window.reduce((a, b) => a + b, 0) / Math.max(1, window.length)).toFixed(1));
    await contentTracing.stopRecording(traceFile);
    if (profiling) result.profile = selfTimes((await profiling).profile);
    const trace = JSON.parse(fs.readFileSync(traceFile, "utf8"));
    result.main_thread = mainThreadBreakdown(trace, result.wall_ms);
    // --paint: where the measured window's paint went, by component (the page's component boxes, see page.js).
    if (args.includes("--paint")) { result.paint_by_component = paintByComponent(trace, result.dom?.component_boxes || []); result.invalidations = invalidations(trace); }
    fs.rmSync(traceFile, { force: true });
    return result;
  } finally { clearInterval(sampler); win.destroy(); }
}

app.whenReady().then(async () => {
  try {
    const results = [];
    for (let i = 0; i < runs; i++) results.push(await oneRunWithCpu());
    const pick = (fn) => median(results.map(fn).filter((v) => v !== null && v !== undefined));
    const summary = {
      options, runs,
      renderer_cpu_percent: pick((r) => r.renderer_cpu_percent),
      deltas_per_second: pick((r) => r.deltas_per_second),
      dispatch_ms_p95: pick((r) => r.dispatch_ms.p95), dispatch_ms_total: pick((r) => r.dispatch_ms.total),
      frame_interval_p95: pick((r) => r.frame_interval_ms.p95), frame_interval_p99: pick((r) => r.frame_interval_ms.p99),
      long_task_total_ms: pick((r) => r.long_tasks.total_ms), long_task_count: pick((r) => r.long_tasks.count),
      heap_growth_mb: pick((r) => r.heap_growth_mb),
      main_thread: Object.fromEntries(Object.keys(results[0].main_thread || {}).map((k) => [k, pick((r) => r.main_thread?.[k])])),
      latency_p95: Object.fromEntries(Object.keys(results[0].latency).map((k) => [k, pick((r) => r.latency[k]?.p95)])),
      latency_p50: Object.fromEntries(Object.keys(results[0].latency).map((k) => [k, pick((r) => r.latency[k]?.p50)])),
      raw: results,
    };
    if (profileOut) fs.writeFileSync(profileOut, JSON.stringify(results.map((r) => r.profile), null, 1));
    for (const r of results) delete r.profile;
    const text = JSON.stringify(summary, null, 2);
    if (out) fs.writeFileSync(out, text);
    console.log(text);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});

