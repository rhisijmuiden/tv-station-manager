# SPDX-License-Identifier: AGPL-3.0-only
<#
.SYNOPSIS
  TV Station Manager desktop background: a calm wallpaper in the house style that says what this node does
  and how it is doing (role, channels, services, CPU/RAM/disk, agent version).

.DESCRIPTION
  Renders %ProgramData%\TVSM\desktop\wallpaper.png with System.Drawing and sets it as the desktop background of
  the signed-in user. Read only: it never starts, stops or changes a service.

    desktop-info.ps1 -Install [-Language en|nl] [-Description "Playout - channel 2 + stream2"]
        registers the scheduled task "TVSM Desktop Info" (every signed-in user, at logon and every 5 minutes,
        hidden through wscript) and draws the wallpaper once.
    desktop-info.ps1 -Uninstall      removes the task (the last wallpaper stays).
    desktop-info.ps1                 draws and sets the wallpaper (what the task runs).

  Language and description are kept in %ProgramData%\TVSM\desktop\desktop.json. The logo is logo.png next to
  this script (the agent zip ships the active brand's white logo there).
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall,
  [ValidateSet("en", "nl")][string]$Language,
  [string]$Description
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $env:ProgramData "TVSM\desktop"
$cfgPath = Join-Path $data "desktop.json"
$taskName = "TVSM Desktop Info"
function Write-Utf8([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) }
function Read-Json([string]$path) { if (Test-Path $path) { try { return Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } } return $null }

# ---- settings ----------------------------------------------------------------------------------
$cfg = Read-Json $cfgPath
$lang = if ($Language) { $Language } elseif ($cfg -and $cfg.language) { $cfg.language } else { "en" }
$desc = if ($PSBoundParameters.ContainsKey("Description")) { $Description } elseif ($cfg) { $cfg.description } else { "" }

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$taskName'."
  return
}

if ($Install) {
  New-Item -ItemType Directory -Force $data | Out-Null
  Write-Utf8 $cfgPath (([ordered]@{ language = $lang; description = $desc }) | ConvertTo-Json)
  # wscript runs PowerShell without a console window flashing every 5 minutes.
  $vbs = Join-Path $data "desktop-info.vbs"
  $ps = Join-Path $here "desktop-info.ps1"
  Write-Utf8 $vbs ("CreateObject(""WScript.Shell"").Run ""powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """"$ps"""""", 0, False`r`n")
  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
  $logon = New-ScheduledTaskTrigger -AtLogOn
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $principal = New-ScheduledTaskPrincipal -GroupId "S-1-5-32-545" -RunLevel Limited   # BUILTIN\Users, interactive
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $repeat) -Principal $principal -Settings $settings -Description "TV Station Manager: desktop background with the node's role and status." -Force | Out-Null
  Write-Host "Registered '$taskName' (language $lang)."
}

# ---- texts -------------------------------------------------------------------------------------
$T = @{
  en = @{
    playout = "Playout"; live = "Live / ingest"; studio = "Playout + live"; none = "Studio node"
    playoutText = "Plays the channel schedule from the management node to SDI and the stream output."
    liveText = "Takes live streams (RTMP/SRT) from events and plays them to SDI when the schedule goes live."
    studioText = "Plays the schedule and takes live streams on the same machine."
    noneText = "TV Station Manager node."
    channels = "Channels"; channel = "Channel"; services = "Services"; system = "System"
    agent = "Node agent"; casparcg = "CasparCG playout"; ingest = "MediaMTX ingest"
    running = "Running"; stopped = "Stopped"; missing = "Not installed"
    cpu = "CPU"; ram = "Memory"; disk = "Disk C:"; uptime = "Up"; days = "d"; updated = "Updated"
    allOk = "All systems running"; attention = "Needs attention"; managed = "Managed by TV Station Manager. Changes go through the orchestrator."
    decklink = "DeckLink"; version = "Agent"; media = "Media"
  }
  nl = @{
    playout = "Playout"; live = "Live / ingest"; studio = "Playout + live"; none = "Studionode"
    playoutText = "Speelt de zenderplanning van de management node af naar SDI en de streamuitgang."
    liveText = "Neemt livestreams (RTMP/SRT) van evenementen binnen en speelt ze naar SDI als de planning live gaat."
    studioText = "Speelt de planning af en neemt livestreams binnen op dezelfde machine."
    noneText = "TV Station Manager-node."
    channels = "Kanalen"; channel = "Kanaal"; services = "Diensten"; system = "Systeem"
    agent = "Node-agent"; casparcg = "CasparCG playout"; ingest = "MediaMTX ingest"
    running = "Actief"; stopped = "Gestopt"; missing = "Niet geinstalleerd"
    cpu = "CPU"; ram = "Geheugen"; disk = "Schijf C:"; uptime = "Aan"; days = "d"; updated = "Bijgewerkt"
    allOk = "Alles draait"; attention = "Aandacht nodig"; managed = "Beheerd door TV Station Manager. Wijzigingen via de orchestrator."
    decklink = "DeckLink"; version = "Agent"; media = "Media"
  }
}[$lang]

# ---- facts (read only) -------------------------------------------------------------------------
$studio = Read-Json (Join-Path $env:ProgramData "TVSM\studio\studio.json")
$health = Read-Json (Join-Path $env:ProgramData "TVSM\agent\health.json")
$role = if ($studio -and $studio.role) { [string]$studio.role } else { "none" }
if (-not $T.ContainsKey($role)) { $role = "none" }
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | Sort-Object InterfaceIndex | Select-Object -First 1).IPAddress
$os = Get-CimInstance Win32_OperatingSystem
$cpu = [int]((Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average)
$ramPct = [int](100 - 100 * $os.FreePhysicalMemory / $os.TotalVisibleMemorySize)
$ramTxt = "{0:N1} / {1:N0} GB" -f (($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB), ($os.TotalVisibleMemorySize / 1MB)
$c = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$diskPct = [int](100 - 100 * $c.FreeSpace / $c.Size)
$diskTxt = "{0:N0} GB free" -f ($c.FreeSpace / 1GB); if ($lang -eq "nl") { $diskTxt = "{0:N0} GB vrij" -f ($c.FreeSpace / 1GB) }
$up = (Get-Date) - $os.LastBootUpTime
$upTxt = if ($up.TotalDays -ge 1) { "{0}{1} {2}h" -f [int][Math]::Floor($up.TotalDays), $T.days, $up.Hours } else { "{0}h {1}m" -f $up.Hours, $up.Minutes }

$svcDefs = @(
  @{ name = "tvsm-agent"; label = $T.agent },
  @{ name = $(if ($studio -and $studio.casparService) { $studio.casparService } else { "tvsm-casparcg" }); label = $T.casparcg },
  @{ name = $(if ($studio -and $studio.ingestService) { $studio.ingestService } else { "tvsm-ingest" }); label = $T.ingest }
)
$svcs = foreach ($d in $svcDefs) {
  $s = Get-Service -Name $d.name -ErrorAction SilentlyContinue
  $state = if (-not $s) { "missing" } elseif ($s.Status -eq "Running") { "running" } else { "stopped" }
  [pscustomobject]@{ label = $d.label; state = $state }
}
$ok = -not ($svcs | Where-Object { $_.state -ne "running" })
$outs = if ($studio -and $studio.outputs) { @($studio.outputs) } else { @() }

$dot = [string][char]0xB7
# ---- drawing -----------------------------------------------------------------------------------
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$W = [Math]::Max(1280, $bounds.Width); $H = [Math]::Max(720, $bounds.Height)
$scale = $H / 1080.0
function Px([double]$v) { [float]($v * $scale) }
function Col([string]$hex, [int]$a = 255) { $c = [Drawing.ColorTranslator]::FromHtml($hex); [Drawing.Color]::FromArgb($a, $c.R, $c.G, $c.B) }

# IJmond360 house style (branding/ijmond360/tokens.json).
$bg1 = Col "#2A1430"; $bg2 = Col "#1A0C1E"; $purple = Col "#713C80"; $pink = Col "#E92E7F"
$text = Col "#F4EEF7"; $muted = Col "#B9A8C2"; $card = Col "#FFFFFF" 14; $line = Col "#FFFFFF" 28
$green = Col "#1DB97A"; $amber = Col "#F5A524"; $red = Col "#DC2F45"

$bmp = New-Object Drawing.Bitmap $W, $H
$g = [Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = "AntiAlias"; $g.TextRenderingHint = "AntiAliasGridFit"; $g.InterpolationMode = "HighQualityBicubic"
$rect = New-Object Drawing.Rectangle 0, 0, $W, $H
$grad = New-Object Drawing.Drawing2D.LinearGradientBrush $rect, $bg1, $bg2, 60.0
$g.FillRectangle($grad, $rect)
# Soft purple glow top right and a thin pink line at the bottom.
$glow = New-Object Drawing.Drawing2D.GraphicsPath
$glow.AddEllipse([float]($W - (Px 900)), (Px -500), (Px 1400), (Px 1100))
$pg = New-Object Drawing.Drawing2D.PathGradientBrush $glow
$pg.CenterColor = Col "#713C80" 90; $pg.SurroundColors = @([Drawing.Color]::FromArgb(0, 113, 60, 128))
$g.FillPath($pg, $glow)
$g.FillRectangle((New-Object Drawing.SolidBrush $pink), 0, [float]($H - (Px 6)), [float]$W, (Px 6))

function Font([double]$size, [string]$style = "Regular", [string]$family = "Segoe UI") { New-Object Drawing.Font $family, (Px $size), ([Drawing.FontStyle]$style), ([Drawing.GraphicsUnit]::Pixel) }
function Text([string]$t, $font, $color, [double]$x, [double]$y) { $g.DrawString($t, $font, (New-Object Drawing.SolidBrush $color), [float]$x, [float]$y) }
function RoundRect([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath; $d = [float](2 * $r)
  $p.AddArc([float]$x, [float]$y, $d, $d, 180, 90); $p.AddArc([float]($x + $w - $d), [float]$y, $d, $d, 270, 90)
  $p.AddArc([float]($x + $w - $d), [float]($y + $h - $d), $d, $d, 0, 90); $p.AddArc([float]$x, [float]($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure(); return $p
}
function Card([double]$x, [double]$y, [double]$w, [double]$h) {
  $p = RoundRect $x $y $w $h (Px 18)
  $g.FillPath((New-Object Drawing.SolidBrush $card), $p); $g.DrawPath((New-Object Drawing.Pen $line, 1), $p)
}
function Dot([double]$x, [double]$y, $color) { $r = Px 7; $g.FillEllipse((New-Object Drawing.SolidBrush $color), [float]$x, [float]$y, [float](2 * $r), [float](2 * $r)) }
function Bar([double]$x, [double]$y, [double]$w, [int]$pct) {
  $h = Px 8; $g.FillPath((New-Object Drawing.SolidBrush (Col "#FFFFFF" 30)), (RoundRect $x $y $w $h ($h / 2)))
  $c = if ($pct -ge 90) { $red } elseif ($pct -ge 75) { $amber } else { $purple }
  $fw = [Math]::Max($h, $w * [Math]::Min(100, $pct) / 100)
  $g.FillPath((New-Object Drawing.SolidBrush $c), (RoundRect $x $y $fw $h ($h / 2)))
}

$L = Px 120; $top = Px 110
# Logo
$logo = Join-Path $here "logo.png"
if (Test-Path $logo) {
  $img = [Drawing.Image]::FromFile($logo); $lh = Px 64; $lw = $img.Width * $lh / $img.Height
  $g.DrawImage($img, [float]$L, [float]$top, [float]$lw, [float]$lh); $img.Dispose()
}
# Host name, role, description
$y = $top + (Px 120)
Text $env:COMPUTERNAME.ToUpper() (Font 96 "Bold") $text $L $y
$y += Px 130
$roleTxt = $T[$role]
$pillFont = Font 26 "Bold"; $pw = $g.MeasureString($roleTxt, $pillFont).Width + (Px 36)
$g.FillPath((New-Object Drawing.SolidBrush $pink), (RoundRect $L $y $pw (Px 46) (Px 23)))
Text $roleTxt $pillFont (Col "#FFFFFF") ($L + (Px 18)) ($y + (Px 6))
$ipFont = Font 26
Text ("$ip") $ipFont $muted ($L + $pw + (Px 22)) ($y + (Px 6))
$y += Px 72
if ($desc) { Text $desc (Font 34 "Regular") $text $L $y; $y += Px 52 }
Text $T["${role}Text"] (Font 24) $muted $L $y

# Status line
$y = $top + (Px 470)
Dot $L ($y + (Px 10)) $(if ($ok) { $green } else { $red })
Text $(if ($ok) { $T.allOk } else { $T.attention }) (Font 28 "Bold") $text ($L + (Px 28)) $y

# Cards: services, channels, system
$cy = $y + (Px 70); $cw = Px 470; $ch = Px 300; $gap = Px 30
$h2 = Font 20 "Bold"; $row = Font 24; $small = Font 20
# Services
Card $L $cy $cw $ch
Text $T.services.ToUpper() $h2 $muted ($L + (Px 30)) ($cy + (Px 26))
$ry = $cy + (Px 80)
foreach ($sv in $svcs) {
  $col = @{ running = $green; stopped = $red; missing = $amber }[$sv.state]
  Dot ($L + (Px 30)) ($ry + (Px 9)) $col
  Text $sv.label $row $text ($L + (Px 58)) $ry
  $st = $T[$sv.state]; $sw = $g.MeasureString($st, $small).Width
  Text $st $small $muted ($L + $cw - (Px 30) - $sw) ($ry + (Px 3))
  $ry += Px 62
}
# Channels
$x2 = $L + $cw + $gap
Card $x2 $cy $cw $ch
Text $T.channels.ToUpper() $h2 $muted ($x2 + (Px 30)) ($cy + (Px 26))
$ry = $cy + (Px 80)
if ($outs.Count -eq 0) { Text "-" $row $muted ($x2 + (Px 30)) $ry }
foreach ($o in ($outs | Select-Object -First 4)) {
  Text ("{0} {1}" -f $T.channel, $o.channel) $row $text ($x2 + (Px 30)) $ry
  $t2 = "{0} {1} $dot {2}" -f $T.decklink, $o.device, $o.format; $tw = $g.MeasureString($t2, $small).Width
  Text $t2 $small $muted ($x2 + $cw - (Px 30) - $tw) ($ry + (Px 3))
  $ry += Px 50
}
# System
$x3 = $x2 + $cw + $gap
Card $x3 $cy $cw $ch
Text $T.system.ToUpper() $h2 $muted ($x3 + (Px 30)) ($cy + (Px 26))
$ry = $cy + (Px 78); $bw = $cw - (Px 60)
foreach ($m in @(@($T.cpu, $cpu, "$cpu %"), @($T.ram, $ramPct, $ramTxt), @($T.disk, $diskPct, $diskTxt))) {
  Text $m[0] $small $text ($x3 + (Px 30)) $ry
  $vw = $g.MeasureString($m[2], $small).Width; Text $m[2] $small $muted ($x3 + $cw - (Px 30) - $vw) $ry
  Bar ($x3 + (Px 30)) ($ry + (Px 36)) $bw $m[1]
  $ry += Px 68
}

# Footer
$ver = if ($health -and $health.version) { $health.version } else { "?" }
$foot = "{0} {1}   $dot   {2} {3}   $dot   {4} {5}" -f $T.version, $ver, $T.uptime, $upTxt, $T.updated, (Get-Date -Format "yyyy-MM-dd HH:mm")
Text $foot (Font 20) $muted $L ($H - (Px 110))
Text $T.managed (Font 20) (Col "#B9A8C2" 170) $L ($H - (Px 76))

# ---- save + set --------------------------------------------------------------------------------
New-Item -ItemType Directory -Force $data -ErrorAction SilentlyContinue | Out-Null
$out = Join-Path $data "wallpaper.png"
$tmp = Join-Path $env:TEMP "tvsm-wallpaper-$PID.png"
$bmp.Save($tmp, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
# Each user may not write to ProgramData; then keep the picture in the user's own folder.
try { Copy-Item $tmp $out -Force } catch { $out = Join-Path $env:LOCALAPPDATA "TVSM\wallpaper.png"; New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null; Copy-Item $tmp $out -Force }
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
if (-not ("TvsmWallpaper" -as [type])) {
  Add-Type @"
using System.Runtime.InteropServices;
public static class TvsmWallpaper { [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int SystemParametersInfo(int a, int b, string c, int d); }
"@
}
Set-ItemProperty "HKCU:\Control Panel\Desktop" -Name WallpaperStyle -Value "10" -ErrorAction SilentlyContinue   # fill
Set-ItemProperty "HKCU:\Control Panel\Desktop" -Name TileWallpaper -Value "0" -ErrorAction SilentlyContinue
[TvsmWallpaper]::SystemParametersInfo(0x14, 0, $out, 3) | Out-Null   # SPI_SETDESKWALLPAPER, update ini + broadcast
