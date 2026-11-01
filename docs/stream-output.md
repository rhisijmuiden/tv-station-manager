# Stream output

*Nederlands: [stream-output.nl.md](stream-output.nl.md)*

Management node → **Stream output** sends a TV channel or a live event over RTMP(S) to the station's own stream
server (the stream on the website), YouTube, Facebook, Twitch or any other RTMP server. One stream can go to several
destinations at once.

```
TV channel:  CasparCG channel ─(H.264 encoder on the studio node)─► ingest server on the studio node ─┐
Live event:  contributor (OBS, vMix, encoder) ─────────────────────► ingest server on the studio node ─┤
                                                                                                       ▼
                     management node: one `ffmpeg -c copy` relay per destination ──► website / YouTube / Facebook
```

- **TV channel output**: what CasparCG plays on a channel, including logo and graphics. CasparCG encodes it once
  (FFmpeg consumer, `ADD <channel>-<700+id> STREAM ...`) and publishes it to its own ingest server (MediaMTX) at
  `program/out-<id>`. Nothing extra has to be installed on the studio node.
- **Live event (remote source)**: the stream a contributor pushes is forwarded unchanged (no logo, no second encode)
  and stays available for the ATEM at the same time. Start the stream output before the event and forwarding begins as
  soon as the stream comes in.
- One relay per destination: a destination that fails (wrong key, platform down) retries by itself (5 s, growing to
  60 s) without affecting the others. Started streams come back after a restart of the management node or CasparCG.

## 1. Destinations

**Add destination** (editor-in-chief or admin):

| Platform | Server URL | Stream key |
| --- | --- | --- |
| Own server / RTMP | e.g. `rtmp://stream.example.org/live` (or the full URL including the key) | optional, appended to the URL |
| YouTube | empty = `rtmp://a.rtmp.youtube.com/live2` | YouTube Studio → Go live → Stream |
| Facebook | empty = `rtmps://live-api-s.facebook.com:443/rtmp` | Live Producer → Streaming software (persistent key for 24/7) |
| Twitch | empty = `rtmp://live.twitch.tv/app` | Creator Dashboard → Settings → Stream |

Stream keys stay on the management node and are never shown again (only the last 4 characters). Leave the key empty
when editing to keep it.

## 2. Streams

**Add stream**: a TV channel output (studio node + CasparCG channel) or a remote source, plus the destinations.
Channel settings: video bitrate (default 4500 kbit/s), audio bitrate (160 kbit/s AAC), resolution (same as the
channel, or 720p), encoder (x264 on the CPU, or NVIDIA NVENC), deinterlace (on; keep it on for 1080i50) and extra
FFmpeg options for specialists. Keyframe every 50 frames (2 s at 25 fps), as YouTube and Facebook require.

## 3. Start and check

**Start streaming** (operators too). Per destination: *Connecting*, *Live* (bitrate, since) or *Reconnecting* with the
last error. **Stop** ends every destination and removes the encoder from CasparCG.

## Network

- The management node must reach the destinations on TCP 1935 (RTMP) and TCP 443 (RTMPS, Facebook), and the studio
  node's ingest server on TCP 1935 (already open for remote sources). It logs in there with the same generated
  password it uses for the ingest status API.
- Internet upload: the bitrate once per destination (website + YouTube + Facebook at 4.5 Mbit/s ≈ 14 Mbit/s).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| *CasparCG is starting the encoder…* stays | CasparCG cannot publish to `rtmp://127.0.0.1/program/out-<id>`; see the CasparCG log on the studio node. The encoder is re-added every 20 s. With NVENC the GPU driver must support it; otherwise use x264. |
| *CasparCG refused the stream encoder* | The AMCP `ADD ... STREAM` command failed, usually because of the extra options. |
| Destination *Reconnecting*, `Input/output error` | Wrong stream key, or the platform does not accept the stream (yet). |
| Destination *Reconnecting*, `Connection timed out` | Firewall between the management node and the destination or the studio node. |
| Live event fine on the ATEM, platform rejects it | Contributor's encoder: use H.264 + AAC, keyframe every 2 s. |
