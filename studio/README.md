# Studio node (Windows)

The studio node runs **CasparCG Server** with a Blackmagic DeckLink card (4 SDI outputs, up to 2 TV channels).
The management node controls it over AMCP (TCP 5250): it plays clips from the UNAS share, starts RTMP streams and
drives the graphics overlay. Full installer follows in step 4; until then, set it up by hand:

1. Install CasparCG Server 2.4+ and the DeckLink Desktop Video driver.
2. In `casparcg.config`:
   - `<media>`: the UNAS share root, the same folder the management node scans (e.g. `\\unas\TV\`). Clip names in
     the management node are paths relative to that folder.
   - `<template-path>`: a folder that contains `casparcg-templates/tvsm` from this repository (the overlay template).
   - One `<channel>` per output, each with a `<decklink><device>N</device></decklink>` consumer. Typical layout:
     channel 1 = TV 1 playout (DeckLink 1), channel 2 = TV 1 live/RTMP (DeckLink 2), channel 3 = TV 2 playout, channel 4 = TV 2 live.
3. Allow TCP 5250 from the management node in the Windows firewall.
4. Install the TV Station Manager agent (`packaging/windows/install-agent.ps1`) so the orchestrator monitors it.

In the management node: **Devices → Studio nodes** (host + port 5250), then **Channels** (CasparCG channel, ATEM input
each DeckLink output is cabled to). The overlay can be previewed in a browser with `overlay.html?demo`.
