// Offline 歷史回放 render benchmark: mounts the real 歷史回放 page in a hidden Electron window against recorded answers
// (history_page.js) and reports frame intervals, long tasks, the renderer main thread by phase and, with --profile, the
// hot functions. Never starts Health, Market Runtime or any service.
//
//   node_modules/electron/dist/electron.exe scripts/qa/ui_render_bench/history_run.cjs --api <history_api.json>
//     --frames <replay_recording.jsonl> --date 2026-10-29 --code 2303 [--scenario play|drag|jumps] [--seconds 10] [--profile out.json]
//     [--seek-snapshot keep|drop] [--b-ms 200] [--b-resync]
//   ... --api <history_api.json> --seek-answers <PROBE_DUMP recording> --scenario drag: the seeks answered with Market
//     Runtime's real answers (the replay seek probe's recording), to compare whole views with seek diffs
//
// A seek's answer is modelled on Market Runtime and Rust B as measured on the real stack (native/analysis_runtime/tests/
// replay_seek_probe.rs): --seek-snapshot drop re-sends the view without B's analysis (what Market Runtime did before it
// kept B's last analysis across a seek), keep with it; --b-ms is how long after a seek B's analysis of the new time
// arrives (a newer seek supersedes it, as Market Runtime refuses an older generation's). jumps: one seek forward every
// 1.5 s, each timed until 價量 and 大單 show B's analysis again.
//
// <history_api.json>: FastAPI's answers by path and query (/api/history/dates, /api/history/stocks?date=..., ...).
// <replay_recording.jsonl>: one line per Market Runtime message, {"t": ms, "raw": "<the message JSON>"}, from a client
// that opened the replay, subscribed its view with every channel and pressed play.
const { app, BrowserWindow, contentTracing } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { mainThreadBreakdown, selfTimes } = require("./bench_trace.cjs");

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const options = { scenario: arg("scenario", "play"), seconds: Number(arg("seconds", 10)), date: arg("date", ""), code: arg("code", ""),
  seekSnapshot: arg("seek-snapshot", "keep"), bMs: Number(arg("b-ms", 200)), bResync: args.includes("--b-resync"),
  // Diagnostic only: panels whose view model is held fixed during the run (what the others cost without them).
  freeze: String(arg("freeze", "")).split(",").filter(Boolean) };
const profileOut = arg("profile", "");
// --shot <png>: the page as it stands after the run, to look at its layout.
const shotOut = arg("shot", "");
const repo = path.resolve(__dirname, "../../..");

app.commandLine.appendSwitch("js-flags", "--expose-gc");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "stockmonitor-history-bench-")));
app.on("window-all-closed", () => {});

// --seek-answers <PROBE_DUMP recording>: the drag's seeks are answered with that recording's view messages (see
// history_page.js); its replay.opened and subscribe snapshot open the replay, so --frames is not needed with it.
const seekAnswers = arg("seek-answers", "");
if (seekAnswers) options.seekAnswersUrl = pathToFileURL(path.resolve(seekAnswers)).href;

// The first replay.opened and view.snapshot of a probe recording (read line by line: it is hundreds of MB).
function openingFrames(file) {
  const fd = fs.openSync(file, "r");
  const out = [];
  const chunk = Buffer.alloc(1 << 20);
  let rest = "";
  try {
    while (out.length < 2) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      const lines = (rest + chunk.toString("utf8", 0, n)).split("\n");
      rest = lines.pop();
      for (const line of lines) {
        const { t, raw } = JSON.parse(line);
        const msg = JSON.parse(raw);
        if (["replay.opened", "view.snapshot"].includes(msg.type) && !out.some((f) => f.msg.type === msg.type)) out.push({ t, msg });
      }
    }
  } finally { fs.closeSync(fd); }
  return out;
}

function recordedAnswers() {
  const api = JSON.parse(fs.readFileSync(arg("api"), "utf8"));
  const frames = seekAnswers ? openingFrames(seekAnswers) : fs.readFileSync(arg("frames"), "utf8").trim().split("\n").map((line) => {
    const { t, raw } = JSON.parse(line);
    return { t, msg: JSON.parse(raw) };
  });
  return { api, frames };
}

// The run's output goes to a caller's pipe: once that pipe is closed nobody reads the result, so the run ends instead of
// Electron's uncaught-exception dialog holding the process open.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => { if (error.code === "EPIPE") app.exit(2); else throw error; });
}

async function run() {
  const win = new BrowserWindow({ show: false, width: 1920, height: 1000, webPreferences: { backgroundThrottling: false, offscreen: true } });
  win.webContents.setFrameRate(60);
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning" || event.message.startsWith("[bench]")) console.error(`[renderer] ${event.message.slice(0, 300)}`);
  });
  await win.loadFile(path.join(repo, "tests/fixtures/renderer_ui_geometry.html"));
  const base = pathToFileURL(path.join(repo, "ui/renderer/")).href;
  const historyHtml = fs.readFileSync(path.join(repo, "ui/renderer/pages/history.html"), "utf8");
  const moduleUrl = pathToFileURL(path.join(__dirname, "history_page.js")).href;
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
  const traceFile = path.join(os.tmpdir(), `stockmonitor-history-bench-${process.pid}-${Date.now()}.json`);
  await contentTracing.startRecording({ included_categories: ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "blink.user_timing"] });
  try {
    const recorded = recordedAnswers();
    const result = await win.webContents.executeJavaScript(
      `import(${JSON.stringify(moduleUrl)}).then(m => m.runHistoryBench(${JSON.stringify(base)},${JSON.stringify(historyHtml)},${JSON.stringify(recorded)},${JSON.stringify(options)}))`);
    await contentTracing.stopRecording(traceFile);
    result.main_thread = mainThreadBreakdown(JSON.parse(fs.readFileSync(traceFile, "utf8")), result.wall_ms);
    if (profiling) {
      const profile = selfTimes((await profiling).profile);
      fs.writeFileSync(profileOut, JSON.stringify(profile, null, 1));
      result.profile_top = profile.functions.slice(0, 15);
      result.profile_inclusive = profile.inclusive.slice(0, 15);
    }
    fs.rmSync(traceFile, { force: true });
    if (shotOut) fs.writeFileSync(shotOut, (await win.webContents.capturePage()).toPNG());
    return result;
  } finally { win.destroy(); }
}

app.whenReady().then(async () => {
  try {
    console.log(JSON.stringify(await run(), null, 2));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
