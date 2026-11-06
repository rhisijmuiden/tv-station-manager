# Backup locations: SMB and OneDrive

Both apps (orchestrator and management) share the backup module in `packages/platform/src/backup`. A location is a row in
`backup_targets` (`protocol` = `ftp`, `ftps`, `scp`, `smb` or `onedrive`; secrets in `config` are encrypted with the
app's secret key and shown as `********` in the API). Every protocol implements the same `BackupTarget` interface
(`test`, `upload`, `download`, `list`, `remove`), so full + incremental backups, retention and restore work the same
everywhere. UI: System > Backup & restore (`packages/ui/src/pages/Backup.tsx`).

## SMB (`targets/smb.ts`)

- Uses Samba's `smbclient` (a `.deb` dependency of both apps): no mount, no root, SMB2/SMB3 with signing.
- Settings: server, share, folder (created when missing), user, password, domain, max protocol (`SMB3` default,
  `SMB2` for older NAS), `encrypt` (`--client-protection=encrypt`, SMB3 encryption required), optional `port`.
- The password goes into a temporary `-A` credentials file (mode 0600), never on the command line.
- Uploads go to `<name>.part` and are renamed when complete. `smbclient` exits 0 on many errors, so every
  `NT_STATUS_*` line in the output is treated as a failure (except the ones a step expects, e.g. "folder exists").
- Pasting `\\nas\share\folder` in the Server field fills server, share and folder.

## OneDrive (`targets/onedrive.ts`)

- Microsoft Graph with delegated scopes `Files.ReadWrite offline_access User.Read`: the app can only reach the drive of
  the account that signed in.
- Sign-in: device-code flow. `POST /api/backup/onedrive/start` returns a code + `microsoft.com/devicelogin`; the UI polls
  `POST /api/backup/onedrive/poll`. The refresh token stays on the server: the browser gets `flow:<id>`, which the
  test/save routes swap for the token. `GET /api/backup/onedrive/defaults` offers the tenant and client ID of the
  Office 365 SSO settings.
- App registration (Entra ID): the SSO registration can be reused. Turn on **Authentication > Allow public client
  flows** and add the delegated Microsoft Graph permission **Files.ReadWrite** (admin consent if the tenant requires it).
  For a personal Microsoft account use tenant `common` and an app registration that allows personal accounts.
- Refresh tokens rotate; a new one is written back to the location (`BackupEngine.updateTargetConfig`). Access tokens
  are cached in memory per account.
- Files up to 4 MiB use a simple PUT; larger files use an upload session in 10 MiB chunks (multiple of 320 KiB), so a
  half-uploaded archive never appears. Throttling (429/503) is retried with `Retry-After`.
- If Microsoft revokes the sign-in (password change, 90 days without use), backups fail with "connect OneDrive again";
  the administrator opens the location and clicks Sign in again.

## Tests

`packages/platform/test/platform.test.ts` runs full + incremental + restore over every protocol. OneDrive always runs
against `test/graph-mock.ts` (login + Graph); SMB runs when `TVSM_IT_SMB_*` is set (see `test/README.md`).
`test/backup-targets.test.ts` covers parsers, the upload session, token rotation and the table migration.
