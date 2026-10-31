# Remote sources

*Nederlands: [remote-sources.nl.md](remote-sources.nl.md)*

A remote source is a live stream from outside the studio: a reporter with a phone, a remote studio running vMix, a
church service with a hardware encoder. The contributor pushes it over **RTMP** or **SRT** to the studio node. CasparCG
plays it to a **DeckLink SDI output**, and the ATEM input that output is cabled to goes on air.

```
Contributor (OBS / vMix / Larix / encoder)
   │  RTMP  rtmp://<studio node>/live/<stream key>      or   SRT  srt://<studio node>:8890?streamid=publish:live/<stream key>
   ▼
Ingest server on the studio node (MediaMTX, "tvsm-ingest")  ── asks the management node: is this stream key valid?
   │  rtmp://127.0.0.1/live/<stream key>
   ▼
CasparCG channel N  ──►  DeckLink SDI output N  ──►  ATEM input  ──►  on air
```

## 1. Add the source

Management node → **Remote sources** → **Add remote source** (role editor-in-chief or admin):

| Field | What to enter |
| --- | --- |
| Name | Who or what is sending, e.g. *Reporter Zandvoort*. The stream key starts with it. |
| Studio node | The studio node whose ingest server receives the stream. |
| DeckLink output | The SDI output (= CasparCG channel) that plays the stream. Use an output the playout of a channel does not use, e.g. output 2 next to channel 1 on output 1. |
| ATEM input | The ATEM input that DeckLink output is cabled to. |

Saving creates a stream key such as `reporter-zandvoort-3f9c0a…` and opens the connection details.

*Advanced:* tick **Pull from a URL instead** when an encoder cannot push. CasparCG then fetches the stream itself
(`srt://`, `rtmp://`, `udp://`, `rtsp://`, `https://`) and no stream key is used.

## 2. Send the connection details

**Connection details** shows, with copy buttons:

- **Server (RTMP)**: `rtmp://<studio node>/live`
- **Stream key**: the key of this source (treat it as a password)
- **Full RTMP URL**: server + key in one, for apps with a single URL field
- **SRT URL**: `srt://<studio node>:8890?streamid=publish:live/<stream key>`

It also has step-by-step instructions for OBS Studio, vMix, Larix Broadcaster (phone) and ffmpeg.

**New stream key** revokes the old one for new connections (a stream that is running is not cut off until it
reconnects). Deleting the source revokes its key as well.

### OBS Studio

1. Settings → Stream: Service *Custom…*
2. Server: the RTMP server, Stream key: the stream key
3. Settings → Output (Advanced): x264 or NVENC H.264, CBR, 4000–6000 kbps, keyframe interval 2 s
4. Settings → Video: 1920×1080 at the channel's frame rate (25 or 50). Start Streaming.

For SRT put the SRT URL in Server and leave the stream key empty (OBS 28 or newer).

### vMix

Stream (cog) → Destination *Custom RTMP Server* → URL = server, Stream Name or Key = stream key. For SRT choose
*SRT (Caller)* and paste the SRT URL.

### Larix Broadcaster (iOS/Android)

Settings → Connections → New connection → URL = full RTMP URL (or the SRT URL), mode Audio + Video.

### ffmpeg

```bash
ffmpeg -re -i input.mp4 -c:v libx264 -preset veryfast -b:v 6000k -maxrate 6000k -bufsize 12000k \
  -g 50 -keyint_min 50 -pix_fmt yuv420p -c:a aac -b:a 160k -ar 48000 \
  -f flv "rtmp://<studio node>/live/<stream key>"
```

### Recommended encoder settings

H.264 video, AAC 48 kHz audio (128–192 kbit/s), 1920×1080 at the channel's frame rate, constant bitrate 4–6 Mbit/s,
keyframe every 2 seconds, upload speed at least 1.5× the bitrate, wired network where possible.

## 3. Check the signal

The status next to the source shows:

| Status | Meaning |
| --- | --- |
| **Receiving** | The stream is coming in. The codecs, bitrate and start time are shown. |
| **Waiting for stream** | Nobody is sending to this key yet. |
| **Status unknown** | The management node cannot reach the ingest API of the studio node (see *Setup*). |
| **Pulled from URL** | CasparCG pulls the stream itself; there is no ingest status. |

Rejected connections (wrong or old stream key) are logged in the management node log.

## 4. Put it on DeckLink (preview)

**Send to DeckLink** plays the stream on its SDI output without switching the ATEM, so you can check it on the ATEM
preview or multiview. If you send it before the contributor starts, it starts as soon as the stream arrives. When the
stream drops and comes back, CasparCG is restarted on it automatically. **Stop output** ends it.

## 5. Switch it on air

- **Control room** → the channel → **Take live** → click the source. The stream is started on its DeckLink output
  and the ATEM switches to its input. **Back to schedule** returns to the planning and stops the stream output.
- Or plan it: add the source as a *Live* item to a TV block and schedule the block. At that time the director starts
  the stream and switches the ATEM; at the end of the item the schedule continues.

A source that is still *Waiting for stream* gives black on that ATEM input until the contributor starts.

## Setup

1. Install the studio node with `-ManagementHost <management node IP>` (see [studio/README.md](../studio/README.md)).
   The ingest server then checks stream keys at `http://<management node>:8080/ingest/auth` (use `-ManagementUrl` for
   another address or port) and opens its status API (TCP 9997) to the management node only.
   A studio node installed before remote sources existed: run the installer again with the same options.
2. Management node → **Devices → Studio nodes**: the studio node shows *Ingest server reachable*. Fill in **Address for
   remote senders** when contributors stream from outside your network (public IP or host name).
3. From outside your network, contributors must reach the studio node on **TCP 1935** (RTMP) and/or **UDP 8890** (SRT):
   forward those ports on the router/firewall, or use a VPN. Prefer SRT over the internet; it copes with packet loss.

Security: only valid stream keys can publish; only CasparCG and the agent on the studio node itself can read streams;
the ingest API only accepts the management node (its password is generated and kept on the management node). Stream
keys in the orchestrator's node status are masked.
