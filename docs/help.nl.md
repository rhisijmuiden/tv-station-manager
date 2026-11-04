# Handleiding en Help-knop

De management-app bevat een stap-voor-stap handleiding voor redacteuren: de weekplanning vullen, uurblokken vullen, een live-uitzending plannen en hoe opnames werken. Er staan screenshots in, vier korte video's en vinkjes om je voortgang bij te houden.

- Plaats: `apps/management/web/public/help/` (`index.html`, `img/`, `video/`). Vite kopieert `web/public` naar `dist/web`, dus de server serveert de handleiding op `/help/index.html`.
- In de linkerbalk staat boven de Info-knop een link **Handleiding** ("Help" in het Engels). Die opent de handleiding in een nieuw tabblad. Een app zet de link aan met `mountPlatformApp({ helpUrl })`.
- De pagina is statisch en openbaar, net als het inlogscherm, en bevat alleen demogegevens.

## Bijwerken na wijzigingen in de app

Maak nieuwe screenshots en video's met een lokale management-server met demodata en Playwright. Vervang de bestanden in `img/` en `video/` door bestanden met dezelfde namen, en pas daarna de tekst in `index.html` aan.
