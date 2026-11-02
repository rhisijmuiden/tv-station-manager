# Studio node (Windows)

A studio node is a Windows PC with a Blackmagic DeckLink card (4 SDI outputs, up to 2 TV channels). It runs:

| Service | What | Port |
| --- | --- | --- |
| `tvsm-agent` | TV Station Manager agent: registers with the orchestrator, reports CasparCG / ingest / media share status, runs commands (update, restart CasparCG, restart ingest, reboot) | outbound only |
| `tvsm-casparcg` | CasparCG Server 2.4: plays clips from the UNAS share, RTMP streams and the graphics overlay to the DeckLink outputs. Controlled by the management node over AMCP | TCP 5250 (management node only) |
| `tvsm-ingest` | MediaMTX: receives RTMP/SRT pushes from remote sources, CasparCG plays them from `rtmp://127.0.0.1/live/<stream key>`. Stream keys are checked by the management node | TCP 1935, UDP 8890, TCP 9997 (status API, management node only) |

## Install

1. Install **Blackmagic Desktop Video** (DeckLink driver) and reboot.
2. In an elevated PowerShell:

   ```powershell
   iwr -useb https://raw.githubusercontent.com/rhisijmuiden/tv-station-manager/production/packaging/windows/install-studio.ps1 -OutFile $env:TEMP\install-studio.ps1
   & $env:TEMP\install-studio.ps1 -Orchestrator http://<orchestrator>:8080 -ManagementHost <management-ip> -MediaPath \\<unas>\<share> -SmbUser <user>
   ```

   Use `test` instead of `production` in the URL plus `-Channel test` for the test channel. Other options:
   `-Outputs 4` (DeckLink outputs = CasparCG channels), `-VideoMode 1080i5000` (default; `1080p5000`, `720p5000`, ...; must match the ATEM or receiver; a rerun keeps the previous mode), `-Keyer default` (fill only, so the DeckLink HDMI output shows the programme; `external` for fill + key),
   `-ManagementUrl` (where the ingest server checks stream keys; default `http://<first -ManagementHost>:8080`),
   `-PublicHost` (address shown in the RTMP push URL), `-HtmlGpu auto` (HTML graphics such as the overlay, beeldkrant and
   webcam pages render on the graphics card when an NVIDIA/AMD/Intel driver is installed; `off` renders them in software
   on the CPU; a rerun keeps the previous choice), `-Role tv` (what the node does: `tv` = TV node that plays the
   schedule, `ingest` = ingest server for live RTMP/SRT streams from events, `both`; a rerun keeps the previous choice),
   `-CasparVersion 2.4`, `-MediaMtxVersion latest`, `-SkipAgent`.
   The script asks for the share password and stores it encrypted for this machine (DPAPI).
3. Approve the node in the orchestrator (**Nodes**). The approval dialog proposes the role chosen with `-Role`
   (tv = **playout**, ingest = **live**, both = **studio**). The node page then shows
   CasparCG, the DeckLink outputs, incoming streams and whether the media share is reachable.

Running the installer again updates CasparCG/MediaMTX and rewrites the configuration (the old `casparcg.config` is
kept as `casparcg.config.bak`). Agent updates (orchestrator → node → Update agent) also update the overlay template,
because CasparCG loads it straight from `%ProgramFiles%\TVSM\agent\studio\templates`.

## Graphics card

CasparCG mixes every channel on the GPU (OpenGL 4.5; the log shows `Initialized OpenGL 4.5.0 NVIDIA ...`), so install
the vendor driver (not the Windows Basic Display driver). Three things still cost CPU and are worth moving:

- **HTML graphics** (overlay, beeldkrant, webcams): CEF renders them on the GPU with `-HtmlGpu auto` (default since
  this version). Older installs wrote `<html><enable-gpu>false</enable-gpu></html>`; run the installer again.
- **Stream output** (Owncast, YouTube, ...): pick encoder **NVIDIA NVENC** in the management node (Output → stream)
  instead of x264. The GTX 1060 and newer encode 1080p in hardware at almost no CPU cost.
- **File decoding**: CasparCG 2.4 decodes media files in software; there is no setting for hardware decoding.
  Keep playout files in the channel format (1080i50 files for a 1080i50 channel) to avoid extra scaling/deinterlacing.

Check on the node: `nvidia-smi` shows casparcg.exe as a C+G process, and *Task Manager → Performance → GPU* shows
3D and Video Encode load.

## Channel layout

CasparCG channel N plays to DeckLink output N. The usual layout for two TV channels:

| CasparCG channel | DeckLink / SDI | Use |
| --- | --- | --- |
| 1 | 1 | TV 1 playout (+ overlay) |
| 2 | 2 | TV 1 live / RTMP |
| 3 | 3 | TV 2 playout (+ overlay) |
| 4 | 4 | TV 2 live / RTMP |

## Management node settings

1. **Devices → Studio nodes**: host = this machine, port 5250.
2. **Channels**: per TV channel the CasparCG channel, and the ATEM input each DeckLink output is cabled to.
3. **Remote sources**: one per contributor, with the studio node, the DeckLink output (CasparCG channel, e.g. 2) and the
   ATEM input. See [docs/remote-sources.md](../docs/remote-sources.md).
4. **EPG → Public address of this server** must be reachable from the studio node: the overlay loads the logo and subtitles from it.

Remote contributors push to `rtmp://<studio node>/live` with the stream key of their remote source, or over SRT to
`srt://<studio node>:8890?streamid=publish:live/<stream key>`. The management node shows the details per source
(**Remote sources → Connection details**) and whether the stream is coming in. Full guide:
[docs/remote-sources.md](../docs/remote-sources.md) ([Nederlands](../docs/remote-sources.nl.md)).

Without `-ManagementHost`/`-ManagementUrl` the installer falls back to one shared publish password (stream key
`<name>?user=publish&pass=<password>`, stored in `studio.json`), and the management node cannot show stream status.

## Graphics overlay

`casparcg-templates/tvsm/overlay.html` is an HTML template (1920×1080, transparent): logo, clock, "up next" bar,
news ticker and subtitles. The management node loads it with `CG ADD` on layer 20 and updates it with `CG UPDATE`.
Preview it in a browser with `overlay.html?demo`.

Subtitles come from a `.srt` or `.vtt` file next to the clip with the same name (`Show.mp4` + `Show.srt`, or
`Show.nl.srt`). The media scan finds them; the overlay times the cues from the clip's start, so the studio node and
the management node must have NTP-synced clocks (Windows Time / systemd-timesyncd).

## Files

- `%ProgramFiles%\TVSM\agent`: agent, WinSW, `studio\start-casparcg.ps1` (CasparCG launcher) and templates.
- `%ProgramFiles%\TVSM\casparcg`: CasparCG Server and `casparcg.config` (generated).
- `%ProgramFiles%\TVSM\ingest`: MediaMTX.
- `%ProgramData%\TVSM\studio`: `studio.json`, `smb.cred`, `mediamtx.yml`, `logs\` (SYSTEM and Administrators only).
