"use strict";

// Daily remediation summaries older than the 30-day window are never read: summarizing the finished days deletes
// them and writes none for such a day, while the window's summaries stay. Today's summary is written too (資料中心
// reads a date's 補救事件 from these files), and an event of today rewrites it once the ledger is flushed.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SummaryIndex } = require("../health/remediation/ledger_summary.js");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remediation-summary-"));
  try {
    for (const day of ["20260920", "20260927", "20260928", "20261027"]) fs.writeFileSync(path.join(dir, `${day}.json`), "{\"mechanisms\":{}}");
    fs.writeFileSync(path.join(dir, "notes.txt"), "kept");
    const index = new SummaryIndex({ fs, now: () => new Date(2026, 9, 28, 10), logger: { warn: () => {} }, summaryDir: dir,
      registry: { mechanisms: {} }, stats: {}, flush: async () => true, isClosed: () => false });
    index.dayStats("20260901");   // raw events of a day outside the window
    index.summarizeFinishedDays();
    assert.deepEqual(fs.readdirSync(dir).sort(), ["20260928.json", "20261027.json", "20261028.json", "notes.txt"]);
    assert.equal(index.days.has("20260901"), false, "an old day leaves memory without a summary");
    const todayFile = () => JSON.parse(fs.readFileSync(path.join(dir, "20261028.json"), "utf8")).mechanisms;
    assert.deepEqual(todayFile(), {}, "today's summary is written at start, empty when nothing happened");

    const event = { mechanism_id: "health.service_restart", at: "2026-10-28T09:30:00.000+08:00", outcome: "succeeded",
      operation_id: null, trigger_reason: "exited", identity: {}, detail: {} };
    index.fold(event);
    index.noteEvent(event);
    clearTimeout(index.pendingTimer);
    index.pendingTimer = null;
    await index.writePendingSummaries();
    assert.equal(todayFile()["health.service_restart"].attempts, 1, "today's summary follows its events");
    console.log("remediation_summary_retention_contract: ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
