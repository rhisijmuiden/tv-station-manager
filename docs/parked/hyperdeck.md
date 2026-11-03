# HyperDecks (orchestrator)

> **Parked (2026-11-03).** There is no HyperDeck in the facility: the device at 10.40.5.219 turned out to be a
> Teranex AV, which the orchestrator now supports instead (see [Teranex](../teranex.md)). HyperDeck support is no longer
> in `test`/`production`; the complete code (server module, UI page, tests, translations) is kept on the branch
> [`parked/hyperdeck`](https://github.com/rhisijmuiden/tv-station-manager/tree/parked/hyperdeck) (originally PR #31).
> To bring it back: restore `apps/orchestrator/server/hyperdeck.ts`, `hyperdecklogic.ts`, `web/Hyperdeck.tsx`,
> `test/hyperdeck.test.ts`, the `orch.hyperdeck` translations, the menu entry and the diagram / monitoring wiring from
> that branch. The `hyperdecks` tables still exist (their migration stays in `server/legacy.ts`).

The orchestrator keeps Blackmagic HyperDeck recorders / players in its equipment overview, next to the nodes and the
ATEM switchers, and lets operators start and stop recordings.

## What it does

- **Register** a deck by IP address (menu *HyperDecks*, admin only). The orchestrator connects over the HyperDeck
  Ethernet Protocol (TCP **9993**, the same protocol ATEMs and HyperDeck Setup use) and reads model, protocol
  version, video format, selected input (SDI / HDMI), codec, media slots and whether remote control is on.
- **Live status**: online / offline (15 s grace period, mail alert to the alert recipients), transport state
  (REC / playing / stopped), running timecode, and per SSD / SD slot the volume name and **recording time left**.
  Changes made on the deck itself (front panel, ATEM, another controller) are picked up straight away.
- **Record / play / stop** (operator and up). A recording can get a clip name; it is cleaned to letters, digits,
  spaces and dashes. Recording is refused when no media is mounted.
- **Alerts**: offline / back online, and once per recording when less than 15 minutes of recording time is left.
- **Connection diagram**: *Add device → HyperDeck* places the deck with the connectors of its model
  (Studio HD Plus / HD Pro / 4K Pro: SDI In, HDMI In, SDI Out A/B, SDI Monitor Out, HDMI Out; Studio HD Mini:
  SDI In, SDI Out, HDMI Out). The box shows a REC badge while recording. *Place everything* also places all decks.
- **Dashboard**: a HyperDecks tile (online / total, how many are recording) once a deck is registered.

## On the deck

- Give the deck a fixed IP address (Setup → Network, or Blackmagic HyperDeck Setup over USB).
- Turn on **Remote** (front panel setup menu → Remote, or in HyperDeck Setup). Without it the deck still reports
  its status, but refuses record / play / stop; the orchestrator then shows a warning.
- Port TCP 9993 must be reachable from the orchestrator.

## Technical

- `apps/orchestrator/server/hyperdeck.ts`: one `hyperdeck-connection` link per deck (notifications for transport,
  slot, configuration, remote and display timecode; slot info refreshed every 10 s), table `hyperdecks` +
  `hyperdeck_events`, routes `/api/hyperdecks[/:id[/transport]]`.
- `server/hyperdecklogic.ts`: pure helpers shared with the UI (model → diagram preset, time left, clip names).
- On the diagram a deck is a `device` row with `ref_id = 'hyperdeck:<id>'`; the API shows it as kind `hyperdeck`.
  Removing the deck from the inventory removes its diagram box.
- A host may be written as `ip:port` for a deck behind NAT; the default port is 9993.
- Tests: `test/hyperdeck.test.ts` (API with a fake link, and the real connector against a small fake HyperDeck
  that speaks the protocol). Not yet tested against a physical deck.
