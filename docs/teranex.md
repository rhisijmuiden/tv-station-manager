# Teranex converters (orchestrator)

The orchestrator keeps Blackmagic Teranex converters (Teranex AV, Teranex Express, Teranex 2D / 3D processor) in its
equipment overview, next to the nodes and the ATEM switchers. At IJmond360 the Teranex AV sits in the live chain:
ATEM -> Teranex -> Red Bee encoder (live TV output).

## Read only

A Teranex in the live chain must not be changed by accident, so the orchestrator **only reads** it. It connects over
the Teranex Ethernet Protocol (TCP **9800**), reads the status the device sends by itself and only sends `PING` as a
keep-alive. There are no buttons that change the device: input, format, aspect, presets and so on are set on the front
panel or in Blackmagic Teranex Setup. Adding control later needs an explicit decision.

## What it shows

- **Register** a Teranex by IP address (menu *Teranex*, admin only). Optionally an **expected input format**
  (e.g. `1080i50`).
- **Signal**: a drawing of the front panel with the lit input (SDI / HDMI / OPT) and audio (Embed / AES / Analog)
  keys, the format on the input, the output format, whether a signal is present and the genlock reference. Changes
  made on the front panel show up within a second.
- **Device**: model, software version, protocol version, label, last seen.
- **All reported settings**: every status block the device sends, exactly as received (for reference).
- **Events**: online / offline, input signal lost / back, input and output format changes.

## Alerts (mail to the alert recipients)

- Offline for more than 15 s, and back online.
- **No input signal** for more than 5 s (everything after the Teranex, such as the broadcast encoder, gets no picture
  from it), and input back.
- Input format different from the expected format.

## Monitoring and diagram

- Monitoring: layer **Converters** between Switchers and Distribution. No signal = down (red), wrong format or genlock
  not locked = warning.
- Connection diagram: *Add device -> Teranex* places it with the connectors of its model (Teranex AV: 12G-SDI In,
  HDMI In, Optical In, 12G-SDI Out A/B, HDMI Out, Optical Out). The box shows the input format, or NO SIGNAL in red.
- Dashboard: a Teranex tile (online / total, how many without input) once one is registered.

## On the device

- Give the Teranex a fixed IP address (Teranex Setup -> Network).
- TCP 9800 must be reachable from the orchestrator.

## Technical

- `apps/orchestrator/server/teranex.ts`: one TCP link per device (reconnects every 5 s, `PING` every 10 s, dead after
  30 s without data), tables `teranexes` + `teranex_events`, routes `GET /api/teranex[/:id]`, `POST/PUT/DELETE` for
  admins. No route writes to the device.
- `server/teranexlogic.ts`: pure protocol parser (blocks, partial chunks, ACK), snapshot, diagram presets.
- On the diagram a Teranex is a `device` row with `ref_id = 'teranex:<id>'`; the API shows it as kind `teranex`.
- A host may be written as `ip:port`; the default port is 9800.
- Tests: `test/teranex.test.ts` (parser, API with a fake link, real connector against a small fake Teranex that also
  checks nothing but `PING` is sent). Field names follow the published protocol; not yet tried on the real device.
