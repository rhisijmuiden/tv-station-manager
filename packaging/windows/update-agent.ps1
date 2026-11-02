<#
  TV Station Manager - applies a downloaded agent update on Windows.
  The agent verifies the zip (SHA256SUMS), copies this script next to it in %ProgramData%\TVSM\agent\update and starts
  it as a one-off scheduled task (SYSTEM), because WinSW stops child processes together with the service.
#>
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here "update.log"
function Log($m) { "$(Get-Date -Format o) $m" | Out-File -Append -Encoding utf8 $log }
try {
  $zip = Get-ChildItem $here -Filter "tvsm-agent_*_windows-x64.zip" | Select-Object -First 1
  if (-not $zip) { throw "No update zip in $here" }
  $dir = Join-Path $env:ProgramFiles "TVSM\agent"
  $svc = Join-Path $dir "tvsm-agent-service.exe"
  Log "Updating agent from $($zip.Name)"
  & $svc stop | Out-Null
  for ($i = 0; $i -lt 30 -and (Get-Service tvsm-agent).Status -ne "Stopped"; $i++) { Start-Sleep 1 }
  Expand-Archive $zip.FullName -DestinationPath $dir -Force
  & $svc start | Out-Null
  Log "Agent started: $(Get-Content (Join-Path $dir 'VERSION'))"
} catch {
  Log "Update failed: $($_.Exception.Message)"
  # Never leave the node without an agent.
  try { Start-Service tvsm-agent } catch { }
} finally {
  schtasks.exe /Delete /TN tvsm-agent-update /F | Out-Null
}
