# Monitoring (orchestrator)

Menu **Monitoring** in de orchestrator toont de status van het hele platform op één pagina. Alles wat bewaakt wordt,
staat in een **laag van het signaalpad**:

**Kern** (orchestrator) > **Regie** (regisseur) > **TV-nodes** (rol studio / playout / live) > **Mengtafels** (ATEM) >
**Converters** (Teranex) > **Distributie** (Owncast, webpagina's), plus **Infrastructuur** als ondersteunende laag
(apparaten in de blokken Infrastructuur en Extra apparatuur, nodes met rol "Overig" en nodes die op goedkeuring wachten).

De pagina groeit mee met het platform: de balk Signaalpad vat elke laag samen (aantal en slechtste status) en wordt niet
langer als er nodes bijkomen. Een nieuw soort apparatuur hoeft alleen in een laag te worden ingedeeld
(`web/monitorView.ts`); beide weergaven nemen het dan vanzelf over.

- **Statusbalk**: aantal onderdelen per status; klik op een status om alleen die onderdelen te zien.
- **Signaalpad**: klik op een laag om alleen die laag te zien.
- **2D-overzicht** (standaard): per laag een kaart met de onderdelen als tegels. Zoek op naam, rol of adres. "Kaarten"
  toont meetwaarden en problemen, "Compact" twee regels per onderdeel; boven 24 onderdelen start de pagina compact.
- **3D-ruimte**: per laag een platform, per onderdeel een blok in de kleur van de status (rode blokken knipperen). Draaien
  en zoomen met de knoppen, slepen om te draaien en te kantelen, "Kabels" tekent het signaalpad, "Alleen problemen" dimt
  alles wat in orde is. Bij veel onderdelen staan alleen bij problemen en het gekozen onderdeel namen.
- **Details** (rechts, in beide weergaven): status, problemen, gegevens, CPU / RAM / schijf, een CPU-lijn van de laatste
  5 minuten (opgebouwd zolang de pagina open staat), de laatste gebeurtenissen van een apparaat, en knoppen om het
  onderdeel of het aansluitschema te openen.
- **Aandacht nodig**: alles wat niet in orde is, ernstigste eerst.

De gekozen weergave en indeling worden per browser onthouden. De pagina ververst elke 5 seconden.

Apparaten toevoegen (beheerders): **Apparatuur toevoegen** bovenaan, of **Toevoegen** op de kaart Distributie of
Infrastructuur. Controles: Owncast (alleen lezen), webpagina, poort of handmatig. Zie [monitoring.md](monitoring.md) voor
alle details over de controles en waar de status vandaan komt.
