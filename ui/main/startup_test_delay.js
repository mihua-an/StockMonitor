"use strict";

// Lets acceptance tests inject an artificial pause into a named startup phase
// via STOCK_MONITOR_TEST_DELAY_<NAME> env vars, without the startup sequencer
// itself knowing tests exist.
// Only with the explicit test-fault opt-in (STOCK_MONITOR_TEST_FAULTS=1, the same switch the Rust runtime's test
// faults require): a stray variable in a user's environment must not delay the real App's startup.
function createStartupTestDelay({ env = process.env, logger = console } = {}) {
  const enabled = env.STOCK_MONITOR_TEST_FAULTS === "1";
  function getDelayMs(name) {
    if (!enabled) return 0;
    const raw = Number(env[name] || 0);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(120000, Math.max(0, Math.floor(raw)));
  }

  return async function applyStartupTestDelay(name, label) {
    const delayMs = getDelayMs(name);
    if (!delayMs) return;
    logger.warn(`[STARTUP TEST] ${label} delayed ${delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  };
}

module.exports = { createStartupTestDelay };
