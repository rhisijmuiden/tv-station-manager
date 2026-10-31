# TV Station Manager

Monorepo (pnpm workspaces, TypeScript, Node 24).

- `branding/`: house style (logo, tokens, BRAND.md). UI colours/fonts come only from `tokens.css`.
- `packages/platform`: shared server (Fastify + node:sqlite): auth, mail (SMTP), backup/restore (FTP/FTPS/SCP, full + incremental), self-update from GitHub releases, system info.
- `packages/ui`: shared React UI (Tailwind 4, i18next EN/NL, left sidebar, Info dialog, system pages). Apps call `mountPlatformApp`.
- `apps/orchestrator`: enrolls and manages nodes (Debian 13 .deb). Management node and Windows studio node follow.
- `packaging/`: .deb builder (bundles Node), systemd unit, update helper, `install.sh`.

Rules:
- Every user-facing string goes through i18n with both `en` and `nl` keys.
- Admin UIs keep the menu on the left and the Info button (version, check/install updates) in the sidebar.
- Branches: feature branch -> PR into `test` -> merge `test` into `production`. Pushes to either publish a release (see `.github/workflows/release.yml`). Bump `package.json` version for a new production release.

Commands: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm dev:orchestrator` (API :8080, UI :5173).
