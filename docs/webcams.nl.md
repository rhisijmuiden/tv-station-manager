# Webcams & streams

Live beelden van buiten als item in een programma, net zo makkelijk bij elkaar geklikt als een beeldkrant: een webcam uit de omgeving (een pagina op een site als webcam.nl), een IP-camera via RTSP, een HLS-stream, RTMP, SRT, een MJPEG-camera of een camerafoto die steeds ververst. Menu: **Redactie → Webcams & streams**.

## Een webcam toevoegen

1. **Plak een link** en druk op **Opzoeken**.
   - Een webpagina (bijv. een pagina van webcam.nl) wordt doorzocht op de stream die erachter zit: `<video>`/`<source>`-tags, spelerinstellingen in scripts (hls.js, video.js, JW Player, Clappr: elke `.m3u8`-, `rtsp://`- of `.mjpg`-link), `og:video`, camerafoto's en ingesloten spelers (`<iframe>`, één niveau diep). De beste stream wordt gekozen (HLS, dan RTSP, RTMP, SRT, video, MJPEG, foto); zijn er meer, dan kies je zelf.
   - Geen stream gevonden: de pagina zelf wordt getoond zoals hij is (CasparCG HTML-producer). Reclame of een cookiemelding kan in beeld komen en de studio node heeft dan internet nodig, dus een directe streamlink is beter.
   - YouTube kan niet rechtstreeks; vraag de eigenaar van de webcam om een RTSP- of HLS-link.
2. De link wordt meteen **getest**: de management node pakt met ffmpeg één beeld (voorbeeld) en toont formaat, codec en of er geluid is.
3. **Zo gaat hij de uitzending in**: naam, standaardlengte (30 s … 10 min, per programma aan te passen), onderschrift (tekst, "LIVE", positie), geluid (standaard uit), zenderlogo/klok erover (standaard aan), seconden tussen foto's bij een camerafoto. *Meer opties*: soort, streamadres, afspelen (via de management node of rechtstreeks) en vullen/passend maken bij foto's.

Gebruikersnaam en wachtwoord in een link (`rtsp://gebruiker:wachtwoord@camera/…`) worden bewaard maar nooit getoond in de UI of de API (`***`).

Elke webcam wordt elke 10 minuten gecontroleerd (online/offline en een nieuw voorbeeldbeeld); **Nu controleren** doet het meteen.

## Plannen

Een webcam is een blokitem (`block_items.type = 'webcam'`). Elke webcam krijgt bij opslaan een **eigen blok**, zodat je hem vanuit de mediabak (tab **Webcams**) in een uurklok, het weekbord, een draaiboek of een ander blok sleept. In de blokeditor voegt **+ Webcam** er een toe; het duurveld mag leeg blijven (= de lengte van de webcam).

## In de uitzending

De regisseur speelt de webcam op de playout-laag (10) van het kanaal en houdt de ATEM op de playout-input:

| Soort | Afgespeeld als |
| --- | --- |
| HLS, RTSP, RTMP, SRT, video | `PLAY <ch>-10 "<management>/webcam/<id>/live.ts"`: de management node draait `ffmpeg -c copy` (RTSP over TCP, zonder geluid tenzij aangezet) en geeft de stream als MPEG-TS aan CasparCG. De studio node heeft geen internet nodig. Bij afspelen *rechtstreeks* opent CasparCG de streamlink zelf. |
| Camerafoto, MJPEG | `PLAY <ch>-10 [HTML] "<management>/webcam/page.html?id=<id>"`: de pagina toont de foto (elke *n* seconden opnieuw) of de MJPEG-stream via de management node, met het onderschrift. |
| Webpagina | `PLAY <ch>-10 [HTML] "<pagina-url>"`. |

Het onderschrift bij een videostream of webpagina is een transparante pagina op laag 11 (`page.html?id=<id>&caption=1`), onder de zender-overlay. Komt de stream niet binnen, dan verschijnt een kaart "beeld niet beschikbaar" (`page.html?id=<id>&offline=1`), staat het probleem in de as-run log (en gaat er een mail uit) en probeert de regisseur het elke 5 seconden opnieuw.

Stel **Instellingen → publieke URL** van de management node in, zodat de studio node hem kan bereiken.
