"use strict";

// Per-PID CPU / memory / I/O for the processes Health manages (docs/system-architecture/07 section 3).
//
// One long-lived PowerShell child answers one query per sample (spawning a shell every 2 s would itself be the
// most expensive thing monitoring does). CPU is normalized over all logical CPUs to 0-100 % with the actual
// sampling window attached; working set and private bytes are separate fields; I/O is bytes/second from the OS
// process transfer counters (source named). A PID whose creation time changed is a different process: its
// baseline restarts instead of producing a bogus delta. Nothing here is guessed: a missing sample is null.
//
// Wire protocol: each query is "<id>;<pid>,<pid>..." and each reply {"id", "rows"}; a reply is
// matched by its id, never by order. A query that times out (or whose write fails) ends alone; its late reply is
// dropped and counted. A sampler that exits, fails to spawn or loses its input is replaced at the next query, and
// that replacement is a `health.resource_sampler_restart` remediation.

const os = require("os");
const { spawn } = require("child_process");
const readline = require("readline");
const { TRIGGERS, killChildAndRecord } = require("../../service/platform/js/forced_termination");

const SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($line -eq $null) { break }",
  "  $parts = $line.Split(';', 2)",
  "  $request = [int64]$parts[0]",
  "  $ids = @($parts[1].Split(',') | Where-Object { $_ -match '^\\d+$' })",
  "  if ($ids.Count -eq 0) { [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject @{ id = $request; rows = @() })); [Console]::Out.Flush(); continue }",
  "  $filter = ($ids | ForEach-Object { \"IDProcess=$_\" }) -join ' OR '",
  // The raw process performance counters, in one query: CPU time (100 ns), the private working set (what Task
  // Manager's 記憶體 column shows), private bytes (commit), cumulative I/O bytes, and the start time (ElapsedTime's
  // raw value), which tells a reused PID from the process sampled before.
  "  $rows = Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter $filter | ForEach-Object {",
  "    [pscustomobject]@{ pid = $_.IDProcess; cpu = $_.PercentProcessorTime; memory = $_.WorkingSetPrivate;",
  "      private = $_.PrivateBytes; read = $_.IOReadBytesPerSec; write = $_.IOWriteBytesPerSec; created = [string]$_.ElapsedTime }",
  "  }",
  "  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject @{ id = $request; rows = @($rows) }))",
  "  [Console]::Out.Flush()",
  "}",
].join("\n");

// How long a new sampler (a PowerShell host) may take to answer its first query: past it, one that has answered
// nothing is not a sampler still starting.
const FIRST_ANSWER_MS = 30000;

class ProcessResources {
  constructor({ logger = console, spawnImpl = spawn, remediation = null, firstAnswerMs = FIRST_ANSWER_MS } = {}) {
    this.firstAnswerMs = firstAnswerMs;
    this.logger = logger;
    this.spawn = spawnImpl;
    this.remediation = remediation;
    this.child = null;
    this.pending = new Map();   // request id -> waiter
    this.nextId = 1;
    this.lateReplies = 0;
    this.retired = null;        // why the previous sampler ended (a replacement is a remediation)
    this.baselines = new Map();
    this.cpus = os.cpus().length || 1;
    this.lastCostMs = null;
    this.failures = 0;
    this.stopped = false;
  }

  start() {
    if (this.child || this.stopped) return;
    if (process.platform !== "win32") return;
    // A replacement is one recorded operation: started now, succeeded only when the new sampler answers its
    // first query, failed when it cannot be spawned or ends before it answers -- never "succeeded" before the
    // spawn.
    let replacement = null;
    if (this.retired) {
      const trigger = this.retired;
      this.retired = null;
      try {
        replacement = this.remediation?.begin({ component: "process_resources", mechanismId: "health.resource_sampler_restart",
          triggerReason: trigger, identity: {}, detail: { late_replies: this.lateReplies } }) || null;
      } catch (error) { console.warn("[recording the resource sampler restart] failed", error); }
    }
    const settle = (outcome, detail) => {
      if (!replacement) return;
      const operation = replacement;
      replacement = null;
      try { operation.finish(outcome, { detail }); } catch (error) { console.warn("[recording the resource sampler restart outcome] failed", error); }
    };
    // The script goes in as -EncodedCommand so stdin carries only the PID queries ("-Command -" would make the
    // host's own script reader and [Console]::In compete for the same stream, and every query would time out).
    const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
    let child;
    try {
      child = this.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch (error) {
      this.retired = "sampler_failed";
      settle("failed", { error: String(error?.message || error) });
      console.warn("[starting the resource sampler] failed", error);
      return;
    }
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let reply;
      try { reply = JSON.parse(line); } catch (error) { console.warn("[parsing a resource sampler reply] failed", error); this.lateReplies += 1; return; }
      const waiter = this.pending.get(reply?.id);
      // A reply to a query that already timed out (or to a retired sampler's) is dropped -- alone.
      if (!waiter) { this.lateReplies += 1; return; }
      child.answered = true;
      settle("succeeded", { first_reply_id: reply.id });
      waiter.resolve(Array.isArray(reply.rows) ? reply.rows : []);
    });
    // Every way a sampler ends -- it exits or fails, its input breaks, it never answers, or stop() -- goes through
    // here once: its pending queries are rejected at once (not left to their own timeouts) and its pipes closed.
    const gone = (trigger, reason) => {
      settle("failed", { reason });
      this.retireChild(child, lines, trigger, reason);
    };
    child.once("exit", () => gone("sampler_exited", "resource sampler exited"));
    // A failed spawn emits "error" (never "exit"); a dead pipe errors on write. Unhandled, either was an uncaught
    // exception in Health.
    child.once("error", (error) => gone("sampler_failed", `resource sampler failed: ${error?.message || error}`));
    child.stdin?.on("error", (error) => gone("sampler_input_failed", `resource sampler input failed: ${error?.message || error}`));
    child.answered = false;
    child.startedAt = Date.now();
    child.retire = gone;
    this.child = child;
  }

  // A sampler that has never answered a query within its startup allowance is not kept: it is ended and proven
  // gone, its replacement (when it was one) failed, and the next query starts another.
  retireUnanswered(child) {
    if (this.child !== child || child.answered || Date.now() - child.startedAt < this.firstAnswerMs) return;
    child.retire("sampler_unanswered", "resource sampler never answered");
    void killChildAndRecord(child, this.remediation, { component: "process_resources", serviceId: "resource_sampler",
      trigger: TRIGGERS.START_FAILED, reason: "never answered a query", graceMs: null });
  }

  // `trigger` is why the next start is a recorded restart; stop() passes null (a stop is not a failure to recover).
  retireChild(child, lines, trigger, reason) {
    if (this.child !== child) return false;
    this.child = null;
    if (trigger) this.retired = trigger;
    for (const waiter of [...this.pending.values()]) waiter.reject(new Error(reason));
    try { lines.close(); } catch (error) { console.warn("[closing the resource sampler reply reader] failed", error); }
    try { child.stdin?.end(); } catch (error) { console.warn("[closing the resource sampler input] failed", error); }
    return true;
  }

  // Final: a query after it gets no sample, and no sampler is started again (Health is stopping).
  stop() {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    child.retire(null, "resource sampler stopped");
    try { child.kill(); } catch (error) { console.warn("[stopping the resource sampler] failed", error); }
  }

  query(pids, timeoutMs = 3000) {
    if (!this.child) this.start();
    if (!this.child) return Promise.resolve(null);
    const id = this.nextId++;
    const child = this.child;
    return new Promise((resolve, reject) => {
      const settle = (fn, value) => { clearTimeout(timer); this.pending.delete(id); fn(value); };
      const waiter = { resolve: (v) => settle(resolve, v), reject: (e) => settle(reject, e) };
      // Only this query ends: its reply, should it come, is dropped by id.
      const timer = setTimeout(() => {
        waiter.reject(new Error("resource sample timed out"));
        this.retireUnanswered(child);
      }, timeoutMs);
      this.pending.set(id, waiter);
      try {
        child.stdin.write(`${id};${pids.join(",")}\n`);
      } catch (error) {
        // A synchronous write failure means the pipe is gone: this sampler is retired, not reused.
        waiter.reject(error);
        child.retire("sampler_input_failed", "resource sampler input failed");
        try { child.kill(); } catch (killError) { console.warn("[stopping the failed resource sampler] failed", killError); }
      }
    });
  }

  // -> Map pid -> {cpu_percent, memory_bytes, private_bytes, io_read_bps, io_write_bps, window_ms, availability}.
  // memory_bytes is the private working set: the pages only this process holds. The plain working set also counts
  // the code it shares with other processes (Electron's and Python's DLLs), once per process -- summed over the
  // App's processes that read about twice the memory really in use.
  async sample(pids) {
    const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    const out = new Map();
    if (!unique.length) return out;
    const started = Date.now();
    let rows;
    try {
      rows = await this.query(unique);
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      // not an error: a failure after the first of a streak repeats one already logged (failures resets on success)
      if (this.failures === 1) this.logger.warn(`[HEALTH] resource sample failed: ${error?.message || error}`);
      for (const pid of unique) out.set(pid, { availability: "TEMPORARILY_UNAVAILABLE", reason: String(error?.message || error) });
      return out;
    }
    this.lastCostMs = Date.now() - started;
    const now = process.hrtime.bigint();
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const pid = Number(row.pid);
      seen.add(pid);
      const cpuTicks = BigInt(row.cpu || 0); // 100 ns units
      const base = this.baselines.get(pid);
      const entry = { memory_bytes: Number(row.memory), private_bytes: Number(row.private), created: row.created,
        io_source: "process performance counters (all I/O, not only disk)" };
      if (base && base.created === row.created) {
        const elapsedNs = Number(now - base.at);
        const cpu = Number(cpuTicks - base.cpu) * 100 / (elapsedNs * this.cpus) * 100;
        entry.cpu_percent = Math.max(0, Math.min(100, cpu));
        entry.window_ms = Math.round(elapsedNs / 1e6);
        entry.io_read_bps = Math.max(0, (Number(row.read) - base.read) / (elapsedNs / 1e9));
        entry.io_write_bps = Math.max(0, (Number(row.write) - base.write) / (elapsedNs / 1e9));
        entry.availability = "OK";
      } else {
        entry.cpu_percent = null;
        entry.availability = base ? "WARMING" : "NO_SAMPLE";
        entry.reason = base ? "process identity changed (PID reuse or restart): baseline restarted" : "first sample";
      }
      this.baselines.set(pid, { cpu: cpuTicks, at: now, created: row.created, read: Number(row.read), write: Number(row.write) });
      out.set(pid, entry);
    }
    for (const pid of unique) {
      if (!seen.has(pid)) {
        out.set(pid, { availability: "NOT_APPLICABLE", reason: "process not found" });
        this.baselines.delete(pid);
      }
    }
    return out;
  }
}

module.exports = { ProcessResources };
