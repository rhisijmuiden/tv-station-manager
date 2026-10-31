<#
  TV Station Manager - node agent installer for Windows (studio nodes).
  Run in an elevated PowerShell:
    iwr -useb https://raw.githubusercontent.com/rhisijmuiden/tv-station-manager/production/packaging/windows/install-agent.ps1 -OutFile $env:TEMP\install-agent.ps1
    & $env:TEMP\install-agent.ps1 -Orchestrator https://orchestrator.example.com
  Installs to %ProgramFiles%\TVSM\agent as the Windows service "tvsm-agent" (WinSW, LocalSystem).
  Config lives in %ProgramData%\TVSM\agent\agent.json.
#>
param(
  [string]$Orchestrator = "",
  [ValidateSet("production", "test")][string]$Channel = "production",
  [string]$Repo = "rhisijmuiden/tv-station-manager"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run this script in an elevated (Administrator) PowerShell." }

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { throw "64-bit Windows is required." }
$pattern = "^tvsm-agent_.+_windows-$arch\.zip$"
$headers = @{ "User-Agent" = "tvsm-agent-installer" }
$releases = Invoke-RestMethod -UseBasicParsing -Headers $headers "https://api.github.com/repos/$Repo/releases?per_page=50"
$release = $releases | Where-Object { -not $_.draft -and ($Channel -eq "test" -or -not $_.prerelease) -and ($_.assets | Where-Object { $_.name -match $pattern }) } | Select-Object -First 1
if (-not $release) { throw "No $Channel release with a Windows agent found in $Repo." }
$asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
$sums = $release.assets | Where-Object { $_.name -eq "SHA256SUMS" } | Select-Object -First 1
if (-not $sums) { throw "Release $($release.tag_name) has no SHA256SUMS." }

$tmp = Join-Path $env:TEMP "tvsm-agent-install"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $tmp | Out-Null
$zip = Join-Path $tmp $asset.name
Write-Host "Downloading $($asset.name) ($($release.tag_name))"
Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $asset.browser_download_url -OutFile $zip
# Saved to a file: on Windows PowerShell 5.1 .Content of a binary download is a byte array, not text.
$sumsFile = Join-Path $tmp "SHA256SUMS"
Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $sums.browser_download_url -OutFile $sumsFile
$expected = ((Get-Content $sumsFile) | Where-Object { $_ -match [regex]::Escape($asset.name) + "\s*$" } | Select-Object -First 1) -split "\s+" | Select-Object -First 1
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $expected.ToLower() -ne $actual) { throw "Checksum mismatch, installation aborted." }

$dir = Join-Path $env:ProgramFiles "TVSM\agent"
$svc = Join-Path $dir "tvsm-agent-service.exe"
if (Get-Service tvsm-agent -ErrorAction SilentlyContinue) {
  Write-Host "Stopping existing agent service"
  & $svc stop | Out-Null
}
New-Item -ItemType Directory $dir -Force | Out-Null
Expand-Archive $zip -DestinationPath $dir -Force
$dataDir = Join-Path $env:ProgramData "TVSM\agent"
New-Item -ItemType Directory $dataDir -Force | Out-Null
# Only SYSTEM and Administrators may read the node secret.
icacls $dataDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

if (-not (Get-Service tvsm-agent -ErrorAction SilentlyContinue)) { & $svc install | Out-Null }

$cli = Join-Path $dir "tvsm-agent.cmd"
if ($Orchestrator) {
  if (Test-Path (Join-Path $dataDir "agent.json")) {
    Write-Host "Agent is already enrolled. To re-enroll: `"$cli`" enroll $Orchestrator"
  } else {
    & $cli enroll $Orchestrator
    if ($LASTEXITCODE -ne 0) { throw "Enrollment failed." }
  }
} else {
  Write-Host "Connect this node with: `"$cli`" enroll https://<orchestrator>"
}
& $svc start | Out-Null
Write-Host "tvsm-agent service is running. Approve this node in the orchestrator (Nodes)."
