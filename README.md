# TV Station Manager

Platform for running automated TV channels:

| Part | Runs on | Role |
|---|---|---|
| **Orchestrator** | Debian 13 | Enrolls nodes, assigns roles, monitors them and rolls out updates |
| **Management node** | Debian 13 | The director: schedule, EPG, ad breaks, media from the UNAS, ATEM switching |
| **Studio node** | Windows + DeckLink | Playout over SDI with graphics overlay and RTMP input |

Every app has the same base: a left-hand admin menu, English and Dutch, an Info button with the version and update check, updates from the UI with a production/test channel switch, a configurable SMTP mail server, and full/incremental backups to FTP, FTPS or SCP with restore.

## Install (Debian 13)

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/tv-station-manager/production/packaging/install.sh | sudo bash -s -- orchestrator
# test channel:
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/tv-station-manager/production/packaging/install.sh | sudo bash -s -- orchestrator --channel test
```

Management node (registers itself with the orchestrator through the agent):

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/tv-station-manager/production/packaging/install.sh | sudo bash -s -- management --channel test --orchestrator http://10.40.6.201:8080
```

Then open `http://<server>:8080` and sign in with **admin / admin**. The UI shows a warning until you change that password (My account). Set `TVSM_DEFAULT_ADMIN=user:password` or `off` in `/etc/tvsm/<app>/env` before the first start to change this.

## Management node

The director of the station. Sign in as editor-in-chief (role *Editor-in-chief*) to plan, or as *Operator* for the control room only.

| Menu | What it does |
|---|---|
| Control room | Per channel: now/next with countdown, automation on/off, ATEM program/preview/cut/auto, take a live source (camera or RTMP) and go back to the schedule, as-run log |
| Schedule | Day planning per channel. Entries start exactly on time (an overrun is cut, gaps play the filler clip or the fallback ATEM input). Append blocks back to back, copy a day |
| TV blocks / Ad breaks | Reusable rundowns of media, ad breaks (nested blocks) and live sources. The logo is hidden during ads |
| Media library | Files on the UniFi UNAS Pro over SMB (`smbclient`, works in an unprivileged LXC), rescanned every 15 minutes. Durations are measured with ffprobe; folders named *Reclame*, *Jingles*, *Bumpers*, *Filler* are categorised automatically |
| Programme guide | EPG grid and a token protected XMLTV feed (`/epg/xmltv.xml?token=…`) |
| Graphics | Per channel logo, clock, up-next bar and ticker, with a live preview. Rendered on the studio node by the CasparCG template in `studio/casparcg-templates/tvsm/overlay.html` |
| Remote sources | RTMP/SRT streams from outside (OBS, vMix, a phone): own stream key per source, live status, send to a DeckLink output and take on air. See [docs/remote-sources.md](docs/remote-sources.md) ([NL](docs/remote-sources.nl.md)) |
| Channels / Devices | ATEM switchers (any model; model, inputs and M/E rows are read from the switcher), studio nodes (CasparCG AMCP, port 5250), live sources and the per-channel wiring |

How it plays out: for every channel the management node tells CasparCG on the studio node to play the clip
(`PLAY <channel>-10 "Folder/Clip"`, the next clip is preloaded with `LOADBG`), switches the ATEM to the input the studio
node output is cabled to, and updates the overlay with `CG UPDATE`. See [studio/README.md](studio/README.md) for the
CasparCG side.

### Behind a reverse proxy

The apps trust `X-Forwarded-*` headers, so the session cookie is marked `Secure` when the proxy terminates HTTPS. Example for nginx:

```nginx
location / {
    proxy_pass http://<orchestrator-ip>:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Only expose the proxy, not port 8080 directly.

## Development

```bash
pnpm install
pnpm dev:orchestrator   # API on :8080, UI on http://localhost:5173
pnpm dev:management     # API on :8081, UI on http://localhost:5174
pnpm typecheck && pnpm test
```

## Branches and releases

- `test`: pre-releases (`v0.2.0-test.<n>`), installed by apps on the **test** channel.
- `production`: stable releases (`v0.2.0`), installed by apps on the **production** channel.

Work goes into a feature branch, then a PR into `test`, then `test` is merged into `production`.

## House style

See [branding/BRAND.md](branding/BRAND.md).
