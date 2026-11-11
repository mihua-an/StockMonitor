"use strict";
// The test-only startup delay was read in production too.
const assert = require("assert");
const { createStartupTestDelay } = require("../ui/main/startup_test_delay.js");

(async () => {
  const warned = [];
  const logger = { warn: (line) => warned.push(line) };
  const env = { STARTUP_TEST_CREATE_WINDOW_DELAY_MS: "30" };
  await createStartupTestDelay({ env, logger })("STARTUP_TEST_CREATE_WINDOW_DELAY_MS", "createWindow");
  assert.deepStrictEqual(warned, [], "no delay without the test-fault opt-in");
  const started = Date.now();
  await createStartupTestDelay({ env: { ...env, STOCK_MONITOR_TEST_FAULTS: "1" }, logger })("STARTUP_TEST_CREATE_WINDOW_DELAY_MS", "createWindow");
  assert.ok(Date.now() - started >= 25 && warned.length === 1, "the opt-in still allows it");
  console.log("startup test delay gate contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
