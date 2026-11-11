"use strict";

// The ledger's day index: every retained day's per-mechanism counts (folded from raw events, live or replayed), the
// summary file of each day (<summaries>/YYYYMMDD.json, always equal to its raw events) -- today's included, kept
// current after each burst of events, so a reader of the files (資料中心's per-date 補救事件) sees today too --, the 30
// finished days' summaries kept in memory for the 7/30-day windows, and the rewrite of a finished day an event arrives
// late for. A summary is written only once the lines it counts are on disk (`flush`).

const path = require("path");
const { writeJsonAtomic } = require("../../service/platform/js/atomic_files");
const contract = require("../../config/js/remediation_contract.js");
const { SUMMARY_SCHEMA, localDay, eventDay, shiftDay, emptyDayStats, foldDay, summarizeDay } = require("./ledger_records.js");

// An event's day summary is rewritten after this quiet period (one rewrite for a burst of events).
const SUMMARY_DELAY_MS = 5_000;
const SUMMARY_DAYS = 30;

class SummaryIndex {
  constructor({ fs, now, logger, summaryDir, registry, stats, flush, isClosed }) {
    Object.assign(this, { fs, now, logger, summaryDir, registry, stats, flush, isClosed });
    this.days = new Map();           // day -> mechanism -> stats, for every retained day (the summaries are folded from it)
    this.history = new Map();        // day -> { mechanism -> summary } for finished days (from summary files)
    this.today = { day: localDay(now()), byMechanism: this.dayStats(localDay(now())) };
    this.pendingDays = new Set();
    this.pendingTimer = null;
    this.pendingAttempts = 0;
  }

  dayStats(day) {
    if (!this.days.has(day)) this.days.set(day, new Map());
    return this.days.get(day);
  }

  /** One event into its day's counts. */
  fold(event) {
    const byMechanism = this.dayStats(eventDay(event));
    if (!byMechanism.has(event.mechanism_id)) byMechanism.set(event.mechanism_id, emptyDayStats());
    foldDay(byMechanism.get(event.mechanism_id), event);
  }

  resetToday() {
    this.today = { day: localDay(this.now()), byMechanism: this.dayStats(localDay(this.now())) };
  }

  buildSummary(day) {
    const byMechanism = this.days.get(day) || new Map();
    const mechanisms = Object.fromEntries([...byMechanism.entries()].map(([id, stats]) =>
      [id, summarizeDay(day, id, stats, this.registry.mechanisms[id])]));
    return { schema: SUMMARY_SCHEMA, date: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`,
      generated_at: contract.localIso(this.now()), mechanisms };
  }

  summaryPath(day) { return path.join(this.summaryDir, `${day}.json`); }

  writeSummary(day) {
    const summary = this.buildSummary(day);
    const target = this.summaryPath(day);
    writeJsonAtomic(target, summary, { fsImpl: this.fs, indent: 2 });
    this.history.set(day, summary.mechanisms);
    return summary;
  }

  // A finished day gets its summary when events of it were read at this start (an event resent late counts where it
  // happened) or when its summary is missing; today's is written from what this start read. Days older than the 30-day
  // window are never read: they get no summary, leave memory, and their summary files are deleted. Then the last 30
  // days' summaries into memory for the 7/30-day counts.
  summarizeFinishedDays(dirty = new Set()) {
    const today = localDay(this.now());
    const oldest = shiftDay(today, -SUMMARY_DAYS);
    this.pruneSummaries(oldest);
    try { this.writeSummary(today); } catch (error) { this.logger.warn?.(`[REMEDIATION] summary ${today} failed: ${error.message}`); }
    for (const day of [...this.days.keys()].sort()) {
      if (day >= today) continue;
      if (day < oldest) { this.days.delete(day); continue; }
      if (dirty.has(day) || !this.fs.existsSync(this.summaryPath(day))) {
        try { this.writeSummary(day); } catch (error) { this.logger.warn?.(`[REMEDIATION] summary ${day} failed: ${error.message}`); continue; }
      }
      if (day < oldest) this.days.delete(day);
    }
    for (let back = 1; back < SUMMARY_DAYS; back += 1) {
      const day = shiftDay(today, -back);
      if (this.history.has(day)) continue;
      try { this.history.set(day, JSON.parse(this.fs.readFileSync(this.summaryPath(day), "utf8")).mechanisms || {}); }
      catch (error) {
        // absent is not an error: no remediation that day
        if (error?.code !== "ENOENT") console.warn("[reading a remediation daily summary] failed", error);
      }
    }
  }

  pruneSummaries(oldest) {
    let names;
    try { names = this.fs.readdirSync(this.summaryDir); }
    catch (error) { this.logger.warn?.(`[REMEDIATION] listing the daily summaries failed: ${error.message}`); return; }
    for (const name of names) {
      const day = /^(\d{8})\.json$/.exec(name)?.[1];
      if (!day || day >= oldest) continue;
      try { this.fs.unlinkSync(path.join(this.summaryDir, name)); }
      catch (error) { this.logger.warn?.(`[REMEDIATION] deleting the old daily summary ${name} failed: ${error.message}`); }
    }
  }

  // An event changes its day's summary (today's, or a finished day's when it was resent late): rewritten once its line
  // is on disk.
  noteEvent(event) {
    const day = eventDay(event);
    if (day > this.today.day || day < shiftDay(this.today.day, -SUMMARY_DAYS)) return;
    this.pendingDays.add(day);
    if (this.pendingTimer) return;
    this.schedulePendingSummaries(SUMMARY_DELAY_MS);
  }

  schedulePendingSummaries(delayMs) {
    if (this.pendingTimer || this.isClosed()) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.writePendingSummaries();
    }, delayMs);
    this.pendingTimer.unref?.();
  }

  async writePendingSummaries() {
    const days = [...this.pendingDays];
    if (!days.length) return;
    const flushed = await this.flush();
    let failed = !flushed;
    if (flushed) {
      for (const day of days) {
        try { this.writeSummary(day); this.pendingDays.delete(day); }
        catch (error) { failed = true; this.logger.warn?.(`[REMEDIATION] summary ${day} failed: ${error.message}`); }
      }
    } else {
      this.logger.warn?.(`[REMEDIATION] summaries ${days.join(", ")} wait: the ledger is not flushed`);
    }
    if (failed) {
      this.pendingAttempts += 1;
      this.stats.summary_failures = (this.stats.summary_failures || 0) + 1;
      this.schedulePendingSummaries(Math.min(SUMMARY_DELAY_MS * 2 ** Math.min(this.pendingAttempts, 6), 10 * 60_000));
    } else {
      this.pendingAttempts = 0;
    }
  }

  checkDay() {
    const day = localDay(this.now());
    if (day === this.today.day) return;
    const finished = this.today.day;
    this.today = { day, byMechanism: this.dayStats(day) };
    // The finished day's summary is written once its last lines are on disk; the new day starts with its own (empty).
    void this.flush().then(() => {
      for (const written of [finished, day]) {
        try { this.writeSummary(written); } catch (error) { this.logger.warn?.(`[REMEDIATION] summary ${written} failed: ${error.message}`); }
      }
      this.pruneSummaries(shiftDay(day, -SUMMARY_DAYS));
    });
  }

  windowCounts(mechanismId, days) {
    let count = this.today.byMechanism.get(mechanismId)?.attempts || 0;
    for (let back = 1; back < days; back += 1) count += this.history.get(shiftDay(this.today.day, -back))?.[mechanismId]?.attempts || 0;
    return count;
  }

  // Occurrences per service over the last `days` days (today included).
  windowServiceCounts(mechanismId, days) {
    const out = {};
    const add = (entries) => { for (const [sid, n] of entries) out[sid] = (out[sid] || 0) + (Number(n) || 0); };
    add(this.today.byMechanism.get(mechanismId)?.services || []);
    for (let back = 1; back < days; back += 1) add(Object.entries(this.history.get(shiftDay(this.today.day, -back))?.[mechanismId]?.by_service || {}));
    return out;
  }

  stop() {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }
}

module.exports = { SummaryIndex };
