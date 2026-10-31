# Remote bronnen

*English: [remote-sources.md](remote-sources.md)*

Een remote bron is een livestream van buiten de studio: een verslaggever met een telefoon, een andere studio met vMix,
een kerkdienst met een hardware-encoder. De inzender stuurt hem via **RTMP** of **SRT** naar de studio node. CasparCG
speelt hem af op een **DeckLink SDI-uitgang**, en de ATEM-ingang waar die uitgang op aangesloten is gaat op de lucht.

```
Inzender (OBS / vMix / Larix / encoder)
   │  RTMP  rtmp://<studio node>/live/<streamkey>      of   SRT  srt://<studio node>:8890?streamid=publish:live/<streamkey>
   ▼
Ingest-server op de studio node (MediaMTX, "tvsm-ingest")  ── vraagt de management node: is deze streamkey geldig?
   │  rtmp://127.0.0.1/live/<streamkey>
   ▼
CasparCG-kanaal N  ──►  DeckLink SDI-uitgang N  ──►  ATEM-ingang  ──►  op de lucht
```

## 1. Bron toevoegen

Management node → **Remote bronnen** → **Remote bron toevoegen** (rol hoofdredacteur of beheerder):

| Veld | Wat vul je in |
| --- | --- |
| Naam | Wie of wat er verstuurt, bijv. *Verslaggever Zandvoort*. De streamkey begint ermee. |
| Studio node | De studio node waarvan de ingest-server de stream ontvangt. |
| DeckLink-uitgang | De SDI-uitgang (= CasparCG-kanaal) die de stream afspeelt. Weet je niet welke aansluiting dat is? **Apparatuur → Studio-nodes → Uitgangen identificeren** toont 60 seconden een genummerd testbeeld op elke uitgang. Kies een uitgang die de playout van een kanaal niet gebruikt, bijv. uitgang 2 naast kanaal 1 op uitgang 1. |
| ATEM-ingang | De ATEM-ingang waar die DeckLink-uitgang op aangesloten is. |

Bij opslaan wordt een streamkey gemaakt, zoals `verslaggever-zandvoort-3f9c0a…`, en openen de verbindingsgegevens.

*Geavanceerd:* vink **In plaats daarvan ophalen van een URL** aan als een encoder niet kan pushen. CasparCG haalt de
stream dan zelf op (`srt://`, `rtmp://`, `udp://`, `rtsp://`, `https://`) en er is geen streamkey.

## 2. Verbindingsgegevens versturen

**Verbindingsgegevens** toont, met kopieerknoppen:

- **Server (RTMP)**: `rtmp://<studio node>/live`
- **Streamkey**: de key van deze bron (behandel hem als een wachtwoord)
- **Volledige RTMP-URL**: server en key in één, voor apps met één URL-veld
- **SRT-URL**: `srt://<studio node>:8890?streamid=publish:live/<streamkey>`

Er staan ook stap-voor-stap-instructies bij voor OBS Studio, vMix, Larix Broadcaster (telefoon) en ffmpeg.

**Nieuwe streamkey** maakt de oude ongeldig voor nieuwe verbindingen (een stream die nu loopt wordt pas afgekapt als
hij opnieuw verbindt). Een bron verwijderen maakt zijn key ook ongeldig.

### OBS Studio

1. Instellingen → Stream: dienst *Aangepast…*
2. Server: de RTMP-server, Streamsleutel: de streamkey
3. Instellingen → Uitvoer (Geavanceerd): x264 of NVENC H.264, CBR, 4000–6000 kbps, keyframe-interval 2 s
4. Instellingen → Video: 1920×1080 op de framerate van het kanaal (25 of 50). Streamen starten.

Voor SRT zet je de SRT-URL bij Server en laat je de streamsleutel leeg (OBS 28 of nieuwer).

### vMix

Stream (tandwiel) → Destination *Custom RTMP Server* → URL = server, Stream Name or Key = streamkey. Voor SRT kies je
*SRT (Caller)* en plak je de SRT-URL.

### Larix Broadcaster (iOS/Android)

Settings → Connections → New connection → URL = volledige RTMP-URL (of de SRT-URL), mode Audio + Video.

### ffmpeg

```bash
ffmpeg -re -i input.mp4 -c:v libx264 -preset veryfast -b:v 6000k -maxrate 6000k -bufsize 12000k \
  -g 50 -keyint_min 50 -pix_fmt yuv420p -c:a aac -b:a 160k -ar 48000 \
  -f flv "rtmp://<studio node>/live/<streamkey>"
```

### Aanbevolen encoderinstellingen

H.264-video, AAC-audio 48 kHz (128–192 kbit/s), 1920×1080 op de framerate van het kanaal, constante bitrate
4–6 Mbit/s, keyframe elke 2 seconden, uploadsnelheid minstens 1,5× de bitrate, waar mogelijk bekabeld netwerk.

## 3. Signaal controleren

De status naast de bron:

| Status | Betekenis |
| --- | --- |
| **Ontvangt** | De stream komt binnen. Codecs, bitrate en starttijd staan erbij. |
| **Wacht op stream** | Er stuurt nog niemand naar deze key. |
| **Status onbekend** | De management node kan de ingest-API van de studio node niet bereiken (zie *Inrichten*). |
| **Opgehaald van URL** | CasparCG haalt de stream zelf op; er is geen ingest-status. |

Geweigerde verbindingen (verkeerde of oude streamkey) staan in het log van de management node.

## 4. Op DeckLink zetten (preview)

**Naar DeckLink** speelt de stream af op zijn SDI-uitgang zonder de ATEM te schakelen, zodat je hem kunt controleren op
de preview of multiview van de ATEM. Zet je hem klaar voordat de inzender begint, dan start hij zodra de stream
binnenkomt. Valt de stream weg en komt hij terug, dan start CasparCG hem vanzelf opnieuw. **Uitgang stoppen** beëindigt het.

## 5. Op de lucht zetten

- **Regie** → het kanaal → **Live nemen** → klik op de bron. De stream start op zijn DeckLink-uitgang en de ATEM
  schakelt naar zijn ingang. **Terug naar schema** gaat terug naar het schema en stopt de stream-uitgang.
- Of plan het: zet de bron als *Live*-item in een TV-blok en plan het blok in. Op dat moment start de regisseur de
  stream en schakelt de ATEM; aan het eind van het item gaat het schema verder.

Een bron die nog op *Wacht op stream* staat geeft zwart beeld op die ATEM-ingang tot de inzender begint.

## Inrichten

1. Installeer de studio node met `-ManagementHost <IP van de management node>` (zie [studio/README.md](../studio/README.md)).
   De ingest-server controleert streamkeys dan via `http://<management node>:8080/ingest/auth` (gebruik `-ManagementUrl`
   voor een ander adres of andere poort) en zet zijn status-API (TCP 9997) alleen open voor de management node.
   Een studio node die geïnstalleerd is voordat remote bronnen bestonden: draai de installer opnieuw met dezelfde opties.
2. Management node → **Apparatuur → Studio-nodes**: de studio node toont *Ingest-server bereikbaar*. Vul **Adres voor
   remote inzenders** in als inzenders van buiten je netwerk streamen (publiek IP-adres of hostnaam).
3. Van buiten je netwerk moeten inzenders de studio node bereiken op **TCP 1935** (RTMP) en/of **UDP 8890** (SRT):
   zet die poorten door op de router/firewall, of gebruik een VPN. Gebruik via internet bij voorkeur SRT.

Beveiliging: alleen geldige streamkeys kunnen versturen; alleen CasparCG en de agent op de studio node zelf kunnen
streams lezen; de ingest-API accepteert alleen de management node (het wachtwoord wordt op de management node gemaakt
en bewaard). Streamkeys in de nodestatus van de orchestrator worden gemaskeerd.
