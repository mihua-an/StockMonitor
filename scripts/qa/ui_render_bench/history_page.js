// Offline 歷史回放 render benchmark, run inside an Electron window by history_run.cjs. The real 歷史回放 page is mounted
// against fixture answers: FastAPI's history reads (recorded) and a fixture Market Runtime socket that plays a recorded
// replay stream (replay.open / view.subscribe / play / seek), with every batch's signals frames merged into one as
// Market Runtime sends them. Scenarios: play (the recorded deltas at their recorded pace), drag (the time bar moved
// one second per frame, each move a seek answered with a snapshot and Rust B's analysis `bMs` later) and jumps (a seek
// forward every 1.5 s). `seekSnapshot` "drop" answers a seek with a view that lost B's analysis, "keep" with B's last.
// `bResync` re-sends the whole view right after B's analysis of each seek, as Market Runtime did when B's new feed
// invalidated the previous one's blocks (it now re-sends only a view whose blocks the new feed did not all replace).
// `seekAnswersUrl`: the seeks are answered with Market Runtime's real answers, in the order it sent them, from a
// recording of native/analysis_runtime/tests/replay_seek_probe.rs (PROBE_DUMP): its subscribe snapshot opens the view
// and every later view message (a whole view or a seek's diff) answers the next seek, unchanged -- so their cost to
// parse and apply, and what the panels redraw for them, is the real one.
export async function runHistoryBench(base, historyHtml, recorded, options) {
  const { scenario = "play", seconds = 10, warmupSeconds = 2, date, code, seekSnapshot = "keep", bMs = 200, bResync = false, seekAnswersUrl = "" } = options || {};
  localStorage.clear();
  window.desktopAPI = {
    sourceSettings: { enabled_sources: ["shioaji"], sources: {} },
    networkManifest: { services: { test: { url: "http://fixture.invalid" } }, routes: [["/api/", "test"]] },
    liveEngineConnection: { url: "ws://fixture.invalid", expected: { service_id: "market_runtime", protocol: 2 } },
    loadWatchPagesLocal: async () => ({ pages: [] }),
  };
  const originalFetch = window.fetch;
  window.fetch = async (url, init) => {
    if (String(url).startsWith("file:")) return originalFetch(url, init);
    const parsed = new URL(url);
    const key = `${parsed.pathname}${parsed.search}`;
    const value = recorded.api[key] ?? recorded.api[parsed.pathname] ?? { ok: true, items: [], rows: [], events: [], dates: [], stocks: [] };
    return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  };

  // The recorded stream: the open's status, the view snapshot, then deltas (a batch's signals merged into its last).
  const frames = recorded.frames;
  const opened = frames.find((f) => f.msg.type === "replay.opened").msg.payload;
  const snapshot = frames.find((f) => f.msg.type === "view.snapshot").msg.payload;
  const answers = seekAnswersUrl ? await recordedSeekAnswers(seekAnswersUrl, originalFetch) : null;
  const deltas = frames.filter((f) => f.msg.type === "view.delta" || f.msg.type === "view.delta.batch").map((f) => {
    const items = f.msg.type === "view.delta.batch" ? f.msg.payload.items : [f.msg.payload];
    const lastSignals = items.map((item) => item.delta_type).lastIndexOf("signals.frame");
    return { t: f.t, items: items.filter((item, i) => item.delta_type !== "signals.frame" || i === lastSignals) };
  });
  const projection = deltas.flatMap((d) => d.items).filter((item) => ["minutes.upsert", "day.updated", "tradeflow.updated", "windows.updated"].includes(item.delta_type));
  const lastOf = (type) => projection.filter((item) => item.delta_type === type).at(-1);
  const republication = ["minutes.upsert", "day.updated", "tradeflow.updated", "windows.updated"].map(lastOf).filter(Boolean);

  let socket = null;
  let view = null; // { id, seq }
  let subscribes = 0;
  const status = { ...opened.status };
  // A recording made before Market Runtime reported the market's span: 09:00 to 13:30 of the day.
  const dayNs = (clock) => String(BigInt(Date.parse(`${date}T${clock}+08:00`)) * 1_000_000n);
  status.recording = { market_first_ns: dayNs("09:00:00"), market_last_ns: dayNs("13:30:00"), ...(status.recording || {}) };
  class FixtureSocket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { super(); socket = this; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
    reply(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
    send(raw) {
      const message = JSON.parse(raw);
      const p = message.payload || {};
      // A reply names its request as Market Runtime does: the message's request_id, or the one its payload carries (view.subscribe).
      const answer = (type, payload) => queueMicrotask(() => this.reply({ type, request_id: message.request_id ?? p.request_id, payload }));
      if (message.type === "replay.open") answer("replay.opened", { ...opened, status });
      else if (message.type === "view.subscribe" && p.replay_id) {
        // Each subscribe its own id, as Market Runtime gives: a reused one is the closed subscription's to the view store.
        view = { id: answers ? snapshot.subscription_id : `bench-view-${++subscribes}`, seq: 0 };
        answer("view.subscription.accepted", { subscription_id: view.id, replay_id: p.replay_id, stream_id: snapshot.stream_id, daemon_instance_id: snapshot.daemon_instance_id, watermark: 0, snapshot_follows: true });
        // Recorded answers continue the recorded snapshot's numbering (a diff names the sequence it moves from).
        const numbered = answers ? {} : { sequence: 0, watermark: 0 };
        queueMicrotask(() => this.reply({ type: "view.snapshot", request_id: p.request_id, payload: { ...snapshot, subscription_id: view.id, request_id: p.request_id, ...numbered } }));
      } else if (message.type === "view.subscribe") answer("view.subscription.accepted", { subscription_id: `live-${p.code}`, stream_id: "bench" });
      else if (message.type === "replay.control") {
        if (p.action === "play") status.playing = true;
        if (p.action === "pause") status.playing = false;
        if (p.action === "seek" || p.action === "step") { status.position_ns = p.at_ns || status.position_ns; seeks.push(performance.now()); }
        answer("replay.control.ack", { ok: true, status: { ...status } });
        if (p.action === "seek" || p.action === "step") queueMicrotask(() => resnapshot());
      } else if (message.type === "replay.close") answer("replay.closed", { ok: true });
      else if (message.type === "view.resync" && view) queueMicrotask(() => resnapshot(p.request_id));
      else if (message.type === "health") answer("health", { status: "serving", service_id: "market_runtime", protocol: 2 });
    }
    close() { this.readyState = 3; }
  }
  window.WebSocket = FixtureSocket;

  const seeks = [];
  let seekSnapshots = 0;
  // Recorded answers: each one's bytes and how long the socket's dispatch of it took (parse, store, notify).
  const answerCost = [], answerBytes = [], answerKinds = { whole: 0, diff: 0 };
  let nextAnswer = 0;
  // The view a seek re-sends without Rust B's analysis (Market Runtime emptied the replay's projection on a seek): no
  // minutes (the trend keeps the current minute only), no day, 價量, 大單 flow or windows.
  const withoutB = { ...snapshot, price_volume: {}, tradeflow: {}, windows: null, day: null, minutes: [],
    trend: Array.isArray(snapshot.trend) ? snapshot.trend.slice(-1) : [] };
  function resnapshot(requestId = null) {
    if (!view) return;
    if (answers) {
      const raw = answers[nextAnswer++];
      if (raw == null) return;
      seekSnapshots += 1;
      const started = performance.now();
      socket.dispatchEvent(new MessageEvent("message", { data: raw }));
      if (measuring) {
        answerCost.push(performance.now() - started);
        answerBytes.push(raw.length);
        answerKinds[raw.includes('"type":"view.replay_diff"') ? "diff" : "whole"] += 1;
      }
      return;
    }
    // Numbered after the view's last delta, as Market Runtime numbers a resync (one numbered 0 after deltas is refused
    // by the view store as STALE_SNAPSHOT: the page never applied a seek's snapshot).
    const seq = ++view.seq;
    const body = seekSnapshot === "drop" ? withoutB : snapshot;
    seekSnapshots += 1;
    socket.reply({ type: "view.snapshot", request_id: requestId, payload: { ...body, subscription_id: view.id, request_id: requestId, sequence: seq, watermark: seq, resync_reason: "REPLAY_SEEK" } });
    scheduleRepublication();
  }
  // Rust B's analysis of the time sought arrives `bMs` after the seek; a newer seek supersedes it (Market Runtime refuses
  // a publish of an older generation).
  let republishTimer = 0;
  function scheduleRepublication() {
    clearTimeout(republishTimer);
    republishTimer = setTimeout(() => {
      republishTimer = 0;
      sendItems(republication);
      if (bResync && view) {
        const seq = ++view.seq;
        socket.reply({ type: "view.snapshot", request_id: null, payload: { ...snapshot, subscription_id: view.id, request_id: null, sequence: seq, watermark: seq, resync_reason: "PROJECTION_RESET" } });
      }
    }, bMs);
  }
  const dispatchCost = [];
  let sent = 0;
  function sendItems(items) {
    if (!view || !items.length) return;
    const numbered = items.map((item) => ({ ...item, subscription_id: view.id, sequence: ++view.seq, watermark: view.seq }));
    sent += numbered.length;
    const started = performance.now();
    socket.reply({ type: "view.delta.batch", payload: { items: numbered } });
    if (measuring) dispatchCost.push(performance.now() - started);
  }

  const { startRealtimeStream, getRealtimeViewStats } = await import(`${base}js/market_data/realtime.js`);
  await import(`${base}js/dashboard_components.js`);
  const history = await import(`${base}js/pages/history.js`);
  const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve)); };
  // The App's frame (index.html): a main of the window's height holding the page container, so every panel has the
  // height it has in the App (a bare <main> let the page grow to its content and every list drew all its rows).
  const main = document.querySelector("main");
  main.className = "main main-with-bottom-nav";
  main.innerHTML = `<section id="pageContainer" class="page-container" data-trend-lookup-host>${historyHtml}</section>`;
  startRealtimeStream();
  history.bindHistoryEvents();
  await history.refreshHistoryPage();
  await history.openHistoryReplay({ date, code });
  for (let i = 0; i < 100 && !view; i++) await settle(3);
  await settle(20);
  // Diagnostic only (--freeze eventFeed,trendChart): those panels keep the view model they have now, so a run shows
  // what the others cost without them.
  if (options.freeze?.length) {
    const { replayHistoryContext } = await import(`${base}js/core/dashboard_context.js`);
    for (const id of options.freeze) {
      const held = replayHistoryContext.dataSource.resolve(id, {});
      replayHistoryContext.dataSource.setResolver(id, () => held);
    }
  }
  console.log(`[bench] view=${Boolean(view)} replay=${Boolean(document.getElementById("historyTimeRange") && !document.getElementById("historyTimeRange").disabled)}`);

  let measuring = false;
  const frameIntervals = [];
  let lastFrame = 0;
  const frameLoop = (t) => { if (measuring && lastFrame) frameIntervals.push(t - lastFrame); lastFrame = t; requestAnimationFrame(frameLoop); };
  requestAnimationFrame(frameLoop);
  const longTasks = [];
  new PerformanceObserver((list) => { if (measuring) for (const entry of list.getEntries()) longTasks.push(entry.duration); }).observe({ entryTypes: ["longtask"] });
  // 成交明細 rows that started their new-row wash, and rows added to its body, while measuring.
  const tape = { washed: 0, added: 0 };
  new MutationObserver((records) => {
    if (!measuring) return;
    for (const record of records) {
      if (record.type === "childList" && record.target.matches?.('[data-role="tick-body"]')) {
        tape.added += record.addedNodes.length;
        for (const node of record.addedNodes) if (node.classList?.contains("row-wash")) tape.washed += 1;
      }
      if (record.type === "attributes" && record.target.classList.contains("row-wash") && !String(record.oldValue || "").includes("row-wash")) tape.washed += 1;
    }
  }).observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });

  const range = document.getElementById("historyTimeRange");
  const play = (ms) => new Promise((resolve) => {
    // The recorded deltas at their recorded pace (the speed was chosen when recording), looping over the recording.
    const span = deltas.at(-1).t - deltas[0].t;
    const start = performance.now();
    let index = 0, loop = 0;
    const step = () => {
      const elapsed = performance.now() - start;
      while (deltas[index] && deltas[index].t - deltas[0].t + loop * span <= elapsed) { sendItems(deltas[index].items); index += 1; }
      if (index >= deltas.length) { index = 0; loop += 1; }
      if (elapsed < ms) setTimeout(step, 4); else resolve();
    };
    step();
  });
  const drag = (ms) => new Promise((resolve) => {
    // One second of the day per frame, back and forth across the morning (the user's hand on the bar).
    const min = Number(range.min), max = Number(range.max);
    let value = Number(range.value), direction = -1;
    const start = performance.now();
    range.dispatchEvent(new PointerEvent("pointerdown"));
    const frame = () => {
      value += direction * 7;
      if (value <= min || value >= Math.min(max, min + 3 * 3600)) direction = -direction;
      range.value = String(value);
      range.dispatchEvent(new Event("input"));
      if (performance.now() - start < ms) requestAnimationFrame(frame);
      else { range.dispatchEvent(new PointerEvent("pointerup")); resolve(); }
    };
    requestAnimationFrame(frame);
  });
  // A B-fed panel waiting for B: 價量 or 大單流向 showing its empty message instead of an analysis.
  const waitingForB = () => [...main.querySelectorAll('[data-component-slot^="replay"]')]
    .some((slot) => /回放尚未播到成交|等待 Rust B/.test(slot.textContent || ""));
  // Sampled every 50 ms while measuring: how long the page showed B's panels empty.
  let blankSamples = 0, samples = 0;
  const sampler = setInterval(() => { if (measuring) { samples += 1; blankSamples += waitingForB() ? 1 : 0; } }, 50);
  const jumpWaits = [];
  const jumps = (ms) => new Promise((resolve) => {
    // One seek forward every 1.5 s (« » and an event row do this; so does a drag released), each timed until B's
    // panels are filled again.
    const min = Number(range.min), max = Number(range.max);
    let value = Number(range.value);
    const start = performance.now();
    const next = () => {
      if (performance.now() - start >= ms) { resolve(); return; }
      value = value + 40 * 60 > max ? min + 600 : value + 40 * 60;
      range.value = String(value);
      range.dispatchEvent(new Event("input"));
      range.dispatchEvent(new Event("change"));
      const sought = performance.now();
      const answered = seekSnapshots;
      let sawBlank = false;
      const watch = () => {
        const blank = waitingForB();
        sawBlank ||= blank;
        // Judged once the seek's view has arrived (and been drawn a frame).
        if (!blank && seekSnapshots > answered && performance.now() - sought > 16) { if (measuring) jumpWaits.push(sawBlank ? performance.now() - sought : 0); setTimeout(next, 1500); }
        else if (performance.now() - sought > 5000) { if (measuring) jumpWaits.push(5000); setTimeout(next, 1500); }
        else requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    };
    next();
  });
  const run = scenario === "drag" ? drag : scenario === "jumps" ? jumps : play;
  if (scenario === "play") document.getElementById("historyPlayBtn")?.click();
  await run(warmupSeconds * 1000);
  const sentBefore = sent;
  const seeksBefore = seeks.length;
  measuring = true;
  console.timeStamp("bench-measure-start");
  console.log("[bench] measure-start");
  const wallStart = performance.now();
  await run(seconds * 1000);
  const wallMs = performance.now() - wallStart;
  console.timeStamp("bench-measure-end");
  console.log("[bench] measure-end");
  measuring = false;
  clearInterval(sampler);
  await settle(4);
  const q = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return Number(s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)].toFixed(2)); };
  return {
    scenario,
    deltas_per_second: Number(((sent - sentBefore) / (wallMs / 1000)).toFixed(1)),
    seeks_per_second: Number(((seeks.length - seeksBefore) / (wallMs / 1000)).toFixed(1)),
    dispatch_ms: { p50: q(dispatchCost, 0.5), p95: q(dispatchCost, 0.95), max: q(dispatchCost, 1), total: Number(dispatchCost.reduce((a, b) => a + b, 0).toFixed(1)) },
    // Recorded seek answers (seekAnswersUrl): parse + store + notify per answer, its size, whole views and diffs.
    seek_answers: answers ? { count: answerCost.length, kinds: answerKinds, left: answers.length - nextAnswer,
      parse_apply_ms: { p50: q(answerCost, 0.5), p95: q(answerCost, 0.95), max: q(answerCost, 1), total: Number(answerCost.reduce((a, b) => a + b, 0).toFixed(1)) },
      bytes: { p50: q(answerBytes, 0.5), p95: q(answerBytes, 0.95), max: q(answerBytes, 1) },
      // The view store's count of diffs applied and of protocol faults (a diff refused is one).
      store: (({ snapshot_count, replay_diff_count, protocol_fault_count }) => ({ snapshot_count, replay_diff_count, protocol_fault_count }))(getRealtimeViewStats()) } : null,
    frame_interval_ms: { p50: q(frameIntervals, 0.5), p95: q(frameIntervals, 0.95), p99: q(frameIntervals, 0.99), max: q(frameIntervals, 1), count: frameIntervals.length },
    long_tasks: { count: longTasks.length, total_ms: Number(longTasks.reduce((a, b) => a + b, 0).toFixed(1)), max_ms: longTasks.length ? Number(Math.max(...longTasks).toFixed(1)) : 0 },
    wall_ms: Math.round(wallMs),
    // How long B's panels (價量, 大單流向) showed their empty message while measuring, and for jumps how long each seek
    // waited for them (0: never emptied).
    b_panels_blank_ms: samples ? Math.round((blankSamples / samples) * wallMs) : 0,
    jump_wait_ms: jumpWaits.length ? { count: jumpWaits.length, p50: q(jumpWaits, 0.5), max: q(jumpWaits, 1) } : null,
    dom: {
      thumb: document.getElementById("historyTimeNow")?.textContent || "",
      book_rows: main.querySelectorAll("[data-orderbook-level]").length,
      tick_rows: main.querySelectorAll('[data-role="tick-body"] tr').length,
      tick_rows_added: tape.added,
      tick_rows_washed: tape.washed,
      price_flow_rows: main.querySelectorAll('[data-component-slot="replayPriceFlow"] tr').length,
      event_rows: main.querySelectorAll("tr[data-event-key]").length,
      // The event feed's viewport: its height and how many rows the row controller says it holds of how many listed.
      event_viewport: (() => {
        const viewport = main.querySelector('[data-role="event-scroll"] .standard-data-grid-body-scroll');
        return viewport ? { height: viewport.clientHeight, visible: Number(viewport.dataset.visibleRows || 0), scroll_height: viewport.scrollHeight } : null;
      })(),
      page_nodes: document.getElementsByTagName("*").length,
      orderbook_text: (main.querySelector('[data-component-slot="replayOrderbook"]')?.textContent || "").replace(/\s+/g, " ").slice(0, 120),
    },
  };
}

// The view messages after the subscribe snapshot in a probe recording, as sent (text): read as a stream, the recording
// being hundreds of MB, and kept to the first `limit`.
async function recordedSeekAnswers(url, fetchFile, limit = 1500) {
  const reader = (await fetchFile(url)).body.getReader();
  const decoder = new TextDecoder();
  const out = [];
  let rest = "", subscribed = false;
  const take = (line) => {
    if (!line) return;
    const raw = JSON.parse(line).raw;
    const type = raw.slice(raw.lastIndexOf('"type":"') + 8).split('"')[0];
    if (type !== "view.snapshot" && type !== "view.replay_diff") return;
    if (subscribed) out.push(raw);
    subscribed = true;
  };
  while (out.length < limit) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (rest + decoder.decode(value, { stream: true })).split("\n");
    rest = lines.pop();
    for (const line of lines) take(line);
  }
  if (out.length < limit) take(rest);
  await reader.cancel();
  return out.slice(0, limit);
}
