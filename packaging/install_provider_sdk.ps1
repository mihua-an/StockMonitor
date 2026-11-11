<#
.SYNOPSIS
  Install the broker SDKs (Shioaji and/or moomoo-api) for the StockMonitor installed app.

.DESCRIPTION
  The installer does not contain the broker SDKs: their redistribution terms are not confirmed, so you download
  them yourself from PyPI. This script uses the app's own bundled Python and pip, installs exactly the versions
  the app was built and tested with (hash-checked, no dependency resolution: everything else is already bundled),
  into your profile -- never into the installation directory.

  Default root: %APPDATA%\<installed flavor>\provider-sdk, from installed_flavor.json (the app reads STOCK_MONITOR_PROVIDER_SDK_DIR instead when it
  is set). Each provider is installed into a new version folder, <root>\<provider>\v-<time>-<id>, imported and checked
  against the pinned version there, and only then made active (<root>\<provider>\active.txt, replaced atomically).
  A failed or interrupted install never touches the active version; the previous version is kept for a rollback.
  One install per provider at a time, across processes: <root>\<provider>\install.lock is held open exclusively
  for the whole install, so a second run (by hand, or the App's) is refused instead of sharing a folder.
  The app's 設定 → 券商帳號 runs this script and restarts that provider itself; when you run it by hand,
  restart StockMonitor afterwards. moomoo-api also needs the official OpenD program installed and logged in.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File "C:\Program Files\StockMonitor\resources\install_provider_sdk.ps1"
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install_provider_sdk.ps1 -Provider shioaji
#>
param(
  [ValidateSet("all", "shioaji", "futu")]
  [string]$Provider = "all",
  [string]$Target = ""
)

$ErrorActionPreference = "Stop"

# region install helpers (tests/test_provider_sdk_install_lock.py runs these)
# The provider's install lock: the file held open with no sharing until the returned stream is disposed. The OS
# releases it if the process dies, so a crashed install never blocks the next one.
function Open-ProviderInstallLock([string]$providerRoot) {
  $path = Join-Path $providerRoot "install.lock"
  try {
    return [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    throw "另一個 $(Split-Path -Leaf $providerRoot) SDK 安裝正在進行（$path 被占用）；請等它結束再試"
  }
}

# A version folder of its own: time for the reader, a random id so two installs never share one; created only if
# it does not exist yet.
function New-ProviderStage([string]$providerRoot) {
  $name = "v-" + (Get-Date -Format "yyyyMMddHHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
  $stage = Join-Path $providerRoot $name
  if (Test-Path -LiteralPath $stage) { throw "版本資料夾 $stage 已存在" }
  New-Item -ItemType Directory -Path $stage | Out-Null
  return $stage
}
# endregion
# The App reads this script's output as UTF-8 (Windows PowerShell 5.1 would otherwise write the ANSI code page).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$runtime = Join-Path $PSScriptRoot "app-runtime\python"
$python = Join-Path $runtime "python.exe"
if (-not (Test-Path $python)) { throw "找不到內建 Python：$python（請從安裝目錄的 resources 資料夾執行本腳本）" }

if (-not $Target) {
  if ($env:STOCK_MONITOR_PROVIDER_SDK_DIR) { $Target = $env:STOCK_MONITOR_PROVIDER_SDK_DIR }
  else {
    # The installed flavor's SDK root, generated from config/var_layout.json (scripts/tooling/installed_flavor.py).
    $flavorFile = Join-Path $PSScriptRoot "installed_flavor.json"
    if (-not (Test-Path $flavorFile)) { throw "找不到 $flavorFile（請從安裝目錄的 resources 資料夾執行本腳本）" }
    $flavor = Get-Content -Raw -Encoding UTF8 $flavorFile | ConvertFrom-Json
    if ($flavor.schema -ne "stock-monitor-installed-flavor-v1") { throw "不支援的 installed_flavor.json：$($flavor.schema)" }
    $Target = $env:APPDATA
    foreach ($part in $flavor.provider_sdk_dir) { $Target = Join-Path $Target $part }
  }
}
New-Item -ItemType Directory -Force -Path $Target | Out-Null
# 與 App 相同：內建 Python 不讀本機的 user site-packages（%APPDATA%\Python\...）。
$env:PYTHONNOUSERSITE = "1"

# The distribution whose version proves the install, and the module that must import, per provider.
$checks = @{ shioaji = @{ dist = "shioaji"; module = "shioaji" }; futu = @{ dist = "moomoo-api"; module = "moomoo" } }

$providers = if ($Provider -eq "all") { @("shioaji", "futu") } else { @($Provider) }
foreach ($name in $providers) {
  $requirements = Join-Path $runtime "provider_sdk\$name.txt"
  if (-not (Test-Path $requirements)) { throw "找不到 $requirements" }
  $check = $checks[$name]
  $pinned = (Select-String -Path $requirements -Pattern ("^" + [regex]::Escape($check.dist) + "==([^\s]+)") | Select-Object -First 1)
  if (-not $pinned) { throw "$requirements 沒有 $($check.dist) 的固定版本" }
  $version = $pinned.Matches[0].Groups[1].Value

  $providerRoot = Join-Path $Target $name
  New-Item -ItemType Directory -Force -Path $providerRoot | Out-Null
  $lock = Open-ProviderInstallLock $providerRoot
  try {
  $stage = New-ProviderStage $providerRoot
  Write-Host "安裝 $name SDK $version 到 $stage ..."
  try {
    & $python -m pip install --no-user --disable-pip-version-check --no-deps --require-hashes --target $stage -r $requirements
    if ($LASTEXITCODE -ne 0) { throw "$name SDK 安裝失敗（pip exit $LASTEXITCODE）" }
    # Imported from the new folder alone, and its version the pinned one: a partial install never becomes active.
    $probe = "import sys, importlib, importlib.metadata as m; sys.path.insert(0, sys.argv[1]); importlib.import_module(sys.argv[2]); print(m.version(sys.argv[3]))"
    $installed = (& $python -c $probe $stage $check.module $check.dist | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0) { throw "$name SDK 安裝後無法匯入（exit $LASTEXITCODE）" }
    if ("$installed".Trim() -ne $version) { throw "$name SDK 版本 $installed 不是預期的 $version" }
  } catch {
    $failure = $_
    try { Remove-Item -Recurse -Force -LiteralPath $stage -ErrorAction Stop }
    catch { Write-Warning "清除失敗的安裝資料夾 $stage 失敗：$($_.Exception.Message)" }
    throw $failure
  }
  # Activate, still under the lock: active.txt replaced in one rename from a temporary file of this install's own;
  # the version it named stays as the rollback, older ones go.
  if (-not (Test-Path -LiteralPath $stage -PathType Container)) { throw "版本資料夾 $stage 在啟用前消失" }
  $active = Join-Path $providerRoot "active.txt"
  $previous = if (Test-Path $active) { (Get-Content -LiteralPath $active -Raw).Trim() } else { "" }
  $tmp = "$active." + [guid]::NewGuid().ToString("N") + ".tmp"
  Set-Content -LiteralPath $tmp -Value (Split-Path -Leaf $stage) -Encoding ascii -NoNewline
  Move-Item -LiteralPath $tmp -Destination $active -Force
  Get-ChildItem -LiteralPath $providerRoot -Directory -Filter "v-*" | Where-Object { $_.Name -ne (Split-Path -Leaf $stage) -and $_.Name -ne $previous } |
    ForEach-Object { Remove-Item -Recurse -Force -LiteralPath $_.FullName -ErrorAction Continue }
  Write-Host "$name SDK $version 已啟用（$(Split-Path -Leaf $stage)）"
  } finally {
    $lock.Dispose()
  }
}
Write-Host "完成。（從 App 的 設定 → 券商帳號 安裝時，App 會自動重新啟動該行情來源；手動執行本腳本請重新啟動 StockMonitor。）"
