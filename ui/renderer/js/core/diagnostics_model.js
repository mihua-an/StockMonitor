// buildDiagnosticsModel(): pure data in, the panel's nodes, links, tiles and card figures out (see
// diagnostics_panel.js for the rules it keeps). It reads only the snapshot adapter and the topology.

import { LAT, T, ageText, amount, bytesText, clockText, durationText, fmtInt, latencyText, msText, num, rateText, toMs } from "./diagnostics_format.js";
import { SERVICE_TITLE, STATE_TEXT, apiFigures, docOf, serviceOf, toneOfState } from "./diagnostics_snapshot.js";
import { ASK, FLOW_FRESH_MS, HEALTH_STALE_MS, LAYOUT, MATERIALIZATION_STALE_MS, PAINT_SLOW_FPS, RATE_COUNTER, RATE_GAP_MS, RATE_POINTS, SERVICE_OF } from "./diagnostics_topology.js";

function restartTile(m) {
  if (!m) return T("自動重啟服務", null);
  const today = num(m.today) || 0, week = num(m.last_7_days) || 0;
  const byService = Object.entries(m.last_7_days_by_service || {}).filter(([, n]) => num(n))
    .map(([sid, n]) => `${SERVICE_TITLE[sid] || sid} ${fmtInt(n)}`);
  return T("自動重啟服務（今日 · 7 日）", `${fmtInt(today)} · ${fmtInt(week)} 次`,
    { wide: true, tone: today ? "warn" : undefined, sub: byService.length ? `7 日：${byService.join("、")}` : undefined });
}

// How long the App took from its start to the 即時報價 page's first screen (Electron main's startup coordinator:
// startup_started_at to the first_paint step's end) -- what a user waits for when opening it.
function startupTile(startup) {
  const began = toMs(startup?.startup_started_at);
  const shown = toMs((startup?.steps || []).find((step) => step.id === "first_paint" && step.status === "done")?.finished_at);
  const ms = began === null || shown === null ? null : shown - began;
  return T("上次開 App 到畫面可用", ms === null ? null : `${(ms / 1000).toFixed(1)} 秒`, { wide: true });
}

// How long a provider has held its source (user 10-14). Connected or not is the node's own badge and state on the
// map; disconnected says so rather than leaving the detail empty.
const uptimeTile = (connected, since, uptimeOf) => T("連線時長",
  connected === true ? uptimeOf(since) : connected === false ? "未連線" : null, { tone: connected === false ? "fail" : undefined });

// Shioaji 訂閱數 (user 10-19): the subscriptions held of the limit of every 永豐行情連線 together (the provider's
// lightweight status). 連線數 is not shown (user 10-22).
function shioajiQuotaTile(broker) {
  const held = num(broker?.active_subscription_count), limit = num(broker?.subscription_limit);
  return T("訂閱數", held === null || limit === null ? null : `${held}／${limit}`, { tone: held !== null && limit !== null && held >= limit ? "warn" : undefined });
}

// Futu 訂閱數: what OpenD holds for this connection of the quota it may hold, both in OpenD's unit -- every type of
// every symbol is one (service.py status(): subscription_quota); unknown until OpenD's quota is read.
function futuQuotaTile(moomoo) {
  const quota = moomoo?.subscription_quota;
  const held = quota?.known ? num(quota.held) : null;
  const limit = quota?.known ? num(quota.streams) : null;
  return T("訂閱數", held === null || limit === null ? null : `${held}／${limit}`, { tone: held !== null && limit !== null && held >= limit ? "warn" : undefined });
}

// The provider's queue of events to Market Runtime (its live_ingress in Health's snapshot, the same for both providers)
// is not a tile (user 10-19): full, the provider drops what arrives (rust_live.py), and the node says 轉送塞車.
function queueJammed(probe) {
  const ingress = probe?.live_ingress;
  return num(ingress?.queue_depth) !== null && num(ingress?.capacity) > 0 && num(ingress.queue_depth) >= num(ingress.capacity);
}

// 行情來源 (user 10-22): each source and its provider are one node. Its state is the first thing wrong along the way
// -- the provider's process, then its source (the broker session; OpenD, as Health's TCP knock finds it), then its
// queue to Market Runtime -- and otherwise whether quotes are arriving. A provider switched off
// has nothing coming: no connection tiles to wait on. A reconnect is a 補救事件 (provider.broker_session_reconnect),
// not a tile; 上次推送 is not a tile either (user 10-19). Quotes arriving are the node's events per second and its
// moving link, not a state of their own (user 10-27): connected is 已連線 either way.
function sourceNodes({ snap, uptimeOf, shioajiProbe, futuProbe, moomoo, shConnected, svcNode, put }) {
  const sh = svcNode("shioaji");
  const shOff = sh.tone === "off";
  const shState = sh.tone !== "ok" ? [sh.tone, sh.state]
    : shConnected === false ? ["fail", "券商未連線"]
      : queueJammed(shioajiProbe) ? ["warn", "轉送塞車"]
        : shConnected === true ? ["ok", "已連線"] : ["unknown", "狀態未知"];
  put("shioaji", {
    ...sh, tone: shState[0], state: shState[1],
    // 連線時長 and 訂閱數, as Futu's (user 10-22: the two sources alike). Events per second are on the node itself.
    groups: shOff ? [] : [["連線", [uptimeTile(shConnected, shioajiProbe?.last_login_at, uptimeOf), shioajiQuotaTile(shioajiProbe?.shioaji)]]],
  });
  const fu = svcNode("futu");
  const fuOff = fu.tone === "off";
  const opendSvc = serviceOf(snap, "external_futu_opend");
  const opendReach = opendSvc?.state_reason === "reachable" ? true : opendSvc?.state_reason === "unreachable" ? false : null;
  const futuConnected = Boolean(moomoo?.readiness?.connected);
  const fuState = fu.tone !== "ok" ? [fu.tone, fu.state]
    : opendReach === false ? ["fail", "OpenD 無法連線"]
      : queueJammed(futuProbe) ? ["warn", "轉送塞車"]
        : !futuConnected ? ["warn", "服務在，沒行情"] : ["ok", "已連線"];
  put("futu", {
    ...fu, tone: fuState[0], state: fuState[1],
    // 連線時長 and 訂閱數, as Shioaji's (user 10-22). No 端點 tile on any node (user 10-14).
    groups: fuOff ? [] : [["連線", [uptimeTile(moomoo ? futuConnected : null, moomoo?.last_connected_at, uptimeOf), futuQuotaTile(moomoo)]]],
    // 重新檢查 Futu 連線 is offered only while Futu is not connected (user 10-19).
    action: futuConnected ? null : "futu-reconnect",
  });
}

// Rust A, its WAL and Rust B.
function runtimeNodes({ now, snap, rates, runtime, analysis, svcNode, put }) {
  const ma = svcNode("market");
  const rejected = runtime?.ingest ? ["rejected_validation", "rejected_wal_full", "rejected_wal_failed", "rejected_forbidden", "rejected_draining", "rejected_parse"]
    .reduce((sum, k) => sum + (num(runtime.ingest[k]) || 0), 0) : null;
  const wal = runtime?.wal || null;
  const walFailed = Boolean(wal?.failed);
  // WAL's 待合併 and 下次合併 are Market Runtime's second row (user 10-22): the WAL lives in it, and its state is on its
  // chip in the node -- one heading fewer keeps the Rust detail as low as the topology beside it.
  // 待落盤佇列 / 已落盤序號 (user 10-19), 寫入耗時 and Checkpoint (user 10-14) are the developer's: Health's monitoring
  // snapshot carries them. 待合併 and 下次合併 one cell each (user 10-22: two tiles a row at most).
  const space = walSpace(wal?.disk, snap?.health?.materializer_jobs?.materialization, now).map((t) => ({ ...t, k: `WAL ${t.k}` }));
  // 自啟動後累積接收 and the programs connected to it are the developer's (Health's monitoring snapshot), as are 盤中事件
  // beyond A's per-symbol cap (projection.events_evicted).
  put("market", {
    ...ma,
    groups: [["處理", [T("每秒處理", rateText(rates.market)), T("拒收", amount(rejected), { tone: rejected ? "warn" : undefined })]],
      ...(space.length ? [["WAL", space]] : [])],
  });
  put("wal", {
    tone: !runtime ? "unknown" : walFailed ? "fail" : wal?.integrity_complete === false ? "warn" : "ok",
    state: !runtime ? "狀態未知" : walFailed ? "寫入失敗" : num(wal?.queue_depth) ? "寫入中" : "無積壓",
  });
  const an = svcNode("analysis");
  const refused = num(analysis?.publish?.acks_rejected);
  // 每秒處理 and 被拒 (user 10-22: no 模型訊號 count). 落後 Rust A, 發布筆數
  // and 特徵熱身 are the developer's; the acks still move the Rust B -> Rust A link.
  put("analysis", {
    ...an,
    groups: [["處理", [T("每秒處理", rateText(rates.analysis)), T("被拒", fmtInt(refused), { tone: refused ? "warn" : undefined })]]],
  });
}

// The renderer chain (this window's own state): the connection and drawing what arrived. Applying it (the views, their
// sequences and refusals) is the developer's, not a node (user 10-16, 10-19): a selected stock whose quotes stopped
// updating is the dock's 資料未同步 (input.freshness, status.js) -- said on this node too -- and a [realtime freshness]
// record. When a component last redrew is the WebSocket -> 畫面繪製 link moving. Data arriving is the link's moving
// dots, not a state of its own (user 10-27): connected is 已連線 either way, as the 行情來源 nodes.
function rendererNodes({ transport, put, input, uptimeOf }) {
  const wsConnected = transport ? Boolean(transport.connected) : null;
  const notSynced = wsConnected === true && input.freshness === "stale";
  put("ws", {
    tone: wsConnected === null ? "unknown" : !wsConnected ? "fail" : notSynced ? "warn" : "ok",
    state: wsConnected === null ? "狀態未知" : !wsConnected ? "未連線" : notSynced ? "已連線 · 資料未同步" : "已連線",
    // 連線狀態 is the node's own badge on the map (user 10-14). The user reads only how long this connection has held
    // and how often this window lost it (user 10-19).
    groups: [["連線", [
      uptimeTile(wsConnected, transport?.connected_at, uptimeOf),
      T("斷線次數", transport ? fmtInt(transport.disconnect_count || 0) : null, { tone: num(transport?.disconnect_count) ? "warn" : undefined })]]],
  });
  const paint = input.paint || null;
  const fps = num(paint?.fps);
  put("paint", {
    // Frames are measured only while market components update (renderer_runtime_health): a window with no update
    // is idle, not a missing measurement. Idle is said in one word (user 10-22: 近 2 秒無畫面更新 was too long). Not
    // measured, or visible and busy without frames, is 狀態未知 like every node's unknown (user 10-27).
    tone: !paint ? "unknown" : fps === null ? (paint.visible === false ? "off" : paint.idle ? "ok" : "unknown") : fps < PAINT_SLOW_FPS ? "warn" : "ok",
    state: !paint ? "狀態未知" : fps === null ? (paint.visible === false ? "視窗隱藏中" : paint.idle ? "閒置" : "狀態未知") : fps < PAINT_SLOW_FPS ? "畫面卡頓" : "正常",
    groups: [
      // Idle and hidden windows draw no frames: that is the value, not one still to come.
      ["繪製", [T("每秒幀數", fps !== null ? `${Math.round(fps)} fps` : paint?.visible === false ? "視窗隱藏中" : paint?.idle ? "閒置" : null,
        { tone: fps !== null && fps < PAINT_SLOW_FPS ? "warn" : undefined }),
        // Frames more than 34 ms apart in the last 2 s window (renderer_runtime_health); back on the node (user 10-20).
        T("慢幀（近 2 秒）", paint ? fmtInt(paint.slow_frames ?? 0) : null, { tone: num(paint?.slow_frames) ? "warn" : undefined }),
      ]],
      ...(fps === null ? [] : [LAT("幀間隔", msText(paint.frame_interval_p50_ms), msText(paint.frame_interval_p95_ms), msText(paint.frame_interval_p99_ms))]),
    ],
  });
}

// Business APIs.
function apiNodes({ snap, svcNode, put }) {
  for (const id of ["app", "realtime"]) {
    const base = svcNode(id);
    const figures = apiFigures(docOf(snap, SERVICE_OF[id]));
    put(id, {
      ...base,
      groups: [
        // 回應時間 alone, without the route it was measured on (user 10-22). 累計請求 and 伺服器錯誤 / 操作失敗 are the
        // developer's (user 10-19).
        ...(figures.latency ? [LAT("回應時間",
          latencyText(figures.latency.p50), latencyText(figures.latency.p95), latencyText(figures.latency.p99))] : []),
      ],
    });
  }
}

// Links: animate only on evidence that data moved.
function flowLinks({ lastPaint, advanced, fresh }) {
  const flows = new Set();
  // A provider -> Rust A link moves only when THAT provider's sends were acknowledged. A's intake total is fed by
  // every source, so it is never borrowed: no count of its own, no animation.
  if (advanced("shAcked")) flows.add("shioaji>market");
  if (advanced("fuAcked")) flows.add("futu>market");
  if (advanced("committed")) flows.add("market>wal");
  if (advanced("cursor")) flows.add("market>analysis");
  if (advanced("acks")) flows.add("analysis>market");
  // Model signals have their own counter (Rust B's accepted results), never borrowed from the projection acks.
  if (advanced("signals")) flows.add("analysis>market:signals");
  // market>ws moves on market data reaching this window, not on any frame -- heartbeats are frames.
  if (advanced("received")) flows.add("market>ws");
  // market_render_trace samples are taken when a component re-rendered on market data: that is the link's own evidence.
  if (fresh(lastPaint)) flows.add("ws>paint");
  return flows;
}

export function buildDiagnosticsModel(input = {}, previous = null) {
  const now = input.now ?? Date.now();
  const snap = input.monitoring || null;
  const uptimeOf = (startedAt) => durationText(toMs(startedAt) === null ? null : now - toMs(startedAt));

  const shioajiProbe = docOf(snap, "provider_shioaji")?.payload || null;
  const futuProbe = docOf(snap, "provider_futu")?.payload || null;
  const runtime = docOf(snap, "market_runtime");
  // Per source (Rust A latency.by_source): 交易所延遲 (exchange -> provider), 資料傳遞延遲 (provider -> Rust A),
  // 畫面繪製延遲 (Rust A -> paint) and 整體延遲 (exchange -> paint), each p50 / P95 / P99 over the last minute.
  const bySource = runtime?.latency?.by_source || {};
  const analysis = docOf(snap, "analysis_runtime");
  const moomoo = input.moomoo?.ok ? input.moomoo : null;
  const transport = input.transport || null;
  const lastPaint = toMs(input.paint?.last_update_at);
  const views = Array.isArray(input.views?.subscriptions) ? input.views.subscriptions : [];
  const view = views.find((v) => ["STALE", "RESYNC_REQUIRED", "RESYNCING", "ERROR"].includes(String(v?.view_state || v?.status || ""))) || views[0] || null;

  // Counters compared with the previous poll: a link "flows" only if its counter advanced.
  const counters = {
    committed: num(runtime?.wal?.committed),
    cursor: num(analysis?.stream?.cursor), acks: num(analysis?.publish?.acks_ok), signals: num(analysis?.signals?.counts?.accepted),
    received: num(view?.last_received_sequence),
    // Each provider's own Market Runtime acknowledgements, from Health's probe of it (daemon health live_ingress.acked)
    // and nowhere else: a probe without the count is a poll with no sample, never a count read from another source
    // at another moment (the rate between the two would jump).
    shAcked: num(shioajiProbe?.live_ingress?.acked), fuAcked: num(futuProbe?.live_ingress?.acked),
  };
  const advanced = (key) => previous?.counters && counters[key] !== null && previous.counters[key] !== null && counters[key] > previous.counters[key];
  const fresh = (stamp) => { const t = toMs(stamp); return t !== null && now - t <= FLOW_FRESH_MS; };
  // Events per second since the previous poll. A counter that went back (its process restarted) has no rate; a poll
  // long after the previous one (the panel was closed) starts the line anew rather than averaging the time it was shut.
  const gap = previous ? now - previous.now : null;
  const series = Object.fromEntries(Object.entries(RATE_COUNTER).map(([node, key]) => {
    const was = previous?.counters?.[key];
    const rate = gap > 0 && gap <= RATE_GAP_MS && counters[key] !== null && num(was) !== null && counters[key] >= was
      ? (counters[key] - was) / (gap / 1000) : null;
    const before = gap !== null && gap <= RATE_GAP_MS ? previous.rates?.[node]?.values || [] : [];
    return [node, { values: [...before, rate].slice(-RATE_POINTS), latest: rate }];
  }));
  const rates = Object.fromEntries(Object.entries(series).map(([node, s]) => [node, s.latest]));

  // The broker session as Health's probe of the persistent provider found it (daemon health shioaji_connected). Not
  // in this snapshot: unknown -- never /api/status, read at another moment, which could contradict it.
  const shConnected = typeof shioajiProbe?.shioaji_connected === "boolean" ? shioajiProbe.shioaji_connected : null;

  const svcNode = (id) => {
    const svc = serviceOf(snap, SERVICE_OF[id]);
    const state = String(svc?.state || "UNKNOWN").toUpperCase();
    // collector.js describe(): DISABLED / "no host registered" are answered without a probe.
    const probed = Boolean(svc) && state !== "DISABLED" && svc.state_reason !== "no host registered";
    return { tone: toneOfState(state), state: STATE_TEXT[state] || "狀態未知", probed };
  };
  const nodes = {};
  const put = (id, fields) => { nodes[id] = { id, ...LAYOUT[id], ask: ASK[id] || null, ...fields }; };

  const c = { now, snap, uptimeOf, rates, shioajiProbe, futuProbe, runtime, bySource, analysis, moomoo, transport, lastPaint, views, view, counters, advanced, fresh, shConnected, svcNode, nodes, put, input, previous };
  sourceNodes(c);
  runtimeNodes(c);
  rendererNodes(c);
  apiNodes(c);
  const flows = flowLinks(c);
  const sampledAt = toMs(snap?.sampled_at);
  // Fresh is judged when the snapshot ARRIVED, not after every other source answered: a slow API must not make a
  // healthy Health read "沒有回應".
  const receivedAt = num(input.monitoringReceivedAt) ?? now;
  const healthOk = Boolean(input.external?.healthy) && sampledAt !== null && receivedAt - sampledAt <= HEALTH_STALE_MS;
  put("health", {
    // 運作中 alone, as every process node (user 10-22: 每 2 秒確認一次 removed; 10-27: one word per kind of node).
    tone: healthOk ? "ok" : "fail", state: healthOk ? "運作中" : "沒有回應",
    // 已運作: how long this Health has run (its started_at, user 10-19). Its CPU and 記憶體 are the cards' (user 10-22).
    groups: [["監控", [T("上次確認", sampledAt === null ? null : ageText(now - sampledAt), { tone: healthOk ? undefined : "fail" }),
      T("狀態", healthOk ? "運作中" : "沒有回應", { tone: healthOk ? "ok" : "fail", sub: healthOk ? undefined : "其他節點的狀態可能已過時" }),
      T("已運作", uptimeOf(snap?.health?.started_at))]],
      ["救援", [restartTile(snap?.health?.service_restarts), startupTile(input.startup)]]],
  });
  return {
    now, nodes, flows, counters, healthOk, healthSampledAt: sampledAt,
    heartbeat: healthOk && sampledAt !== previous?.healthSampledAt,   // a new Health pass happened since the last draw
    rates: series,
    system: processModel(snap?.system, "cpu_percent", "cpu", input.trend, now),
    memory: processModel(snap?.system, "bytes", "mem", input.trend, now),
    latency: latencyModel(runtime?.latency),
    storage: storageModel(snap?.storage, now),
  };
}

// ---------- the four cards on top (user 10-20, 10-22)

const TREND_SPAN_MS = 120_000;

// 系統 CPU and 記憶體 (Health's snapshot.system, one part per process, user 10-22): every StockMonitor process in fixed
// groups and colours, named as the topology's lanes (user 10-27) -- 行情來源 (the providers), 資料處理 (Rust), 畫面渲染
// (Electron), 系統狀態 (Health), 服務端點 (the APIs), and 訓練 / 收盤整理 (the materializer) only while those jobs run. Each
// group keeps its colour (part) whatever its place in the list.
// A process of no group is not drawn; the ring's total is what the groups hold.
// CPU is a share of the whole computer (100% = every core busy, as Task Manager counts it; the core count is not shown,
// user 10-20). The last 2 minutes of each total, from Health's trend, are the line in the card's title row.
const PROCESS_GROUPS = [
  ["providers", "行情來源", ["provider_shioaji", "provider_futu"], 1],
  ["rust", "資料處理", ["market_runtime", "analysis_runtime"], 2],
  ["screen", "畫面渲染", ["app"], 3],
  ["health", "系統狀態", ["service_controller"], 5],
  ["api", "服務端點", ["realtime_api", "app_api"], 4],
  ["training", "訓練", ["training"], 6],
  ["materializer", "收盤整理", ["materializer"], 7],
];

// The trend's points keep their time: Health samples every 10 s while no page is open and every pass while one is, so
// the line is placed by time over the span, not one step per point.
function processModel(system, field, trendKey, samples, now) {
  const points = (Array.isArray(samples) ? samples : []).filter((p) => num(p?.t) !== null && now - p.t <= TREND_SPAN_MS)
    .map((p) => ({ t: p.t, v: num(p?.system?.[trendKey]) }));
  const trend = { points, from: now - TREND_SPAN_MS, to: now };
  if (system?.availability !== "OK") return { ring: null, trend };
  const procs = system.parts || [];
  const parts = PROCESS_GROUPS.map(([id, label, members, part]) => {
    const mine = procs.filter((p) => members.includes(p.id));
    return mine.length ? { id, label, value: mine.reduce((sum, p) => sum + (num(p[field]) ?? 0), 0), part } : null;
  }).filter(Boolean);
  return { ring: { total: parts.reduce((sum, p) => sum + p.value, 0), parts }, trend };
}

// 延遲 per source (Rust A latency.by_source, the last minute): 整體 (exchange -> paint) with its P99, and the three
// stages it is made of. A stage Rust A does not report at all (an older Rust A) is 未回報; a reported stage nothing
// passed through is 沒有樣本 -- never 0.
const LATENCY_SOURCES = [["shioaji", "Shioaji"], ["futu", "Futu"]];

const LATENCY_STAGES = [["exchange_to_backend", "交易所", 1], ["backend_to_a", "傳遞", 2], ["a_to_ui_paint", "繪製", 4]];

// 整體延遲 above this reads in orange (the decided page, user 10-20).
export const LATENCY_WARN_US = 1_200_000;

function latencyModel(latency) {
  const bySource = latency?.by_source || {};
  const stat = (s) => (!s ? { missing: "未回報" } : s.availability === "OK" ? { p50: num(s.p50), p95: num(s.p95), p99: num(s.p99) } : { missing: "沒有樣本" });
  const rows = LATENCY_SOURCES.map(([id, name]) => ({
    id, name, all: stat(bySource?.[id]?.exchange_to_ui_paint),
    stages: LATENCY_STAGES.map(([key, label, part]) => ({ key, label, part, ...stat(bySource?.[id]?.[key]) })),
  }));
  return { rows };
}

// 儲存空間 (Health's storage walk, once a minute): the parts in the order Health gives them, and the disk of the storage
// location (user 10-28: where the growing history is, the disk that can run out) with its size and what is left.
const STORAGE_PART = { historical: 1, events: 2, model: 3, wal: 4, analysis: 5, market: 6, other: 7 };

// The storage move under way (設定 → 資料儲存, user 11-09): how far, for how long, and the room left where it goes.
const MOVE_STATE = { scanning: "掃描中", copying: "複製中", verifying: "驗證中", synced: "已複製，下次完整重開切換", moving: "搬移中", switching: "切換中" };

function storageMoveModel(move, now) {
  if (!move) return null;
  const total = num(move.bytes_total), done = num(move.bytes_done), started = toMs(move.started_at);
  return { to: String(move.to || ""), state: MOVE_STATE[move.state] || String(move.state || ""), total, done,
    percent: total > 0 && done !== null ? Math.min(100, (done / total) * 100) : null,
    elapsedMs: started === null ? null : now - started,
    drive: String(move.target_root || "").replace(/[\\/]+$/, ""), targetFree: num(move.target_free_bytes) };
}

function storageModel(storage, now) {
  if (storage?.availability !== "OK") return null;
  return { total: num(storage.total_bytes),
    parts: (storage.parts || []).map((p) => ({ id: p.id, label: p.label, value: num(p.bytes), part: STORAGE_PART[p.id] || 7 })),
    drive: String(storage.disk?.root || "").replace(/[\\/]+$/, ""), free: num(storage.disk?.free_bytes), disk: num(storage.disk?.total_bytes),
    move: storageMoveModel(storage.move, now) };
}

// WAL 空間: A reports its segments (bytes, oldest/newest exchange time each); the session owners report from which
// exchange time nothing is materialized yet (wal_retention.py materialization_status, carried by Health). 待合併 is
// every segment that still holds an event at or after that time.
function walSpace(disk, owner, now) {
  if (!disk) return [];
  const evaluated = toMs(owner?.evaluated_at);
  const current = owner && evaluated !== null && now - evaluated <= MATERIALIZATION_STALE_MS ? owner : null;
  let pending = null;
  if (current && Array.isArray(disk.segment_ranges)) {
    const from = num(current.pending_from_ns);
    pending = from === null ? 0 : disk.segment_ranges.reduce((sum, [bytes, , newest]) => sum + (num(newest) !== null && newest >= from ? num(bytes) || 0 : 0), 0);
  }
  const pendingFrom = toMs(num(current?.pending_from_ns));
  const next = toMs(current?.next_materialization_at);
  // 磁碟用量, 最早資料 and 下次合併資料 are not shown (user 10-19).
  return [
    T("待合併", pending === null ? null : pending === 0 ? "無" : bytesText(pending),
      { tone: pending && pendingFrom !== null && now - pendingFrom > 86_400_000 ? "warn" : undefined }),
    // Only the time, no line naming the session (user 10-19).
    T("下次合併", !current ? null : nextMergeText(current.next_kind, next, now)),
  ];
}

// Waiting and running are different answers: a session past its seal time is still waiting for its owner.
function nextMergeText(kind, next, now) {
  if (kind === "running") return "執行中";
  if (kind === "queued") return "等待執行";
  if (next === null) return "沒有排定";
  if (kind === "retry") return `重試 ${clockText(next)}`;
  return next <= now ? "等待封存" : clockText(next);
}
