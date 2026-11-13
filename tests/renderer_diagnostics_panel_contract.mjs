import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";

// 系統連線診斷 (ui/renderer/js/core/diagnostics_panel.js). The rules a screenshot cannot pin:
//  * a link animates only when data really moved through it since the previous poll;
//  * a node's tiles are drawn at once; a value that has not arrived reads 等待資料, never 0 or "--";
//  * Health that stopped answering turns the band red and stops the heartbeat;
//  * every /api/status field the panel reads is one the route returns (a panel reading fields
//    that do not exist shows "--" for ever).
const url = (relative) => new URL(relative, import.meta.url);
const { renderDiagnostics: renderAllDetails, __test } = await import("../ui/renderer/js/core/diagnostics_panel.js");
const { buildDiagnosticsModel } = await import("../ui/renderer/js/core/diagnostics_model.js");
const { ageText, durationText } = await import("../ui/renderer/js/core/diagnostics_format.js");
// What shows: the map and the picked detail. The card also holds every other detail, hidden (checked on its own below).
const renderDiagnostics = (model, pick) => renderAllDetails(model, pick)
  .replace(/<div class="dg-pane" data-morph-key="pane:[a-z]+" aria-hidden="true" inert>[\s\S]*?(?=<div class="dg-pane|<\/aside>)/g, "");

const NOW = Date.parse("2026-10-02T14:47:00Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const running = (service_id, extra = {}) => ({ service_id, state: "RUNNING", pid: 1, addresses: { effective: { host: "127.0.0.1", port: 1 } },
  resources: { availability: "OK", cpu_percent: 0.4, memory_bytes: 64 << 20 }, metrics: { availability: "NO_SAMPLE" }, ...extra });
const runtimeDoc = (accepted, committed) => ({ availability: "OK", document: {
  health: { clients: { provider: 2, analysis: 1 } },
  ingest: { accepted, rejected_validation: 0 },
  wal: { committed, queue_depth: 0, queue_capacity: 65536, last_sync_us: 900, max_sync_us: 14000, failed: null, integrity_complete: true },
  checkpoint: { bytes: 2_900_000, events_since: 12 },
  latency: { backend_to_a: { availability: "OK", p50: 1800, p95: 6000, p99: 11000 }, accept_to_commit: { availability: "NO_SAMPLE" } },
} });
function input({ accepted = 100, committed = 50, callbackAgo = 1000, opend = "unreachable", sampledAgo = 1000, healthy = true, shAcked = 10, fuAcked = null, shConnected = true } = {}) {
  return {
    now: NOW,
    external: { healthy, services: {} },
    monitoring: { sampled_at: iso(sampledAgo), services: [
      running("market_runtime", { metrics: runtimeDoc(accepted, committed) }),
      running("provider_shioaji", { metrics: { availability: "OK", document: { payload: {
        ...(shConnected === null ? {} : { shioaji_connected: shConnected }),
        live_ingress: { acked: shAcked }, last_market_callback_at: iso(callbackAgo), last_login_at: iso(7_200_000), login_count: 1,
      } } } }),
      fuAcked === null ? running("provider_futu")
        : running("provider_futu", { metrics: { availability: "OK", document: { payload: { live_ingress: { acked: fuAcked } } } } }),
      running("analysis_runtime"), running("app_api"), running("realtime_api"),
      { service_id: "external_futu_opend", state: "EXTERNAL", state_reason: opend, addresses: { effective: { host: "127.0.0.1", port: 11111 } } },
    ] },
    moomoo: { ok: true, readiness: { connected: false }, event_sink: { queue_depth: 0, capacity: 131072 } },
    transport: { connected: true, connected_at: NOW - 3_900_000, disconnect_count: 2, last_frame_at: NOW - 400, heartbeat_round_trip_ms: 3, frame_parse_errors: 0, frame_shape_errors: 0 },
    views: { subscriptions: [] }, trend: [],
  };
}

// The three successive polls the flow, heartbeat and detail cases read.
const first = buildDiagnosticsModel(input());
const second = buildDiagnosticsModel({ ...input({ accepted: 140, committed: 90, sampledAgo: -1000, shAcked: 14 }), now: NOW + 2000 }, first);
const still = buildDiagnosticsModel({ ...input({ accepted: 140, committed: 90, callbackAgo: 60_000, sampledAgo: -3000, shAcked: 14 }), now: NOW + 4000 }, second);

// First poll: nothing to compare with, so only freshness-based links flow.
test("a link animates only when data moved through it since the previous poll", () => {
  assert.equal(first.nodes.shioaji.state, "已連線", "connected is 已連線 whether or not quotes just arrived (user 10-27: no 行情更新中)");
  assert.equal(still.nodes.shioaji.state, "已連線", "a callback a minute old is still 已連線");
  assert.ok(!first.flows.has("shioaji>market"), "no previous counter: Rust A intake is not claimed on the first poll");
  assert.ok(!first.flows.has("market>wal"));
  assert.ok(!first.flows.has("futu>market"), "nothing from Futu, no animation");
  assert.ok(second.flows.has("shioaji>market") && second.flows.has("market>wal"), "counters advanced: those links flow");
  assert.ok(!still.flows.has("shioaji>market") && !still.flows.has("market>wal"), "a green node with nothing passing through draws a still line");
  assert.equal(still.nodes.shioaji.state, "已連線", "a callback 60 s old: connected, no quotes arriving");
});

// OpenD down: the Futu node (OpenD and its provider, user 10-22) is red and says so; its link is broken, not idle.
test("OpenD down", () => {
  assert.deepEqual([first.nodes.futu.tone, first.nodes.futu.state], ["fail", "OpenD 無法連線"]);
  const html = renderDiagnostics(first, "sources");
  assert.match(html, /dg-edge broken/);
  assert.ok(!/>--</.test(html) && !/>0 \/ 0</.test(html), "no placeholder values");
  assert.ok(!html.includes("undefined") && !html.includes("null"), "no raw JS values leak into the page");
});

// A provider's detail is its process only: 上次推送 is not a tile (user 10-19).
test("A provider's detail is its process only", () => {
  const futuHtml = renderDiagnostics(first, "futu");
  assert.ok(!futuHtml.includes("上次推送") && !futuHtml.includes("尚未收到"));
  const paintHtml = renderDiagnostics(first, "paint");
  assert.match(paintHtml, /<div class="dg-tile dg-tone-pending"><small>每秒幀數<\/small><b>等待資料<\/b>/,
    "a tile whose value has not arrived is drawn, waiting -- the card does not appear late (user 10-19)");
  // The first poll after the panel opens has no detail from Health yet: every node's card is there, waiting.
  {
    const noDetail = input();
    noDetail.monitoring.services = noDetail.monitoring.services.map((svc) => svc.service_id.startsWith("external")
      ? svc : { ...svc, resources: { availability: "TEMPORARILY_UNAVAILABLE" }, metrics: { availability: "TEMPORARILY_UNAVAILABLE" } });
    const early = buildDiagnosticsModel(noDetail);
    const keys = (id) => early.nodes[id].groups.flatMap(([, tiles]) => tiles).map((t) => t.k);
    // The two sources alike (user 10-22): 連線時長 and 訂閱數 -- no 連線數, no 每秒收到 (on the node), no CPU / 記憶體.
    assert.deepEqual(keys("shioaji"), ["連線時長", "訂閱數"], "Shioaji's card is there before its numbers (user 10-20 order)");
    assert.deepEqual(keys("futu"), ["連線時長", "訂閱數"]);
    assert.deepEqual(keys("market"), ["每秒處理", "拒收"]);
    assert.match(renderDiagnostics(early, "sources"), /<small>訂閱數<\/small><b>等待資料</);
    // A provider switched off has nothing coming: no connection tiles to wait on, no tiles at all.
    const off = input();
    off.monitoring.services = off.monitoring.services.map((svc) => svc.service_id.startsWith("provider_") ? { ...svc, state: "DISABLED" } : svc);
    const offModel = buildDiagnosticsModel(off);
    for (const id of ["shioaji", "futu"]) {
      assert.deepEqual(offModel.nodes[id].groups.flatMap(([, tiles]) => tiles).map((t) => t.k), [], id);
      assert.equal(offModel.nodes[id].state, "依設定停用");
    }
  }
});

// Market Runtime shows no latency histograms of its own: 資料傳遞延遲 (provider -> Rust A) is on the latency board.
test("Market Runtime shows no latency histograms of its own", () => {
  const marketHtml = renderDiagnostics(second, "market");
  assert.ok(!marketHtml.includes("後端 → Rust A") && !marketHtml.includes("接收 → 落盤"));
  // Market Runtime: 每秒處理 and 拒收, then its WAL's 待合併 and 下次合併 (user 10-22); 自啟動後累積接收 and 連線中的程式 are
  // the developer's (user 10-19).
  assert.ok(!marketHtml.includes("連線中的程式") && !marketHtml.includes("自啟動後累積接收"));
  assert.deepEqual(second.nodes.market.groups.map(([, tiles]) => tiles.map((t) => t.k)), [["每秒處理", "拒收"]], "no WAL disk report: no WAL row");
  assert.match(marketHtml, /<div class="dg-tiles"><div class="dg-tile[^"]*"><small>每秒處理<\/small>/);
  assert.ok(!/dg-tiles-3|dg-tile-span2/.test(marketHtml), "two tiles a row at most (user 10-22)");
  // A lane is named by its title alone: no line under 行情來源 / 畫面端 … on the map or in a lane's detail (user 10-19).
  const laneHtml = renderDiagnostics(second, "sources");
  for (const sub of ["券商 SDK／閘道", "Python 行情轉接", "行情核心與分析", "這個視窗自己量測", "Health 檢查每個服務還活著", "FastAPI · HTTP"]) {
    assert.ok(!laneHtml.includes(sub), `no lane subtitle: ${sub}`);
  }
});

// Health: a new pass draws the heartbeat; a stale or unhealthy Health turns the band red and stops it.
test("Health: a new pass draws the heartbeat, a stale or unhealthy Health turns the band red", () => {
  assert.equal(second.heartbeat, true);
  assert.equal(buildDiagnosticsModel({ ...input({ sampledAgo: -1000 }), now: NOW + 2500 }, second).heartbeat, false,
    "the same Health pass is not a second heartbeat");
  // Judged when the snapshot arrived: a fresh snapshot that waited 30 s for a slow API is still a healthy Health.
  assert.equal(buildDiagnosticsModel({ ...input({ sampledAgo: 31_000 }), monitoringReceivedAt: NOW - 30_000 }).healthOk, true,
    "a slow /api/status must not make a healthy Health read 沒有回應");
  const stale = buildDiagnosticsModel(input({ sampledAgo: 30_000 }));
  assert.equal(stale.healthOk, false);
  assert.equal(stale.heartbeat, false);
  assert.match(renderDiagnostics(stale, "sources"), /data-dg-node="health"[^>]*aria-label="Health：沒有回應"/);   // Health is a node of the bottom row
  assert.match(renderDiagnostics(first, "sources"), /dg-pulse dg-no-reply/, "Futu is asked and OpenD does not answer: red ring");
});

// WAL space, quota, paint.
test("WAL space, quota, paint", () => {
  const ns = (msAgo) => String(BigInt(NOW - msAgo) * 1_000_000n);
  const base = input();
  const market = base.monitoring.services.find((svc) => svc.service_id === "market_runtime").metrics.document;
  const GB = 1 << 30;
  market.wal.disk = { bytes: 6 * GB, segments: 96, oldest_exchange_ts_ns: Number(ns(9 * 86_400_000)), newest_exchange_ts_ns: Number(ns(1000)),
    segment_ranges: [[4 * GB, Number(ns(9 * 86_400_000)), Number(ns(5 * 86_400_000))], [2 * GB, Number(ns(2 * 86_400_000)), Number(ns(1000))]] };
  market.wal.sync_latency = { availability: "OK", p50: 900, p95: 3000, p99: 8000 };
  market.checkpoint.last_at_ns = ns(60_000);
  market.latency.a_to_ui_paint = { availability: "OK", p50: 4000, p95: 9000, p99: 15000 };
  base.monitoring.health = { materializer_jobs: { materialization: { evaluated_at: iso(30_000),
    pending_from_ns: Number(ns(3 * 86_400_000)), next_materialization_at: new Date(NOW + 3 * 3600_000).toISOString() } } };
  base.paint = { visible: true, fps: 59.6, slow_frames: 0, frame_interval_p50_ms: 16.7, frame_interval_p95_ms: 18.2, frame_interval_p99_ms: 33.4,
    last_update_at: NOW - 400 };
  const model = buildDiagnosticsModel(base);
  const walHtml = renderDiagnostics(model, "wal");
  // 待合併 (2.0 GB) is shown; the WAL's own size (6.0 GB · 96 個檔) is not (user 10-19).
  assert.ok(walHtml.includes("2.0 GB") && !walHtml.includes("6.0 GB · 96 個檔"));
  assert.ok(walHtml.includes('<div class="dg-groups"><div class="dg-tiles">'), "a node's own detail: the same groups markup as a lane's");
  // WAL's two tiles are Market Runtime's second row, one cell each (user 10-22); WAL has no section of its own.
  assert.match(walHtml, /<div class="dg-tile[^"]*"><small>WAL 待合併<\/small>.*<div class="dg-tile[^"]*"><small>WAL 下次合併<\/small>/s);
  assert.ok(!walHtml.includes("<h4>WAL</h4>"), "WAL is drawn inside Market Runtime, its numbers too");
  assert.ok(!walHtml.includes('class="dg-group"'), "no group captions");
  // 寫入耗時 and Checkpoint are the developer's (Health's monitoring snapshot), not tiles (user 10-14).
  assert.ok(!walHtml.includes("寫入耗時") && !walHtml.includes("Checkpoint") && !walHtml.includes("900 µs"));
  assert.ok(!walHtml.includes("最早資料"), "no 最早資料 (user 10-19)");
  assert.match(walHtml, /WAL 下次合併<\/small><b[^>]*>\d+\/\d+ \d\d:\d\d</);
  // Waiting and running are told apart: a seal that is past due is still 等待封存, not 進行中.
  const mergeWith = (kind, at) => renderDiagnostics(buildDiagnosticsModel({ ...base, monitoring: { ...base.monitoring, health: { materializer_jobs: {
    materialization: { evaluated_at: iso(1000), pending_from_ns: Number(ns(3 * 86_400_000)), next_materialization_at: new Date(at).toISOString(), next_kind: kind } } } } }), "wal");
  assert.match(mergeWith("running", NOW), /WAL 下次合併<\/small><b[^>]*>執行中</);
  assert.match(mergeWith("queued", NOW), /WAL 下次合併<\/small><b[^>]*>等待執行</);
  assert.match(mergeWith("session_close", NOW - 60_000), /WAL 下次合併<\/small><b[^>]*>等待封存</);
  assert.match(mergeWith("retry", NOW + 600_000), /WAL 下次合併<\/small><b[^>]*>重試 /);
  // A stale materialization status (its owner stopped) waits for a current one instead of showing old numbers.
  base.monitoring.health.materializer_jobs.materialization.evaluated_at = iso(10 * 60_000);
  const staleWal = renderDiagnostics(buildDiagnosticsModel(base), "wal");
  assert.ok(!staleWal.includes("2.0 GB"), "no old numbers");
  assert.match(staleWal, /<small>WAL 待合併<\/small><b>等待資料</);
  assert.match(staleWal, /<small>WAL 下次合併<\/small><b>等待資料</);
  // 磁碟用量 and 下次合併資料 are not shown (user 10-19).
  assert.ok(!walHtml.includes("磁碟用量") && !walHtml.includes("下次合併資料"));
  const named = renderDiagnostics(buildDiagnosticsModel({ ...base, monitoring: { ...base.monitoring, health: { materializer_jobs: { materialization: {
    evaluated_at: iso(1000), pending_from_ns: Number(ns(3 * 86_400_000)), next_materialization_at: new Date(NOW + 3600_000).toISOString(), next_kind: "session_close",
    next: { source: "shioaji", market: "FUT", trading_date: "2026-10-08", session: "DAY", accepted: 300_000 },
    accepted_spans: [[300_000, Number(ns(2 * 86_400_000)), Number(ns(86_400_000))], [300_000, Number(ns(8 * 86_400_000)), Number(ns(6 * 86_400_000))]] } } } } }), "wal");
  // 下次合併 is the time alone: no grey line naming the session (user 10-19).
  assert.ok(!named.includes("台指期日盤") && !/WAL 下次合併<\/small><b[^>]*>[^<]*<\/b><span class="sub"/.test(named), "no session line under 下次合併");
  assert.ok(!named.includes("下次合併資料") && !named.includes("萬筆"), "no session size tile");
  // Nothing pending is a reported value: 無, not dropped and not "0".
  base.monitoring.health.materializer_jobs.materialization = { evaluated_at: iso(1000), pending_from_ns: null, next_materialization_at: null };
  const idleWal = renderDiagnostics(buildDiagnosticsModel(base), "wal");
  assert.match(idleWal, /WAL 待合併<\/small><b[^>]*>無</);
  assert.match(idleWal, /WAL 下次合併<\/small><b[^>]*>沒有排定</);

  // An API shows its response time alone (user 10-22); 伺服器錯誤 / 操作失敗 is the developer's (user 10-19).
  const withApiMetrics = { ...base, monitoring: { ...base.monitoring, services: base.monitoring.services.map((svc) => svc.service_id !== "app_api" ? svc
    : { ...svc, metrics: { availability: "OK", document: { metrics: [{ name: "http.requests_total", value: 152 }, { name: "http.errors_total", value: 146 },
      { name: "http.app_failures_total", value: 0 },
      { name: "http.latency/api/paper-wallet", availability: "OK", samples: 5, p50: 12300, p95: 13500, p99: 13500, route_group: "/api/paper-wallet" }] } } }) } };
  const appTiles = buildDiagnosticsModel(withApiMetrics).nodes.app.groups.flatMap(([, tiles]) => tiles);
  assert.deepEqual(appTiles.map((t) => t.k), ["回應時間 一般 · P95 · P99"], JSON.stringify(appTiles));
  assert.equal(appTiles[0].v, "12.3 ms · 13.5 ms · 13.5 ms");
  // 運行時長 / 近 5 分鐘重啟 are not on any node (user 10-14); no node has CPU or 記憶體 tiles (the cards', user 10-22).
  for (const id of Object.keys(model.nodes)) {
    const html = renderDiagnostics(model, id);
    assert.ok(!html.includes("運行時長") && !html.includes("近 5 分鐘重啟"), `${id}: no uptime / restart tile`);
    assert.ok(!/<small>(CPU|記憶體)<\/small>/.test(html), `${id}: no CPU / 記憶體 tile`);
  }
  // Shioaji (the broker session and its provider) and Futu (OpenD and its provider) alike (user 10-22): 連線時長 and
  // 訂閱數 in one row. Connected or not is the node badge; no logins, 交易所延遲, 連線數 or 每秒收到 (user 10-22).
  const sourceKeys = (id) => model.nodes[id].groups.flatMap(([, tiles]) => tiles).map((t) => t.k);
  assert.deepEqual(sourceKeys("shioaji"), ["連線時長", "訂閱數"]);
  assert.deepEqual(model.nodes.shioaji.groups.length, 1);
  assert.deepEqual(model.nodes.futu.groups.length, 1);
  {
    const probe = { ...base, monitoring: { ...base.monitoring, services: base.monitoring.services.map((svc) => svc.service_id !== "provider_shioaji" ? svc
      : { ...svc, metrics: { availability: "OK", document: { ...(svc.metrics?.document || {}), payload: { ...(svc.metrics?.document?.payload || {}),
        shioaji: { active_subscription_count: 600, subscription_limit: 600 } } } } }) } };
    const tile = buildDiagnosticsModel(probe).nodes.shioaji.groups[0][1][1];
    assert.equal(tile.v, "600／600");
    assert.equal(tile.tone, "warn", "every allowed subscription held");
  }
  assert.deepEqual(sourceKeys("futu"), ["連線時長", "訂閱數"]);
  {
    // Futu 訂閱數: what OpenD holds of its quota, both in OpenD's unit (every type of every symbol is one).
    const futu = { ...base, moomoo: { ...base.moomoo, subscription_quota: { known: true, streams: 100, held: 29 } } };
    assert.equal(buildDiagnosticsModel(futu).nodes.futu.groups[0][1][1].v, "29／100");
    const unread = { ...base, moomoo: { ...base.moomoo, subscription_quota: { known: false, held: 0 } } };
    assert.equal(buildDiagnosticsModel(unread).nodes.futu.groups[0][1][1].v, null, "no quota read yet: no number");
  }
  // Connected: counted from the provider's own login / connect time; disconnected: 未連線, never an empty detail.
  const brokerSince = model.nodes.shioaji.groups[0][1][0];
  assert.equal(brokerSince.v, "2 時 0 分", "Shioaji counts from last_login_at");
  const futuSince = model.nodes.futu.groups[0][1][0];
  assert.equal(futuSince.v, "未連線");
  assert.ok(!sourceKeys("ws").includes("連線狀態"), "WebSocket: connected or not is the node badge");
  // WebSocket: what the user reads, not when the last heartbeat was answered (user 10-19).
  assert.deepEqual(sourceKeys("ws"), ["連線時長", "斷線次數"]);
  const wsTile = (k) => model.nodes.ws.groups.flatMap(([, t]) => t).find((t) => t.k === k);
  assert.equal(wsTile("連線時長").v, "1 時 5 分");
  assert.equal(wsTile("斷線次數").v, "2");
  assert.equal(wsTile("斷線次數").tone, "warn");
  // A node's detail has no line under its title (user 10-19).
  assert.ok(!renderDiagnostics(model, "market").includes("dg-ins-meta") && !renderDiagnostics(model, "market").includes("Rust A · WS server"));
  // The dock's 資料未同步 is said on the WebSocket node too (user 10-19).
  const notSynced = buildDiagnosticsModel({ ...base, freshness: "stale" }).nodes.ws;
  assert.equal(notSynced.state, "已連線 · 資料未同步");
  assert.equal(notSynced.tone, "warn");
  assert.notEqual(buildDiagnosticsModel({ ...base, freshness: null }).nodes.ws.state, "已連線 · 資料未同步");

  assert.equal(model.nodes.paint.tone, "ok");
  const paintLive = renderDiagnostics(model, "paint");
  for (const text of ["60 fps", "16.7 ms", "18.2 ms", "33.4 ms"]) assert.ok(paintLive.includes(text), `paint shows ${text}`);
  // 慢幀 is back beside 每秒幀數 (user 10-20).
  assert.deepEqual(model.nodes.paint.groups[0][1].map((t) => [t.k, t.v]), [["每秒幀數", "60 fps"], ["慢幀（近 2 秒）", "0"]]);
  assert.equal(buildDiagnosticsModel({ ...base, paint: { ...base.paint, slow_frames: 3 } }).nodes.paint.groups[0][1][1].tone, "warn");
  assert.ok(paintLive.includes("<small>幀間隔 一般 · P95 · P99</small><b>"), "a latency is one tile that names what it measures");
  // 上次重繪 is not a tile (user 10-19): a component redrawing shows as the WebSocket → 畫面繪製 link moving.
  assert.ok(!paintLive.includes("上次重繪") && !paintLive.includes("0.4 秒前"), "no 上次重繪 tile");
  assert.ok(model.flows.has("ws>paint"), "a component updated 0.4 s ago: the last link flows");
  const hidden = buildDiagnosticsModel({ ...base, paint: { visible: false, fps: null, slow_frames: 0, last_update_at: null } });
  assert.equal(hidden.nodes.paint.state, "視窗隱藏中");
  assert.ok(!renderDiagnostics(hidden, "paint").includes("fps"), "no frames is not 0 fps");
  assert.equal(buildDiagnosticsModel({ ...base, paint: { ...base.paint, fps: 12 } }).nodes.paint.tone, "warn");

  // No node shows an 端點 (user 10-14): addresses are configuration, not a state.
  const opend = base.monitoring.services.find((svc) => svc.service_id === "external_futu_opend");
  opend.addresses.observed = { host: "127.0.0.1", port: 11112, verified: false };
  const all = buildDiagnosticsModel(base);
  // The lane named 服務端點 (user 10-27) is the APIs' lane, not an address.
  for (const id of Object.keys(all.nodes)) assert.ok(!renderDiagnostics(all, id).replaceAll("服務端點", "").includes("端點"), `${id}: no 端點 tile`);
});

test("ageText and durationText", () => {
  assert.equal(ageText(1100), "1.1 秒前");
  assert.equal(durationText(14 * 3600_000 + 41 * 60_000), "14 時 41 分");
});

// The Shioaji connection and each provider's acknowledgements are Health's provider probes alone (D06-03, D06-04): a
// probe without them is no sample, never a value from /api/status or /api/futu/status read at another moment.
test("The Shioaji connection and the provider acknowledgements come from Health's probes only", () => {
  // The panel is split by job (topology, snapshot, model, cards, map, inspector): read them all.
  const panel = readdirSync(url("../ui/renderer/js/core/")).filter((name) => name.startsWith("diagnostics_"))
    .map((name) => readFileSync(url(`../ui/renderer/js/core/${name}`), "utf8")).join("\n");
  assert.doesNotMatch(panel, /\bstatus\?\.(broker_status|sources)|event_sink\?\.acked/, "no /api/status, no Futu route counter");

  // The probe has no shioaji_connected: 狀態未知, even while /api/status (no longer read) says connected.
  const unknown = buildDiagnosticsModel({ ...input({ shConnected: null }), status: { broker_status: { shioaji_connected: true }, sources: { shioaji: { connected: true } } } });
  assert.equal(unknown.nodes.shioaji.state, "狀態未知");
  assert.equal(buildDiagnosticsModel(input({ shConnected: false })).nodes.shioaji.state, "券商未連線", "the probe's own answer decides");

  // Futu: the probe's count, or no sample -- the route's event_sink.acked never stands in for it.
  const routeOnly = (fu) => ({ ...input({ sampledAgo: -1000 }), moomoo: { ok: true, readiness: { connected: true }, event_sink: { acked: fu } } });
  const before = buildDiagnosticsModel(routeOnly(10));
  const after = buildDiagnosticsModel({ ...routeOnly(25), now: NOW + 2000 }, before);
  assert.equal(after.counters.fuAcked, null, "no probe count: this poll has no sample");
  assert.ok(!after.flows.has("futu>market"));
  const probed = buildDiagnosticsModel({ ...input({ sampledAgo: -1000, fuAcked: 25 }), now: NOW + 2000 }, buildDiagnosticsModel(input({ fuAcked: 10 })));
  assert.equal(probed.counters.fuAcked, 25);
  assert.ok(probed.flows.has("futu>market"), "the probe's count moves the link");
});

// 券商 SDK is user-installed; without it the provider runs but can never connect, so the node says 尚未安裝 SDK
// with how to install it, not a 未連線 that reads as "logged out" and leaves the user waiting (user 11-13).
test("a provider whose SDK is not installed says 尚未安裝 SDK, not 未連線", () => {
  const sdk = (p, installed) => ({ providers: { [p]: { installed } } });
  const sh = buildDiagnosticsModel({ ...input({ shConnected: false }), providerSdk: sdk("shioaji", false) }).nodes.shioaji;
  assert.deepEqual([sh.tone, sh.state], ["fail", "尚未安裝 SDK"], "missing SDK is said plainly, not 券商未連線");
  assert.match(renderDiagnostics(buildDiagnosticsModel({ ...input({ shConnected: false }), providerSdk: sdk("shioaji", false) }), "shioaji"),
    /設定 → 券商帳號 安裝/, "the node says where to install it");
  // installed: true leaves the broker-login verdict (券商未連線) untouched; an unread probe (no providerSdk) too.
  assert.equal(buildDiagnosticsModel({ ...input({ shConnected: false }), providerSdk: sdk("shioaji", true) }).nodes.shioaji.state, "券商未連線");
  // Futu: 尚未安裝 SDK wins over OpenD 無法連線, and the 重新檢查 Futu 連線 action is dropped (nothing to connect with).
  const fu = buildDiagnosticsModel({ ...input(), providerSdk: sdk("futu", false) }).nodes.futu;
  assert.deepEqual([fu.tone, fu.state, fu.action], ["fail", "尚未安裝 SDK", null]);
});

// Rust B publishes its own model signals to Rust A. That link moves on B's own count of published signals,
// never on the projection acks of the 分析結果 link beside it; Realtime API only writes the inference config file.
test("Rust B publishes its own model signals to Rust A", () => {
  const withB = (accepted, acks, sampledAgo) => {
    const at = input({ sampledAgo });
    at.monitoring.services = at.monitoring.services.map((svc) => svc.service_id === "analysis_runtime"
      ? { ...svc, metrics: { availability: "OK", document: { stream: { cursor: 1 }, publish: { acks_ok: acks },
          signals: { counts: { accepted } } } } }
      : svc);
    return at;
  };
  const earlier = buildDiagnosticsModel(withB(3, 10, 1000));
  const signalsMoved = buildDiagnosticsModel({ ...withB(5, 10, -1000), now: NOW + 2000 }, earlier);
  assert.ok(signalsMoved.flows.has("analysis>market:signals") && !signalsMoved.flows.has("analysis>market"),
    "published signals move the 模型訊號 link only");
  const acksMoved = buildDiagnosticsModel({ ...withB(3, 20, -1000), now: NOW + 2000 }, earlier);
  assert.ok(acksMoved.flows.has("analysis>market") && !acksMoved.flows.has("analysis>market:signals"),
    "projection acks move the 分析結果 link only");
  const edges = __test.EDGES.map((e) => `${e.from}>${e.to}`);
  assert.ok(!edges.includes("analysis>realtime") && !edges.includes("realtime>market"), "no model-signal path through FastAPI");
  assert.ok(edges.includes("realtime>analysis"), "Realtime API writes the inference config Rust B reads");
  const html = renderDiagnostics(signalsMoved, "analysis");
  const groups = signalsMoved.nodes.analysis.groups.map(([label]) => label);
  assert.ok(!groups.includes("模型推論") && !groups.includes("模型訊號"), "Analysis Runtime's detail has no inference / signal tiles");
  // 每秒處理 and 被拒 (user 10-22: no 模型訊號 count); 落後 Rust A, 發布筆數 and 特徵熱身 are gone (user 10-19).
  assert.deepEqual(signalsMoved.nodes.analysis.groups.map(([, tiles]) => tiles.map((t) => t.k)), [["每秒處理", "被拒"]]);
  assert.equal(signalsMoved.nodes.analysis.groups[0][1][0].v, "0.0 筆", "the stream cursor did not move: 0 a second, a measured value");
  assert.ok(!html.includes("發布筆數") && !html.includes("特徵熱身") && !html.includes("落後 Rust A"));
});

// Each link moves on its own evidence, missing halves never print, and a service Health
// did not probe gets no heartbeat ring.
test("Each link moves on its own evidence, missing halves never print, and a service Health did not probe gets no heartbeat ring", () => {
  const withAcks = (sh, fu, received = null) => ({ ...input({ sampledAgo: -1000, shAcked: sh, fuAcked: fu }), now: NOW + 2000,
    moomoo: { ok: true, readiness: { connected: true }, last_push_at: iso(500) },
    views: received === null ? { subscriptions: [] } : { subscriptions: [{ view_state: "LIVE", last_received_sequence: received, last_applied_sequence: received }] } });
  const before = buildDiagnosticsModel(withAcks(10, 10, 5));
  const futuOnly = buildDiagnosticsModel({ ...withAcks(10, 25, 5), now: NOW + 4000 }, before);
  assert.ok(futuOnly.flows.has("futu>market") && !futuOnly.flows.has("shioaji>market"),
    "Futu's acknowledgements move Futu's link only, even while Shioaji callbacks are fresh");
  assert.ok(!futuOnly.flows.has("market>ws"), "a fresh WebSocket frame with no new market data is a heartbeat, not a flow");
  assert.ok(buildDiagnosticsModel({ ...withAcks(10, 25, 9), now: NOW + 4000 }, before).flows.has("market>ws"));
  assert.ok(!futuOnly.flows.has("analysis>market:signals"), "no signal count reported: model-signal publication stays still");
  // A provider that reports no count of its own never borrows Rust A's intake total (fed by every source).
  const noOwn = (accepted) => ({ ...input({ accepted, sampledAgo: -1000, shAcked: null }), moomoo: { ok: true, readiness: { connected: true }, last_push_at: iso(500) } });
  const silent = buildDiagnosticsModel({ ...noOwn(500), now: NOW + 4000 }, buildDiagnosticsModel(noOwn(100)));
  assert.ok(!silent.flows.has("shioaji>market") && !silent.flows.has("futu>market"),
    "no own acknowledgement count: the link stays still even though Rust A's total advanced");

  const holes = input();
  holes.monitoring.services = holes.monitoring.services.map((svc) => svc.service_id === "market_runtime"
    ? { ...svc, resources: { availability: "OK", cpu_percent: null, memory_bytes: 1 << 20 },
        metrics: { availability: "OK", document: { health: {}, ingest: {}, wal: { committed: 1, queue_depth: null, queue_capacity: 65536 } } } }
    : svc);
  const holeHtml = renderDiagnostics(buildDiagnosticsModel(holes), "market") + renderDiagnostics(buildDiagnosticsModel(holes), "wal");
  assert.ok(!/null|undefined|NaN/.test(holeHtml), "a missing half never prints");
  assert.ok(/<small>每秒處理<\/small><b>等待資料</.test(holeHtml), "no previous poll to compare with: the rate waits, it is not 0");
  assert.ok(!holeHtml.includes("待落盤佇列") && !holeHtml.includes("已落盤序號"), "WAL: no write queue / committed sequence tiles (user 10-19)");

  const disabled = input({ sampledAgo: -1000 });
  disabled.monitoring.services = disabled.monitoring.services.map((svc) => svc.service_id === "provider_futu" ? { ...svc, state: "DISABLED" } : svc);
  const map = renderDiagnostics(buildDiagnosticsModel({ ...disabled, now: NOW + 2000 }, first), "futu");
  const futuNode = map.slice(map.indexOf('data-morph-key="node:futu"'), map.indexOf("</g>", map.indexOf('data-morph-key="node:futu"')));
  assert.ok(!futuNode.includes("dg-pulse"), "Health does not probe a disabled source: no heartbeat ring on it");
  assert.ok(map.slice(map.indexOf('data-morph-key="node:market"')).includes("dg-pulse"), "a probed service still gets its ring");
});

// Geometry (user 10-20): the compact map, 1016 x 336; every node and link stays inside it, each node within its lane, and
// WAL drawn inside the Market Runtime node it lives in (no 「Rust A 程序內」 frame or note).
test("Geometry (user 10-20)", async () => {
  const { __test } = await import("../ui/renderer/js/core/diagnostics_panel.js");
  const html = renderDiagnostics(first, "sources");
  assert.match(html, /viewBox="0 0 1016 336"/);
  for (const [id, node] of Object.entries(__test.LAYOUT)) {
    if (node.inner) continue;
    assert.ok(node.x >= 8 && node.x + node.w <= 1008 && node.y >= 34 && node.y + (node.h || 58) <= 328, `${id} lies inside the map`);
    const lane = Object.values(__test.LANES).find((l) => l.members.includes(id));
    if (lane) {
      const [lx, ly, lw, lh] = lane.rect;
      assert.ok(node.x >= lx && node.x + node.w <= lx + lw && node.y >= ly && node.y + (node.h || 58) <= ly + lh, `${id} lies inside its lane`);
    }
  }
  const { market, wal } = __test.LAYOUT;
  assert.ok(wal.inner && wal.x + wal.w <= market.w && wal.y + wal.h <= (market.h || 58), "WAL fits inside the Market Runtime node");
  const marketNode = html.slice(html.indexOf('data-morph-key="node:market"'), html.indexOf('data-morph-key="node:analysis"'));
  assert.match(marketNode, /class="dg-wal dg-tone-[a-z]+"/, "WAL is drawn by the Market Runtime node");
  // Its name and state centred in a box as wide as its longest state, so both sides keep the same room (user 10-27).
  assert.match(marketNode, /<rect class="dg-wal-box" width="64"[^>]*\/>\s*<text class="title" x="32" y="19" text-anchor="middle">WAL<\/text><text class="state" x="32" y="37" text-anchor="middle">/);
  assert.doesNotMatch(html, /data-morph-key="node:wal"/, "WAL is not a node of its own on the map");
  assert.ok(!html.includes("Rust A 程序內"), "no Rust A process note (user 10-20)");
  for (const edge of __test.EDGES) {
    for (const value of edge.d.match(/[HV]\s*-?\d+|M\s*-?\d+\s+-?\d+/g) || []) {
      const numbers = value.match(/-?\d+/g).map(Number);
      if (value.startsWith("M") || value.startsWith("H")) assert.ok(numbers[0] <= 1008, `${edge.from}>${edge.to} stays inside`);
      if (value.startsWith("V")) assert.ok(numbers[0] <= 328, `${edge.from}>${edge.to} stays inside`);
    }
  }
  // No vertical link runs into the tag on a node's top edge (自己回報 / HTTP 問 / 看狀態檔 ...), and Market Runtime's badge
  // clears its title (live check 10-20).
  for (const [id, ask] of Object.entries(__test.ASK)) {
    const n = __test.LAYOUT[id];
    const tw = __test.askWidth(ask);
    const [left, right] = [n.x + n.w - tw - 10, n.x + n.w - 10];
    for (const edge of __test.EDGES) {
      const [, x, y] = edge.d.match(/^M(\d+) (\d+) V(\d+)$/) || [];
      if (x === undefined) continue;
      const ends = [Number(y), Number(edge.d.split("V")[1])];
      const touchesTop = ends.some((v) => Math.abs(v - n.y) <= 8);
      assert.ok(!(touchesTop && Number(x) >= left - 4 && Number(x) <= right + 4), `${edge.from}>${edge.to} runs into ${id}'s ${ask} tag`);
    }
  }
  // Market Runtime is as tall as every node, its WAL in its middle: right of its title (Market Runtime at 17 px is 133
  // wide) and the 寫入 label, left of its badge and its events per second (user 10-22).
  assert.ok(!market.h && wal.x >= 14 + 133 + 30 && wal.x + wal.w <= market.w - 10 - 36 - 54, "WAL between the title and the right column");
  // The traffic dots are drawn after every node and label, so nothing covers them (user 10-20).
  const live = renderDiagnostics(second, "sources");
  const lastText = Math.max(live.lastIndexOf("</text>"), live.lastIndexOf('class="dg-node'));
  assert.ok(live.indexOf('class="dg-traffic"') > lastText, "dots over the text");
});

// The popover is closed by its hidden attribute (index.html): its own rule must not set a display, which would override
// hidden and show it, stuck at 讀取中, on every App start (10-20).
test("The popover is closed by its hidden attribute (index.html)", () => {
  const shell = readFileSync(url("../ui/renderer/styles/layout/app-shell.css"), "utf8");
  const rule = shell.match(/\n\.service-diagnostics-popover \{[^}]*\}/)[0];
  assert.doesNotMatch(rule.replace(/\/\*[\s\S]*?\*\//g, ""), /(^|[\s;{])display\s*:/, "no display on the popover itself");
  const html = readFileSync(url("../ui/renderer/index.html"), "utf8");
  assert.match(html, /id="serviceDiagnosticsPopover"[^>]*\bhidden\b/, "it starts hidden");
});

// Each diagnostics source is bounded and the bound really ends it (status.js).
test("Each diagnostics source is bounded and the bound really ends it (status.js)", () => {
  const status = readFileSync(url("../ui/renderer/js/core/status.js"), "utf8");
  assert.match(status, /const DIAGNOSTICS_SOURCE_TIMEOUT_MS = 2500;/);
  assert.match(status, /\.finally\(\(\) => clearTimeout\(timer\)\)/, "the budget timer is cleared once the source answered");
  assert.doesNotMatch(status, /kbars\/usage/, "歷史資料額度 is gone: the panel no longer polls the quota");
  assert.match(status, /\]\.map\(withinDiagnosticsBudget\)\);/, "every source goes through the budget");
  // The start-up steps too: an IPC that never answers must not leave the panel busy for good.
  const budgeted = status.match(/await Promise\.allSettled\(\[([\s\S]*?)\]\.map\(withinDiagnosticsBudget\)\)/)?.[1] || "";
  assert.match(budgeted, /getStartupState/, "getStartupState is one of the budgeted sources");
  assert.equal((status.match(/getStartupState/g) || []).length, 2, "and is read nowhere else (the call and its name in the record)");
  assert.match(status, /if \(startup\.status === "fulfilled"\) diagnostics\.startup = startup\.value;/, "a missed read keeps the last start-up steps");
});

// 延遲 per source (Rust A latency.by_source) is the top card, not part of any node or the map (user 10-20): 整體 large,
// its P99, and the three stages, each 一般.
test("延遲 per source (Rust A latency.by_source) is the top card, not part of any node or the map (user 10-20)", () => {
  const ok = (p50, p95, p99) => ({ availability: "OK", p50, p95, p99, samples: 10 });
  const monitoring = { sampled_at: new Date(NOW).toISOString(), services: [{ service_id: "market_runtime", state: "RUNNING",
    metrics: { availability: "OK", document: { latency: { by_source: {
      shioaji: { exchange_to_backend: ok(1049000, 1049000, 1095000), backend_to_a: ok(575, 1400, 3300), a_to_ui_paint: ok(10300, 24500, 42500),
        exchange_to_ui_paint: ok(1050000, 1050000, 1190000) },
      futu: { exchange_to_backend: ok(180000, 420000, 900000), a_to_ui_paint: { availability: "NO_SAMPLE", samples: 0 },
        exchange_to_ui_paint: ok(1400000, 1870000, 2490000) },
    } } } } }] };
  const model = buildDiagnosticsModel({ now: NOW, monitoring, external: { healthy: true } });
  const labels = (id) => model.nodes[id].groups.flatMap(([, tiles]) => tiles).map((t) => t.k);
  for (const id of ["shioaji", "futu", "paint"]) assert.ok(!labels(id).some((label) => label.includes("延遲")), `${id}: latency is on the card only`);
  const html = renderDiagnostics(model, "paint");
  const card = html.slice(html.indexOf('data-morph-key="kpi:latency"'), html.indexOf('data-morph-key="kpi:storage"'));
  assert.match(card, /延遲（交易所 → 畫面）<\/span><\/div>/, "nothing beside the title (user 10-22: 近 1 分鐘 · 一般 removed)");
  assert.match(card, /Shioaji<\/span><b>1\.05 s<\/b>/, "整體 一般 in seconds");
  assert.match(card, /<span>P99 1\.19 s<\/span>/);
  assert.doesNotMatch(card, /P95/, "P99 alone (user 10-22)");
  assert.match(card, /交易所 1\.05 s<\/span>.*傳遞 575 µs<\/span>.*繪製 10\.3 ms<\/span>/s, "the three stages in order");
  assert.match(card, /Futu<\/span><b class="dg-tone-warn">1\.40 s<\/b>/, "over 1.2 s reads in orange");
  assert.match(card, /傳遞 未回報<\/span>.*繪製 沒有樣本<\/span>/s, "a stage not reported / without samples says so, never 0");
  assert.doesNotMatch(html, /dg-latency-board/, "no latency board on the map");
  assert.doesNotMatch(card, /時間倒退|lat:skew/, "the clock-skew line was removed (user 10-20)");
});

// 系統 CPU, 記憶體 and 儲存空間, the other top cards (user 10-20, 10-22).
test("系統 CPU, 記憶體 and 儲存空間, the other top cards (user 10-20, 10-22)", () => {
  const GB = 1024 ** 3, MB = 1024 ** 2;
  // Health's one list of processes (snapshot.system.parts): each with its CPU and memory (private working set).
  const procParts = [["provider_futu", 1.0, 167], ["app", 5.0, 1229], ["market_runtime", 1.5, 120], ["provider_shioaji", 0.5, 160], ["service_controller", 0.3, 70],
    ["realtime_api", 0.4, 60], ["analysis_runtime", 0.6, 40], ["ungrouped_tool", 2.0, 500]]
    .map(([id, cpu, mb]) => ({ id, service_ids: id === "app" ? [] : id === "realtime_api" ? ["realtime_api", "app_api"] : [id], cpu_percent: cpu, bytes: mb * MB }));
  const system = { availability: "OK", cpu_percent: 11.3, memory_bytes: 2346 * MB, cores: 12, parts: procParts };
  const monitoring = { sampled_at: new Date(NOW).toISOString(), services: [], system,
    storage: { availability: "OK", total_bytes: 20.8 * GB, disk: { root: "D:\\", total_bytes: 931 * GB, free_bytes: 800 * GB },
      parts: [{ id: "historical", label: "歷史資料", bytes: 13 * GB }, { id: "wal", label: "WAL", bytes: 3.9 * GB },
        { id: "analysis", label: "分析", bytes: 2.8 * GB }, { id: "market", label: "行情", bytes: 0.6 * GB }, { id: "other", label: "其他", bytes: 0.5 * GB }] } };
  const trend = [{ t: NOW - 200_000, system: { cpu: 50, mem: 9 * GB } }, { t: NOW - 4000, system: { cpu: 8.7, mem: 2300 * MB } },
    { t: NOW - 2000, system: { cpu: null, mem: null } }, { t: NOW, system: { cpu: 11.2, mem: 2346 * MB } }];
  const model = buildDiagnosticsModel({ now: NOW, monitoring, trend, external: { healthy: true } });
  const html = renderDiagnostics(model, "sources");
  const at = (key) => html.indexOf(`kpi:${key}"`);
  assert.ok(at("latency") < at("cpu") && at("cpu") < at("memory") && at("memory") < at("storage"), "延遲, CPU, 記憶體, 儲存空間 in order (user 10-22)");
  assert.ok(html.indexOf('data-morph-key="kpis"') < html.indexOf('data-morph-key="topology"'), "the cards are above the map");
  assert.match(html, /data-morph-key="topology"><header class="dg-card-head"><h4>系統拓樸<\/h4><\/header>/, "the map card keeps its title (user 10-20)");
  const cpu = html.slice(at("cpu"), at("memory"));
  assert.doesNotMatch(cpu, /核/, "no core count (user 10-20)");
  assert.doesNotMatch(cpu, /近 2 分鐘/, "no min–max text (user 10-20)");
  // 系統 CPU a ring like 記憶體 (user 10-22), in the same groups and colours; the ring's whole is the computer (100%), so
  // each arc is its group's percent; the figure in its middle is one value, no unit line.
  assert.match(cpu, /<text class="dg-donut-total" x="50" y="57"[^>]*>9\.3%<\/text><\/svg>/);
  assert.deepEqual([...cpu.matchAll(/<\/i>([^<]+)<\/span><b>([^<]+)<\/b>/g)].map(([, name, v]) => `${name} ${v}`),
    ["行情來源 1.5%", "資料處理 2.1%", "畫面渲染 5.0%", "系統狀態 0.3%", "服務端點 0.4%"], "named as the topology's lanes (user 10-27)");
  const cpuArc = cpu.match(/dg-donut-arc dg-part-1"[^>]*stroke-dasharray="([\d.]+) /);
  assert.ok(Math.abs(Number(cpuArc[1]) - (1.5 - 0.6)) < 0.01, "Provider's arc is 1.5 of the ring's 100 (less the gap)");
  // The last 2 minutes of each total, a line in the title row (user 10-22: moved from under the figure), for 記憶體 too.
  assert.match(cpu, /<div class="dg-kpi-head"><span>系統 CPU<\/span><svg class="dg-kpi-trend"/);
  assert.match(html.slice(at("memory"), at("storage")), /<div class="dg-kpi-head"><span>記憶體<\/span><svg class="dg-kpi-trend"/);
  assert.equal(model.system.trend.points.length, 3, "older than 2 minutes is left out");
  assert.deepEqual(model.memory.trend.points.map((p) => p.v), [2300 * MB, null, 2346 * MB]);
  // Each point at its time across the 2 minutes, not one step per point: Health's background samples are 10 s apart,
  // an open page's 2 s (user 10-27: the line is there when the page opens).
  const spaced = buildDiagnosticsModel({ now: NOW, monitoring, external: { healthy: true },
    trend: [{ t: NOW - 60_000, system: { cpu: 4, mem: 1 } }, { t: NOW - 50_000, system: { cpu: 4, mem: 1 } }, { t: NOW, system: { cpu: 4, mem: 1 } }] });
  const line = renderDiagnostics(spaced, "sources").match(/<path class="dg-spark-line" d="([^"]+)"/)[1];
  assert.deepEqual([...line.matchAll(/[ML]([\d.]+) /g)].map(([, x]) => Number(x)), [80, 93.3, 160], "x is the time within the span");
  const oneValue = buildDiagnosticsModel({ now: NOW, monitoring, trend: trend.slice(-1), external: { healthy: true } });
  assert.doesNotMatch(renderDiagnostics(oneValue, "sources"), /dg-kpi-trend/, "no line from a single value");
  // 記憶體 a ring like 儲存空間 in fixed groups and colours (user 10-22, names 10-27): 行情來源, 資料處理, 畫面渲染, 系統狀態,
  // 服務端點, each group keeping its colour; the isolated
  // mode's test ingress is in no group and not drawn.
  const memory = html.slice(at("memory"), at("storage"));
  assert.match(memory, /<text class="dg-donut-total"[^>]*>1\.8<\/text><text class="dg-donut-unit"[^>]*>GB<\/text>/);
  assert.deepEqual([...memory.matchAll(/class="dg-donut-arc dg-part-(\d)"/g)].map(([, p]) => Number(p)), [1, 2, 3, 5, 4]);
  assert.deepEqual([...memory.matchAll(/<\/i>([^<]+)<\/span><b>([^<]+)<\/b>/g)].map(([, name, size]) => `${name} ${size}`),
    ["行情來源 327.0 MB", "資料處理 160.0 MB", "畫面渲染 1.2 GB", "系統狀態 70.0 MB", "服務端點 60.0 MB"]);
  // 訓練 and 收盤整理 follow in both cards, each only while its job runs.
  const jobs = (extra) => buildDiagnosticsModel({ now: NOW, monitoring: { ...monitoring, system: { ...system, parts: [...procParts, ...extra] } },
    external: { healthy: true } });
  const training = jobs([{ id: "training", service_ids: [], cpu_percent: 12, bytes: 300 * MB }]);
  assert.deepEqual(training.memory.ring.parts.map((p) => [p.label, p.part]), [["行情來源", 1], ["資料處理", 2], ["畫面渲染", 3], ["系統狀態", 5], ["服務端點", 4], ["訓練", 6]]);
  assert.equal(training.memory.ring.total, 2146 * MB);
  assert.deepEqual(training.system.ring.parts.at(-1), { id: "training", label: "訓練", value: 12, part: 6 });
  const both = jobs([{ id: "materializer", service_ids: [], cpu_percent: 3, bytes: 100 * MB }, { id: "training", service_ids: [], cpu_percent: 12, bytes: 300 * MB }]);
  assert.deepEqual(both.memory.ring.parts.slice(-2).map((p) => [p.label, p.part]), [["訓練", 6], ["收盤整理", 7]]);
  assert.deepEqual(jobs([{ id: "materializer", service_ids: [], cpu_percent: 3, bytes: 100 * MB }]).memory.ring.parts.at(-1),
    { id: "materializer", label: "收盤整理", value: 100 * MB, part: 7 }, "its colour is its own whether or not training runs");
  const storage = html.slice(at("storage"));
  assert.match(storage, /<span>儲存空間<\/span><span>D: 剩 800 \/ 931 GB<\/span><\/div>/,
    "the storage location's disk (user 10-28): its size and what is left, in the title row");
  // A ring (user 10-20): the total in its middle, one arc per part in order from the top, each its share of the total.
  assert.match(storage, /<text class="dg-donut-total"[^>]*>20\.8<\/text><text class="dg-donut-unit"[^>]*>GB<\/text>/);
  const arcs = [...storage.matchAll(/class="dg-donut-arc dg-part-(\d)"[^>]*stroke-dasharray="([\d.]+) [\d.]+" stroke-dashoffset="([-\d.]+)"/g)]
    .map(([, part, len, offset]) => [Number(part), Number(len), Number(offset)]);
  assert.deepEqual(arcs.map(([part]) => part), [1, 4, 5, 6, 7], "each part keeps its own colour");
  assert.ok(Math.abs(arcs[0][1] - (13 / 20.8 * 100 - 0.6)) < 0.01, "歷史資料's arc is its share (less the gap between arcs)");
  assert.equal(arcs[0][2], 25, "the first arc starts at the top");
  assert.ok(Math.abs(arcs[1][2] - (25 - 13 / 20.8 * 100)) < 0.01, "each arc starts where the one before ended");
  assert.match(storage, /歷史資料<\/span><b>13\.0 GB<\/b>.*WAL<\/span><b>3\.9 GB<\/b>.*分析<\/span><b>2\.8 GB<\/b>.*行情<\/span><b>614\.4 MB<\/b>.*其他<\/span><b>512\.0 MB<\/b>/s,
    "the parts listed beside the ring, one per line, each in the unit that fits it");
  // A new install holds a few MB: the figures say so, as the arcs drawn from them do -- never a full ring over 0.0 GB.
  const fresh = renderDiagnostics(buildDiagnosticsModel({ now: NOW, external: { healthy: true }, monitoring: { ...monitoring,
    storage: { availability: "OK", total_bytes: 3 * MB, disk: { root: "C:\\", total_bytes: 455 * GB, free_bytes: 169 * GB },
      parts: [{ id: "market", label: "行情", bytes: 2 * MB }, { id: "other", label: "其他", bytes: 1 * MB }] } } }), "sources");
  const freshStorage = fresh.slice(fresh.indexOf('data-morph-key="kpi:storage"'));
  assert.match(freshStorage, /<text class="dg-donut-total"[^>]*>3\.0<\/text><text class="dg-donut-unit"[^>]*>MB<\/text>/);
  assert.match(freshStorage, /行情<\/span><b>2\.0 MB<\/b>.*其他<\/span><b>1\.0 MB<\/b>/s);
  assert.doesNotMatch(freshStorage, /0\.0 GB/);
  assert.doesNotMatch(storage, /dg-kpi-bar/, "no bar any more");
  // Nothing reported yet: the cards are drawn, waiting -- never 0.
  const empty = renderDiagnostics(buildDiagnosticsModel({ now: NOW, external: { healthy: true } }), "sources");
  assert.equal((empty.match(/dg-kpi-pending">等待資料</g) || []).length, 3, "系統 CPU, 記憶體 and 儲存空間 wait");
  assert.ok(!/kpi:cpu[\s\S]*?>0\.0%</.test(empty));
  // No 補救事件 card any more (user 10-20).
  assert.ok(!html.includes("補救事件") && !("remediation" in model));
});

// The 2 s poll morphs the panel (dom_morph.js), never rebuilds it: cards, scroll panes and the map keep their elements.
test("The 2 s poll morphs the panel (dom_morph.js), never rebuilds it", () => {
  const status = readFileSync(url("../ui/renderer/js/core/status.js"), "utf8");
  assert.doesNotMatch(status, /body\.innerHTML\s*=/, "the diagnostics body is never rebuilt with innerHTML");
  assert.match(status, /morphInto\(body, await loadDiagnostics\(\)\)/);
  const html = renderDiagnostics(buildDiagnosticsModel({ now: NOW, external: { healthy: true } }), "shioaji");
  for (const key of ["kpis", "kpi:cpu", "kpi:latency", "kpi:memory", "kpi:storage", "topology", "inspector:sources", "node:shioaji", "lane:sources"]) {
    assert.ok(html.includes(`data-morph-key="${key}"`), `${key} keeps its element across polls`);
  }
});

// Futu 上次推送 is the provider's own last_push_at (no tick/book/bar times exist); 已確認訂閱 is gone. Health's 監控
// is one row.
test("Futu 上次推送 is the provider's own last_push_at (no tick/book/bar times exist)", () => {
  const at = { ...input({ opend: "reachable" }), moomoo: { ok: true, readiness: { connected: true }, last_push_at: iso(3000) } };
  // Both providers' queue to Market Runtime is their own live_ingress in Health's snapshot; it is not a tile (user 10-19).
  at.monitoring.services = at.monitoring.services.map((svc) => {
    if (svc.service_id === "provider_futu") return { ...svc, metrics: { availability: "OK", document: { payload: { live_ingress: { queue_depth: 2, capacity: 8 } } } } };
    if (svc.service_id === "provider_shioaji") {
      const payload = { ...svc.metrics.document.payload, live_ingress: { ...svc.metrics.document.payload.live_ingress, queue_depth: 0, capacity: 4096 }, reconnect_count: 3 };
      return { ...svc, metrics: { ...svc.metrics, document: { ...svc.metrics.document, payload } } };
    }
    return svc;
  });
  const model = buildDiagnosticsModel(at);
  const tilesOf = (id) => Object.fromEntries(model.nodes[id].groups.flatMap(([, tiles]) => tiles).map((t) => [t.k, t.v]));
  const futuTiles = tilesOf("futu"), shTiles = tilesOf("shioaji");
  assert.ok(!("上次推送" in futuTiles) && !("已確認訂閱" in futuTiles));
  assert.ok(!("事件佇列" in futuTiles) && !("事件佇列" in shTiles), "no queue tile");
  assert.deepEqual(Object.keys(shTiles), ["連線時長", "訂閱數"], "Shioaji: its connection (user 10-22)");
  assert.equal(model.nodes.futu.state, "已連線", "2 of 8 is not full; connected is 已連線 (user 10-27: no 行情更新中)");
  // A full queue drops what arrives (rust_live.py): the node says so in place of 已連線.
  const jam = { ...at, monitoring: { ...at.monitoring, services: at.monitoring.services.map((svc) => svc.service_id === "provider_futu"
    ? { ...svc, metrics: { availability: "OK", document: { payload: { live_ingress: { queue_depth: 8, capacity: 8 } } } } } : svc) } };
  const jammed = buildDiagnosticsModel(jam).nodes.futu;
  assert.equal(jammed.state, "轉送塞車");
  assert.equal(jammed.tone, "warn");
  assert.ok(!("重新連線次數" in shTiles), "a reconnect is a 補救事件, not a tile");
  assert.ok(!("apply" in model.nodes), "no 資料套用 node (user 10-19)");
  // No 程序 group: Health's CPU and 記憶體 are the cards' (user 10-22).
  const [monitor, rescue] = model.nodes.health.groups;
  // 監控: 上次確認, 狀態 and 已運作 (Health's started_at, user 10-19), two a row at most (user 10-22).
  assert.deepEqual(monitor[1].map((t) => t.k), ["上次確認", "狀態", "已運作"]);
  assert.equal(monitor[1][2].v, null, "no started_at reported: no value");
  const running = buildDiagnosticsModel({ ...at, monitoring: { ...at.monitoring, health: { started_at: new Date(NOW - 95 * 60_000).toISOString() } } });
  assert.equal(running.nodes.health.groups[0][1][2].v, "1 時 35 分");
  assert.deepEqual(rescue[1].map((t) => t.k), ["自動重啟服務", "上次開 App 到畫面可用"]);
  assert.ok(rescue[1].every((t) => t.v === null), "nothing reported yet: no value, no 0");
  // Health's automatic restarts (health.service_restart), today · 7 days and which services; the App's last start
  // from Electron main's startup coordinator (startup_started_at -> first_paint done) (user 10-19).
  const restarts = buildDiagnosticsModel({ ...at, startup: { startup_started_at: "2026-10-19T19:12:57.000Z",
    steps: [{ id: "first_paint", status: "done", finished_at: "2026-10-19T19:13:21.400Z" }] },
  monitoring: { ...at.monitoring, health: { service_restarts: { today: 1, last_7_days: 3, last_7_days_by_service: { market_runtime: 2, provider_futu: 1 } } } } });
  const rescueTiles = Object.fromEntries(restarts.nodes.health.groups[1][1].map((t) => [t.k, t]));
  assert.equal(rescueTiles["自動重啟服務（今日 · 7 日）"].v, "1 · 3 次");
  assert.equal(rescueTiles["自動重啟服務（今日 · 7 日）"].sub, "7 日：Market Runtime 2、Futu Provider 1");
  assert.equal(rescueTiles["自動重啟服務（今日 · 7 日）"].tone, "warn");
  assert.equal(rescueTiles["上次開 App 到畫面可用"].v, "24.4 秒");
  const stillStarting = buildDiagnosticsModel({ ...at, startup: { startup_started_at: "2026-10-19T19:12:57.000Z",
    steps: [{ id: "first_paint", status: "running", finished_at: null }] } });
  assert.equal(stillStarting.nodes.health.groups[1][1][1].v, null, "not shown before the first screen is in");
});

// 行情來源 / 資料處理 / 畫面渲染 / 服務端點 are picked as a whole lane (user 10-16, 10-19, 10-22): their nodes are no
// buttons of their own, and the lane's detail holds every node of it, each as one line (name, state) over its tiles.
// Health stays a detail of its own. 畫面渲染 has no 前端接收 node: view subscriptions and sequences are not tiles.
test("行情來源 / 資料處理 / 畫面渲染 / 服務端點 are picked as a whole lane (user 10-16, 10-19, 10-22)", () => {
  const model = buildDiagnosticsModel(input());
  assert.ok(!("receive" in model.nodes), "no 前端接收 node");
  assert.ok(!__test.EDGES.some((e) => e.from === "receive" || e.to === "receive"));
  const html = renderDiagnostics(model, "sources");
  for (const id of ["shioaji", "futu", "market", "wal", "analysis", "ws", "paint", "realtime", "app"]) {
    assert.doesNotMatch(html, new RegExp(`data-dg-node="${id}"`), `${id} is picked with its lane`);
  }
  for (const id of ["sources", "rust", "screen", "api", "health"]) {
    assert.match(html, new RegExp(`data-dg-node="${id}"[^>]*role="button"`), `${id} is a button`);
  }
  // Every pickable detail lies in the card, one over another; only the picked one is .current, the rest hidden.
  const stack = renderAllDetails(model, "sources");
  const paneIds = [...stack.matchAll(/class="dg-pane[^"]*" data-morph-key="pane:([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...paneIds].sort(), ["api", "health", "rust", "screen", "sources"]);
  // 行情來源 (user 10-22): each source and its provider are one node -- no separate 外部來源 / Provider lanes or nodes.
  assert.ok(!("broker" in model.nodes) && !("opend" in model.nodes) && !("providers" in __test.LANES));
  assert.ok(!html.includes("外部來源") && !html.includes(">Provider<"), "no 外部來源 / Provider lane titles");
  assert.equal((stack.match(/class="dg-pane current"/g) || []).length, 1, "one detail shows");
  assert.equal((stack.match(/aria-hidden="true" inert>/g) || []).length, paneIds.length - 1, "the others are hidden and inert");
  const inspector = (pick) => {
    const h = renderDiagnostics(model, pick);
    const start = h.indexOf('class="dg-pane current"');
    const next = h.indexOf('<div class="dg-pane', start);
    return h.slice(start, next < 0 ? h.indexOf("</aside>", start) : next);
  };
  const sources = inspector("sources");
  assert.match(sources, /<h3>行情來源<\/h3>/);
  assert.ok(sources.includes("<h4>Shioaji</h4>") && sources.includes("<h4>Futu</h4>"), "both sources in one detail");
  // One rule for a lane's detail and a node's own: every group under its caption (user 10-19).
  assert.equal((sources.match(/<div class="dg-groups"><div class="dg-tiles">/g) || []).length, 2, "行情來源: each source's groups in the same spaced stack");
  assert.equal((sources.match(/data-moomoo-reconnect/g) || []).length, 1, "Futu not connected: one reconnect button");
  // Connected, the button is not offered (user 10-19).
  const connectedModel = buildDiagnosticsModel({ ...input(), moomoo: { ok: true, readiness: { connected: true } } });
  assert.ok(!renderDiagnostics(connectedModel, "sources").includes("data-moomoo-reconnect"), "no button while connected");
  for (const old of ["opend", "broker", "providers"]) assert.equal(inspector(old), sources, `an older selection (${old}) opens 行情來源`);
  assert.equal(inspector("nothing"), sources, "nothing picked: 行情來源");
  const screen = inspector("screen");
  for (const title of ["WebSocket 連線", "畫面繪製"]) assert.ok(screen.includes(`<h4>${title}</h4>`), title);
  assert.ok(!screen.includes("資料套用") && !renderDiagnostics(model, "screen").includes("資料套用"), "no 資料套用 (user 10-19)");
  for (const gone of ["前端接收", "訂閱中的視圖", "接收序號", "上次 frame"]) assert.ok(!screen.includes(gone), `${gone} is gone`);
  const rust = inspector("rust");
  assert.match(rust, /<h3>資料處理<\/h3>/);
  for (const title of ["Market Runtime", "Analysis Runtime"]) assert.ok(rust.includes(`<h4>${title}</h4>`), title);
  assert.ok(!rust.includes("<h4>WAL</h4>"), "WAL has no section: its numbers are Market Runtime's (user 10-22)");
  assert.equal(inspector("wal"), rust, "an older node selection opens its lane");
  const apis = inspector("api");
  assert.ok(apis.includes("<h3>服務端點</h3>") && apis.includes("<h4>Realtime API</h4>") && apis.includes("<h4>App API</h4>"));
  assert.match(renderDiagnostics(model, "wal"), /class="dg-lane-pick selected" data-morph-key="lane:rust"/);
  assert.match(renderDiagnostics(model, "screen"), /class="dg-lane-pick selected" data-morph-key="lane:screen"/);
  assert.match(inspector("health"), /<h3>Health<\/h3>/);
});

// The view model is data in, data out: it imports the topology, the number formats and the snapshot adapter only,
// never a renderer, so it is built and tested without any markup.
test("buildDiagnosticsModel depends on data modules only", () => {
  const model = readFileSync(url("../ui/renderer/js/core/diagnostics_model.js"), "utf8");
  const imported = [...model.matchAll(/from "\.\/([\w.]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imported, ["diagnostics_format.js", "diagnostics_snapshot.js", "diagnostics_topology.js"]);
  assert.doesNotMatch(model, /escapeHtml|<div|<svg/, "no markup in the model");
});

// 延遲's bar holds only the stages that have a sample, each its share of their total: a stage without one is no
// block (it would read as a real share of the delay), all missing is no bar, and an effective zero takes no share.
test("延遲's bar draws only stages with a sample", async () => {
  const { latencyCardHtml } = await import("../ui/renderer/js/core/diagnostics_cards.js");
  const row = (stages) => latencyCardHtml({ rows: [{ id: "x", name: "X", all: { p50: 1000, p99: 2000 }, stages }] });
  const blocks = (html) => [...html.matchAll(/<i class="dg-part-(\d)" style="width:([\d.]+)%"><\/i>/g)].map(([, part, width]) => [Number(part), Number(width)]);
  const partial = blocks(row([{ label: "交易所", part: 1, p50: 300 }, { label: "傳遞", part: 2, missing: "沒有樣本" }, { label: "繪製", part: 3, p50: 100 }]));
  assert.deepEqual(partial, [[1, 75], [3, 25]], "the missing stage has no block; the others share 100%");
  assert.deepEqual(blocks(row([{ label: "交易所", part: 1, missing: "未回報" }, { label: "傳遞", part: 2, missing: "沒有樣本" }])), [], "all missing: no bar");
  const zero = blocks(row([{ label: "交易所", part: 1, p50: 500 }, { label: "傳遞", part: 2, p50: 0 }]));
  assert.deepEqual(zero, [[1, 100]], "an effective zero takes no share and is not drawn as a sliver");
  assert.match(row([{ label: "傳遞", part: 2, p50: 0 }, { label: "繪製", part: 3, missing: "沒有樣本" }]), /傳遞 0 µs<\/span>.*繪製 沒有樣本/s, "the legend still says 0 and 沒有樣本 apart");
});

// The CPU / 記憶體 lines keep a missing sample as a gap: the line is cut there, never drawn straight across it.
test("The CPU / 記憶體 trend lines are cut where a sample is missing", async () => {
  const { cpuCardHtml } = await import("../ui/renderer/js/core/diagnostics_cards.js");
  const line = (values) => cpuCardHtml({ trend: { points: values.map((v, i) => ({ t: i * 10, v })), from: 0, to: (values.length - 1) * 10 }, ring: { parts: [], total: 0 } }).match(/<path class="dg-spark-line" d="([^"]*)"/)?.[1] ?? null;
  const moves = (d) => (d.match(/M/g) || []).length;
  assert.equal(moves(line([10, 20, 30, 40])), 1, "no gap: one run");
  const gapped = line([10, 20, null, null, 30, 40]);
  assert.equal(moves(gapped), 2, `a gap cuts the line in two: ${gapped}`);
  assert.ok(!/L64\.0/.test(gapped) && !/L96\.0/.test(gapped), "nothing is drawn at the missing samples' places");
  const lone = line([10, null, 20, null, 30, 40]);
  assert.equal(moves(lone), 3, `a lone sample between gaps is its own short dash: ${lone}`);
  assert.equal(line([null, 10, null]), null, "fewer than two samples: no line");
});

// One word per kind of node (user 10-27): processes 運作中 (Health too), connections 已連線 whether or not data just
// arrived (no 行情更新中 / 持續接收), and every unknown 狀態未知.
test("the topology's states use one word per kind of node (user 10-27)", () => {
  const model = (fields) => buildDiagnosticsModel({ now: NOW, monitoringReceivedAt: NOW, external: { healthy: true }, transport: { connected: true },
    monitoring: { sampled_at: new Date(NOW).toISOString(), services: [{ service_id: "provider_shioaji", state: "RUNNING" }, { service_id: "market_runtime", state: "RUNNING" }] }, ...fields });
  const m = model({ paint: null });
  assert.equal(m.nodes.health.state, "運作中");
  assert.equal(m.nodes.market.state, "運作中");
  assert.equal(m.nodes.ws.state, "已連線");
  assert.equal(m.nodes.shioaji.state, "狀態未知", "running, its connection not reported");
  assert.equal(m.nodes.paint.state, "狀態未知", "not measured");
  assert.equal(model({ paint: { fps: null, visible: true, idle: false } }).nodes.paint.state, "狀態未知", "visible and busy without frames");
  assert.equal(model({ paint: { fps: null, visible: true, idle: true } }).nodes.paint.state, "閒置");
  const html = renderDiagnostics(m, "health");
  for (const old of ["行情更新中", "持續接收", "連線狀態未知", "未量測", "沒有畫格", "完整 · 無積壓"]) assert.ok(!html.includes(old), `no ${old}`);
});

