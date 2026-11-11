"use strict";
// A startup row that degraded (attach not seen within its window) could never become done, so the
// background recovery watch's completeStep was swallowed and the row stayed degraded for the whole session.
// Every other terminal state still stays terminal.
const assert = require("node:assert/strict");
const { loadSourceSettings } = require("../config/js/source_settings");
const { StartupCoordinator } = require("../ui/main/startup_lifecycle");

const sources = loadSourceSettings({ STOCK_MONITOR_SOURCES: "shioaji,futu" });
const coordinator = new StartupCoordinator({ electronPid: 1, sources, logger: { log() {}, warn() {}, error() {} } });
const step = (id) => coordinator.snapshot().steps.find((row) => row.id === id);

coordinator.startStep("moomoo_attach", "waiting");
coordinator.degradeStep("moomoo_attach", "not attached yet");
assert.equal(step("moomoo_attach").status, "degraded");
coordinator.completeStep("moomoo_attach", "背景連線已恢復");
assert.equal(step("moomoo_attach").status, "done", "a late success upgrades a degraded row");

coordinator.startStep("shioaji_attach", "waiting");
coordinator.completeStep("shioaji_attach");
coordinator.degradeStep("shioaji_attach", "stale");
assert.equal(step("shioaji_attach").status, "done", "done stays done");

coordinator.startStep("live_ingress", "waiting");
coordinator.failStep("live_ingress", "failed");
coordinator.completeStep("live_ingress");
assert.equal(step("live_ingress").status, "failed", "failed stays failed");

console.log("startup step recovery contract ok");
