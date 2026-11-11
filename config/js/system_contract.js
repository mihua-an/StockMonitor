"use strict";

// Node loader for config/system_contract.json (see config/system_contract.py). Read-only, cached.
const fs = require("fs");
const path = require("path");

const SCHEMA = "stock-monitor-system-contract-v1";
let cached = null;

function contract() {
  if (!cached) {
    const file = path.resolve(__dirname, "..", "system_contract.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.schema !== SCHEMA) throw new Error(`${file} is not ${SCHEMA}`);
    cached = value;
  }
  return JSON.parse(JSON.stringify(cached));
}

// Name of the DATA_ROOT child a native runtime owns ("market_runtime" -> "live-engine").
function dataChild(owner) {
  const name = contract().data_children[owner];
  if (!name) throw new Error(`system contract names no data directory for ${owner}`);
  return name;
}

module.exports = { SCHEMA, contract, dataChild };
