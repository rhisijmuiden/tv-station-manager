# Schakelknoppen

*English: [switching.md](switching.md)*

Sommige live beelden komen binnen zonder planning: een persconferentie, breaking news, een stream van een evenement.
De redactie zet ze op zender met een paar grote knoppen met een naam, onder **Redactie → Schakelen** (`/switch`),
zonder de planning of de ATEM aan te raken.

## Voor de redactie

- Druk op een knop (bijv. "IJmond360 Nieuws live"). Bij een camera bevestig je één keer; de ATEM schakelt meteen.
- Bij een stream (RTMP/SRT remote bron) volgen twee vragen:
  1. **Wil je deze live-uitzending opnemen?** Ja / Nee. Het standaardantwoord is de instelling van de bron
     (Opnames → Bronnen).
  2. **Wil je de opname direct na de live-uitzending in de herhaling?** Ja / Nee. Bij ja worden de herhaaltijden van
     de bron gebruikt; heeft de bron die niet, dan kies je een dag en een tijd.
- Zolang je live bent wacht de planning. **Terug naar de planning** beëindigt de live-uitzending: de opname stopt,
  gaat naar de mediabibliotheek en de herhalingen worden ingepland (zoals bij elke opname, zie
  [recordings.nl.md](recordings.nl.md)).
- Druk je op een andere knop, dan schakelt hij direct over; de live-sessie (en opname) van de vorige stream stopt.
- De pagina laat zien welke knop op zender is, sinds wanneer, en of er opgenomen wordt.

## Voor beheerders

**Inrichting → Schakelknoppen** (`/switch-buttons`, alleen beheerders): per kanaal een lijst knoppen met een naam, een
kleur en de live bron waar hij naar schakelt; volgorde met de pijltjes. De live bron bevat het schakelschema: de
ATEM-ingang, en bij een stream de studio-node en DeckLink-uitgang (Apparatuur, Remote bronnen). Een knop schakelt
altijd de ATEM van zijn kanaal (M/E en overgang van het kanaal).

## Hoe het werkt

Zie de Engelse versie voor de technische details (override van de regisseur, `recordings.plan`, vastzetten in de
orchestrator). Kort: de knoppen werken niet terwijl de ATEM in de orchestrator is vastgezet; "Terug naar de planning"
werkt dan wel. Na een herstart van de management node volgt hij weer de planning.
