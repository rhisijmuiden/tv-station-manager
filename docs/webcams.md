# Webcams & streams

Live pictures from outside as an item in a programme, clicked together like a beeldkrant: a local webcam (a page on a site like webcam.nl), an IP camera over RTSP, an HLS stream, RTMP, SRT, an MJPEG camera or a camera picture that refreshes. Menu: **Editorial → Webcams & streams**.

## Adding a webcam

1. **Paste a link** and press **Look up**.
   - A web page (e.g. a webcam.nl page) is searched for the stream behind it: `<video>`/`<source>` tags, player settings in scripts (hls.js, video.js, JW Player, Clappr: any `.m3u8`, `rtsp://`, `.mjpg` URL), `og:video`, camera pictures and embedded players (`<iframe>`, one level deep). The best stream is picked (HLS, then RTSP, RTMP, SRT, video, MJPEG, picture); when there are more, you choose.
   - No stream found: the page itself is shown as it is (CasparCG HTML producer). Adverts or a cookie banner may be visible and the studio node needs internet access, so a direct stream link is better.
   - YouTube cannot be played directly; ask the owner of the webcam for an RTSP or HLS link.
2. The link is **tested** right away: the management node grabs one frame with ffmpeg (preview), and shows size, codec and whether there is sound.
3. **How it goes on air**: name, default length (30 s … 10 min, can be changed per programme), caption (text, "LIVE" badge, position), sound (off by default), channel logo/clock on top (on by default), seconds between pictures for a camera picture. *More options*: type, stream address, playback (through the management node or directly) and fill/fit for pictures.

User name and password in a link (`rtsp://user:pass@camera/…`) are stored but never shown in the UI or the API (`***`).

Every webcam is checked every 10 minutes (online/offline and a new preview picture); **Check now** does it at once.

## Planning

A webcam is a block item (`block_items.type = 'webcam'`). Every webcam gets its **own block** when it is saved, so it can be dragged from the media library (tab **Webcams**) into an hour clock, the week board, a rundown or another block. In the block editor **+ Webcam** adds one; the duration field can be left empty (= the length set on the webcam).

## On air

The director plays the webcam on the playout layer (10) of the channel and keeps the ATEM on the playout input:

| Type | Played as |
| --- | --- |
| HLS, RTSP, RTMP, SRT, video | `PLAY <ch>-10 "<management>/webcam/<id>/live.ts"`: the management node runs `ffmpeg -c copy` (RTSP over TCP, no sound unless switched on) and hands the stream to CasparCG as MPEG-TS. The studio node needs no internet access. With playback *directly*, CasparCG opens the stream URL itself. |
| Camera picture, MJPEG | `PLAY <ch>-10 [HTML] "<management>/webcam/page.html?id=<id>"`: the page shows the picture (fetched again every *n* seconds) or the MJPEG stream through the management node, with the caption. |
| Web page | `PLAY <ch>-10 [HTML] "<page url>"`. |

The caption of a video stream or web page is a transparent page on layer 11 (`page.html?id=<id>&caption=1`), below the channel overlay. When the stream does not come in, a "picture not available" card is shown (`page.html?id=<id>&offline=1`), the problem is in the as-run log (and mailed), and the director tries again every 5 seconds.

Webcams are often silent: the **audio under the broadcast** chosen for the block or item (a radio stream or a physical input) plays under a webcam just like under a clip or a beeldkrant.

Set **Settings → public URL** of the management node so the studio node can reach it.

Code: `apps/management/server/webcamlogic.ts` (pure: kinds, page scanning, ffmpeg arguments, play plan), `server/webcams.ts` (inspect, test, checks, relay, routes), `server/webcamdb.ts`, `server/webcam-page.ts` (the HTML page), `web/pages/Webcams.tsx`. Tests: `test/webcams.test.ts`.
