<#
.SYNOPSIS
  Builds MCP Explorer for Windows as an unpacked app: release\win-unpacked\MCP Explorer.exe.

.DESCRIPTION
  The package:windows CI job's steps, stopping short of the installer:
  dependencies installed if needed, every package and the renderer compiled
  (npm run build), then electron-builder --dir. Nothing compiles natively: the
  SQLite module ships N-API prebuilds and electron-builder runs with
  npmRebuild false. Runs under Windows PowerShell 5.1 and PowerShell 7.

.PARAMETER Clean
  Reinstall dependencies with npm ci even when node_modules exists.

.EXAMPLE
  .\scripts\build.ps1

.EXAMPLE
  .\scripts\build.ps1 -Clean
#>
[CmdletBinding()]
param(
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$unpacked = Join-Path $repo 'release\win-unpacked'
$exe = Join-Path $unpacked 'MCP Explorer.exe'

# Runs one step and stops the build on a non-zero exit, naming the step.
function Invoke-Step([string]$Name, [scriptblock]$Command) {
  Write-Host "== $Name" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
}

foreach ($tool in 'node', 'npm') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is not on PATH. Install Node.js and open a new shell."
  }
}

# A running copy holds its files open, and electron-builder then fails to
# replace them with an error that does not say why.
$running = @(Get-Process -Name 'MCP Explorer' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$unpacked\*" })
if ($running.Count -gt 0) {
  throw "MCP Explorer is running from $unpacked (PID $($running.Id -join ', ')). Close it and build again."
}

Push-Location $repo
try {
  Write-Host "node $(node --version), npm $(npm --version)"
  # --ignore-scripts is load-bearing: the SQLite package's install script runs
  # node-gyp rebuild, which needs a compiler and a Python this build never uses:
  # the module ships prebuilt binaries.
  # The flag also skips electron's postinstall, which fetches the binary that
  # npm start and the smoke tests run; it is run by hand, as CI does.
  # The packaged app does not need it: electron-builder fetches its own copy.
  if ($Clean -or -not (Test-Path 'node_modules')) {
    Invoke-Step 'npm ci --ignore-scripts' { npm ci --ignore-scripts }
    Invoke-Step 'electron install' { node node_modules/electron/install.js }
  } else {
    Write-Host '== node_modules present, install skipped (-Clean reinstalls)' -ForegroundColor Cyan
  }
  Invoke-Step 'npm run build' { npm run build }
  Invoke-Step 'electron-builder --dir' { npx electron-builder --win --dir --publish never }
  if (-not (Test-Path -LiteralPath $exe)) { throw "electron-builder finished, and $exe is missing." }
  Write-Host "Built: $exe" -ForegroundColor Green
} finally {
  Pop-Location
}
