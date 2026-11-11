"use strict";

// Shared by BOTH ui/main (Electron) and health/ (the Service
// Controller, which needs these for daemon/backend PID liveness checks).

const fs = require("fs");

function processAliveFast(pid, processRef = process) {
  const value = Number(pid || 0);
  if (!(value > 0)) return false;
  try {
    processRef.kill(value, 0);
    return true;
  } catch (error) { /* not an error: EPERM proves the process exists; any other error answers that it is gone */ return ["EPERM", "EACCES"].includes(String(error?.code || "")); }
}

function readUtf8FileTail(filePath, maxChars = 5000, maxBytes = 64 * 1024) {
  if (!filePath) return "";
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const wantedChars = Math.max(500, Number(maxChars) || 5000);
    const bytesToRead = Math.min(
      Number(stat.size || 0),
      Math.max(wantedChars * 4, Math.max(4096, Number(maxBytes) || 64 * 1024)),
    );
    if (bytesToRead <= 0) return "";
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const position = Math.max(0, Number(stat.size || 0) - bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, position);
    return buffer.subarray(0, bytesRead).toString("utf8").slice(-wantedChars);
  } catch (error) { console.warn("[reading a log tail] failed", error); return ""; } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (error) { console.warn("[closing a log file] failed", error); }
    }
  }
}

// The OS creation time of `pid` in epoch ms, or null when it cannot be known (no such process, not Windows). A pid
// alone is not a process: a recorded owner whose pid now names a process created at another time is gone. The CIM
// query takes ~0.5 s, so it is never run synchronously in a process with other work (Health's control API, service starts).
function processCreatedMsAsync(pid, execFileImpl = require("child_process").execFile) {
  const value = Number(pid || 0);
  if (!(value > 0) || process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFileImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${value}"; if ($p) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() }`],
    { encoding: "utf8", windowsHide: true, timeout: 5000 }, (error, stdout) => {
      // A failed query is "cannot be known" (null), which every caller treats as unverified -- never as gone.
      if (error) console.warn(`[reading the creation time of pid ${value}] failed`, error);
      const created = Number(String(stdout || "").trim());
      resolve(Number.isFinite(created) && created > 0 ? created : null);
    });
  });
}

module.exports = { processAliveFast, processCreatedMsAsync, readUtf8FileTail };
