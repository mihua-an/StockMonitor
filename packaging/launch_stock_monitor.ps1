# Thin packaged-install launcher: starts the Electron executable and nothing
# else. Health bootstrap (spawn Health, wait for it to report healthy,
# restart it if it crashes unexpectedly) is Electron's own responsibility
# (ui/main/health_bootstrap.js, wired from ui/main/main.js) -- see
# docs/system-architecture/README.md: "Electron -> bootstrap Health -> Health
# starts/manages services". A launcher that spawned Health itself would be a
# second Health bootstrap owner beside Electron. Electron's own
# app.requestSingleInstanceLock() handles a duplicate launch (a second
# StockMonitor.exe focuses the primary instance's window and exits before ever
# reaching the Health-bootstrap code path), so no readiness gate is needed here.
$ErrorActionPreference = 'Stop'

try {
    $resourcesDir = $PSScriptRoot
    $installDir = Split-Path -Parent $resourcesDir
    $appExe = Join-Path $installDir 'StockMonitor.exe'
    if (-not (Test-Path -LiteralPath $appExe)) {
        throw 'StockMonitor installation is incomplete (application executable missing).'
    }
    Start-Process -FilePath $appExe -WorkingDirectory $installDir
} catch {
    $failure = $_
    # The record comes first and does not depend on the dialog: the same file Electron's early error sink falls back
    # to (ui/main/main.js), so a launch that never reached Electron is still on disk.
    try {
        $logDir = Join-Path $env:APPDATA 'StockMonitor'
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $line = '[{0}] [LAUNCHER] {1}: {2}' -f (Get-Date).ToUniversalTime().ToString('o'), $failure.Exception.GetType().FullName, ([string]$failure -replace '[\r\n]+', ' ')
        Add-Content -LiteralPath (Join-Path $logDir 'startup_errors.log') -Value $line -Encoding UTF8
    } catch {
        [Console]::Error.WriteLine("StockMonitor launcher: recording the startup failure failed: $_ (failure: $failure)")
    }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show([string]$failure, 'StockMonitor startup failed', 'OK', 'Error') | Out-Null
    } catch {
        [Console]::Error.WriteLine("StockMonitor launcher: showing the startup failure failed: $_ (failure: $failure)")
    }
    exit 1
}
