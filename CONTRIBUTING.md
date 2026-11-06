# Contributing

Branches: feature branch -> PR into `test` -> merge `test` into `production` (see `CLAUDE.md`).

## Every feature PR

Each PR that changes something users notice must also:

1. **Add a changelog file** in `changelog/<version>/`, where `<version>` is the version in the root `package.json` (the next release). One file per feature, named after it, so parallel branches never conflict:

   ```json
   {
     "apps": ["management"],
     "pr": [72],
     "changes": [
       { "kind": "added", "en": "Traffic information on the beeldkrant.", "nl": "Verkeersinformatie op de beeldkrant." }
     ]
   }
   ```

   - `kind`: `added`, `changed`, `improved`, `fixed` or `removed`.
   - `apps`: one or more of `management`, `orchestrator`, `studio`, `platform` (`platform` = every app).
   - `pr` is optional: add the number once the PR exists.
   - Write for editors and admins, not developers: what they can do now and where to find it. Both `en` and `nl` are required.

   The changelog shows in every app under **Info > What's new** (`/system/changelog`) and becomes the GitHub release notes. `pnpm test` checks every file.

2. **Extend the editor guide** when editors use the feature: add or update a step, tip or FAQ entry in `apps/management/web/public/help/index.html` (Dutch), with a screenshot when it helps. See `docs/help.md`.

3. **Translate** every new UI string in both `en` and `nl`, and add `docs/<feature>.md` + `docs/<feature>.nl.md` for larger features.

## Releasing

1. Set `"date": "YYYY-MM-DD"` (and optionally a one-line `summary` in `en`/`nl`) in `changelog/<version>/release.json`.
2. Merge `test` into `production`.
3. Right after the release, bump the version in `package.json` (and the workspace packages) to the next patch and create `changelog/<next>/release.json` without a date. Otherwise test builds rank older than the release and are not offered as an update.
