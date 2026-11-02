# Opnames van live-uitzendingen

*English: [recordings.md](recordings.md)*

Elke livestream die binnenkomt van een remote bron (RTMP of SRT, zie [remote-sources.nl.md](remote-sources.nl.md))
wordt automatisch opgenomen. Na de uitzending knipt een redacteur het begin en einde bij, en gaat de opname naar de
mediabibliotheek (waar hij net als elke andere clip in te plannen is) of wordt hij meteen als herhaling ingepland.

```
Inzender ──RTMP/SRT──► ingest-server op de studio node (MediaMTX) ──► CasparCG ──► DeckLink ──► ATEM
                                       │
                                       └──RTMP (gelezen als management node)──► recorder op de management node
                                                                                   │  ffmpeg -c copy, MPEG-TS-stukken
                                                                                   ▼
                                                   één MP4 ──► knippen in de browser ──► bibliotheek (UNAS) / herhaling
```

Op de studio node verandert niets: de management node leest de stream van de ingest-server, zoals de stream-output dat
ook doet. Het beeld wordt niet opnieuw gecodeerd, dus de opname heeft de kwaliteit die de inzender stuurde.

## Wanneer wordt er opgenomen?

- **Start**: zodra er een stream binnenkomt op de streamsleutel van een remote bron (een opgehaalde bron: zolang hij op
  zijn DeckLink-uitgang speelt). Inzenders beginnen vaak eerder om te testen; dat stuk knip je er later af.
- **Korte onderbrekingen**: valt de verbinding weg en komt hij binnen de *onderbrekingstijd* (standaard 90 s) terug,
  dan loopt de opname door en worden de stukken aan elkaar gezet.
- **Stop**:
  - de stream stopt (en komt niet binnen de onderbrekingstijd terug), of
  - de bron staat als *live*-item in het uitzendschema: de opname stopt *doorlopen na het programma* (standaard
    2 minuten) na het einde van dat item, ook als de inzender blijft sturen. Een nieuwe opname begint pas als de stream
    stopt en terugkomt, of als het volgende programma met deze bron begint. Twee programma's met dezelfde bron direct
    na elkaar geven twee opnames.
  - **Opname stoppen** op de pagina *Opnames* (operators en hoger).
- Een opname die bij een programma in het uitzendschema hoort krijgt de naam van dat programma, anders van de bron.
- Opnames korter dan de *minimale lengte* (standaard 30 s) worden weggegooid (teststreams).
- Onder de *minimale vrije ruimte* (standaard 5 GB) start er geen nieuwe opname en gaat er een waarschuwingsmail uit.

## Na de opname

Redactie → **Opnames** toont de opnames (nieuwste bovenaan) met een beeld, lengte en status:

| Status | Betekenis |
| --- | --- |
| Neemt op | Loopt nog (rode REC-kaart bovenaan, met de tijd en grootte tot nu toe). |
| Verwerken | De stukken worden tot één MP4 samengevoegd (seconden). |
| Klaar om na te kijken | Klaar; knip hem bij en zet hem in de bibliotheek, of plan een herhaling. |
| Naar bibliotheek | Wordt naar de UNAS-share gekopieerd. |
| In bibliotheek | Staat in de mediabibliotheek, in te plannen. *Bibliotheek heeft een oudere versie*: opnieuw geknipt, kies **Bibliotheek bijwerken**. |
| Mislukt | Kon niet afgemaakt worden; de stukken blijven op de management node staan en er ging een waarschuwingsmail uit. |

### Knippen

**Knippen** opent de speler met een filmstrook van de opname. Sleep de gele handvatten, of speel af tot het juiste
moment en druk op **Hier zetten** onder *Begin* of *Einde*. Je kunt ook een tijd typen (`12:03.5`). *Bekijk de eerste /
laatste 5 seconden* controleert de knip. Er wordt geknipt zonder opnieuw te coderen: geen kwaliteitsverlies en klaar in
seconden; het begin valt op het dichtstbijzijnde sleutelbeeld, hooguit 1–2 seconden eerder. Geef de opname een
duidelijke naam en een categorie; de naam komt in de bibliotheek, het uitzendschema en de programmagids.

Staat de opname al in de bibliotheek, dan wordt die bijgewerkt als je een nieuwe knip opslaat: hetzelfde bestand op de
share en hetzelfde media-item, dus ingeplande herhalingen krijgen vanzelf de nieuwe lengte.

### Naar de bibliotheek

**Naar bibliotheek** (of *Opslaan en naar bibliotheek* in het knipvenster) kopieert de opname naar de mediabibliotheek
die bij **Instellingen** gekozen is (standaard de eerste) in de map *Recordings* (verander dat bijv. in *Opnames*). Het
bestand heet `<naam> <datum> <tijd>.mp4`. Hij krijgt soort *Programma* en de gekozen categorie, zodat uurklokken die
per categorie plannen hem oppakken.

### Herhaling inplannen

**Herhaling inplannen**: kies het kanaal en één of meer tijden (snelknoppen: vanavond 22:00, morgen 10:00, morgen /
volgende week op de tijd van de uitzending). Voordat je inplant laat het venster zien waar de herhaling mee overlapt:
met de hand geplande programma's worden afgekapt; programma's uit het weekbord maken plaats (handmatige items gaan voor
het weekbord). Een opname die nog niet in de bibliotheek staat wordt daar eerst in gezet; de herhalingen volgen zodra
hij er staat. Ingeplande herhalingen staan in het venster en bij de opname, en kunnen daar weer weg.

De herhaling is een gewoon item in het *Uitzendschema* met een uurblok dat de opname bevat, dus hij staat ook in de
programmagids.

## Automatisch per remote bron

**Automatisch na de opname, per remote bron** (onderaan de pagina, eindredacteur):

- **Deze bron opnemen** (standaard aan).
- **Categorie** die de opname krijgt.
- **Meteen naar de bibliotheek**: zodra de opname klaar is (knippen kan daarna nog; de bibliotheek wordt dan
  bijgewerkt). Uit: hij wacht op *Klaar om na te kijken*.
- **Automatisch herhalen**: vaste tijden ten opzichte van de dag van de uitzending (zelfde dag, volgende dag, na n dagen)
  op hetzelfde of een ander kanaal, bijv. *volgende dag 10:00* en *volgende dag 19:00*. Ze worden ingepland zodra de
  opname in de bibliotheek staat.

## Instellingen

| Instelling | Standaard | |
| --- | --- | --- |
| Mediabibliotheek / map | eerste bibliotheek, `Recordings` | Waar klare opnames naartoe gaan. |
| Onderbrekingstijd | 90 s | Een stream die binnen deze tijd terugkomt blijft één opname. |
| Doorlopen na het programma | 120 s | Na het einde van het live-item in het uitzendschema. |
| Minimale lengte | 30 s | Kortere opnames worden weggegooid. |
| Lokale kopie bewaren | 7 dagen | Nadat hij in de bibliotheek staat (om nog eens te knippen); daarna wordt de kopie op de management node opgeruimd. |
| Minimale vrije ruimte | 5 GB | Daaronder geen nieuwe opnames. |

## Opslag en vereisten

- Opnames staan op de management node in `/var/lib/tvsm/management/recordings` zolang ze lopen en nagekeken worden.
  Reken op ongeveer **2,7 GB per uur** bij 6 Mbit/s. Ze zitten niet in de back-up (de kopie in de bibliotheek staat op
  de UNAS).
- De management node heeft `ffmpeg` nodig (zit al in het pakket) en de ingest-server van de studio node moet de
  management node als lezer toelaten. Dat is zo bij studio nodes die met `-ManagementHost` geïnstalleerd zijn (net als
  voor remote bronnen en stream-output; RTMP-poort 1935 vanaf de management node).
- SRT-streams worden via RTMP van de ingest-server teruggelezen. Gebruik H.264- (of H.265-)video en AAC-audio, zoals
  aangeraden voor remote bronnen.
