# Monitoring (orchestrator)

Menu **Monitoring** in the orchestrator shows the status of the whole platform on one page, as a block diagram:

- **Core**: the orchestrator itself (version, update channel, uptime, mail alerts, last backup).
- **Infrastructure** (control line from the core): TV studio nodes (role studio / playout / live, with count), management
  nodes, ATEM switchers, HyperDecks, other nodes and any extra devices placed in this block.
- **Distribution** (status line from the core, "program" arrow from infrastructure): Owncast servers and other outlets.
- **Extra equipment**: hard to monitor gear, checked by port / web page or with a status set by hand.

Every item is OK, warning, down or unknown. Below the diagram, "Needs attention" lists every problem, worst first.
The page refreshes every 5 seconds.

## Where the status comes from

| Item | Source | Problems shown |
|---|---|---|
| Node | agent heartbeat (`nodes`) | agent does not respond (no heartbeat for 45 s), never reported, waiting for approval, disk ≥ 90 %, memory ≥ 95 %, CPU ≥ 95 %, CasparCG not running, media share not reachable |
| ATEM | ATEM inventory (`server/atem.ts`) | not reachable; badge shows automation / locked |
| HyperDeck | HyperDeck inventory (`server/hyperdeck.ts`) | not reachable, remote off, no media, < 15 min left while recording |
| Orchestrator | platform | mail server not set, no backup location, last backup failed, no successful backup in 8 days |
| Monitor device | `monitor_devices`, probed every 15 s | see below |

## Monitor devices

Added with **Add** on a block (admins). Check types:

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
stops answering or the disk fills up. A linked node is shown on the device instead of a second time under "Other nodes".

Code: `apps/orchestrator/server/monitoring.ts` (API, probes, polling), `server/monitorlogic.ts` (pure health rules,
tested), UI `web/Monitoring.tsx`. API: `GET /api/monitoring`, `GET|POST|PUT|DELETE /api/monitoring/devices[/:id]`,
`POST /api/monitoring/devices/:id/check`.
