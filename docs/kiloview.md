# Kiloview encoders and decoders (orchestrator)

The orchestrator keeps the Kiloview boxes that carry the TV signal between locations, next to the ATEMs and the Teranex.
At IJmond360 the **E3 encoder** in the Beverwijk studio sends the picture over SRT to the **D260 decoder** in Velsen,
whose SDI output is the TV signal.

## Read only

These boxes are in the live chain, so the orchestrator **only reads** them. It logs in over the device's HTTP API and
asks for a fixed list of status pages every 10 seconds. Kiloview implements dangerous actions (reboot, restore, factory
reset, EDID reset) as plain GET requests too, so the client checks every request against an allowlist
(`allowedPath` in `server/kiloviewlogic.ts`) before sending it. Never widen that list with "all GETs".

| Kind | Login | Status pages |
| --- | --- | --- |
| Encoder (E3) | `POST /api/systemctrl/users/login`, header `Authorization: <token>` | `systemctrl/system/getSystemInfo?version=true`, `systemctrl/system/getNetworkSpeed`, `codec/vin/active_interface`, `codec/{hdmi,sdi}/vin/detail`, `codec/{hdmi,sdi}/venc/settings`, `codec/{hdmi,sdi}/audio/input`, `streamer/{hdmi,sdi}/stream/list` |
| Decoder (D260 / D350) | `POST /api/users/login`, header `app: <login answer as JSON + language>` | `report/system_info`, `report/codec_info`, `output/list`, `output/get?output_id=N` |

The field names follow the answers of the real boxes (E3 firmware 1.26, D260 firmware 2.20), see
`apps/orchestrator/test/kiloviewFixtures.ts`. D260 position status 2 = playing, 3 = error (seen on the device, not
documented).

## What it shows

- Menu **Kiloview** (admins add / edit / remove): type (encoder / decoder), IP address, user name and password
  (stored encrypted, never shown again), optional expected format, *Test connection*.
- **Encoder**: active input (HDMI / SDI) with format and lock, encoder (codec, bitrate, resolution, fps), audio, every
  stream (SRT, RTMP, NDI) with its destination (stream keys hidden) and whether it runs, network in / out.
- **Decoder**: per output the connector (SDI / HDMI1), the incoming stream (name, type, format, bitrate) and the output
  format; CPU, memory, temperature.
- **Watch**: per stream (encoder) or output (decoder). What runs at first contact is watched; admins change it with the
  checkboxes (stored in the orchestrator only).
- All status answers as received (secrets masked), and the event list.

## Alerts (mail to the alert recipients)

Every problem must be seen on two polls in a row (about 20 s) before it is mailed; a mail follows when it is resolved.

- Offline (two failed polls) and back online; a refused login shows as such.
- Encoder: **no signal on the input**; a watched **stream stopped** (e.g. the SRT link to Velsen).
- Decoder: a watched output gets **no picture** from its stream.
- Warning: input (encoder) or watched output (decoder) format other than expected, temperature from 75 °C, CPU high.

## Monitoring

Layer **Studio links** (`transport`) between Converters and Distribution, in 2D and in the 3D room. Down = offline,
no input, stream stopped or no picture; warning = format, temperature, CPU. The dashboard gets a Kiloview tile once a
box is registered. Not on the connection diagram yet.

## Technical

- `server/kiloview.ts`: client (`RealKiloviewClient`, logs in again once when the session runs out), tables
  `kiloviews` + `kiloview_events`, poller, routes `GET /api/kiloview[/:id]`, `POST /api/kiloview/test`,
  `POST/PUT/DELETE /api/kiloview[/:id]`, `PUT /api/kiloview/:id/watch` (admins). No route writes to a device.
- `server/kiloviewlogic.ts`: pure allowlist, parsers, format names (`1920x1080i 50Hz` -> `1080i50`), masking, issues.
- A host may be written as `ip:port`. The orchestrator must reach the boxes on port 80.
- Tests: `test/kiloview.test.ts` (parsers on the real answers, a fake box over HTTP that records every request and
  checks nothing outside the allowlist is ever sent).
