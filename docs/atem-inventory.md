# ATEM inventory (orchestrator)

The orchestrator keeps an overview of every Blackmagic ATEM switcher in the facility, next to the nodes.
Normally the management node (the director) switches the ATEMs by schedule. An operator can also switch by hand from
the orchestrator and **lock** an ATEM so the automation leaves it alone: see
[connection-diagram.md](connection-diagram.md).

## What it does

- **Register** a switcher by IP address or host name (menu *ATEM switchers*, admin only). The orchestrator connects
  over the ATEM protocol (UDP 9910, same as ATEM Software Control) and reads model, protocol version, video mode,
  M/E rows, keyers, DSKs, aux outputs, media players, SuperSources, multiviews and all inputs with their names.
- **Live status**: online/offline (with a 15 s grace period and a mail alert via the configured alert recipients),
  current program and preview per M/E. When a switcher is offline the last known state is shown.
- **Front panel**: a drawing of the switcher's front for its model family, with the device's own labels and tally:
  - ATEM Mini / Mini Pro / SDI: 4 input buttons, audio keys, transitions, keyers, streaming keys on Pro/ISO models.
  - ATEM Mini Extreme (ISO, G2, SDI Extreme ISO): 8 input buttons, audio, transitions, keyers, output selection.
  - Television Studio HD8 / HD8 ISO / 4K8 / Pro HD / Pro 4K: program and preview rows (inputs, black, MP1, MP2),
    keyers, transitions, T-bar, LCD.
  - Rack models (Production Studio, 1/2 M/E, Constellation): LCD, source buttons (two rows on large units), menu keys.
  - Unknown models: a generic program/preview panel built from what the switcher reports.
  The drawing is a recognisable simplification, not a photo-exact copy.
- **Rename inputs** (editor and up): click a source button or *Rename* in the input table. The long name (max 20)
  and short name (max 4, printable ASCII) are written **to the ATEM itself**, so they show up in the multiview,
  ATEM Software Control, hardware panels and the management node. Only possible while the switcher is online.
- **Fed by**: per input you can link the node (e.g. the playout or live CasparCG node) and a free note such as
  "DeckLink SDI 1". This is stored only in the orchestrator, for the equipment overview.

## Notes

- An ATEM accepts a limited number of simultaneous control connections (typically 5 to 8, depending on model).
  The orchestrator uses one per switcher, next to the management node and any ATEM Software Control instances.
- Changing the address of a switcher reconnects; removing it only removes it from the orchestrator.
- API: `GET/POST /api/atem`, `GET/PUT/DELETE /api/atem/:id`, `PUT /api/atem/:id/inputs/:input`
  (`{ longName?, shortName?, nodeId?, note? }`), `POST /api/atem/:id/switch`, `PUT /api/atem/:id/control`.
