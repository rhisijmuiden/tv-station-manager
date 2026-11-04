<#
  TV Station Manager - provisioning job on a Windows node, started by the agent (scheduled task "tvsm-provision",
  SYSTEM) when the orchestrator sends a "provision" command (Nodes -> node -> Change role).
  Reads <Dir>\payload.json (+ smbpass.txt, deleted right away), writes progress to <Dir>\status.json and a log to
  <Dir>\provision.log. Steps, each skipped when not needed:
    1. Microsoft Visual C++ runtime (CasparCG needs it)            - vcredist
    2. Blackmagic Desktop Video (DeckLink driver) from the source configured in the orchestrator - decklink
    3. FFmpeg (BtbN GPL build, %ProgramFiles%\TVSM\ffmpeg, on PATH) - ffmpeg
    4. install-studio.ps1 -SkipAgent with the role and settings (CasparCG, MediaMTX, casparcg.config, share, firewall)
       or, for role "none", stop + disable the studio services (settings parked in studio.json.disabled)
    5. optional restart of the machine
  SPDX-License-Identifier: AGPL-3.0-only
#>
param([Parameter(Mandatory = $true)][string]$Dir)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$statusFile = Join-Path $Dir "status.json"
$logFile = Join-Path $Dir "provision.log"
$tmp = Join-Path $env:TEMP "tvsm-provision"
$studioData = Join-Path $env:ProgramData "TVSM\studio"
$headers = @{ "User-Agent" = "tvsm-provision" }
$global:TvsmStep = "start"
$global:TvsmReboot = $false
$p = Get-Content (Join-Path $Dir "payload.json") -Raw | ConvertFrom-Json
$id = [int]$p.id

function Write-Utf8([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) }
function Write-Status([string]$state, [string]$message = "", [string]$logTail = "") {
  $o = [ordered]@{ id = $id; state = $state; step = $global:TvsmStep; message = $message; rebootRequired = $global:TvsmReboot; updatedAt = (Get-Date).ToUniversalTime().ToString("o") }
  if ($logTail) { $o.log = $logTail }
  Write-Utf8 $statusFile ($o | ConvertTo-Json -Compress)
}
# Also called by install-studio.ps1 (Step), so its progress shows up in the orchestrator.
function Set-ProvisionStep([string]$s) {
  $global:TvsmStep = $s
  Write-Host ""
  Write-Host "==> $s"
  Write-Status "running"
}
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $exe @arguments 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
}
function Assert-Signed([string]$file, [string]$publisher) {
  $sig = Get-AuthenticodeSignature $file
  if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notmatch [regex]::Escape($publisher)) {
    throw "$([IO.Path]::GetFileName($file)) is not validly signed by $publisher ($($sig.Status)); not installed."
  }
  return $sig
}
# The media share credentials stored by install-studio.ps1 (DPAPI, LocalMachine), to read a UNC driver source.
function Connect-Unc([string]$path) {
  $cred = Join-Path $studioData "smb.cred"
  if (-not (Test-Path $cred)) { return }
  Add-Type -AssemblyName System.Security
  $c = Get-Content $cred -Raw | ConvertFrom-Json
  $plain = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($c.password), $null, "LocalMachine"))
  $root = ($path.TrimEnd("\") -split "\\" | Select-Object -First 4) -join "\"
  Invoke-Native net @("use", $root, $plain, "/user:$($c.username)", "/persistent:no")
}

Start-Transcript -Path $logFile -Append | Out-Null
try {
  Write-Host "Provisioning #$id on $($env:COMPUTERNAME): role $($p.role), components $(@($p.components) -join ', ')"
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $tmp -Force | Out-Null
  $components = @($p.components)
  $smbPassFile = Join-Path $Dir "smbpass.txt"
  $smbPassword = $null
  if (Test-Path $smbPassFile) {
    $smbPassword = ConvertTo-SecureString (Get-Content $smbPassFile -Raw).TrimEnd("`r", "`n") -AsPlainText -Force
    Remove-Item $smbPassFile -Force
  }

  if ($p.role -eq "none") {
    # ---- remove the studio role (reversible: settings and software stay) ----
    Set-ProvisionStep "disable"
    foreach ($s in "tvsm-casparcg", "tvsm-ingest") {
      if (Get-Service $s -ErrorAction SilentlyContinue) {
        Stop-Service $s -Force -ErrorAction SilentlyContinue
        Set-Service $s -StartupType Disabled
        Write-Host "$s stopped and disabled"
      }
    }
    Get-NetFirewallRule -Group "TV Station Manager" -ErrorAction SilentlyContinue | Disable-NetFirewallRule
    $sj = Join-Path $studioData "studio.json"
    if (Test-Path $sj) { Move-Item $sj "$sj.disabled" -Force; Write-Host "studio.json parked as studio.json.disabled" }
  } else {
    # ---- 1. Visual C++ runtime ----
    if ($components -contains "vcredist") {
      Set-ProvisionStep "vcredist"
      $exe = Join-Path $tmp "vc_redist.x64.exe"
      Invoke-WebRequest -UseBasicParsing -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $exe
      Assert-Signed $exe "Microsoft Corporation" | Out-Null
      $r = Start-Process $exe -ArgumentList "/install", "/quiet", "/norestart" -Wait -PassThru
      if ($r.ExitCode -eq 3010) { $global:TvsmReboot = $true } elseif ($r.ExitCode -notin 0, 1638) { throw "Visual C++ runtime installer exited with $($r.ExitCode)" }
      Write-Host "Visual C++ runtime OK (exit $($r.ExitCode))"
    }

    # ---- 2. DeckLink driver (Blackmagic Desktop Video) ----
    if ($components -contains "decklink") {
      Set-ProvisionStep "decklink"
      $src = [string]$p.deckLinkSource
      if (-not $src) { throw "No Desktop Video installer configured (orchestrator: Nodes -> Agent settings)." }
      $file = Join-Path $tmp ([IO.Path]::GetFileName(($src -split "\?")[0]))
      if ($src -match "^https://") { Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $src -OutFile $file }
      elseif ($src.StartsWith("\\")) { Connect-Unc $src; Copy-Item $src $file -Force }
      else { throw "Desktop Video source must be an https URL or a UNC path." }
      $msi = $file
      if ($file -match "(?i)\.zip$") {
        $x = Join-Path $tmp "desktopvideo"
        Expand-Archive $file -DestinationPath $x -Force
        $msi = (Get-ChildItem $x -Recurse -Filter "*.msi" | Where-Object { $_.Name -match "(?i)desktop ?video" } | Select-Object -First 1).FullName
        if (-not $msi) { $msi = (Get-ChildItem $x -Recurse -Filter "*.msi" | Select-Object -First 1).FullName }
        if (-not $msi) { throw "No .msi found in $([IO.Path]::GetFileName($file))" }
      }
      $sig = Assert-Signed $msi "Blackmagic"
      # Trust Blackmagic as driver publisher so the driver installs without a "Would you like to install" prompt.
      $store = New-Object Security.Cryptography.X509Certificates.X509Store("TrustedPublisher", "LocalMachine")
      $store.Open("ReadWrite"); $store.Add($sig.SignerCertificate); $store.Close()
      if ((Get-Service tvsm-casparcg -ErrorAction SilentlyContinue).Status -eq "Running") { Write-Host "Stopping CasparCG for the driver installation"; Stop-Service tvsm-casparcg -Force }
      $r = Start-Process msiexec.exe -ArgumentList "/i", "`"$msi`"", "/qn", "/norestart", "/l*v", "`"$(Join-Path $Dir 'desktopvideo-msi.log')`"" -Wait -PassThru
      if ($r.ExitCode -in 3010, 1641) { $global:TvsmReboot = $true } elseif ($r.ExitCode -ne 0) { throw "Desktop Video installer exited with $($r.ExitCode) (see desktopvideo-msi.log)" }
      $global:TvsmReboot = $true # a new kernel driver is only active after a restart
      Write-Host "Desktop Video installed from $([IO.Path]::GetFileName($msi))"
    }

    # ---- 3. FFmpeg ----
    if ($components -contains "ffmpeg") {
      Set-ProvisionStep "ffmpeg"
      $rel = Invoke-RestMethod -UseBasicParsing -Headers $headers "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest"
      $asset = $rel.assets | Where-Object { $_.name -match '^ffmpeg-n(\d+)\.(\d+)-latest-win64-gpl-\d+\.\d+\.zip$' } |
        Sort-Object { [version]($_.name -replace '^ffmpeg-n(\d+\.\d+).*$', '$1') } -Descending | Select-Object -First 1
      if (-not $asset) { throw "No FFmpeg release build found on BtbN/FFmpeg-Builds" }
      $zip = Join-Path $tmp $asset.name
      Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $asset.browser_download_url -OutFile $zip
      $sums = $rel.assets | Where-Object { $_.name -eq "checksums.sha256" } | Select-Object -First 1
      $expected = $null
      if ($sums) {
        $sf = Join-Path $tmp "ffmpeg-checksums.sha256"
        Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $sums.browser_download_url -OutFile $sf
        $line = (Get-Content $sf) | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
        if ($line) { $expected = ($line -split "\s+")[0] }
      }
      if (-not $expected -and $asset.digest -and $asset.digest.StartsWith("sha256:")) { $expected = $asset.digest.Substring(7) }
      if (-not $expected) { throw "No checksum published for $($asset.name)" }
      if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $expected.ToLower()) { throw "Checksum mismatch for $($asset.name)" }
      $x = Join-Path $tmp "ffmpeg"
      Expand-Archive $zip -DestinationPath $x -Force
      $bin = Get-ChildItem $x -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
      $dest = Join-Path $env:ProgramFiles "TVSM\ffmpeg"
      Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory $dest -Force | Out-Null
      Copy-Item (Join-Path $bin.Directory.Parent.FullName "*") $dest -Recurse -Force
      $destBin = Join-Path $dest "bin"
      $path = [Environment]::GetEnvironmentVariable("Path", "Machine")
      if (($path -split ";") -notcontains $destBin) { [Environment]::SetEnvironmentVariable("Path", "$path;$destBin", "Machine") }
      Write-Host "FFmpeg installed: $((& (Join-Path $destBin 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1))"
    }

    # ---- 4. studio role (install-studio.ps1) ----
    Set-ProvisionStep "studio"
    $sj = Join-Path $studioData "studio.json"
    if (-not (Test-Path $sj) -and (Test-Path "$sj.disabled")) {
      Move-Item "$sj.disabled" $sj -Force
      foreach ($s in "tvsm-casparcg", "tvsm-ingest") { if (Get-Service $s -ErrorAction SilentlyContinue) { Set-Service $s -StartupType Automatic } }
      Write-Host "Restored the parked studio settings"
    }
    $a = @{ SkipAgent = $true; NonInteractive = $true; Role = [string]$p.role; Channel = [string]$p.channel; Repo = [string]$p.repository }
    if ($p.outputs) { $a.Outputs = [int]$p.outputs }
    if ($p.videoMode) { $a.VideoMode = [string]$p.videoMode }
    if ($p.keyer) { $a.Keyer = [string]$p.keyer }
    if ($p.htmlGpu) { $a.HtmlGpu = [string]$p.htmlGpu }
    if ($p.mediaPath) { $a.MediaPath = [string]$p.mediaPath }
    if ($p.smbUser) { $a.SmbUser = [string]$p.smbUser; $a.SmbPassword = $smbPassword }
    if ($p.managementHosts) { $a.ManagementHost = @($p.managementHosts | ForEach-Object { [string]$_ }) }
    if ($p.managementUrl) { $a.ManagementUrl = [string]$p.managementUrl }
    $global:LASTEXITCODE = 0
    & (Join-Path $here "install-studio.ps1") @a
    # install-studio.ps1 throws on errors; exit 2 = port 5250 taken (native tools may leave other exit codes behind).
    if ($LASTEXITCODE -eq 2) { throw "Port 5250 is used by other software (another CasparCG?). Stop it first; tvsm-casparcg is installed but not started." }
  }

  $msg = if ($p.role -eq "none") { "Studio role removed" } else { "Node set up as $($p.role)" }
  if ($p.rebootWhenDone) {
    $global:TvsmStep = "reboot"
    Write-Status "done" "$msg; restarting in 60 seconds"
    Write-Host "Restarting in 60 seconds"
    Stop-Transcript | Out-Null
    shutdown.exe /r /t 60 /c "TV Station Manager: provisioning finished" | Out-Null
  } else {
    $global:TvsmStep = "done"
    Write-Status "done" $msg
    Stop-Transcript | Out-Null
  }
} catch {
  $err = $_.Exception.Message
  Write-Host "FAILED: $err"
  try { Stop-Transcript | Out-Null } catch { }
  $tail = ""
  try { $tail = ((Get-Content $logFile -Tail 25) -join "`n") } catch { }
  Write-Status "failed" $err $tail
} finally {
  Remove-Item (Join-Path $Dir "smbpass.txt") -Force -ErrorAction SilentlyContinue
  schtasks.exe /Delete /TN tvsm-provision /F | Out-Null
}
