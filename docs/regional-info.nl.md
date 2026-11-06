# Regionale info (verkeer, evenementen, raad, 112)

Kant-en-klare beeldkrantbronnen voor Velsen, Beverwijk en Heemskerk. De redactie vindt ze onder **Bibliotheek > Beeldkranten > Regionaal**. Elke bron is een kaart: zet hem aan, controleer de instellingen en het voorbeeld, en **Maak beeldkrant** maakt een beeldkrant (tekstopmaak) met een blok dat in elk uurblok kan. De berichten verversen vanzelf. De bronnen kunnen ook in de nieuwsticker.

| Bron | Gegevens | Verversen |
| --- | --- | --- |
| Files & wegwerkzaamheden | Open data van de NDW (DATEX II v3): actuele situatie (files, ongelukken, afsluitingen) en geplande werkzaamheden (30 min in de cache). Alleen berichten op de gekozen wegen binnen de IJmond of in een van de gemeenten. Huis- en vergunningnummers worden weggelaten. | 5 min |
| Evenementen | Een iCal- (.ics) of RSS-link en/of een eigen lijst. Eerstvolgende eerst. | 60 min |
| Gemeenteraad | Per gemeente: iBabs, de Notubiz-API of een iCal-link. Vergaderingen die niet doorgaan krijgen "Gaat niet door". | 60 min |
| 112 (P2000) | Regio-RSS van alarmeringen.nl (Kennemerland), gefilterd op plaats. | 2 min |

## Privacyregels 112

- In beeld alleen het soort melding en de plaats ("Woningbrand in IJmuiden. De brandweer is uitgerukt."). Nooit adressen, namen, capcodes of medische details. Straatnaam is een keuze (standaard uit, nooit bij ambulance).
- Standaard: brandweer en hulp op het water aan; ambulance, politie en traumaheli uit; automatische brandmeldingen weg; 20 minuten vertraging; goedkeuring door een redacteur aan; meldingen na 6 uur weg.
- Wachtende meldingen staan onder **Meldingen keuren** met **Goedkeuren** / **Afkeuren**. De oorspronkelijke melding ziet alleen de redactie.

## Techniek

Zie `docs/regional-info.md` (Engels) voor tabellen, kolommen en bekende beperkingen: alarmeringen.nl gaf tijdens de ontwikkeling een 403 aan de server (de feed-link is instelbaar) en Notubiz was vanuit de ontwikkelomgeving niet bereikbaar.
