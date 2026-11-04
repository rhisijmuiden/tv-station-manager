<#
  TV Station Manager - applies a downloaded agent update on Windows.
  The agent verifies the zip (SHA256SUMS), copies this script next to it in %ProgramData%\TVSM\agent\update and starts
  it as a one-off scheduled task (SYSTEM), because WinSW stops child processes together with the service.
  Safety net: the current agent is copied to update\previous first. The new agent writes health.json after its first
  good heartbeat with the orchestrator; when that does not happen within 3 minutes, the previous version is put back.
  Only the agent restarts: CasparCG and the ingest server keep running, so the SDI outputs are not interrupted.
  SPDX-License-Identifier: AGPL-3.0-only
#>
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here "update.log"
function Log($m) { "$(Get-Date -Format o) $m" | Out-File -Append -Encoding utf8 $log }
$dir = Join-Path $env:ProgramFiles "TVSM\agent"
$svc = Join-Path $dir "tvsm-agent-service.exe"
$backup = Join-Path $here "previous"
$health = Join-Path $env:ProgramData "TVSM\agent\health.json"
function Stop-Agent {
  & $svc stop | Out-Null
  for ($i = 0; $i -lt 30 -and (Get-Service tvsm-agent).Status -ne "Stopped"; $i++) { Start-Sleep 1 }
}
try {
  $zip = Get-ChildItem $here -Filter "tvsm-agent_*_windows-x64.zip" | Select-Object -First 1
  if (-not $zip) { throw "No update zip in $here" }
  $old = (Get-Content (Join-Path $dir "VERSION") -ErrorAction SilentlyContinue | Select-Object -First 1)
  Log "Updating agent $old from $($zip.Name)"
  Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $backup -Force | Out-Null
  Copy-Item (Join-Path $dir "*") $backup -Recurse -Force
  Stop-Agent
  Remove-Item $health -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip.FullName -DestinationPath $dir -Force
  $new = (Get-Content (Join-Path $dir "VERSION") | Select-Object -First 1).Trim()
  & $svc start | Out-Null
  Log "Agent $new started, waiting for its first heartbeat"
  $ok = $false
  for ($i = 0; $i -lt 180 -and -not $ok; $i += 5) {
    Start-Sleep 5
    try { $ok = ((Get-Content $health -Raw | ConvertFrom-Json).version -eq $new) } catch { }
  }
  if ($ok) {
    Log "Agent $new is healthy"
  } else {
    Log "Agent $new did not report to the orchestrator within 3 minutes: rolling back to $old"
    Stop-Agent
    Copy-Item (Join-Path $backup "*") $dir -Recurse -Force
    & $svc start | Out-Null
    Log "Rolled back to $old"
  }
} catch {
  Log "Update failed: $($_.Exception.Message)"
  # Never leave the node without an agent.
  try {
    if (-not (Test-Path (Join-Path $dir "agent.mjs")) -and (Test-Path (Join-Path $backup "agent.mjs"))) { Copy-Item (Join-Path $backup "*") $dir -Recurse -Force }
    Start-Service tvsm-agent
  } catch { }
} finally {
  schtasks.exe /Delete /TN tvsm-agent-update /F | Out-Null
}
