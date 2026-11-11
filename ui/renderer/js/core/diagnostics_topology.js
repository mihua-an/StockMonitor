// 系統拓樸 as data: the nodes' places and titles, the links, the lanes, how each node is asked, and the
// thresholds the model judges with. No logic.

export const FLOW_FRESH_MS = 5000;

export const HEALTH_STALE_MS = 8000;

// The session owner rewrites the materialization status every 60 s; older than this, its owner is gone.
export const MATERIALIZATION_STALE_MS = 5 * 60_000;

export const PAINT_SLOW_FPS = 20;

export const ICON = { ok: "✓", fail: "×", warn: "!", unknown: "?", off: "−" };

// Health asks these itself; the tag says how (health/services/*_host.js supervisorProbe).
export const ASK = { app: "HTTP 問", realtime: "HTTP 問", market: "HTTP 問", analysis: "自己回報", shioaji: "看狀態檔", futu: "看程序" };

export const SERVICE_OF = { app: "app_api", realtime: "realtime_api", market: "market_runtime", analysis: "analysis_runtime",
  shioaji: "provider_shioaji", futu: "provider_futu" };

// The compact grid (user 10-20): two rows 104 apart (y 52 / 156, nodes 58 tall) shared by every column, and every node
// 16 px inside its lane; under them the band of Health (under 行情來源) and the business APIs under the column each
// one serves: Realtime API under Rust (it writes the inference config Rust B reads), App API under the screen (it
// answers the screen's HTTP). WAL lives inside Rust A, so it is drawn inside the Market Runtime node.
// 行情來源 (user 10-22): each source and its provider are one node -- Shioaji (the broker session and the Shioaji
// provider), Futu (OpenD and the Futu provider) -- so the map has three columns; the columns share its width.
// The rows sit as close as their links' labels allow (user 10-20: the map fits the detail's height beside it).
// Market Runtime is as tall as every node (user 10-22): its WAL sits in its middle, between its title (寫入, a short
// arrow) and its badge and events per second on the right like every node's -- the Rust column is 50 wider for it, the
// 行情來源 column 30 and 畫面渲染 (no events-per-second line there) 30 narrower.
export const MAP_W = 1016, MAP_H = 336;

export const LAYOUT = {
  shioaji: { x: 24, y: 52, w: 218, title: "Shioaji", source: true },
  futu: { x: 24, y: 156, w: 218, title: "Futu", source: true },
  market: { x: 308, y: 52, w: 378, title: "Market Runtime" },
  // Drawn by the Market Runtime node, at this place inside it: as wide as its longest state (寫入失敗, 狀態未知, 12 px
  // each) with 8 px either side; its name and state are centred, so both sides keep the same room.
  wal: { x: 181, y: 7, w: 64, h: 44, title: "WAL", inner: true },
  analysis: { x: 308, y: 156, w: 378, title: "Analysis Runtime" },
  ws: { x: 752, y: 52, w: 240, title: "WebSocket 連線" },
  paint: { x: 752, y: 156, w: 240, title: "畫面繪製" },
  health: { x: 24, y: 261, w: 218, title: "Health" },
  realtime: { x: 308, y: 261, w: 378, title: "Realtime API" },
  app: { x: 752, y: 261, w: 240, title: "App API" },
};

// Every label sits beside its line, never on it, and no line runs into a node's 自己回報 / HTTP 問 tag.
export const EDGES = [
  { from: "shioaji", to: "market", d: "M242 81 H308", label: ["WS", 260, 73] },
  { from: "futu", to: "market", d: "M242 185 H275 V100 H308" },
  // Beside the title, into the WAL in the node's middle; its label right of the title.
  { from: "market", to: "wal", d: "M458 85 H489", label: ["寫入", 459, 76] },
  // The labels between the rows sit clear of Analysis Runtime's 自己回報 tag.
  { from: "market", to: "analysis", d: "M324 110 V156", label: ["持久化串流", 330, 141] },
  // Rust B validates its own inference results and publishes them to Rust A (native/analysis_runtime/src/signals.rs);
  // no FastAPI on the way.
  { from: "analysis", to: "market", key: "analysis>market:signals", d: "M448 156 V110", label: ["模型訊號", 454, 141] },
  { from: "analysis", to: "market", d: "M548 156 V110", label: ["分析結果", 554, 141] },
  { from: "market", to: "ws", d: "M686 81 H752", label: ["WS", 706, 73] },
  { from: "ws", to: "paint", d: "M872 110 V156", mid: [872, 133] },
  // The inference config is a file Realtime API writes and Rust B reads: B keeps the last one when FastAPI stops.
  { from: "realtime", to: "analysis", d: "M472 261 V214", label: ["推論設定檔", 480, 242], api: true },
  // One HTTP line: Realtime API leaves its right side, App API its left side, both join in the gap between the Rust
  // and screen lanes and go up into 畫面繪製's left side.
  { from: "realtime", to: "paint", d: "M686 290 H719 V185 H752", label: ["HTTP", 689, 282], api: true },
  { from: "app", to: "paint", d: "M752 290 H719", noArrow: true, api: true },
];

// 行情來源 and 畫面渲染 are picked as a whole lane: the detail shows every node of the lane together (user 10-16).
// A lane is named by its title alone: the line under each title explained the architecture, not anything to act on
// (user 10-19).
// 資料處理 (Market Runtime, its WAL, Analysis Runtime) and 服務端點 are picked the same way (user 10-19); only
// Health keeps a detail of its own.
export const LANES = {
  sources: { title: "行情來源", members: ["shioaji", "futu"], rect: [8, 34, 250, 198] },
  rust: { title: "資料處理", members: ["market", "wal", "analysis"], rect: [292, 34, 410, 198] },
  screen: { title: "畫面渲染", members: ["ws", "paint"], rect: [736, 34, 272, 198] },
  api: { title: "服務端點", members: ["realtime", "app"], rect: [292, 252, 716, 76] },
};

export const LANE_OF = Object.fromEntries(Object.entries(LANES).flatMap(([lane, { members }]) => members.map((id) => [id, lane])));

// Each process's CPU and 記憶體 are the 系統 CPU / 記憶體 cards' (user 10-22): a node shows how many events per second
// passed through it instead -- the counter it advances, compared between two polls -- with its last 2 minutes as a
// small line in the node's bottom-right corner. The APIs and Health move no events: no line.
export const RATE_COUNTER = { shioaji: "shAcked", futu: "fuAcked", market: "committed", analysis: "cursor" };

export const RATE_POINTS = 60;

export const RATE_GAP_MS = 10_000;

// ---------- small formatters
