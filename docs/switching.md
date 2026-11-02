# Switch buttons

*Nederlands: [switching.nl.md](switching.nl.md)*

Some live pictures come in without a planning: a press conference, breaking news, a stream from an event. Editors put
them on air with a few big, named buttons under **Editorial → Switch** (`/switch`), without touching the schedule or
the ATEM.

## For editors

- Press a button (e.g. "IJmond360 Nieuws live"). For a camera you confirm once; the ATEM switches straight away.
- For a stream (RTMP/SRT remote source) two questions follow:
  1. **Record this live broadcast?** Yes / No. The default answer is the source's own setting (Recordings → Sources).
  2. **Put the recording in the repeat straight after the live broadcast?** Yes / No. With yes the repeat times set
     for the source are used; a source without repeat times asks for a day and a time.
- While live the schedule waits. **Back to the schedule** ends the live broadcast: the recording stops, goes into the
  media library and the repeats are planned (as for any recording, see [recordings.md](recordings.md)).
- Pressing another button switches straight over; the previous stream's live session (and its recording) ends.
- The page shows which button is on air, since when, and whether it is being recorded.

## For administrators

**Setup → Switch buttons** (`/switch-buttons`, admins only): per channel a list of buttons with a name, a colour and the
live source it switches to; order with the arrows. The live source holds the switching scheme: the ATEM input, and for
a stream the studio node and DeckLink output (Devices, Remote sources). A button always switches the ATEM of its
channel (M/E and transition from the channel).

## How it works

- Pressing a button is the director's manual override (`Director.takeLive`), the same as "Take live" in the Control
  room: `POST /api/switch/buttons/:id/press` with `{ record, repeat, repeatAt? }`; back with
  `POST /api/switch/:channelId/back` (`Director.resume`).
- The recorder gets the editor's choice (`Recorder.goLive`): it overrides the source's "record" setting while live. A
  recording that already ran (the contributor started early) is kept and gets the choices, or is thrown away with "no".
  The choices are stored on the recording (`recordings.plan`) so they survive a restart while it is processed.
- When the override ends (`Director.overrideEnded`) the recording stops with reason `live_end`. If the contributor
  keeps sending it is not recorded again until the stream stops.
- While the ATEM is locked in the orchestrator the buttons answer 409 `atem_locked` and are greyed out; "Back to the
  schedule" still works (the automation then holds its switches until the lock is released).
- The override lives in memory: after a restart of the management node the schedule is followed again.
