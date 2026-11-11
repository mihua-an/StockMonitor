"use strict";

// Startup ownership (docs/system-architecture/00 sections 3-4, 06 section 6).
//
// * Electron main owns exactly one child process: Health (health_bootstrap.js). It attaches to a Health that
//   proves itself instead of starting a second one, and treats Health's exit 75 as a planned restart.
// * Health (health/main.js) owns every service process; Electron never instantiates a service host.
// * Electron reaches Health only through the controller client, reads startup progress from /status/startup
//   and never asks Health to start an individual service.
// * Renderers never carry a hardcoded service address: endpoints come from Electron main (Health's effective).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const mainSource = read("ui", "main", "main.js");
const applicationSource = read("ui", "main", "desktop_application.js");
const bootstrapSource = read("ui", "main", "health_bootstrap.js");
const controllerClientSource = read("ui", "main", "controller_client.js");
const lifecycleSource = read("ui", "main", "app_lifecycle_controller.js");
const controlApiSource = read("health", "control_api.js");
const healthMainSource = read("health", "main.js");
const shioajiHostSource = read("health", "services", "shioaji_daemon_host.js");
const futuHostSource = read("health", "services", "futu_daemon_host.js");
const providerHostSource = read("health", "services", "provider_daemon_host.js");
const preloadSource = read("ui", "main", "preload.js");
const rendererAppSource = read("ui", "renderer", "app.js");
const rendererStateSource = read("ui", "renderer", "js", "core", "state.js");
const realtimeSource = read("ui", "renderer", "js", "market_data", "realtime.js");

// Singleton first: nothing that can spawn a process is even loaded before the lock.
const singletonIndex = mainSource.indexOf("app.requestSingleInstanceLock()");
assert.ok(singletonIndex >= 0 && mainSource.indexOf('requireMain("desktop_application")') > singletonIndex,
  "the Electron singleton lock is acquired before desktop_application is loaded");
assert.ok(mainSource.indexOf('requireMain("health_bootstrap")') > singletonIndex, "and before the Health bootstrap");

// Electron's one child process is Health.
assert.doesNotMatch(applicationSource, /require\("child_process"\)/, "the composition root spawns nothing");
assert.match(bootstrapSource, /require\("child_process"\)/);
assert.match(bootstrapSource, /spawn\(execPath, \[healthMainPath\]/, "Health runs on Electron's own binary (ELECTRON_RUN_AS_NODE)");
assert.match(bootstrapSource, /detached: true/, "Health outlives Electron: not in libuv's kill-on-close job");
assert.match(bootstrapSource, /child\.unref\(\)/, "Electron does not wait on Health");
assert.match(bootstrapSource, /ELECTRON_RUN_AS_NODE: "1"/);
assert.match(bootstrapSource, /PLANNED_RESTART_EXIT = 75/, "exit 75 is Health's planned (bootstrap) restart");
assert.match(bootstrapSource, /attached to the running Health/, "a verified running Health is attached to, never duplicated");
assert.match(bootstrapSource, /record\.pid === expectedPid\(\)/, "only the record of the Health this bootstrap owns names its address");
assert.match(bootstrapSource, /Authorization: `Bearer \$\{token\}`/, "readiness is an authenticated health check");

// Health owns every service process; Electron never builds a service host.
assert.match(healthMainSource, /require\("child_process"\)/);
for (const host of ["MarketRuntimeHost", "AnalysisRuntimeHost", "PythonServiceHost", "ShioajiDaemonHost", "FutuDaemonHost"]) {
  assert.match(healthMainSource, new RegExp(`new ${host}\\(`), `Health instantiates ${host}`);
  assert.doesNotMatch(applicationSource, new RegExp(`new ${host}\\(`), `Electron never instantiates ${host}`);
}
assert.match(healthMainSource, /supervisor\.startAll\("startup"/, "Health starts every service on its own");

// Electron is a client of Health's control API only.
assert.match(controlApiSource, /\/status\/startup/);
assert.match(controllerClientSource, /"\/status\/startup"/);
assert.doesNotMatch(controllerClientSource, /\/control\/ensure|\/control\/service/, "Electron never asks for an individual service");
assert.match(lifecycleSource, /STARTUP_SERVICES/, "startup units map to the service_ids Health reports");

// Both provider hosts are the one shared host.
assert.match(shioajiHostSource, /extends ProviderDaemonHost/);
assert.match(futuHostSource, /extends ProviderDaemonHost/);
assert.ok(providerHostSource.length > 0);

// The page's bootstrap comes from Electron main in one synchronous read before the page runs.
assert.match(preloadSource, /ipcRenderer\.sendSync\("runtime:get-bootstrap"\)/);
assert.doesNotMatch(rendererAppSource, /dock-nav-item:not\(\[data-page="realtime"\]\)/, "no page is dropped");

// No hardcoded service address in the renderer.
assert.doesNotMatch(rendererStateSource, /127\.0\.0\.1:\d+/, "the renderer's API addressing has no literal port");
assert.doesNotMatch(realtimeSource, /ws:\/\/127\.0\.0\.1:\d+/, "nor its market_runtime connection");

console.log("startup ownership contract passed");
