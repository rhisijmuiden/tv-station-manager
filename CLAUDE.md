# TV Station Manager

Monorepo (pnpm workspaces, TypeScript, Node 24).

- `branding/`: house style (logo, tokens, BRAND.md). UI colours/fonts come only from `tokens.css`.
- `packages/platform`: shared server (Fastify + node:sqlite): auth, mail (SMTP), backup/restore (FTP/FTPS/SCP, full + incremental), self-update from GitHub releases, system info.
- `packages/ui`: shared React UI (Tailwind 4, i18next EN/NL, left sidebar, Info dialog, system pages). Apps call `mountPlatformApp`.
- `apps/orchestrator`: enrolls and manages nodes (Debian 13 .deb).
- `apps/management`: the director. `server/timeline.ts` (pure schedule/block expansion, tested), `director.ts` (playout loop), `drivers.ts` (ATEM via atem-connection, CasparCG via casparcg-connection; fakes in tests), `media.ts` (UNAS over smbclient + ffprobe).
- `studio/`: Windows studio node: CasparCG overlay template (logo, clock, up next, ticker, subtitles), `windows/start-casparcg.ps1` launcher, README. Installer: `packaging/windows/install-studio.ps1` (agent + CasparCG 2.4 + MediaMTX RTMP/SRT ingest as WinSW services, generated casparcg.config, firewall). The agent reports studio status (`apps/agent/src/studio.ts`, AMCP + MediaMTX API) when `%ProgramData%\TVSM\studio\studio.json` exists; Windows self-update runs `update-agent.ps1` as a one-off scheduled task.
- Subtitles: `.srt`/`.vtt` next to a clip (`apps/management/server/subtitles.ts`), served at `/graphics/subtitles/:mediaId`.
- Roles: `admin` > `editor` (editor-in-chief) > `operator`. Use `requireRole(req, ...)` from `@tvsm/platform` on write routes.
- `packaging/`: .deb builder (bundles Node), systemd unit, update helper, `install.sh`.

Rules:
- Every user-facing string goes through i18n with both `en` and `nl` keys.
- Admin UIs keep the menu on the left and the Info button (version, check/install updates) in the sidebar.
- Branches: feature branch -> PR into `test` -> merge `test` into `production`. Pushes to either publish a release (see `.github/workflows/release.yml`). Bump `package.json` version for a new production release.

Commands: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm dev:orchestrator` (API :8080, UI :5173), `pnpm dev:management` (API :8081, UI :5174).

The management server bundle stubs the native freetype2 add-on and ships `atemSocketChild.cjs` next to `server.mjs` (see `apps/management/build-server.mjs`).
