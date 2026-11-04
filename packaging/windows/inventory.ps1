<#
  TV Station Manager - software/hardware inventory of a Windows node. Prints one JSON object; the agent runs it every
  10 minutes and reports it to the orchestrator (Nodes -> node -> Role & software). Read-only.
  SPDX-License-Identifier: AGPL-3.0-only
#>
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
$data = Join-Path $env:ProgramData "TVSM\studio"
$uninstall = @("HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*")
$apps = Get-ItemProperty $uninstall | Where-Object { $_.DisplayName }

$os = Get-CimInstance Win32_OperatingSystem
$dv = $apps | Where-Object { $_.DisplayName -match "Desktop Video" -and $_.Publisher -match "Blackmagic" } | Select-Object -First 1
$decklinks = @(Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -match "DeckLink" -and $_.Status -eq "OK" } | ForEach-Object { $_.FriendlyName })
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch "(?i)basic|remote|virtual|hyper-v|vmware" } | Select-Object -First 1

$ffmpegExe = Join-Path $env:ProgramFiles "TVSM\ffmpeg\bin\ffmpeg.exe"
if (-not (Test-Path $ffmpegExe)) { $ffmpegExe = (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue).Source }
$ffmpeg = $null
if ($ffmpegExe) {
  $line = (& $ffmpegExe -hide_banner -version 2>$null | Select-Object -First 1)
  if ($line -match "ffmpeg version (\S+)") { $ffmpeg = $Matches[1] }
}

$vc = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
if (-not $vc) { $vc = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" }
$vcVersion = if ($vc -and $vc.Installed -eq 1) { "$($vc.Major).$($vc.Minor).$($vc.Bld)" } else { $null }

$studio = $null
if (Test-Path (Join-Path $data "studio.json")) { $studio = Get-Content (Join-Path $data "studio.json") -Raw | ConvertFrom-Json }
$caspar = if ($studio -and $studio.casparVersion -and (Test-Path (Join-Path $env:ProgramFiles "TVSM\casparcg\casparcg.exe"))) { $studio.casparVersion } elseif (Test-Path (Join-Path $env:ProgramFiles "TVSM\casparcg\casparcg.exe")) { "installed" } else { $null }
$mtx = if ($studio -and $studio.mediamtxVersion -and (Test-Path (Join-Path $env:ProgramFiles "TVSM\ingest\mediamtx.exe"))) { $studio.mediamtxVersion } elseif (Test-Path (Join-Path $env:ProgramFiles "TVSM\ingest\mediamtx.exe")) { "installed" } else { $null }

$rebootPending = (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") -or
  (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") -or
  [bool](Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager" -Name PendingFileRenameOperations).PendingFileRenameOperations

[ordered]@{
  os = if ($os) { "$($os.Caption) ($($os.BuildNumber))" } else { $null }
  powershell = $PSVersionTable.PSVersion.ToString()
  desktopVideo = if ($dv) { $dv.DisplayVersion } else { $null }
  decklinks = $decklinks
  gpu = if ($gpu) { [ordered]@{ name = $gpu.Name; driver = $gpu.DriverVersion } } else { $null }
  ffmpeg = $ffmpeg
  vcredist = $vcVersion
  casparcg = $caspar
  mediamtx = $mtx
  shareCredentials = Test-Path (Join-Path $data "smb.cred")
  rebootPending = [bool]$rebootPending
  studioParked = Test-Path (Join-Path $data "studio.json.disabled")
} | ConvertTo-Json -Compress -Depth 4
