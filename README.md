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

Then open `http://<server>:8080` and create the first administrator.

## Development

```bash
pnpm install
pnpm dev:orchestrator   # API on :8080, UI on http://localhost:5173
pnpm typecheck && pnpm test
```

## Branches and releases

- `test`: pre-releases (`v0.2.0-test.<n>`), installed by apps on the **test** channel.
- `production`: stable releases (`v0.2.0`), installed by apps on the **production** channel.

Work goes into a feature branch, then a PR into `test`, then `test` is merged into `production`.

## House style

See [branding/BRAND.md](branding/BRAND.md).
