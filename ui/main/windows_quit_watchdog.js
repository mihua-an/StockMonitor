"use strict";

// Electron's own quit() reliability guard on Windows: an independent OS process, spawned before app.quit() is even
// called, so it keeps running even if this process's main thread never returns from that call. After its grace time it
// re-checks the target PID's own executable path immediately before killing, so a PID Windows has since recycled for
// an unrelated process can never be targeted. It never taskkill /T: the Shioaji/Futu daemons and Health are spawned
// detached, but Windows still records the real parent PID chain, and a tree-kill would take down services the
// shutdown scope was contracted to keep alive. Only this process's own Chromium helpers (--type=) are stopped with it.
//
// It also records which processes of the UI outlive app.quit() and by how much -- the main process, each Chromium
// helper, the launcher -- each end appended to the shutdown timeline as it happens: they share the launcher's console
// window, which closes only when the last of them is gone.
//
// The marker states what happened: written after the stop, with whether that exact process (its creation time) is gone
// and what the stop answered; the next start collects it into the remediation ledger.
//
// Off Windows arm() is an explicit no-op: Electron's quit there has no such failure to guard.

function createQuitWatchdog({ platform = process.platform, spawn, fs, path, logger = console }) {
  const quote = (text) => String(text).replace(/'/g, "''");

  function script({ pid, execPath, watched, timelinePath, graceMs, markerDir, markerPath }) {
    const timeline = timelinePath ? quote(timelinePath) : "";
    const traceLines = timeline ? [
      `$watch = @(${watched.map((w) => `@{ pid = ${w.pid}; type = '${quote(w.type)}' }`).join(", ")})`,
      `$begun = Get-Date`,
      `$deadline = $begun.AddMilliseconds(${graceMs})`,
      `$gone = @{}`,
      `while ((Get-Date) -lt $deadline -and $gone.Count -lt $watch.Count) {`,
      `  foreach ($w in $watch) {`,
      `    if (-not $gone.ContainsKey($w.pid) -and -not (Get-Process -Id $w.pid -ErrorAction SilentlyContinue)) {`,
      `      $gone[$w.pid] = $true`,
      `      Add-Content -LiteralPath '${timeline}' -Encoding UTF8 -Value ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') + ' [Shutdown timeline] process gone ' + $w.type + ' pid=' + $w.pid + ' after_app_quit_ms=' + [int]((Get-Date) - $begun).TotalMilliseconds)`,
      `    }`,
      `  }`,
      `  Start-Sleep -Milliseconds 100`,
      `}`,
      `$left = ($deadline - (Get-Date)).TotalMilliseconds`,
      `if ($left -gt 0 -and $gone.Count -lt $watch.Count) { Start-Sleep -Milliseconds ([int]$left) }`,
    ] : [`Start-Sleep -Milliseconds ${graceMs}`];
    return [
      ...traceLines,
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
      `if ($p -and $p.ExecutablePath -eq '${quote(execPath)}') {`,
      `  $created = $p.CreationDate`,
      `  Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" -ErrorAction SilentlyContinue |`,
      `    Where-Object { $_.CommandLine -like '*--type=*' } |`,
      `    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      `  $stopError = $null`,
      `  try { Stop-Process -Id ${pid} -Force -ErrorAction Stop } catch { <# not an error: recorded as stop_error in the forced-quit marker #> $stopError = $_.Exception.Message }`,
      `  try { Wait-Process -Id ${pid} -Timeout 10 -ErrorAction Stop } catch { <# not an error: a wait that times out is decided by the check below #> }`,
      `  $still = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
      `  $exited = -not ($still -and $still.CreationDate -eq $created)`,
      `  New-Item -ItemType Directory -Force -Path '${quote(markerDir)}' | Out-Null`,
      `  ConvertTo-Json -Compress -InputObject @{ schema = 'stock-monitor-forced-quit-v2'; kind = 'external_quit_watchdog'; pid = ${pid};`
        + ` created = $created.ToString('o'); exited = $exited; stop_error = $stopError;`
        + ` grace_ms = ${graceMs}; at = (Get-Date).ToString('o') } |`
        + ` Set-Content -LiteralPath '${quote(markerPath)}' -Encoding UTF8`,
      `}`,
      `Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue`,
    ].join("\r\n");
  }

  return {
    /**
     * pid/execPath: the process to end; watched: [{pid, type}] traced to timelinePath; graceMs before the stop;
     * tempDir holds the script; markerDir/markerPath: where the outcome is written. Returns {armed, reason}.
     */
    arm({ pid, execPath, tempDir, watched = [], timelinePath = null, graceMs, markerDir, markerPath }) {
      if (platform !== "win32") return { armed: false, reason: "not_windows" };
      if (!tempDir) {
        logger.warn("[Shutdown] external quit watchdog not armed: no TEMP directory");
        return { armed: false, reason: "no_temp_dir" };
      }
      const grace = Math.max(0, Number(graceMs) || 0);
      const scriptPath = path.join(tempDir, `stock-monitor-quit-watchdog-${pid}.ps1`);
      try {
        fs.writeFileSync(scriptPath, script({ pid, execPath, watched, timelinePath, graceMs: grace, markerDir, markerPath }), "utf8");
        const watchdog = spawn(
          "cmd.exe",
          ["/d", "/c", "start", '""', "/B", "powershell.exe",
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        watchdog.unref();
        return { armed: true, reason: null };
      } catch (error) {
        logger.warn(`[Shutdown] external quit watchdog spawn failed: ${error?.message || error}`);
        return { armed: false, reason: "spawn_failed" };
      }
    },
  };
}

module.exports = { createQuitWatchdog };
