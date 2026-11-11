"use strict";

const { createPerformanceWindowRecorder } = require("./performance_window_recorder");
const { createSinkHealth, lossLine } = require("../../service/platform/js/sink_health");
const { rotateIfLarger } = require("../../service/platform/js/atomic_files");
const { scrubText, scrubValue } = require("../../config/js/secret_scrub");

// Main owns process liveness; the renderer owns its low-frequency telemetry.
// One renderer telemetry payload. The caps are real -- this crosses IPC twice a second and must
// stay bounded -- but they were enforced by silently dropping the payload, so once a populated
// watch page pushed `components` past the array limit EVERY report was rejected, the stored
// telemetry froze at the last (empty, startup) sample, heartbeat_at stopped advancing, and
// Health reported RENDERER_RUNTIME_STALE for the rest of the session with nothing saying why.
// 64 KiB was also too small for a legitimate payload at those array bounds.
const TELEMETRY_ARRAY_LIMIT = 64;
const TELEMETRY_MAX_BYTES = 256 * 1024;
// Renderer errors reach Electron main's error log (error-electron.log) through Electron main. Appended synchronously, one by one, with
// no limit, a renderer raising an error every frame would block main on the disk and grow the log without bound.
// So: at most ERROR_LINES_PER_MINUTE lines a minute (the rest counted and stated), written
// asynchronously, and the file is rotated past ERROR_LOG_MAX_BYTES.
const ERROR_LINES_PER_MINUTE = 120;
const ERROR_LOG_MAX_BYTES = 8 * 1024 * 1024;

function createErrorLogWriter(fs, file, { now = Date.now, perMinute = ERROR_LINES_PER_MINUTE, maxBytes = ERROR_LOG_MAX_BYTES } = {}) {
  let windowStart = 0, inWindow = 0;
  let pending = [], writing = null;
  // Never breaks the UI, never pretends: a failed append is counted with its error, and the first append
  // that succeeds again starts with a loss marker.
  const health = createSinkHealth(`error_log:${file}`, { now });
  // Rotation is its own result: a log that cannot be rotated keeps growing although every append succeeds,
  // so its failures are counted and stated in the sink's health, apart from the appends.
  const rotation = { failures: 0, last_error: null };
  async function rotateIfLarge() {
    const { pruneFailures } = await rotateIfLarger(file, maxBytes, { fsImpl: fs, now });
    if (pruneFailures.length) {
      const first = pruneFailures[0];
      const error = Object.assign(new Error(`removing ${pruneFailures.length} old rotated log(s) failed: ${first.name}: ${first.message}`), { code: first.code });
      throw error;
    }
  }
  const snapshot = () => ({ ...health.snapshot(), rotation: { ...rotation } });
  async function drain() {
    while (pending.length || health.lossMarker()) {
      const lines = pending;
      pending = [];
      const marker = health.lossMarker();
      const data = (marker ? lossLine(marker, `[${new Date(now()).toISOString()}] [RENDERER]`) : "") + lines.join("");
      try {
        await rotateIfLarge();
      } catch (error) {
        rotation.failures += 1;
        const message = String(error?.message || error).slice(0, 300);
        // Attempted before every append: logged when its reason changes, and counted in the sink's health.
        // not an error: the same reason again repeats the one already logged
        if (message !== rotation.last_error?.message) console.warn(`[renderer error log ${file}] rotation failed: ${message}`);
        rotation.last_error = { at: new Date(now()).toISOString(), code: error?.code || null, message };
      }
      try {
        await fs.promises.appendFile(file, data, "utf8");
        health.succeeded();
        health.markerWritten(marker);
      } catch (error) {
        health.failed(error, lines.length);
        break;
      }
    }
  }
  function flush() {
    if (!writing) writing = drain().finally(() => { writing = null; });
    return writing.then(() => snapshot());
  }
  return {
    write(line) {
      const at = now();
      if (at - windowStart >= 60_000) {
        windowStart = at; inWindow = 0;
      }
      // Past the rate limit a line is a dropped record of this sink: counted in its health, and stated by the
      // loss marker the next write -- or the close -- carries, never only a local count that a close lost.
      if (inWindow >= perMinute) { health.dropped(1, "rate_limited"); return false; }
      inWindow += 1;
      pending.push(line);
      if (!writing) setImmediate(flush);
      return true;
    },
    flush,
    health: () => snapshot(),
  };
}

function createRendererHealthRegistry({ fs, path, outputDir, electronPid,
  now = Date.now, maxBytes = TELEMETRY_MAX_BYTES, errorLogPath = null }) {
  const records = new Map();
  const retired = [];
  const file = path.join(outputDir, "renderer_health.json"), tmp = `${file}.tmp`;
  const performanceRecorder = createPerformanceWindowRecorder({ fs, path, outputDir, electronPid, now });
  let pendingWire = null, pendingMarker = null, writing = false;
  const idleWaiters = [];
  // renderer_health.json is replaced whole on every change, so a failed write loses no history -- but Health then
  // reads an old file; the failure is counted and the snapshot carries every sink's health.
  const fileHealth = createSinkHealth(`renderer_health:${file}`, { now });
  fs.mkdirSync(outputDir, { recursive: true });
  const errorLog = errorLogPath ? createErrorLogWriter(fs, errorLogPath, { now }) : null;
  // Every error and warning of a renderer and of Electron main is a record in this run's error log, not only
  // in a devtools console nobody has open. The same text repeated within a minute is one line
  // plus a count, so a failure in a hot path is recorded, not flooded.
  const repeats = new Map();
  // A count is written when its minute is over -- a sweep every half minute -- and at close, never only with the next
  // occurrence of the same text, which may not come.
  function flushRepeats({ force = false } = {}) {
    if (!errorLog) return;
    const at = now();
    for (const [key, seen] of repeats) {
      const over = at - seen.at >= 60_000;
      if (seen.count && (force || over)) {
        const [tag, ...rest] = key.split("\u0000");
        errorLog.write(`[${new Date(at).toISOString()}] [${tag}] ${rest.join("")} (repeated ${seen.count} more time(s) in the minute after the record above)\n`);
        seen.count = 0;
      }
      if (over && !seen.count) repeats.delete(key);
    }
  }
  const repeatSweep = errorLogPath ? setInterval(() => flushRepeats(), 30_000) : null;
  repeatSweep?.unref?.();
  // Every line of the error log passes here, so this is where secrets are masked (a token in a logged URL query, an
  // Authorization header, a quoted "password" field of a logged object) -- before the cut, so a cut cannot leave
  // half a secret the rules no longer recognise.
  function record(tag, text) {
    if (!errorLog) return;
    const at = now();
    const body = scrubText(String(text).replace(/[\r\n]+/g, " ")).slice(0, 2000);
    const key = `${tag}\u0000${body}`;
    const seen = repeats.get(key);
    if (seen && at - seen.at < 60_000) { seen.count += 1; return; }
    const suffix = seen?.count ? ` (also ${seen.count} more time(s) in the minute before)` : "";
    repeats.delete(key);
    repeats.set(key, { at, count: 0 });
    if (repeats.size > 512) repeats.delete(repeats.keys().next().value);
    errorLog.write(`[${new Date(at).toISOString()}] [${tag}] ${body}${suffix}\n`);
  }
  // The page a window shows (its file name), for a log line about it.
  function pageOf(contents) {
    try { return String(contents.getURL() || "").split(/[?#]/)[0].split("/").pop() || "window"; }
    catch (error) { console.warn("[RENDERER HEALTH] reading a window's URL failed", error); return "window"; }
  }

  function reportRendererError(text, tag = "RENDERER") {
    record(tag, text);
  }
  // Electron main's own console.warn / console.error (desktop_application tees them here).
  function reportMain(level, args) {
    const text = args.map((arg) => (arg instanceof Error ? `${arg.message}${arg.stack ? ` ${arg.stack.split("\n")[1]?.trim() || ""}` : ""}`
      : typeof arg === "string" ? arg : (() => { try { return JSON.stringify(scrubValue(arg)); } catch (_error) { /* not an error: an argument that cannot be serialised is written with String() */ return String(arg); } })())).join(" ");
    record(level === "error" ? "MAIN" : "MAIN WARN", text);
  }
  function settleIdle() {
    if (writing || pendingWire !== null) return;
    while (idleWaiters.length) idleWaiters.shift()();
  }
  function drain() {
    if (writing || pendingWire === null) return;
    writing = true;
    const wire = pendingWire, marker = pendingMarker;
    pendingWire = null;
    pendingMarker = null;
    fs.writeFile(tmp, wire, (writeError) => {
      if (writeError) { fileHealth.failed(writeError, 1); writing = false; drain(); settleIdle(); return; }
      fs.rename(tmp, file, (renameError) => {
        if (renameError) fileHealth.failed(renameError, 1);
        else { fileHealth.succeeded(); fileHealth.markerWritten(marker); }   // the loss its sinks snapshot states
        writing = false; drain(); settleIdle();
      });
    });
  }
  function persist() {
    pendingMarker = fileHealth.lossMarker();
    pendingWire = JSON.stringify({ schema: "stock-monitor-renderer-health-v1",
      electron_pid: electronPid, generated_at: now(),
      renderers: [...records.values()].map(({ contents, ...record }) => record),
      last_renderers: retired.slice(-4),
      sinks: sinkHealth(),
    });
    drain();
  }
  function sinkHealth() {
    return { renderer_health: fileHealth.snapshot(), error_log: errorLog ? errorLog.health() : null,
      performance: performanceRecorder.health() };
  }
  function flush() {
    if (!writing && pendingWire === null) return Promise.resolve(sinkHealth());
    return new Promise((resolve) => idleWaiters.push(resolve)).then(sinkHealth);
  }
  function observe(contents) {
    if (!contents || records.has(contents.id)) return;
    const id = contents.id;
    records.set(id, { contents, id, alive: true, responsive: true, started_at: now(), heartbeat_at: 0 });
    const update = patch => { const record = records.get(id); if (record) Object.assign(record, patch); persist(); };
    // A renderer error had nowhere to go: it printed to a devtools console nobody has open and
    // never reached var/logs/<run>/error-electron.log, so a renderer fault was invisible to both the
    // operator and to Health. Errors only -- a renderer can log at high frequency and this must
    // never become the flood the error log exists to avoid.
    contents.on("console-message", (...args) => {
      // Electron 36+ passes a single event object; older builds pass (event, level, message, ...).
      const [first, level, message, line, sourceId] = args;
      const detail = (first && typeof first === "object" && "message" in first)
        ? { level: first.level, message: first.message, line: first.lineNumber, source: first.sourceId }
        : { level, message, line, source: sourceId };
      const isError = detail.level === "error" || Number(detail.level) === 3;
      const isWarning = detail.level === "warning" || Number(detail.level) === 2;
      if ((!isError && !isWarning) || !String(detail.message || "").trim()) return;
      reportRendererError(`${detail.message} (${detail.source || "renderer"}:${detail.line ?? "?"})`,
        isError ? "RENDERER" : "RENDERER WARN");
    });
    // A window that stops answering is written to the error log, and again when it answers, with how long: Market
    // Runtime drops a viewer that has not read for 5 s, and its log alone cannot say what the window was doing.
    let unresponsiveSince = 0;
    contents.on("unresponsive", () => {
      unresponsiveSince = now();
      record("MAIN WARN", `[RENDERER UNRESPONSIVE] ${pageOf(contents)} stopped answering`);
      update({ responsive: false });
    });
    contents.on("responsive", () => {
      if (unresponsiveSince) record("MAIN WARN", `[RENDERER UNRESPONSIVE] ${pageOf(contents)} answers again after ${now() - unresponsiveSince} ms`);
      unresponsiveSince = 0;
      update({ responsive: true });
    });
    contents.on("render-process-gone", (_event, detail) => update({ alive: false, reason: detail.reason }));
    contents.on("did-start-loading", () => update({ alive: true, responsive: true, started_at: now(), heartbeat_at: 0, telemetry: null }));
    contents.once("destroyed", () => {
      const record = records.get(id);
      if (record) {
        const { contents: _contents, ...snapshot } = record;
        retired.push({ ...snapshot, alive: false, destroyed_at: now() });
        if (retired.length > 4) retired.shift();
      }
      records.delete(id); persist();
    });
    persist();
  }
  function report(event, payload) {
    const record = records.get(event.sender?.id);
    if (!record || record.contents !== event.sender || payload?.schema !== "renderer-runtime-health-v1") return false;
    if (now() - record.heartbeat_at < 1000) return false;
    const wire = JSON.stringify(payload);
    const rejection = wire.length > maxBytes ? `payload_bytes:${wire.length}`
      : !Array.isArray(payload.subscriptions) ? "subscriptions_not_array"
      : payload.subscriptions.length > TELEMETRY_ARRAY_LIMIT ? `subscriptions:${payload.subscriptions.length}`
      : !Array.isArray(payload.components) ? "components_not_array"
      : payload.components.length > TELEMETRY_ARRAY_LIMIT ? `components:${payload.components.length}`
      : "";
    if (rejection) {
      // Recorded, not swallowed: a rejected payload is why the telemetry below stops moving.
      record.telemetry_rejected = Number(record.telemetry_rejected || 0) + 1;
      record.telemetry_rejected_reason = rejection;
      record.telemetry_rejected_at = now();
      reportRendererError(`renderer telemetry rejected (${rejection}); Health will see stale renderer runtime`);
      persist();
      return false;
    }
    record.telemetry_rejected_reason = null;
    record.heartbeat_at = now();
    record.telemetry = JSON.parse(wire);
    record.alive = true;
    performanceRecorder.observe(record.id, record.telemetry);
    persist();
    return true;
  }
  function observeStartup(item) { performanceRecorder.observeStartup(item); }
  // Every sink is drained -- the error log's pending lines and loss marker too -- and the close answers with every
  // sink's health: the caller records a loss instead of exiting as if nothing was lost.
  function close() {
    if (repeatSweep) clearInterval(repeatSweep);
    flushRepeats({ force: true });
    return Promise.all([flush(), performanceRecorder.close(), errorLog ? errorLog.flush() : null]).then(() => sinkHealth());
  }
  return { observe, report, observeStartup, flush, close, sinkHealth, reportMain };
}
module.exports = { createRendererHealthRegistry, createErrorLogWriter };
