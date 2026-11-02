# HyperDecks (orchestrator)

De orchestrator neemt Blackmagic HyperDeck-recorders en -spelers op in het apparatenoverzicht, naast de nodes en de
ATEM-mixers, en operators kunnen er opnames mee starten en stoppen.

## Wat het doet

- **Registreren** van een deck met zijn IP-adres (menu *HyperDecks*, alleen beheerders). De orchestrator verbindt via
  het HyperDeck Ethernet Protocol (TCP **9993**, hetzelfde protocol dat ATEM's en HyperDeck Setup gebruiken) en leest
  model, protocolversie, videoformaat, gekozen ingang (SDI / HDMI), codec, mediasloten en of bediening op afstand aan
  staat.
- **Live status**: online / offline (15 s marge, mail naar de alarmontvangers), transportstatus (REC / speelt af /
  gestopt), lopende timecode, en per SSD- of SD-slot de naam en de **resterende opnametijd**. Wat er op de deck zelf
  gebeurt (voorpaneel, ATEM, andere bediening) zie je meteen.
- **Opnemen / afspelen / stoppen** (operator en hoger). Een opname kan een naam krijgen; die wordt opgeschoond tot
  letters, cijfers, spaties en streepjes. Opnemen wordt geweigerd als er geen media in zit.
- **Meldingen**: offline / weer online, en één keer per opname als er minder dan 15 minuten opnametijd over is.
- **Aansluitschema**: *Apparaat toevoegen → HyperDeck* plaatst de deck met de aansluitingen van zijn model
  (Studio HD Plus / HD Pro / 4K Pro: SDI In, HDMI In, SDI Out A/B, SDI Monitor Out, HDMI Out; Studio HD Mini:
  SDI In, SDI Out, HDMI Out). Tijdens een opname staat er een REC-label op het blok.
- **Dashboard**: een HyperDecks-tegel (online / totaal, hoeveel er opnemen) zodra er een deck geregistreerd is.

## Op de deck

- Geef de deck een vast IP-adres (Setup → Network, of Blackmagic HyperDeck Setup via USB).
- Zet **Remote** aan (setup-menu op het voorpaneel → Remote, of in HyperDeck Setup). Zonder Remote meldt de deck wel
  zijn status, maar weigert hij opnemen / afspelen / stoppen; de orchestrator toont dan een waarschuwing.
- TCP-poort 9993 moet bereikbaar zijn vanaf de orchestrator.

Technische details: zie [hyperdeck.md](hyperdeck.md).
