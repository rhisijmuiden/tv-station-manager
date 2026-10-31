<#
  TV Station Manager - studio node installer for Windows (CasparCG + DeckLink + RTMP ingest).
  Run in an elevated PowerShell:
    iwr -useb https://raw.githubusercontent.com/rhisijmuiden/tv-station-manager/production/packaging/windows/install-studio.ps1 -OutFile $env:TEMP\install-studio.ps1
    & $env:TEMP\install-studio.ps1 -Orchestrator http://10.40.6.201:8080 -ManagementHost 10.40.6.202 -MediaPath \\unas\TV -SmbUser tvsm

  What it does (safe to run again; it then updates CasparCG/MediaMTX and rewrites the configuration):
    1. Installs the TV Station Manager agent (install-agent.ps1) and registers it with the orchestrator.
    2. Installs CasparCG Server 2.4 to %ProgramFiles%\TVSM\casparcg, writes casparcg.config with one channel per
       DeckLink output, the UNAS share as media folder and the TVSM overlay templates, and runs it as the service
       "tvsm-casparcg" (connects the media share with stored credentials first).
    3. Installs MediaMTX as the RTMP/SRT ingest server ("tvsm-ingest"): remote sources push to
       rtmp://<this node>/live/<name>, CasparCG plays rtmp://127.0.0.1/live/<name> onto a DeckLink output.
    4. Opens the firewall (AMCP 5250 for the management node, RTMP 1935, SRT 8890) and disables sleep.
  Settings live in %ProgramData%\TVSM\studio (studio.json, smb.cred, mediamtx.yml).
#>
param(
  [string]$Orchestrator = "",
  [ValidateSet("production", "test")][string]$Channel = "production",
  [string]$Repo = "rhisijmuiden/tv-station-manager",
  # UNC path of the media folder, the same folder the management node scans (e.g. \\10.40.1.10\TV).
  [string]$MediaPath = "",
  [string]$SmbUser = "",
  [SecureString]$SmbPassword,
  [ValidateRange(1, 8)][int]$Outputs = 4,
  # CasparCG video mode for every channel, e.g. 1080i5000, 1080p5000, 720p5000, 1080p2500.
  [string]$VideoMode = "1080i5000",
  # IP address(es) of the management node that may connect to AMCP (TCP 5250). Empty = any address.
  [string[]]$ManagementHost = @(),
  # Address used in the RTMP push URL shown to remote contributors. Default: this machine's first IPv4 address.
  [string]$PublicHost = "",
  [string]$CasparVersion = "2.4",
  [string]$MediaMtxVersion = "latest",
  [switch]$SkipAgent
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run this script in an elevated (Administrator) PowerShell." }
if (-not [Environment]::Is64BitOperatingSystem) { throw "64-bit Windows is required." }

function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "WARNING: $m" -ForegroundColor Yellow }
$headers = @{ "User-Agent" = "tvsm-studio-installer" }
$branch = if ($Channel -eq "test") { "test" } else { "production" }
$agentDir = Join-Path $env:ProgramFiles "TVSM\agent"
$casparDir = Join-Path $env:ProgramFiles "TVSM\casparcg"
$ingestDir = Join-Path $env:ProgramFiles "TVSM\ingest"
$data = Join-Path $env:ProgramData "TVSM\studio"
$logs = Join-Path $data "logs"
$tmp = Join-Path $env:TEMP "tvsm-studio-install"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $tmp, $data, $logs -Force | Out-Null
# Only SYSTEM and Administrators may read the share credentials and the ingest password.
icacls $data /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

$old = $null
if (Test-Path (Join-Path $data "studio.json")) { $old = Get-Content (Join-Path $data "studio.json") -Raw | ConvertFrom-Json }
if (-not $MediaPath -and $old) { $MediaPath = $old.mediaPath }
if ($MediaPath -and -not $MediaPath.StartsWith("\\") -and -not ($MediaPath -match '^[A-Za-z]:\\')) { throw "-MediaPath must be a UNC path (\\server\share\folder) or a local folder." }

function Get-Release([string]$repo, [scriptblock]$pick) {
  $all = Invoke-RestMethod -Headers $headers "https://api.github.com/repos/$repo/releases?per_page=30"
  $r = $all | Where-Object { -not $_.draft -and -not $_.prerelease } | Where-Object $pick | Select-Object -First 1
  if (-not $r) { throw "No matching release found in $repo." }
  return $r
}
function Get-Verified($asset, [string]$expected) {
  $file = Join-Path $tmp $asset.name
  Write-Host "Downloading $($asset.name)"
  Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile $file
  if (-not $expected -and $asset.digest -and $asset.digest.StartsWith("sha256:")) { $expected = $asset.digest.Substring(7) }
  if ($expected) {
    if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $expected.ToLower()) { throw "Checksum mismatch for $($asset.name), installation aborted." }
    Write-Host "Checksum OK"
  } else { Warn "No checksum published for $($asset.name); downloaded over HTTPS from GitHub." }
  return $file
}
function Install-WinSW([string]$dir, [string]$id, [string]$xml) {
  $exe = Join-Path $dir "$id-service.exe"
  if (Get-Service $id -ErrorAction SilentlyContinue) { & $exe stop 2>$null | Out-Null; Start-Sleep 2 }
  Copy-Item (Join-Path $agentDir "tvsm-agent-service.exe") $exe -Force
  Set-Content -Path (Join-Path $dir "$id-service.xml") -Value $xml -Encoding UTF8
  if (-not (Get-Service $id -ErrorAction SilentlyContinue)) { & $exe install | Out-Null }
  return $exe
}
function Esc([string]$s) { [Security.SecurityElement]::Escape($s) }

# ---- 1. agent ------------------------------------------------------------------------
if (-not $SkipAgent) {
  Step "TV Station Manager agent"
  # From a repository checkout use the script next to this one, otherwise fetch it from the same branch.
  $agentScript = Join-Path $PSScriptRoot "install-agent.ps1"
  if (-not (Test-Path (Join-Path $PSScriptRoot "build-zip.sh"))) {
    $agentScript = Join-Path $tmp "install-agent.ps1"
    Invoke-WebRequest -Headers $headers -Uri "https://raw.githubusercontent.com/$Repo/$branch/packaging/windows/install-agent.ps1" -OutFile $agentScript
  }
  & $agentScript -Orchestrator $Orchestrator -Channel $Channel -Repo $Repo
}
$studioFiles = Join-Path $agentDir "studio"
if (-not (Test-Path (Join-Path $studioFiles "start-casparcg.ps1"))) { throw "The installed agent has no studio files ($studioFiles). Install a newer agent release (step 4 or later)." }

# ---- 2. checks ------------------------------------------------------------------------
Step "Checking DeckLink driver"
# Desktop Video installs DeckLinkAPI64.dll in its own folder (newer versions) or in System32, and registers it as COM.
$dvDirs = @((Join-Path $env:ProgramFiles "Blackmagic Design\Blackmagic Desktop Video"), (Join-Path $env:WINDIR "System32"))
$dvFound = ($dvDirs | Where-Object { Test-Path (Join-Path $_ "DeckLinkAPI64.dll") }) -or (Test-Path "Registry::HKEY_CLASSES_ROOT\BMDDeckLinkAPI.CBMDDeckLinkIterator")
$cards = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match "DeckLink" -and $_.Status -eq "OK" }
if ($cards) { $cards | ForEach-Object { Write-Host "Found: $($_.FriendlyName)" } }
if ($dvFound) { Write-Host "Blackmagic Desktop Video driver found" }
else { Warn "Blackmagic Desktop Video is not installed. Install it from https://www.blackmagicdesign.com/support (Desktop Video), reboot, then run this script again. CasparCG starts, but without SDI outputs." }

# ---- 3. CasparCG -----------------------------------------------------------------------
Step "CasparCG Server $CasparVersion"
$cr = Get-Release "CasparCG/server" { $_.tag_name -match "^v?$([regex]::Escape($CasparVersion))(\.|$)" -and ($_.assets | Where-Object { $_.name -match '(?i)win.*\.zip$' }) }
$casparTag = $cr.tag_name
if ($old -and $old.casparVersion -eq $casparTag -and (Test-Path (Join-Path $casparDir "casparcg.exe"))) {
  Write-Host "CasparCG $casparTag is already installed"
} else {
  $asset = $cr.assets | Where-Object { $_.name -match '(?i)win.*\.zip$' } | Select-Object -First 1
  $zip = Get-Verified $asset $null
  $x = Join-Path $tmp "casparcg"
  Expand-Archive $zip -DestinationPath $x -Force
  $exe = Get-ChildItem $x -Recurse -Filter "casparcg.exe" | Select-Object -First 1
  if (-not $exe) { throw "casparcg.exe not found in $($asset.name)." }
  if (Get-Service tvsm-casparcg -ErrorAction SilentlyContinue) { Stop-Service tvsm-casparcg -Force; Start-Sleep 2 }
  New-Item -ItemType Directory $casparDir -Force | Out-Null
  Copy-Item (Join-Path $exe.DirectoryName "*") $casparDir -Recurse -Force
  Write-Host "Installed CasparCG $casparTag to $casparDir"
}

$consumers = ""
$outs = @()
for ($i = 1; $i -le $Outputs; $i++) {
  $outs += [ordered]@{ device = $i; channel = $i; format = $VideoMode }
  $consumers += @"
    <channel>
      <video-mode>$(Esc $VideoMode)</video-mode>
      <consumers>
        <decklink>
          <device>$i</device>
          <embedded-audio>true</embedded-audio>
          <latency>normal</latency>
          <buffer-depth>3</buffer-depth>
        </decklink>
      </consumers>
    </channel>

"@
}
$mediaDir = if ($MediaPath) { $MediaPath.TrimEnd("\") + "\" } else { (Join-Path $casparDir "media") + "\" }
$templateDir = (Join-Path $studioFiles "templates") + "\"
$config = @"
<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by TV Station Manager install-studio.ps1. Run the installer again instead of editing by hand. -->
<configuration>
  <paths>
    <media-path>$(Esc $mediaDir)</media-path>
    <log-path disable="false">$(Esc ((Join-Path $logs "casparcg") + "\"))</log-path>
    <data-path>$(Esc ((Join-Path $data "casparcg-data") + "\"))</data-path>
    <template-path>$(Esc $templateDir)</template-path>
  </paths>
  <log-level>info</log-level>
  <channels>
$consumers  </channels>
  <controllers>
    <tcp>
      <port>5250</port>
      <protocol>AMCP</protocol>
    </tcp>
  </controllers>
  <html>
    <enable-gpu>false</enable-gpu>
  </html>
</configuration>
"@
$cfgFile = Join-Path $casparDir "casparcg.config"
if (Test-Path $cfgFile) { Copy-Item $cfgFile "$cfgFile.bak" -Force }
Set-Content -Path $cfgFile -Value $config -Encoding UTF8
New-Item -ItemType Directory (Join-Path $logs "casparcg"), (Join-Path $data "casparcg-data") -Force | Out-Null
if (-not $MediaPath) { New-Item -ItemType Directory (Join-Path $casparDir "media") -Force | Out-Null }

# ---- 4. media share credentials ------------------------------------------------------------
if ($MediaPath.StartsWith("\\") -and $SmbUser) {
  Step "Media share credentials"
  if (-not $SmbPassword) { $SmbPassword = Read-Host "Password for $SmbUser on $MediaPath" -AsSecureString }
  Add-Type -AssemblyName System.Security
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($SmbPassword))
  $enc = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, "LocalMachine")
  @{ username = $SmbUser; password = [Convert]::ToBase64String($enc) } | ConvertTo-Json | Set-Content (Join-Path $data "smb.cred") -Encoding UTF8
  $root = ($MediaPath.TrimEnd("\") -split "\\" | Select-Object -First 4) -join "\"
  net use $root /delete /y 2>$null | Out-Null
  net use $root $plain /user:$SmbUser /persistent:no 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0 -and (Test-Path $MediaPath)) { Write-Host "Media share reachable" } else { Warn "Could not open $MediaPath with these credentials. CasparCG retries at every start." }
  net use $root /delete /y 2>$null | Out-Null
  $plain = $null
}

# ---- 5. RTMP / SRT ingest (MediaMTX) ----------------------------------------------------------
Step "RTMP ingest (MediaMTX $MediaMtxVersion)"
$mr = Get-Release "bluenviron/mediamtx" { ($MediaMtxVersion -eq "latest" -or $_.tag_name -eq "v$($MediaMtxVersion.TrimStart('v'))") -and ($_.assets | Where-Object { $_.name -match '_windows_amd64\.zip$' }) }
$mtxTag = $mr.tag_name
if ($old -and $old.mediamtxVersion -eq $mtxTag -and (Test-Path (Join-Path $ingestDir "mediamtx.exe"))) {
  Write-Host "MediaMTX $mtxTag is already installed"
} else {
  $asset = $mr.assets | Where-Object { $_.name -match '_windows_amd64\.zip$' } | Select-Object -First 1
  $expected = $null
  $sumAsset = $mr.assets | Where-Object { $_.name -eq "checksums.sha256" } | Select-Object -First 1
  if ($sumAsset) {
    $line = ((Invoke-WebRequest -Headers $headers -Uri $sumAsset.browser_download_url).Content -split "`n") | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
    if ($line) { $expected = ($line -split "\s+")[0] }
  }
  $zip = Get-Verified $asset $expected
  if (Get-Service tvsm-ingest -ErrorAction SilentlyContinue) { Stop-Service tvsm-ingest -Force; Start-Sleep 2 }
  New-Item -ItemType Directory $ingestDir -Force | Out-Null
  Expand-Archive $zip -DestinationPath $ingestDir -Force
  Write-Host "Installed MediaMTX $mtxTag to $ingestDir"
}
$publishPass = if ($old -and $old.publishPassword) { $old.publishPassword } else { -join ((48..57) + (97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ }) }
$mtxCfg = Join-Path $data "mediamtx.yml"
@"
# Generated by TV Station Manager install-studio.ps1.
logLevel: info
logDestinations: [file]
logFile: $(Join-Path $logs "mediamtx.log")
api: true
apiAddress: 127.0.0.1:9997
metrics: false
pprof: false
playback: false
rtsp: false
hls: false
webrtc: false
rtmp: true
rtmpAddress: :1935
srt: true
srtAddress: :8890
authMethod: internal
authInternalUsers:
  # Remote contributors: stream key "<name>?user=publish&pass=<password>".
  - user: publish
    pass: $publishPass
    ips: []
    permissions:
      - action: publish
  # CasparCG and the agent on this machine.
  - user: any
    pass:
    ips: ['127.0.0.1', '::1']
    permissions:
      - action: read
      - action: api
paths:
  all_others:
"@ | Set-Content -Path $mtxCfg -Encoding UTF8

# ---- 6. studio.json --------------------------------------------------------------------------
if (-not $PublicHost) {
  $PublicHost = (Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Manual, Dhcp -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | Sort-Object InterfaceIndex | Select-Object -First 1).IPAddress
}
[ordered]@{
  casparDir = $casparDir
  casparVersion = $casparTag
  amcpPort = 5250
  casparService = "tvsm-casparcg"
  ingestService = "tvsm-ingest"
  ingestApiPort = 9997
  mediamtxVersion = $mtxTag
  rtmpUrl = if ($PublicHost) { "rtmp://$PublicHost/live" } else { $null }
  publishPassword = $publishPass
  mediaPath = if ($MediaPath) { $MediaPath } else { $null }
  outputs = $outs
} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $data "studio.json") -Encoding UTF8

# ---- 7. services ------------------------------------------------------------------------------
Step "Services"
$launcher = Join-Path $studioFiles "start-casparcg.ps1"
$casparSvc = Install-WinSW $casparDir "tvsm-casparcg" @"
<service>
  <id>tvsm-casparcg</id>
  <name>TV Station Manager CasparCG</name>
  <description>CasparCG Server playout to the DeckLink outputs, controlled by the TV Station Manager management node.</description>
  <executable>powershell.exe</executable>
  <arguments>-NoProfile -ExecutionPolicy Bypass -File "$(Esc $launcher)"</arguments>
  <workingdirectory>$(Esc $casparDir)</workingdirectory>
  <startmode>Automatic</startmode>
  <depend>LanmanWorkstation</depend>
  <onfailure action="restart" delay="3 sec" />
  <onfailure action="restart" delay="10 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>
  <logpath>$(Esc $logs)</logpath>
</service>
"@
$ingestSvc = Install-WinSW $ingestDir "tvsm-ingest" @"
<service>
  <id>tvsm-ingest</id>
  <name>TV Station Manager RTMP ingest</name>
  <description>MediaMTX: receives RTMP/SRT streams from remote sources for CasparCG.</description>
  <executable>$(Esc (Join-Path $ingestDir "mediamtx.exe"))</executable>
  <arguments>"$(Esc $mtxCfg)"</arguments>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="3 sec" />
  <resetfailure>1 hour</resetfailure>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>3</keepFiles></log>
  <logpath>$(Esc $logs)</logpath>
</service>
"@

# ---- 8. firewall and power ----------------------------------------------------------------------
Step "Firewall and power settings"
Get-NetFirewallRule -Group "TV Station Manager" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$amcpFrom = if ($ManagementHost.Count -gt 0) { $ManagementHost } else { Warn "No -ManagementHost given: AMCP (5250) is open to every address."; @("Any") }
New-NetFirewallRule -Group "TV Station Manager" -DisplayName "TVSM CasparCG AMCP" -Direction Inbound -Protocol TCP -LocalPort 5250 -RemoteAddress $amcpFrom -Action Allow | Out-Null
New-NetFirewallRule -Group "TV Station Manager" -DisplayName "TVSM RTMP ingest" -Direction Inbound -Protocol TCP -LocalPort 1935 -Action Allow | Out-Null
New-NetFirewallRule -Group "TV Station Manager" -DisplayName "TVSM SRT ingest" -Direction Inbound -Protocol UDP -LocalPort 8890 -Action Allow | Out-Null
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /change monitor-timeout-ac 0 | Out-Null

Step "Starting"
& $ingestSvc start | Out-Null
& $casparSvc start | Out-Null
$ok = $false
for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
  Start-Sleep 1
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect("127.0.0.1", 5250); $c.Close(); $ok = $true } catch { }
}
if ($ok) { Write-Host "CasparCG answers on AMCP port 5250" -ForegroundColor Green }
else { Warn "CasparCG does not answer on port 5250 yet. See $logs (tvsm-casparcg*.log and casparcg\)." }

Write-Host ""
Write-Host "Studio node ready." -ForegroundColor Green
Write-Host "  CasparCG $casparTag, $Outputs channel(s) at ${VideoMode}: channel N plays to DeckLink output N."
Write-Host "  Media folder:  $mediaDir"
if ($PublicHost) {
  Write-Host "  RTMP push:     server rtmp://$PublicHost/live   stream key <name>?user=publish&pass=$publishPass"
  Write-Host "  SRT push:      srt://${PublicHost}:8890?streamid=publish:live/<name>:publish:$publishPass"
}
Write-Host "Next, in the management node:"
Write-Host "  1. Devices -> Studio nodes: add $(if ($PublicHost) { $PublicHost } else { 'this machine' }), port 5250."
Write-Host "  2. Channels: pick the CasparCG channel per TV channel and the ATEM input each DeckLink output is cabled to."
Write-Host "  3. Live sources (RTMP): studio node + CasparCG channel + URL rtmp://127.0.0.1/live/<name>."
