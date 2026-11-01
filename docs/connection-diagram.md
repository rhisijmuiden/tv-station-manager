# Connection diagram, manual switching and the automation lock

Menu *Connection diagram* in the orchestrator draws how the equipment is cabled: which server and which DeckLink
output goes into which ATEM input, how ATEMs feed each other, and what sits behind them (capture box, encoder,
monitor). The diagram shows live tally, and every ATEM on it can be switched by hand and locked for the automation.

## Drawing the diagram

1. *Edit diagram* (editor and up). On an empty diagram, *Place all nodes and ATEMs* puts every approved node (except
   management nodes) and every registered ATEM on the canvas; studio, playout and live nodes get a
   DeckLink 4K Extreme 12G card.
2. *Add device* places one more node, ATEM, or any other box (camera, converter, encoder, recorder, monitor,
   router) with a first card.
3. Select a node or device → *Cards & ports*: add cards from presets (DeckLink 4K Extreme 12G, Duo 2, Quad 2,
   8K Pro, Studio 4K, Mini Monitor/Recorder 4K, UltraStudio HD Mini, camera, converter, monitor) or a custom card,
   and rename ports, change their direction (input/output) and connector. On node outputs you can note the CasparCG
   channel (`ch`) that plays there.
4. Drag from an output dot (right side of a device) to an input dot (left side) to draw a cable. An input takes one
   cable; an output can feed several (e.g. through a distribution amplifier). Select a cable to set its type
   (SDI, HDMI, fibre, IP, other) and a label (cable number, patch panel), or to remove it.
5. *Arrange* lays the diagram out by signal flow: sources on the left, each ATEM one column right of what feeds it,
   so a chain of ATEMs reads left to right as a hierarchy.

ATEM ports come from the switcher itself: every physical input (with the names given under *ATEM switchers*),
*Program*, every *Aux* and *Multiview* output. When an ATEM later reports fewer inputs, cables on missing ports are
drawn dashed and listed as a warning until fixed. A cable from a node into an ATEM input also fills in *Fed by* for
that input in the ATEM inventory.

Positions, cards and cables are stored in the orchestrator database (`diagram_devices`, `diagram_links`) and so are
part of its backups. Removing a node or ATEM from the orchestrator also removes it and its cables from the diagram.

## Live tally

- **On air** (thick, animated, brand pink): the chain that ends at a *final* ATEM, one whose program output is not
  cabled into another ATEM. From its program input the chain is followed back through upstream ATEMs' *Program* or
  *Aux* outputs (an aux showing "M/E 1 Program" follows that ATEM's program).
- **Program** (red) / **Preview** (green): the cable into the input an ATEM has on program / preview (M/E 1).
- The ATEM boxes show PGM/PVW on their inputs and the current source on *Program* and *Aux* outputs.

## Switching by hand

Click an ATEM on the diagram (or open it under *ATEM switchers*): program and preview buses, CUT, AUTO, an M/E
selector on multi-M/E models and a source per aux output. Any signed-in user (operator and up) can switch; every
program, cut, auto and aux change is logged in the switcher's activity.

When the ATEM is released to the automation, a program/cut/auto/aux switch first asks *Lock and switch* (recommended)
or *Switch only*: the automation may otherwise switch back at the next item. Preview never asks, it does not change
what is on air.

## Lock and release ("vastzetten" / "vrijgeven")

Per ATEM: **Automation** (the management node's director may switch it) or **Locked** (only people switch it). Lock
with an optional reason; who and when is shown everywhere. While locked:

- The director and Visual Radio keep running the schedule on the servers (CasparCG keeps playing), but they do
  **not** switch that ATEM. Their switches are held.
- On release, the last held program switch is taken straight away, so the station is back on the schedule. If the
  schedule did not want a switch during the lock, the picture stays as the operator left it until the next item.
- Manual switching in the management node's control room for that ATEM is refused ("locked in the orchestrator");
  the control room shows who locked it and why.

### Connecting the management node

1. Orchestrator: *ATEM switchers* → *Automation link* (admin). Copy the address and the token. *New token* makes the
   old one stop working at once.
2. Management node: *Devices* → *Orchestrator link*: switch on *Follow the locks of the orchestrator*, enter the
   orchestrator address (e.g. `http://10.40.6.201:8080`) and the token, save. The badge shows *Connected*.
3. ATEMs are matched **by address**: use the same IP or host name for an ATEM in the orchestrator and on the
   management node. The card warns about ATEMs the orchestrator does not know under the same address.

The management node asks every 3 seconds (`GET /automation-api/v1/atem-control`, `Authorization: Bearer <token>`).
If the orchestrator cannot be reached, the last known locks stay in force (a lock is a deliberate decision); switching
the link off on the management node releases all locks there. The token is stored encrypted on the management node.

## API

- `GET /api/diagram` – devices with resolved ports and ATEM state, cables, broken cables, nodes/ATEMs not placed yet.
- `POST /api/diagram/devices` `{ kind: node|atem|device, refId?, name?, deviceType?, x, y, cards? }`,
  `PUT /api/diagram/devices/:id` `{ name?, deviceType?, cards?, notes? }`, `DELETE /api/diagram/devices/:id`,
  `PUT /api/diagram/layout` `{ positions: [{ id, x, y }] }` (editor).
- `POST /api/diagram/links` `{ from: { device, port }, to: { device, port }, cable?, label? }`,
  `PUT/DELETE /api/diagram/links/:id` (editor).
- `POST /api/atem/:id/switch` `{ action: program|preview|cut|auto|aux, me?, input?, lock? }` (operator; for aux `me`
  is the aux index), `PUT /api/atem/:id/control` `{ mode: automation|locked, reason? }` (operator).
- `GET/POST /api/automation`, `/api/automation/token` (admin); `GET /automation-api/v1/atem-control` (token).
- Management node: `GET/PUT /api/orchestrator-link`, `POST /api/orchestrator-link/test`.
