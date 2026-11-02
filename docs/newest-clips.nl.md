# Nieuwste clips (dynamisch nieuwsblok)

Een blok kan een onderdeel **Nieuwste clips** bevatten in plaats van vaste clips. Elke keer dat het blok wordt
uitgezonden pakt dit onderdeel de nieuwste clips uit een **categorie** (bijvoorbeeld Nieuws) of een **map** van de
mediabibliotheek (submappen tellen mee). Komt er een nieuwe clip bij, dan valt de oudste er vanzelf uit.

Uurblokken → *Nieuwste clips*: kies de categorie of map, hoeveel clips, en eventueel *niet ouder dan (dagen)*,
*maximaal (minuten)* en de volgorde (nieuwste eerst, of op volgorde van binnenkomst). Het venster laat zien wat er nu
zou spelen. Vaste onderdelen (intro, outro) kunnen ervoor en erna staan.

Een blok dat al op zender is verandert niet halverwege: het speelt de clips die er waren toen het begon. De volgende
uitzending neemt nieuwe clips vanzelf mee.

## Dynamische onderdelen: een uur opbouwen uit mappen

Hetzelfde onderdeel kan op drie manieren kiezen:
- **Nieuwste**: de nieuwste clips (zie boven).
- **Om de beurt**: de clip die het langst niet gekozen is eerst, zodat elke reclame of bumper aan de beurt komt.
- **Willekeurig**: steeds een andere, niet meteen dezelfde als vorige keer.

Voorbeeld uurblok: *reclame om de beurt uit Reclames*, *bumper om de beurt uit Bumpers*, *nieuwste item uit Programma*,
*willekeurige bumper uit Bumpers*. Binnen één uitzending komt een clip nooit twee keer voor, tenzij de map niets anders
heeft. Zo'n blok maak je in Uurblokken (knop *Dynamisch uit map*) of in de wizard *Nieuwe uurprogrammering*.
Vanaf drie uur voor de uitzending ligt de keuze vast, zodat het blok niet halverwege verandert.

## Een map per week: alleen de nieuwste submap

Komen de programma-items in een map per week (bijvoorbeeld `PROGRAMMA/2026 Reportages/wk 44`, `wk 45` …), kies dan in
het venster de bovenliggende map (`PROGRAMMA/2026 Reportages`, of zelfs `PROGRAMMA`) en zet *Welke clips uit deze map?*
op **Alleen de nieuwste submap**. Het onderdeel pakt dan elke week vanzelf de map van die week; het venster laat zien
uit welke map het nu speelt.

Hoe de nieuwste map gekozen wordt:
- Mappen met een weeknummer in de naam (`wk 45`, `Wk45`, `week 7`) gaan op week, in de tijdzone van de zender. Het jaar
  komt uit het pad (`2026 Reportages`); staat er geen jaar in, dan telt een weeknummer hoger dan het huidige als vorig
  jaar, zodat na de jaarwisseling `wk 1` nieuwer is dan `wk 52`.
- Een week die nog niet begonnen is wordt overgeslagen: de map van volgende week kun je dus al vullen.
- Een map zonder clips telt niet mee: is de map van deze week op maandagochtend nog leeg, dan speelt vorige week door.
- Hebben meerdere mappen dezelfde (nieuwste) week, bijvoorbeeld `2026 Reportages/wk 45` en `2026 Sport/wk 45` onder
  `PROGRAMMA`, dan spelen ze samen.
- Mappen zonder weeknummer: de map met de laatst toegevoegde clip.
- Losse clips in de bovenliggende map zelf tellen in deze stand niet mee.
