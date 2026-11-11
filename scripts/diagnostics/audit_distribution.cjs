"use strict";
// Read directory entries only: never inspect ZIP, executable or production data.
const fs = require("node:fs");
const path = require("node:path");
const expected = ["StockMonitor", "stock_monitor.bat", "stock_monitor_hidden.vbs", "StockMonitor.zip"];
function inspect(directory) {
  const visible = fs.readdirSync(directory).filter(name => !name.startsWith(".") && path.extname(name).toLowerCase() !== ".log");
  return { extra: visible.filter(name => !expected.includes(name)).sort(),
    missing: expected.filter(name => !visible.includes(name)).sort() };
}
module.exports = { inspect, expected };
if (require.main === module) {
  const result = inspect(path.resolve(process.argv[2] || path.join(__dirname, "../../..")));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.extra.length || result.missing.length ? 1 : 0;
}
