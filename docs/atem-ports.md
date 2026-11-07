# ATEM inputs as connectors

The management app names ATEM inputs after the connector on the back of the switcher instead of a bare number:
**SDI in 8 · CASPARCG01**, **HDMI in 2**, **Colour bars**. That makes the channel setup read like cabling documentation.

## Where the switcher gets it from

The ATEM reports for every input whether it is an external connector and which kind (SDI, HDMI, component, ...).
So no table per model is needed: a Television Studio HD reports 1-4 HDMI and 5-8 SDI, a Production Studio 4K reports SDI.
The input number is the number printed on the connector. The name after the dot is the input's own name, as set on the
ATEM or in the orchestrator's ATEM inventory (rename inputs); factory names such as "Camera 8" are left off.

- Driver: `server/drivers.ts` adds `port` (ExternalPortType key) and `namesDefault` to every input.
- Pure logic: `server/atemports.ts` (`portParts`, `groupInputs`, `portSummary`), shared with the web UI; tests in `test/atem-ports.test.ts`.
- Web: `web/atemPorts.tsx` (`portLabel`, `PortOptions`, `useChannelInputs`), texts under `mgmt.atemPorts` (EN + NL).
- Offline: `GET /api/atems` stores the last input list a connected switcher reported in `atem_devices.inputs`, and returns it
  (with `status.cached = true`) while the ATEM is offline, so the pickers keep their labels.

## Where you see it

- **Setup → Channels**: the playout and fallback input pickers list the connectors first ("Connectors on the back"), then the
  ATEM's own sources (black, bars, media players). Under the ATEM the connector layout is shown (`HDMI 1-4 · SDI 5-8`).
  The M/E picker only appears on switchers with more than one M/E row. Channel cards show the connectors too.
- **Switch** (editors): camera buttons say "Camera · SDI in 5"; the button setup and source picker use the same labels.
- **Control room**: the on-air badge says "Playout node CASPARCG02 · SDI in 5"; program/preview buttons show the connector under the short name.
- **Devices**: every ATEM shows its connector layout.

The stored channel settings did not change: a channel still stores the ATEM input number.
