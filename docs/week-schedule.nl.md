# Weekschema en uurklokken

De management node plant het lineaire kanaal per week.

- **Categorieën** (Planning → Categorieën): onderwerpen zoals Sport, Cultuur, Nieuws. Geef media een categorie in de mediabibliotheek (per bestand, of een hele map in één keer). Blokken kunnen ook een categorie hebben; die wordt als genre in de EPG gebruikt.
- **Uurklokken** (Planning → Uurklokken): de indeling van elk uur. Vaste blokken (ident, nieuws, reclameblok) starten elk uur op dezelfde minuut; de programmavensters daartussen worden gevuld met de inhoud van het slot. "Reserveren" houdt een vaste tijd vrij voor een blok (bijv. 5:00 voor reclame); wat overblijft speelt de filler van het kanaal.
- **Weekschema** (Planning → Weekschema): terugkerende slots per kanaal en weekdag, bijv. "ma–vr 18:00–20:00 Sport". Een slot heeft een categorie (redacteuren stellen per datum de rundown samen, of die wordt automatisch uit de categorie gekozen) of een vast blok (elke week hetzelfde tv-blok). Elk slot volgt de standaard uurklok van het kanaal, een andere klok, of geen klok.
- **Redactie** (Planning → Redactie): per week elk slot op elke datum met de status (vast blok, redacteur, automatisch, leeg), hoe vol het is en wat niet past. Open er een om de rundown samen te stellen; de tijdlijn laat live zien waar elk item start. Items worden nooit gesplitst: past een item niet meer in een venster, dan schuift het door naar het volgende.

## Publiceren

Met "Weekschema actief" zet de node de komende 14 dagen (instelling `week.days`) om in gewone regels in het uitzendschema (origin `week`), elke 15 minuten en na elke wijziging. De regisseur, het uitzendschema en de EPG spelen ze af zoals elke andere regel:

- elk vast onderdeel van de klok is een eigen regel met harde starttijd, dus elk uur begint op de seconde;
- de programmavensters spelen een deel van de rundown van het slot (`skip_items`/`take_items`);
- de EPG toont één programma per slot, van begin tot eind;
- handmatige regels in het uitzendschema gaan voor: gegenereerde regels die starten terwijl een handmatige regel loopt vervallen (bijv. een live wedstrijd);
- regels die al begonnen zijn worden nooit aangepast.

Automatisch kiezen pakt media uit de categorie van het slot, het langst niet gekozen eerst, per venster wat past. "Nieuw voorstel" kiest opnieuw; "Terug naar automatisch" gooit de rundown van een redacteur weg.

Zendertijd is `Europe/Amsterdam` (instelling `station.timezone`, `PUT /api/week/settings`); slots volgen zomer- en wintertijd.

## Slepen en neerzetten

Uurklokken, het weekschema, de redactie-rundowns en tv-blokken / reclameblokken hebben rechts de mediabibliotheek (verbergen met de knop bovenin). Sleep clips, meerdere geselecteerde clips tegelijk, of een blok uit het tabblad *Blokken*:

- **Rundown van een datum**: laat los tussen de regels om in te voegen, of op een programmavenster in de tijdlijn om het achter wat daar al speelt te zetten. Sleep regels om de volgorde te wijzigen. Op een datum met een vast blok krijgt die datum een eigen rundown (het blok plus de clips).
- **Weekschema**: laat los op een slot en kies de datum (de volgende vier); de clips komen achteraan de rundown van die datum. Laat los op een lege plek om daar een nieuw slot mee te plannen (afgerond op 15 minuten).
- **Uurklok**: laat los op de klok of tussen de regels voor een vast onderdeel. Een clip wordt eerst een blok; dezelfde clip nog eens gebruikt dat blok opnieuw.
- **Blokken**: laat los tussen de regels; sleep regels om de volgorde te wijzigen.

De `+` op een regel in de bibliotheek (of *Toevoegen* bij een selectie) doet hetzelfde zonder slepen, voor touchscreens.
