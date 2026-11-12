// How much CPU one 連線診斷 refresh costs in JavaScript (the model and the panel's markup), per 2 s refresh.
//   node scripts/qa/diagnostics_render_cost.mjs [--rounds 300]
// It does not measure the DOM diff or paint: those run in the renderer (morphInto) after this string is built.
import { buildDiagnosticsModel } from "../../ui/renderer/js/core/diagnostics_model.js";
import { renderDiagnostics } from "../../ui/renderer/js/core/diagnostics_panel.js";

const rounds = Number(process.argv[process.argv.indexOf("--rounds") + 1] || 300) || 300;
const GB = 1024 ** 3, MB = 1024 ** 2;
const parts = [["provider_futu", 1.0, 167], ["app", 5.0, 400], ["market_runtime", 1.5, 120], ["provider_shioaji", 0.5, 160],
  ["service_controller", 0.3, 70], ["realtime_api", 0.4, 60], ["app_api", 0.2, 90], ["analysis_runtime", 0.6, 40]];

function input(i) {
  const now = 1_800_000_000_000 + i * 2000;
  const system = { availability: "OK", cpu_percent: 5 + (i % 7), memory_bytes: 1200 * MB,
    parts: parts.map(([id, cpu, mb]) => ({ id, service_ids: [id], cpu_percent: cpu + (i % 3) * 0.1, bytes: (mb + (i % 5)) * MB })) };
  const services = parts.filter(([id]) => id !== "app").map(([id]) => ({ service_id: id, state: "RUNNING", pid: 1000 + id.length,
    resources: { availability: "OK", cpu_percent: 1, memory_bytes: 100 * MB }, metrics: { availability: "OK" } }));
  const monitoring = { sampled_at: new Date(now).toISOString(), services, system,
    storage: { availability: "OK", total_bytes: 3 * MB, disk: { root: "C:\\", total_bytes: 455 * GB, free_bytes: 169 * GB },
      parts: [{ id: "market", label: "行情", bytes: 2 * MB }, { id: "other", label: "其他", bytes: 1 * MB }] } };
  const trend = Array.from({ length: 60 }, (_, k) => ({ t: now - (60 - k) * 2000, system: { cpu: 5 + (k % 4), mem: 1200 * MB } }));
  return { now, monitoring, trend, external: { healthy: true } };
}

let model = null;
for (let i = 0; i < 30; i += 1) { model = buildDiagnosticsModel(input(i), model); renderDiagnostics(model, "sources"); }
const cpu0 = process.cpuUsage();
const t0 = performance.now();
let bytes = 0;
for (let i = 0; i < rounds; i += 1) {
  model = buildDiagnosticsModel(input(i), model);
  bytes += renderDiagnostics(model, "sources").length;
}
const ms = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
console.log(`${rounds} refreshes: ${(ms / rounds).toFixed(2)} ms each (cpu ${((cpu.user + cpu.system) / 1000 / rounds).toFixed(2)} ms), `
  + `${Math.round(bytes / rounds / 1024)} KB of markup each; at one refresh per 2 s: ${((ms / rounds) / 2000 * 100).toFixed(3)}% of one core`);
