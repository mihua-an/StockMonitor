// 全站共用狀態與常數
//
// Business API addressing (docs/system-architecture/00): two API processes (realtime_api, app_api), each on its own
// effective address.
// Electron main hands every window its endpoint projection (service_id -> URL, from Health's effective config)
// and the path -> service_id route table (config/api_routes.json) through preload. apiUrl(path) picks the
// service by longest prefix. There is no hardcoded fallback address: a window without the projection cannot
// reach any API (fail closed) rather than silently talking to a guessed port.
const NETWORK = window.desktopAPI?.networkManifest || null;
const ROUTES = (NETWORK?.routes || []).map(([prefix, serviceId]) => [String(prefix), String(serviceId)])
  .sort((a, b) => b[0].length - a[0].length);

export function serviceForPath(path) {
  const clean = String(path || "").split("?")[0];
  for (const [prefix, serviceId] of ROUTES) {
    const base = prefix.replace(/\/$/, "");
    if (clean === base || clean.startsWith(`${base}/`)) return serviceId;
  }
  return null;
}

export function serviceUrl(serviceId) {
  const url = NETWORK?.services?.[serviceId]?.url;
  if (!url) throw new Error(`No effective address for ${serviceId}`);
  return url;
}

export function apiUrl(path) {
  const serviceId = serviceForPath(path);
  if (!serviceId) throw new Error(`No business API serves ${path}`);
  return `${serviceUrl(serviceId)}${path}`;
}

export const appState = {
  // code -> the analysis row (live_signals.js replaceSignalRows is its only writer).
  signalsByCode: new Map(),
  // There is no `missingCodes`: a persistent state for a summary readout
  // that exists in no markup; coverage is now computed on demand -- see
  // getRealtimeSignalCoverage() in features/realtime/live_signals.js.
  watchlistItems: [],
  autoRefreshTimer: null,
  currentPage: "realtime",

};
