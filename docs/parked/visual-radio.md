# Visual Radio

> **Parked (2026-11-01).** Visual Radio is moved to a later phase so the team can focus on the core editorial
> workflow. The code is no longer in `test`/`production`. The complete working concept (server module, UI page,
> tests, translations) is kept on the branch
> [`parked/visual-radio`](https://github.com/rhisijmuiden/tv-station-manager/tree/parked/visual-radio)
> (originally PR #22). To bring it back: restore `apps/management/server/visualradio.ts`, `vrlogic.ts`,
> `web/pages/VisualRadio.tsx`, `test/visualradio.test.ts`, the `mgmt.vr` translations and the menu entry from that
> branch, and add the `vr_*` tables as a NEW migration at the end of the list (the old slot now drops them).

The TV channel follows the radio: for every song the radio plays, the Visual Radio node plays the matching videoclip
(without sound, the radio mix is the channel's audio), and when a microphone opens the ATEM switches to that
microphone's camera. Menu: **Visual Radio** in the management node.

## How it fits

- **Management node** (`apps/management/server/visualradio.ts`, pure rules in `vrlogic.ts`) receives the metadata and the
  microphone signals, finds the clip, tells CasparCG to play it and switches the ATEM. It is the only one that drives the ATEM.
- **Visual Radio node**: a Windows studio node with CasparCG. Its DeckLink output goes into an ATEM input (the *clip input*).
- **ATEM**: the channel's ATEM and M/E. Cameras (one per microphone, optionally a wide shot) and a station loop on other inputs.
  The radio mix goes into an ATEM audio input, always on.
- While a station is **on**, the director leaves its channel alone (`Director.yieldTo`).

## Connecting the radio playout

Each station has two secret URLs (shown under Settings) and an optional RDS port.

| Input | How |
| --- | --- |
| RDS port (Zenlex) | Zenlex sends song info to an RDS encoder. Add an RDS output to the management node's IP and the station's RDS port (TCP or UDP). Lines like `RT=Artist - Title` are read; repeats of the same song are ignored. |
| Now playing URL | `POST` JSON (`artist`, `title`, `type`, `duration`, `startedAt`, `songId`), XML with the same tags, plain `Artist - Title`, or `GET ?artist=…&title=…`. |
| Microphone URL | `…/mic/<key>/1` opens, `…/mic/<key>/0` closes (GET or POST), or `POST {"mic":"dj","open":true}`. For a GPIO box or the radio desk (fader start). |

`type` decides what goes on air: only `music` looks for a clip; jingles, ads and news show the station loop.

## Matching clips

1. Song id from the playout (column *Song id* on the clip, or from the CSV import).
2. A clip linked by hand from *Played without a clip*.
3. Exact key: main artist + title, lowercase, without accents, `feat.`, `(Radio Edit)`, `(Official Video)`, `Remastered`, etc.
4. Fuzzy: character-bigram similarity of artist (40 %) and title (60 %), at least the station's threshold (0.82).

Clips come from a media source/folder in the media library: **Scan clip folder** reads `Artist - Title.ext` names,
**Import CSV** takes `artist;title;path;songId;offsetMs` from an existing clip database. The offset skips a video intro.

## What goes on air

Manual pin > two or more open microphones (wide shot) > one open microphone (its camera) > music with a running clip
(clip input) > music without a clip (station loop or wide shot) > anything else (station loop). A microphone counts after
the open delay (250 ms) and keeps its camera for the close delay (1.5 s); a shot stays at least the minimum shot length (3 s).
The clip keeps running under a camera shot, so it is still in sync when the microphone closes. A late message seeks into the clip.

## Not in this version

Preloading the next song, ATEM audio levels as microphone trigger, a now-playing lower third in the overlay,
switching Visual Radio on per week-schedule slot, and an orchestrator role "Visual Radio".
