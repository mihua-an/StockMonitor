// What the realtime feature reports about this window's views and transport, read by core diagnostics
// (status.js, renderer_runtime_health.js) without core importing the feature. The feature
// registers its readers once at load; before that every reader answers "no data".
//
// The view stats have one shape, StatsSnapshot: `client_subscription_count` (a count) and `subscriptions` (an array),
// with whatever else the store adds. Readers are functions, refused at register time otherwise; a snapshot that comes
// back in another shape is logged with what was wrong and read as its empty form, so one bad registration cannot make
// every diagnostics sample throw.
const EMPTY_VIEW_STATS = Object.freeze({ client_subscription_count: 0, subscriptions: Object.freeze([]) });
let readers = { viewStats: () => EMPTY_VIEW_STATS, focusState: () => null, transportHealth: () => ({}), session: () => null };

export function registerRealtimeStats(next) {
  for (const [name, reader] of Object.entries(next || {})) {
    if (!(name in readers)) throw new TypeError(`registerRealtimeStats: unknown reader ${name}`);
    if (typeof reader !== "function") throw new TypeError(`registerRealtimeStats: ${name} is not a function`);
  }
  readers = { ...readers, ...next };
}

let lastShapeProblem = "";
function viewStatsSnapshot(stats) {
  const problems = [];
  if (!stats || typeof stats !== "object") problems.push(`not an object (${stats === null ? "null" : typeof stats})`);
  else {
    if (!Number.isFinite(stats.client_subscription_count)) problems.push("client_subscription_count is not a number");
    if (!Array.isArray(stats.subscriptions)) problems.push("subscriptions is not an array");
  }
  if (!problems.length) return stats;
  const problem = problems.join("; ");
  // Logged once per distinct problem: the samplers read this every few seconds.
  if (problem !== lastShapeProblem) console.warn(`[realtime stats: view stats] wrong shape: ${problem}`);
  lastShapeProblem = problem;
  return {
    ...(stats && typeof stats === "object" ? stats : {}),
    client_subscription_count: Number.isFinite(stats?.client_subscription_count) ? stats.client_subscription_count : 0,
    subscriptions: Array.isArray(stats?.subscriptions) ? stats.subscriptions : [],
  };
}

export function getRealtimeViewStats() { return viewStatsSnapshot(readers.viewStats()); }
export function getRealtimeFocusState() { return readers.focusState(); }
export function getRealtimeTransportHealth() { return readers.transportHealth(); }
// Market Runtime's session.current for this window (null until it has arrived on a connection).
export function getRealtimeSession() { return readers.session(); }
