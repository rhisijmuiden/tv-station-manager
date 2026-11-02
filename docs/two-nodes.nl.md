# Twee studionodes: playout + live

Een kanaal kan twee Windows CasparCG-machines gebruiken:

- **Playout-node**: speelt de programmering (clips, reclameblokken, graphics). Stel hem bij *Kanalen* in als studionode van het kanaal, met de ATEM-ingang waar zijn DeckLink-uitgang op zit (*Playout-ingang*).
- **Live-node**: ontvangt RTMP/SRT-streams van evenementen (MediaMTX-ingest). Maak de remote bron bij *Remote bronnen* aan op deze node, met de ATEM-ingang waar zijn DeckLink-uitgang op zit.

Geef elke node zijn rol bij *Apparaten → Studionodes* (Playout-node / Live-node / Playout + live). In de orchestrator kun je dezelfde rollen toewijzen bij het goedkeuren van een node.

## Wat de regisseur doet

Zet de remote bron als *live*-item in een TV-blok en plan het in. Dan:

1. **30 s vooraf** wordt de stream op de DeckLink-uitgang van de live-node gestart. De ATEM blijft op de playout-node en de graphics (logo, klok, …) van het kanaal komen ook op de live-node.
2. **Bij de start** schakelt de ATEM naar de live-node. De playout-node speelt de *opvulclip* van het kanaal in een loop als standby.
3. **(Nog) geen stream?** De ATEM blijft op (of gaat terug naar) de playout-node: opvulclip, of de *reserve-ingang* als er geen opvulclip is. Zodra de stream 1,5 s in CasparCG speelt schakelt de ATEM naar de live-node. Een weggevallen stream gaat als melding per mail en staat in het as-run-log.
4. **Na het live-item** gaat de playout-node verder met de programmering; stream en graphics gaan van de live-node af.

De regiekamer toont welke node in de uitzending is en wanneer een live-item op zijn stream wacht.

Stel een opvulclip in op het kanaal: die zien kijkers zolang een live-stream ontbreekt.
