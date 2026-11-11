// Reading Health's monitoring snapshot: one service's entry, its metrics document when it is current, and
// what its state means.

import { LAYOUT, SERVICE_OF } from "./diagnostics_topology.js";

// A service's own document from Health's monitoring snapshot.
export function serviceOf(snapshot, id) { return (snapshot?.services || []).find((s) => s.service_id === id) || null; }

export function docOf(snapshot, id) { const m = serviceOf(snapshot, id)?.metrics; return m && (m.availability === "OK" || m.availability === "STALE") ? m.document : null; }

export function toneOfState(state) {
  switch (String(state || "").toUpperCase()) {
    case "RUNNING": return "ok";
    case "STARTING": case "STOPPING": case "STALE": case "DEGRADED": return "warn";
    case "FAILED": return "fail";
    case "DISABLED": return "off";
    default: return "unknown";
  }
}

export const STATE_TEXT = { RUNNING: "運作中", STARTING: "啟動中", STOPPING: "停止中", STALE: "沒有回應", DEGRADED: "執行中但無法服務", FAILED: "已停止", DISABLED: "依設定停用" };

// Python service metrics are a flat list; latency is one histogram per route group -- the busiest one stands in.
export function apiFigures(doc) {
  const list = Array.isArray(doc?.metrics) ? doc.metrics : [];
  const latency = list.filter((m) => String(m.name).startsWith("http.latency") && m.availability === "OK")
    .sort((a, b) => (b.samples || 0) - (a.samples || 0))[0] || null;
  return { latency };
}

// ---------- the model

// Health starts a service again when it is gone: how often, today and over 7 days, and which services (user 10-19).
// Health's own summary of its remediation ledger (health/supervisor.js restartSummary).
// A provider restarts as a process of its own: its name keeps "Provider" though the map draws it with its source.
export const SERVICE_TITLE = { ...Object.fromEntries(Object.entries(SERVICE_OF).map(([node, sid]) => [sid, LAYOUT[node]?.title || sid])),
  provider_shioaji: "Shioaji Provider", provider_futu: "Futu Provider" };
