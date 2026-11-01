<#
  TV Station Manager - CasparCG launcher, run by the "tvsm-casparcg" service (WinSW, LocalSystem).
  1. Connects the media share (UNAS) with the credentials stored by install-studio.ps1 (DPAPI, machine scope).
  2. Starts casparcg.exe with stdin held open (CasparCG reads console commands from it) and waits.
  The service restarts CasparCG when it exits (also after the AMCP RESTART command, exit code 5).
#>
$ErrorActionPreference = "Stop"
$data = Join-Path $env:ProgramData "TVSM\studio"
$cfg = Get-Content (Join-Path $data "studio.json") -Raw | ConvertFrom-Json

# Native commands (net.exe) write to stderr when e.g. a connection does not exist; with
# $ErrorActionPreference = "Stop" Windows PowerShell 5.1 turns that into a terminating error. Run them with
# "Continue" and let the caller check $LASTEXITCODE.
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $exe @arguments 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
}

function Connect-Share {
  $credFile = Join-Path $data "smb.cred"
  if (-not $cfg.mediaPath -or -not $cfg.mediaPath.StartsWith("\\") -or -not (Test-Path $credFile)) { return }
  Add-Type -AssemblyName System.Security
  $c = Get-Content $credFile -Raw | ConvertFrom-Json
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($c.password), $null, "LocalMachine")
  $pw = [Text.Encoding]::UTF8.GetString($bytes)
  # \\host\share\sub\dir -> \\host\share
  $root = ($cfg.mediaPath.TrimEnd("\") -split "\\" | Select-Object -First 4) -join "\"
  for ($i = 1; $i -le 10; $i++) {
    Invoke-Native net @("use", $root, "/delete", "/y")
    Invoke-Native net @("use", $root, $pw, "/user:$($c.username)", "/persistent:no")
    if ($LASTEXITCODE -eq 0 -and (Test-Path $cfg.mediaPath)) { Write-Host "Media share $root connected"; return }
    Write-Host "Media share $root not reachable yet (attempt $i), retrying"
    Start-Sleep -Seconds ([Math]::Min(30, 3 * $i))
  }
  Write-Host "WARNING: media share $root is not reachable; CasparCG starts without it"
}

Connect-Share
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $cfg.casparDir "casparcg.exe"
$psi.WorkingDirectory = $cfg.casparDir
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$p = [Diagnostics.Process]::Start($psi)
Write-Host "CasparCG started (pid $($p.Id))"
$p.WaitForExit()
Write-Host "CasparCG exited with code $($p.ExitCode)"
# Non-zero exit makes WinSW restart the service; a clean exit (0) is also unexpected here, so restart too.
exit $(if ($p.ExitCode -eq 0) { 1 } else { $p.ExitCode })
