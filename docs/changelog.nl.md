# Wijzigingen ("Wat is er nieuw")

Elke app toont de wijzigingen onder **Info > Wat is er nieuw** (route `/system/changelog`): per versie wat er is toegevoegd, gewijzigd, verbeterd, opgelost en verwijderd. Een versie zonder releasedatum staat als "In test"; de versie die je draait staat als "Jouw versie". Met de schakelaar bovenaan zie je alleen deze app (plus platform- en studionode-wijzigingen) of alle onderdelen.

- Gegevens: `changelog/<versie>/release.json` (`date`, `summary`) en één JSON-bestand per functie. Opbouw en regels: `CONTRIBUTING.md`.
- Code: `packages/ui/src/changelog.ts` (puur: controle, sortering, Markdown), `changelogData.ts` (bundelt de bestanden met `import.meta.glob`), pagina `packages/ui/src/pages/Changelog.tsx`. Tests: `packages/ui/test/changelog.test.ts`.
- Release notes: `.github/workflows/release.yml` draait `node scripts/changelog-notes.mts <versie>` en zet het resultaat boven de door GitHub gemaakte notes.
