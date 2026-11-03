# Monitoring (orchestrator)

Menu **Monitoring** in the orchestrator shows the status of the whole platform on one page. Everything that is
monitored is placed in a **layer of the signal path**:

**Core** (orchestrator) > **Management** (director) > **TV nodes** (role studio / playout / live) > **Switchers** (ATEM) >
**Recorders** (HyperDeck) > **Distribution** (Owncast, web pages), plus **Infrastructure** as a supporting layer
(monitor devices of the blocks Infrastructure and Extra equipment, nodes with role "Other" and nodes waiting for approval).

The page is built to grow with the platform: the signal path bar sums up each layer (count and worst status) and never
gets longer when nodes are added, and a new kind of equipment only needs a mapping into a layer in
`web/monitorView.ts`; both views pick it up by themselves.

- **Health bar**: number of items per status; click a status to show only those items.
- **Signal path**: click a layer to show only that layer.
- **2D overview** (default): one card per layer with the items as tiles. Search on name, role or address. "Cards" shows
  metrics and problems, "Compact" two lines per item; above 24 items the page starts compact.
- **3D room**: one platform per layer, one block per item coloured by status (red blocks pulse). Rotate and zoom with the
  buttons, drag to rotate and tilt, "Cables" draws the signal path, "Only problems" dims everything that is OK. Names are
  shown for every item, or with many items only for problems and the selected item. Plain CSS 3D, no WebGL.
- **Details** (right, both views): status, problems, facts, CPU / RAM / disk, a CPU line of the last 5 minutes (built from
  the refreshes while the page is open), the last events of a monitor device, and buttons to open the item or the
  connection diagram.
- **Needs attention**: everything that is not OK, worst first.

The choice of view and layout is remembered per browser. The page refreshes every 5 seconds.

## Where the status comes from

| Item | Source | Problems shown |
|---|---|---|
| Node | agent heartbeat (`nodes`) | agent does not respond (no heartbeat for 45 s), never reported, waiting for approval, disk ≥ 90 %, memory ≥ 95 %, CPU ≥ 95 %, CasparCG not running, media share not reachable |
| ATEM | ATEM inventory (`server/atem.ts`) | not reachable; badge shows automation / locked |
| HyperDeck | HyperDeck inventory (`server/hyperdeck.ts`) | not reachable, remote off, no media, < 15 min left while recording |
| Orchestrator | platform | mail server not set, no backup location, last backup failed, no successful backup in 8 days |
| Monitor device | `monitor_devices`, probed every 15 s | see below |

## Monitor devices

Added with **Add equipment** at the top or **Add** on the Distribution / Infrastructure card (admins). Check types:

- **Owncast**: reads the public, read-only `GET /api/status` (+ `/api/config` for the name). Shows live / not live,
  viewers, peak this stream and all-time peak. "Reachable, but not live" is a warning. Nothing is changed on Owncast
  and no admin credentials or stream keys are used.
- **Web page**: HTTP(S) GET, OK below status 400.
- **Port**: TCP connect to `host:port` (e.g. `10.40.0.154:445` for the UNAS SMB share).
- **Manual**: status set by hand (OK / warning / down / unknown).

A probe has to fail twice in a row before the device counts as down; going down and coming back are mailed
(mail server settings) and logged in the device history.

**Agent on this machine**: a device can be linked to an enrolled node. Install the normal TVSM agent on the Linux
server that runs Owncast (`install.sh agent --orchestrator http://<orchestrator>:8080`), approve it with role
"Other", and pick it in the device dialog. The device then also shows CPU, memory and disk, and warns when the agent
stops answering or the disk fills up. A linked node is shown on the device instead of a second time under Infrastructure.

Code: `apps/orchestrator/server/monitoring.ts` (API, probes, polling), `server/monitorlogic.ts` (pure health rules,
tested), UI `web/Monitoring.tsx` (page, 2D overview, details), `web/MonitoringRoom.tsx` (3D room) and
`web/monitorView.ts` (pure: layers, filters, summaries, room layout and projection; tested in `test/monitorView.test.ts`). API: `GET /api/monitoring`, `GET|POST|PUT|DELETE /api/monitoring/devices[/:id]`,
`POST /api/monitoring/devices/:id/check`.
