# Visual Radio

Het tv-kanaal volgt de radio: bij elk nummer dat de radio draait speelt de Visual Radio node de bijpassende videoclip
(zonder geluid, de radiomix is het geluid van het kanaal), en als een microfoon opengaat schakelt de ATEM naar de camera
van die microfoon. Menu: **Visual Radio** in de management node.

## Plaats in het geheel

- **Management node** (`apps/management/server/visualradio.ts`, pure regels in `vrlogic.ts`) ontvangt de metadata en de
  microfoonsignalen, zoekt de clip, laat CasparCG die spelen en schakelt de ATEM. Alleen de management node stuurt de ATEM.
- **Visual Radio node**: een Windows studio node met CasparCG. De DeckLink-uitgang gaat naar een ATEM-ingang (de *clip-ingang*).
- **ATEM**: de ATEM en M/E van het kanaal. Camera's (een per microfoon, eventueel een totaalshot) en een stationsloop op andere ingangen.
  De radiomix gaat naar een ATEM audio-ingang, altijd aan.
- Zolang een station **aan** staat laat de regisseur dat kanaal met rust (`Director.yieldTo`).

## De radio playout koppelen

Elk station heeft twee geheime URL's (bij Instellingen) en een optionele RDS-poort.

| Ingang | Hoe |
| --- | --- |
| RDS-poort (Zenlex) | Zenlex stuurt songinfo naar een RDS-encoder. Voeg een RDS-uitgang toe naar het IP van de management node en de RDS-poort van het station (TCP of UDP). Regels als `RT=Artiest - Titel` worden gelezen; herhalingen van hetzelfde nummer worden genegeerd. |
| Now playing-URL | `POST` JSON (`artist`, `title`, `type`, `duration`, `startedAt`, `songId`), XML met dezelfde tags, platte tekst `Artiest - Titel`, of `GET ?artist=…&title=…`. |
| Microfoon-URL | `…/mic/<sleutel>/1` opent, `…/mic/<sleutel>/0` sluit (GET of POST), of `POST {"mic":"dj","open":true}`. Voor een GPIO-kastje of de radiomengtafel (faderstart). |

`type` bepaalt wat er in beeld komt: alleen bij `music` wordt een clip gezocht; jingles, reclame en nieuws tonen de stationsloop.

## Clips koppelen

1. Song-ID uit de playout (kolom *Song-ID* bij de clip, of via de CSV-import).
2. Een clip die met de hand gekoppeld is vanuit *Gedraaid zonder clip*.
3. Exacte sleutel: hoofdartiest + titel, kleine letters, zonder accenten, `feat.`, `(Radio Edit)`, `(Official Video)`, `Remastered` enz.
4. Fuzzy: gelijkenis op lettergroepen van artiest (40 %) en titel (60 %), minimaal de drempel van het station (0,82).

Clips komen uit een mediabron/map in de mediabibliotheek: **Clipmap scannen** leest namen als `Artiest - Titel.ext`,
**CSV importeren** neemt `artist;title;path;songId;offsetMs` over uit een bestaande clipdatabase. De offset slaat een video-intro over.

## Wat er in beeld komt

Handmatig vastgezet > twee of meer open microfoons (totaalshot) > een open microfoon (zijn camera) > muziek met een lopende clip
(clip-ingang) > muziek zonder clip (stationsloop of totaalshot) > al het andere (stationsloop). Een microfoon telt na de
open-vertraging (250 ms) en houdt zijn camera vast tijdens de sluit-vertraging (1,5 s); een shot staat minstens de minimale shotduur (3 s).
De clip loopt onder een camerashot door, dus hij is nog in sync als de microfoon dichtgaat. Een te laat bericht springt verder in de clip.

## Nog niet in deze versie

Het volgende nummer vooraf laden, ATEM-audioniveaus als microfoontrigger, een now-playing balk in de overlay,
Visual Radio per tijdvak uit het weekschema aanzetten, en een orchestrator-rol "Visual Radio".
