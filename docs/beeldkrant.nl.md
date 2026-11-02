# Beeldkrant (RSS-nieuwspagina's)

Beeldvullende nieuwspagina's uit RSS-feeds, afgespeeld door CasparCG op de studio-node. Menu: **Planning → Beeldkrant**.

## Feeds (tab "Feeds")

- **WordPress-site**: vul het adres van de site in (bijv. `www.ijmond360.nl`). Berichten komen binnen via de WordPress REST-API (`/wp-json/wp/v2/posts?_embed`) met uitgelichte afbeelding, nette samenvatting en categorieën. **Categorieën laden** toont de categorieën van de site; kies er een paar om alleen die berichten te nemen (leeg = alles). Is de REST-API dicht, dan wordt de RSS-feed (`/feed/` of `/category/<slug>/feed/`) gebruikt.
- **RSS- / Atom-feed**: elke andere feed (bijv. NOS). Foto's komen uit `enclosure`, `media:content` / `media:thumbnail` of de eerste `<img>` in de tekst.
- Elke feed wordt elke *n* minuten opgehaald (standaard 10). De berichten van de laatste keer blijven bewaard (standaard 20); verwijderde berichten verdwijnen. **Testen** laat zien wat er binnenkomt zonder op te slaan.
- Foto's worden één keer door de management-node opgehaald en via `/beeldkrant/img/<bericht>` aan de studio-node gegeven (cache in `<dataDir>/rss-cache`, 14 dagen); de studio-node heeft dus geen internet nodig.

## Beeldkranten (tab "Beeldkranten")

Een beeldkrant combineert één of meer feeds. Instellingen:

| Instelling | Betekenis |
| --- | --- |
| Tijd per pagina | Seconden dat elk bericht in beeld staat (3–120). |
| Maximaal aantal pagina's / maximale leeftijd | De nieuwste berichten van alle feeds samen; oudere vallen weg. Hetzelfde artikel uit twee feeds komt één keer. |
| Maximale tekstlengte / titellengte | Teksten stoppen bij de laatste hele zin (of het laatste woord, met "…"). 0 = alleen de titel. Tekst uit de samenvatting (excerpt) of het begin van het artikel. Past het dan nog niet, dan wordt de tekst kleiner en op hele regels afgekapt. |
| Opmaak | Foto links, foto rechts, foto boven, foto beeldvullend, alleen tekst. Berichten zonder foto krijgen "alleen tekst". |
| Tonen | Foto, categorie, datum/tijd ("Vandaag 09:00"), naam van de feed, klok en datum, paginanummer, voortgangsbalk. |
| Kop, voettekst, logo, kleuren, taal | Logo = het logo dat bij Graphics voor een kanaal is geüpload. Kleuren standaard volgens de huisstijl. |
| Lengte in het schema | Eén ronde langs alle pagina's (pagina's × tijd per pagina) of een vaste lengte. Een duur op het blok-item gaat voor. De pagina's blijven rondgaan tot het item afloopt. |
| Zender-overlay erover | Standaard uit: de beeldkrant heeft een eigen klok en kop, logo/klok/ticker van de zender gaan opzij. |

De editor toont een live voorbeeld (de echte uitzendpagina, verkleind) met paginaknoppen.

## Inplannen

Een beeldkrant is een item in een tv-blok (`block_items.type = 'beeldkrant'`). **Maak blok** maakt een blok met alleen de beeldkrant; sleep dat blok in een uurklok, het weekschema of een rundown, of voeg **+ Beeldkrant** toe aan een willekeurig blok. Het duurveld van het item mag leeg blijven (= lengte van de beeldkrant).

## Uitzending

De regisseur speelt `PLAY <ch>-10 [HTML] "<publicUrl>/beeldkrant/page.html?id=<id>&start=<epoch ms>"` op de playout-laag en houdt de ATEM op de playout-input. De pagina (1920×1080) haalt elke minuut `/beeldkrant/<id>/data.json` op en toont pagina `floor((nu - start) / secondenPerPagina) mod pagina's`, gecorrigeerd met de klok van de management-node, zodat een herstart op dezelfde pagina verdergaat. Stel bij **Instellingen → publieke URL** het adres van de management-node in zodat de studio-node die kan bereiken.
