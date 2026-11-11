"use strict";
// Prints the offline-guard variables this process was started with (tests/offline_guard_subprocess_contract.cjs).
const names = ["NODE_OPTIONS", "STOCK_MONITOR_OFFLINE_CHECK", "STOCK_MONITOR_OFFLINE_ALLOW"];
process.stdout.write(JSON.stringify({ ...Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])),
  guard_loaded: Object.keys(require.cache).some((file) => file.endsWith("offline_guard.cjs")) }));
