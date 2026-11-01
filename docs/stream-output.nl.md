# Stream-output

*English: [stream-output.md](stream-output.md)*

Management node → **Stream-output** stuurt een tv-kanaal of een live evenement via RTMP(S) naar de eigen streamserver
(de stream op de website), YouTube, Facebook, Twitch of een andere RTMP-server. Eén stream kan tegelijk naar meerdere
bestemmingen.

```
Tv-kanaal:       CasparCG-kanaal ─(H.264-encoder op de studio node)─► ingest-server op de studio node ─┐
Live evenement:  inzender (OBS, vMix, encoder) ──────────────────────► ingest-server op de studio node ─┤
                                                                                                       ▼
                     management node: per bestemming één `ffmpeg -c copy`-relay ──► website / YouTube / Facebook
```

- **Uitgang van een tv-kanaal**: wat CasparCG op een kanaal speelt, inclusief logo en graphics. CasparCG codeert het
  één keer (FFmpeg-consumer, `ADD <kanaal>-<700+id> STREAM ...`) en publiceert het op zijn eigen ingest-server
  (MediaMTX) als `program/out-<id>`. Er hoeft niets extra op de studio node geïnstalleerd te worden.
- **Live evenement (remote bron)**: de stream van de inzender gaat ongewijzigd door (geen logo, geen tweede codering)
  en blijft tegelijk beschikbaar voor de ATEM. Start je de stream-output vóór het evenement, dan begint het doorsturen
  zodra de stream binnenkomt.
- Per bestemming één relay: een bestemming die faalt (verkeerde sleutel, platform plat) probeert het zelf opnieuw (5 s,
  oplopend tot 60 s) zonder de andere te storen. Gestarte streams komen terug na een herstart van de management node of
  CasparCG.

## 1. Bestemmingen

**Bestemming toevoegen** (hoofdredacteur of beheerder):

| Platform | Server-URL | Streamsleutel |
| --- | --- | --- |
| Eigen server / RTMP | bijv. `rtmp://stream.example.org/live` (of de volledige URL incl. sleutel) | optioneel, achter de URL geplakt |
| YouTube | leeg = `rtmp://a.rtmp.youtube.com/live2` | YouTube Studio → Live gaan → Stream |
| Facebook | leeg = `rtmps://live-api-s.facebook.com:443/rtmp` | Live Producer → Streamingsoftware (permanente sleutel voor 24/7) |
| Twitch | leeg = `rtmp://live.twitch.tv/app` | Creator Dashboard → Instellingen → Stream |

Streamsleutels blijven op de management node en worden nooit meer getoond (alleen de laatste 4 tekens). Laat de
sleutel bij bewerken leeg om hem te behouden.

## 2. Streams

**Stream toevoegen**: de uitgang van een tv-kanaal (studio node + CasparCG-kanaal) of een remote bron, plus de
bestemmingen. Instellingen bij een kanaal: videobitrate (standaard 4500 kbit/s), audiobitrate (160 kbit/s AAC),
resolutie (gelijk aan het kanaal, of 720p), encoder (x264 op de CPU, of NVIDIA NVENC), de-interlacen (aan; aan laten
bij 1080i50) en extra FFmpeg-opties voor specialisten. Elke 50 frames een keyframe (2 s bij 25 fps), zoals YouTube en
Facebook eisen.

## 3. Starten en controleren

**Start streamen** (ook operators). Per bestemming: *Verbinden*, *Live* (bitrate, sinds) of *Opnieuw verbinden* met de
laatste fout. **Stoppen** beëindigt alle bestemmingen en haalt de encoder uit CasparCG.

## Netwerk

- De management node moet de bestemmingen bereiken op TCP 1935 (RTMP) en TCP 443 (RTMPS, Facebook), en de
  ingest-server van de studio node op TCP 1935 (al open voor remote bronnen). Hij logt daar in met hetzelfde
  gegenereerde wachtwoord als voor de status-API van de ingest-server.
- Internetupload: de bitrate één keer per bestemming (website + YouTube + Facebook op 4,5 Mbit/s ≈ 14 Mbit/s).

## Problemen oplossen

| Symptoom | Oorzaak |
| --- | --- |
| *CasparCG start de encoder…* blijft staan | CasparCG kan niet publiceren naar `rtmp://127.0.0.1/program/out-<id>`; zie het CasparCG-log op de studio node. De encoder wordt elke 20 s opnieuw toegevoegd. Met NVENC moet de GPU-driver het ondersteunen; gebruik anders x264. |
| *CasparCG weigerde de stream-encoder* | Het AMCP-commando `ADD ... STREAM` faalde, meestal door de extra opties. |
| Bestemming *Opnieuw verbinden*, `Input/output error` | Verkeerde streamsleutel, of het platform accepteert de stream (nog) niet. |
| Bestemming *Opnieuw verbinden*, `Connection timed out` | Firewall tussen de management node en de bestemming of de studio node. |
| Live evenement goed op de ATEM, platform weigert | Encoder van de inzender: gebruik H.264 + AAC, elke 2 s een keyframe. |
