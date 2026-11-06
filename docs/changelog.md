# Changelog ("What's new")

Every app shows the changelog under **Info > What's new** (route `/system/changelog`): per version what was added, changed, improved, fixed and removed. A version without a release date is marked "In test"; the version you run is marked "Your version". The switch at the top shows only this app (plus platform and studio node changes) or all parts.

- Data: `changelog/<version>/release.json` (`date`, `summary`) and one JSON file per feature. Format and rules: `CONTRIBUTING.md`.
- Code: `packages/ui/src/changelog.ts` (pure: validation, sorting, Markdown), `changelogData.ts` (bundles the files with `import.meta.glob`), page `packages/ui/src/pages/Changelog.tsx`. Tests: `packages/ui/test/changelog.test.ts` (every file valid, a folder for the `package.json` version, only the newest version without a date).
- Release notes: `.github/workflows/release.yml` runs `node scripts/changelog-notes.mts <version>` and puts the result above GitHub's generated notes.
