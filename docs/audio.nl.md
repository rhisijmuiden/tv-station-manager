# Geluid onder de uitzending

Geluid dat onder het beeld meeloopt: bijvoorbeeld de live radio van de omroep achter de beeldkrant (die zelf geen geluid heeft), of een microfoon/mengtafel op een fysieke ingang van de studio-node. Menu: **Uitzending → Geluid**.

## Bronnen

| Soort | Adres | Opmerkingen |
| --- | --- | --- |
| Internetstream | De stream zelf, bijv. `https://stream.voorbeeld.nl/radio.mp3`, een Icecast/Shoutcast-adres of een HLS `.m3u8` (ook `rtmp://`, `rtsp://`, `srt://`). | CasparCG op de studio-node opent de stream, dus **de studio-node** moet het adres kunnen bereiken. Speelt met `LOOP`: valt de stream weg, dan wordt hij opnieuw geopend. **Luisteren** speelt hem in de browser af (HLS alleen in Safari). |
| Geluidskaart-ingang | De Windows-naam van het opnameapparaat, bijv. `Line In (Realtek(R) Audio)` (Geluidsinstellingen → Opnemen, of `Get-PnpDevice -Class AudioEndpoint`). | DirectShow: `PLAY <ch>-5 "dshow://audio=<naam>"`. Alleen op kanalen die op de gekozen studio-node draaien. |
| DeckLink-ingang | Apparaatnummer zoals CasparCG telt (1 = eerste). | `PLAY <ch>-5 DECKLINK <n>`: SDI-embedded geluid of de analoge breakout zoals ingesteld in Blackmagic Desktop Video. Het beeld van de ingang wordt nooit getoond. |

Volume 0–150 % (100 % = onveranderd) per bron. Een bron verwijderen maakt de blokken en beeldkranten die hem gebruikten stil.

## Geluid kiezen

- **Beeldkrant → Opmaak → Geluid onder de beeldkrant**: standaard voor elk beeldkrant-item.
- **Uurblokken → Geluid onder dit blok**: loopt onder alle items van het blok, ook onder blokken daarin (tenzij die zelf iets kiezen). *Standaard* = het geluid van de beeldkrant, anders alleen het eigen geluid van het item.
- **Per item** (de 🔊-keuze op elke regel): *Zoals het blok*, *Geen geluid eronder*, of een andere bron. Op een item met een blok erin wint die keuze van de instelling van dat blok.

De dichtstbijzijnde keuze wint: item → blok → bovenliggend blok → standaard van de beeldkrant. Onder live-items komt nooit extra geluid (die hebben eigen geluid), en ook niet in gaten (filler).

## In de uitzending

De regisseur speelt de bron op CasparCG-laag **5** van het kanaal (onder playout-laag 10 en de overlay op 20) met `MIXER OPACITY 0`, zodat alleen het geluid gebruikt wordt, en `MIXER VOLUME` voor het niveau. Het mengt met het geluid van een clip. Opeenvolgende items met dezelfde bron spelen door zonder onderbreking; een volumewijziging stuurt alleen `MIXER VOLUME`. Het stopt (laag leeg) bij een item zonder geluid, een live-item, een gat of handmatig live nemen, en als de automatisering uit gaat. Na een herstart van CasparCG start het opnieuw; een bron die faalt wordt elke 5 s opnieuw geprobeerd, komt in het as-run-logboek en staat in **Regie** ("Geluid eronder: …").

Op de studio-node hoeft niets te veranderen (alleen AMCP).
