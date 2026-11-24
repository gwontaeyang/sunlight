#!/usr/bin/env pwsh
# Sunlight — set up and run with a single command on Windows (PowerShell).
#
#   .\start.ps1
#
# It checks Node, installs dependencies and builds on the first run, then starts
# the app. Open the http://127.0.0.1:… address it prints, and press Ctrl+C to stop.
#
# If PowerShell says running scripts is disabled, start it once with:
#   powershell -ExecutionPolicy Bypass -File .\start.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Say($msg) { Write-Host $msg -ForegroundColor Yellow }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say "Node.js is not installed. Install Node 22 (LTS) from https://nodejs.org/ (the Windows Installer .msi),"
  Say "then close and reopen PowerShell and run  .\start.ps1  again."
  exit 1
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
  Say "Sunlight needs Node 22 or newer — you have $(node -v)."
  Say "Install Node 22 (LTS) from https://nodejs.org/ and reopen PowerShell."
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Say "'npm' was not found next to Node. Reinstall Node 22 from https://nodejs.org/ so a matching npm comes with it,"
  Say "then run  .\start.ps1  again."
  exit 1
}

if (-not (Test-Path node_modules)) {
  Say "Installing dependencies — first run only, this can take a minute…"
  npm ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path apps/web/dist)) {
  Say "Building the app — first run only…"
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Say "Starting Sunlight. Open the http://127.0.0.1:… address printed below. Press Ctrl+C to stop."
npm run start:user -- --user-data
exit $LASTEXITCODE
