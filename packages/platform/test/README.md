# Platform tests

`pnpm --filter @tvsm/platform test` runs unit tests and the API tests.

The backup tests run against real servers when these variables are set:

| Variable | Example |
|---|---|
| `TVSM_IT_FTP_HOST`, `TVSM_IT_FTP_PORT`, `TVSM_IT_FTP_USER`, `TVSM_IT_FTP_PASS` | an FTP server that also supports explicit FTPS (AUTH TLS) |
| `TVSM_IT_SCP_HOST`, `TVSM_IT_SCP_PORT`, `TVSM_IT_SCP_USER`, `TVSM_IT_SCP_KEY` | an SSH server; `TVSM_IT_SCP_KEY` is a path to a private key |
