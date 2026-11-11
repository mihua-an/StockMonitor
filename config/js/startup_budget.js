"use strict";

// How long each part of a desktop start may take. Health enforces them (health/services/market_runtime_host.js) and
// Electron waits for them (ui/main/health_bootstrap.js, ui/main/app_lifecycle_controller.js): one set of numbers, so
// a start Health still lets run is never declared failed by the UI first (start-all was capped at 15 min while A's
// host allowed its recovery 20).

// Market Runtime (A) listens at once and, while it scans and replays its WAL, answers `health` as "recovering" with
// its progress; its host follows that progress instead of one fixed timeout.
const MARKET_RUNTIME_FIRST_ANSWER_MS = 30000;          // until the port answers at all
const MARKET_RUNTIME_SCAN_LIMIT_MS = 5 * 60 * 1000;    // the WAL scan reports no per-event progress
const MARKET_RUNTIME_RECOVERY_STALL_MS = 60000;        // replaying without advancing this long is a hang
const MARKET_RUNTIME_RECOVERY_LIMIT_MS = 20 * 60 * 1000; // a recovery that never ends is a failure too
// The longest A's start can run before its host decides either way.
const MARKET_RUNTIME_START_MAX_MS = MARKET_RUNTIME_FIRST_ANSWER_MS + MARKET_RUNTIME_RECOVERY_LIMIT_MS;

// What a start-all runs besides A (Rust B, the provider daemons with their own retry windows, the APIs): the budget
// the whole start-all had before A's recovery limit was counted into it.
const SERVICES_BESIDES_MARKET_RUNTIME_MS = 15 * 60 * 1000;
// Bounds the whole start-all of an attached Health.
const START_ALL_TIMEOUT_MS = MARKET_RUNTIME_START_MAX_MS + SERVICES_BESIDES_MARKET_RUNTIME_MS;

module.exports = {
  MARKET_RUNTIME_FIRST_ANSWER_MS,
  MARKET_RUNTIME_SCAN_LIMIT_MS,
  MARKET_RUNTIME_RECOVERY_STALL_MS,
  MARKET_RUNTIME_RECOVERY_LIMIT_MS,
  MARKET_RUNTIME_START_MAX_MS,
  START_ALL_TIMEOUT_MS,
};
