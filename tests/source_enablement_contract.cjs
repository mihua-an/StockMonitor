"use strict";
const assert = require("node:assert/strict");
const { loadSourceSettings, sourceSettingsProblems } = require("../config/js/source_settings");
const { StartupCoordinator, STARTUP_UNITS } = require("../ui/main/startup_lifecycle");
const fs = require("node:fs");
const path = require("node:path");

async function verify(selected) {
  const sources = loadSourceSettings({ STOCK_MONITOR_SOURCES: selected });
  const enabled = new Set(sources.enabled_sources);
  const coordinator = new StartupCoordinator({ electronPid: 1, sources, logger: { log() {}, warn() {}, error() {} } });
  const steps = Object.fromEntries(coordinator.snapshot().steps.map(step => [step.id, step]));
  assert.equal(steps.shioaji_daemon.status === "skipped", !enabled.has("shioaji"));
  assert.equal(steps.moomoo_daemon.status === "skipped", !enabled.has("futu"));
  let shioajiCalls = 0;
  let futuCalls = 0;
  if (!enabled.has("shioaji")) {
    await coordinator._startShioajiDaemonUnit({
      ensureMarketDaemon: async () => { shioajiCalls += 1; return { health: {} }; },
      markStartupTrace() {}, markStartupMetric() {},
    });
  }
  if (!enabled.has("futu")) {
    await coordinator._startMoomooUnits({
      ensureMoomooDaemon: async () => { futuCalls += 1; return { health: {} }; },
      fetchBackendHeartbeat: async () => ({}), markStartupTrace() {},
    });
  }
  assert.equal(shioajiCalls, 0);
  assert.equal(futuCalls, 0);
}

(async () => {
  await verify("shioaji");
  await verify("futu");
  await verify("shioaji,futu");
  const offline = loadSourceSettings({ STOCK_MONITOR_OFFLINE_UI: "1", STOCK_MONITOR_SOURCES: "shioaji,futu" });
  assert.deepEqual(offline.enabled_sources, []);
  assert.equal(offline.offline_ui, true);
  const rendererApi = fs.readFileSync(path.join(__dirname, "../ui/renderer/js/core/api.js"), "utf8");
  assert.ok(rendererApi.indexOf("await disabledRequest(path)") < rendererApi.indexOf("await fetch(apiUrl(path)"));
  const quoteStore = fs.readFileSync(path.join(__dirname, "../ui/renderer/js/features/realtime/moomoo_quote_store.js"), "utf8");
  assert.match(quoteStore, /if \(!sourceEnabled\("futu"\)\) return;/);
  const realtime = fs.readFileSync(path.join(__dirname, "../ui/renderer/js/pages/realtime.js"), "utf8");
  assert.match(realtime, /if \(!sourceEnabled\("shioaji"\)\) return;/);
  const rendererSources = fs.readFileSync(path.join(__dirname, "../ui/renderer/js/core/source_settings.js"), "utf8");
  assert.match(rendererSources, /settings\?\.offline_ui && url\.pathname\.startsWith\("\/api\/history\/"\)/);
  assert.match(rendererSources, /"\/api\/data-center\/dates"/);
  // The same damaged settings are refused with the same problems as config/source_settings.py.
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "source_settings_cases.json"), "utf8"));
  for (const { name, settings, problems } of cases) assert.deepEqual(sourceSettingsProblems(settings), problems, name);
  // Which startup step belongs to which source is STARTUP_UNITS' alone (ui/main/desktop_application.js projects it
  // for the renderer): the file holds no second table, and the loaded snapshot cannot be rewritten.
  const loaded = loadSourceSettings({});
  assert.equal(loaded.startup_steps, undefined);
  assert.ok(Object.isFrozen(loaded));
  console.log("source enablement startup contract passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
