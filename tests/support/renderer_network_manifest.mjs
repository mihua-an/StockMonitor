// The network projection Electron main hands a trusted window through preload
// (ui/main/desktop_application.js createRendererBootstrap, "runtime:get-bootstrap"). The renderer is fail-closed
// without it (ui/renderer/js/core/state.js apiUrl), so a contract that drives renderer
// API code must install one. Routes are the real table; addresses are fixed test ports.
import { readFileSync } from "node:fs";

const table = JSON.parse(readFileSync(new URL("../../config/api_routes.json", import.meta.url), "utf8"));
const PORTS = { realtime_api: 8000, app_api: 8001 };

export function rendererNetworkManifest() {
  const services = Object.fromEntries(Object.entries(PORTS)
    .map(([id, port]) => [id, { url: `http://127.0.0.1:${port}` }]));
  return { schema: "stock-monitor-renderer-network-v2", revision: 1, services,
    routes: table.routes.map((route) => [route.prefix, route.service_id]), apiBaseUrl: services.realtime_api.url };
}

// The market_runtime viewer connection (ui/main/desktop_application.js createRendererBootstrap, "runtime:get-bootstrap").
// Without it realtime.js stays offline by design and never opens a socket.
export function liveEngineConnection() {
  return { url: "ws://127.0.0.1:8010/live", revision: 1, expected: { service_id: "market_runtime", protocol: 2 } };
}
