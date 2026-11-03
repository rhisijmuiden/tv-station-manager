# Teranex-converters (orchestrator)

De orchestrator neemt Blackmagic Teranex-converters (Teranex AV, Teranex Express, Teranex 2D / 3D processor) op in het
apparatenoverzicht, naast de nodes en de ATEM-mixers. Bij IJmond360 zit de Teranex AV in de live-keten:
ATEM -> Teranex -> Red Bee-encoder (live tv-uitzending).

## Alleen lezen

Een Teranex in de live-keten mag niet per ongeluk veranderen, dus de orchestrator **leest hem alleen uit**. Hij maakt
verbinding via het Teranex Ethernet Protocol (TCP **9800**), leest de status die het apparaat zelf stuurt en stuurt
alleen `PING` om de verbinding open te houden. Er zijn geen knoppen die het apparaat veranderen: ingang, formaat,
beeldverhouding, presets en dergelijke stel je in op het frontpaneel of in Blackmagic Teranex Setup. Bediening
toevoegen vraagt eerst een expliciete beslissing.

## Wat je ziet

- **Toevoegen** met het IP-adres (menu *Teranex*, alleen admins). Optioneel een **verwacht ingangsformaat**
  (bijvoorbeeld `1080i50`).
- **Signaal**: een tekening van het frontpaneel met de verlichte ingang (SDI / HDMI / OPT) en audio (Embed / AES /
  Analoog), het formaat op de ingang, het uitgangsformaat, of er signaal is en de genlock-referentie. Wijzigingen op het
  frontpaneel zie je binnen een seconde.
- **Apparaat**: model, softwareversie, protocolversie, label, laatst gezien.
- **Alle gemelde instellingen**: elk statusblok dat het apparaat stuurt, precies zoals ontvangen (ter informatie).
- **Gebeurtenissen**: online / offline, ingangssignaal weg / terug, wijziging van ingangs- en uitgangsformaat.

## Meldingen (mail naar de alarmontvangers)

- Langer dan 15 s offline, en weer online.
- **Geen ingangssignaal** langer dan 5 s (alles na de Teranex, zoals de uitzend-encoder, krijgt dan geen beeld), en
  signaal terug.
- Ingangsformaat anders dan het verwachte formaat.

## Monitoring en schema

- Monitoring: laag **Converters** tussen Mengtafels en Distributie. Geen signaal = storing (rood), verkeerd formaat of
  genlock niet vergrendeld = waarschuwing.
- Verbindingsschema: *Apparaat toevoegen -> Teranex* plaatst hem met de aansluitingen van zijn model (Teranex AV:
  12G-SDI In, HDMI In, Optical In, 12G-SDI Out A/B, HDMI Out, Optical Out). Het blok toont het ingangsformaat, of
  GEEN SIGNAAL in rood.
- Dashboard: een Teranex-tegel (online / totaal, hoeveel zonder ingang) zodra er een is toegevoegd.

## Op het apparaat

- Geef de Teranex een vast IP-adres (Teranex Setup -> Network).
- TCP 9800 moet bereikbaar zijn vanaf de orchestrator.

## Technisch

Zie de Engelse versie: [teranex.md](teranex.md).
