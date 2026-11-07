# ATEM-ingangen als aansluitingen

De management-app noemt een ATEM-ingang naar de aansluiting achterop de mengtafel in plaats van een kaal nummer:
**SDI in 8 · CASPARCG01**, **HDMI in 2**, **Testbeeld**. Zo leest de kanaalinstelling als documentatie van de bekabeling.

## Waar het vandaan komt

De ATEM meldt zelf per ingang of het een aansluiting is en welke soort (SDI, HDMI, component, ...). Er is dus geen
tabel per model nodig: een Television Studio HD meldt 1-4 HDMI en 5-8 SDI, een Production Studio 4K meldt SDI.
Het ingangsnummer is het nummer dat bij de aansluiting staat. De naam na de punt is de eigen naam van de ingang, zoals
ingesteld op de ATEM of in de ATEM-inventaris van de orchestrator; fabrieksnamen als "Camera 8" worden weggelaten.

- Driver: `server/drivers.ts` geeft elke ingang `port` (ExternalPortType) en `namesDefault`.
- Pure logica: `server/atemports.ts` (`portParts`, `groupInputs`, `portSummary`), gedeeld met de web-UI; tests in `test/atem-ports.test.ts`.
- Web: `web/atemPorts.tsx` (`portLabel`, `PortOptions`, `useChannelInputs`), teksten onder `mgmt.atemPorts` (EN + NL).
- Offline: `GET /api/atems` bewaart de laatste ingangenlijst van een verbonden mengtafel in `atem_devices.inputs` en geeft die
  terug (met `status.cached = true`) zolang de ATEM offline is, zodat de keuzelijsten hun namen houden.

## Waar je het ziet

- **Inrichting → Kanalen**: de keuzes voor playout- en reserve-ingang tonen eerst de aansluitingen ("Aansluitingen achterop"),
  daarna de eigen bronnen van de ATEM (zwart, testbeeld, mediaspelers). Onder de ATEM staat de indeling (`HDMI 1-4 · SDI 5-8`).
  De M/E-keuze verschijnt alleen bij mengtafels met meer dan één M/E-rij. De kanaalkaarten tonen de aansluitingen ook.
- **Schakelen** (redactie): cameraknoppen zeggen "Camera · SDI in 5"; het knoppenbeheer en de bronkeuze gebruiken dezelfde namen.
- **Regie**: het label op zender zegt "Playout-node CASPARCG02 · SDI in 5"; de program/preview-knoppen tonen de aansluiting onder de korte naam.
- **Apparaten**: elke ATEM toont zijn indeling van aansluitingen.

De opgeslagen kanaalinstellingen veranderen niet: een kanaal bewaart nog steeds het ATEM-ingangsnummer.
