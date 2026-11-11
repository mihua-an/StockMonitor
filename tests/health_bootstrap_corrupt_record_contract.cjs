"use strict";
const { makeTempDir } = require("./support/temp_dirs.cjs");
// A Health endpoint record that exists but cannot be parsed (or does not match its schema) is damage, not "no
// Health": start() must not spawn a second Health on its word. It moves the record aside, reports the reason and
// fails this start; an absent record still means "start one".
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHealthBootstrap } = require("../ui/main/health_bootstrap.js");

(async () => {
  for (const content of ["{\"pid\": 12", JSON.stringify({ pid: 12, host: "127.0.0.1", port: 1 })]) {
    const root = makeTempDir("health-corrupt-");
    const recordDir = path.join(root, "var", "config", "bootstrap");
    fs.mkdirSync(recordDir, { recursive: true });
    const recordFile = path.join(recordDir, "health_endpoint.json");
    fs.writeFileSync(recordFile, content);
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      const env = { ...process.env, STOCK_MONITOR_VAR_ROOT: path.join(root, "var") };
      const bootstrap = createHealthBootstrap({ isPackaged: false, resourcesPath: "", uiMainDir: path.join(__dirname, "..", "ui", "main"),
        healthBaseUrl: "http://127.0.0.1:1", env, execPath: "never-run", logger: { log() {}, warn() {}, error() {} } });
      const result = await bootstrap.start(200).catch((error) => error);
      assert.ok(result instanceof Error, "a damaged record fails the start");
      assert.match(result.message, /Health endpoint record/);
      assert.equal(fs.existsSync(recordFile), false, "the damaged record is moved aside");
      const kept = fs.readdirSync(recordDir).filter((name) => name.startsWith("health_endpoint.json.corrupt-"));
      assert.equal(kept.length, 1);
      assert.equal(fs.readFileSync(path.join(recordDir, kept[0]), "utf8"), content, "the damaged bytes are kept as they were");
      assert.ok(errors.some((line) => line.includes("[BOOTSTRAP read Health endpoint record] failed")), errors.join("\n"));
    } finally {
      console.error = originalError;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  console.log("health bootstrap corrupt record contract ok");
})().catch((error) => { console.error(error); process.exit(1); });
