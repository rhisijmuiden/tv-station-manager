# Recordings of live streams

*Nederlands: [recordings.nl.md](recordings.nl.md)*

Every live stream that comes in from a remote source (RTMP or SRT, see [remote-sources.md](remote-sources.md)) is
recorded automatically. After the broadcast an editor trims the start and end, and the recording goes into the media
library (where it can be planned like any other clip) or is planned straight away as a repeat.

```
Contributor ──RTMP/SRT──► ingest server on the studio node (MediaMTX) ──► CasparCG ──► DeckLink ──► ATEM
                                         │
                                         └──RTMP (read as the management node)──► recorder on the management node
                                                                                     │  ffmpeg -c copy, MPEG-TS pieces
                                                                                     ▼
                                                     one MP4 ──► trim in the browser ──► library (UNAS) / repeat
```

Nothing changes on the studio node: the management node reads the stream from the ingest server the same way the
stream output relays do. The picture is not re-encoded, so the recording has the quality the contributor sent.

## When does it record?

- **Start**: as soon as a stream comes in on the stream key of a remote source (a pulled source: while it plays on its
  DeckLink output). Contributors often start early to test; that part is trimmed off afterwards.
- **Short drop-outs**: when the connection drops and comes back within the *drop-out time* (default 90 s), the
  recording continues and the pieces are joined.
- **Stop**:
  - the stream stops (and does not come back within the drop-out time), or
  - the source is a *live* item in the schedule: the recording stops *keep recording after the programme* (default
    2 minutes) after that item ends, even when the contributor keeps sending. A new recording only starts when the
    stream stops and comes back, or when the next programme with this source starts. Two programmes with the same
    source back to back give two recordings.
  - **Stop recording** on the *Recordings* page (operators and up).
- A recording that is part of a programme in the schedule is named after that programme, otherwise after the source.
- Recordings shorter than the *minimum length* (default 30 s) are thrown away (test streams).
- Below the *minimum free space* (default 5 GB) no new recording starts and an alert mail is sent.

## After the recording

Editorial → **Recordings** lists the recordings (newest first) with a still, length and status:

| Status | Meaning |
| --- | --- |
| Recording | Still running (red REC card at the top, with the time and size so far). |
| Processing | The pieces are being joined into one MP4 (seconds). |
| Ready to check | Done; trim it and put it in the library, or plan a repeat. |
| Going to library | Being copied to the UNAS share. |
| In library | In the media library, schedulable. *Library has an older cut* means it was trimmed again: **Update library**. |
| Failed | Could not be finished; the pieces are kept on the management node and an alert mail was sent. |

### Trim

**Trim** opens the player with a filmstrip of the recording. Drag the yellow handles, or play to the right moment and
press **Set here** under *Start* or *End*. You can also type a time (`12:03.5`). *Watch the first / last 5 seconds*
checks the cut. The cut is made without re-encoding: no quality loss and ready in seconds; the start falls on the nearest
key frame, at most 1–2 seconds earlier. Give the recording a clear name and a content category; the name is used in the
library, schedule and programme guide.

A recording that is already in the library is updated when you save a new cut: the same file on the share and the same
media item, so planned repeats get the new length automatically.

### To the library

**To library** (or *Save and put in library* in the trim window) copies the recording to the media library chosen in
**Settings** (default: the first library) in the folder *Recordings* (change it, e.g. to *Opnames*). The file is named
`<name> <date> <time>.mp4`. It gets category *Program* and the chosen content category, so hour clocks that plan by
category pick it up.

### Plan a repeat

**Plan repeat**: choose the channel and one or more times (quick buttons: tonight 22:00, tomorrow 10:00, tomorrow /
next week at the time of the broadcast). Before you plan, the window shows what the repeat overlaps:
programmes planned by hand are cut short; programmes from the week board make room (manual entries win over the week
board). A recording that is not in the library yet is put in first; the repeats follow as soon as it is there.
Planned repeats are listed in the window and on the recording, and can be removed there.

The repeat is an ordinary entry in the *Schedule* with a TV block that holds the recording, so it also appears in the
programme guide.

## Automatic per remote source

**Automatically after recording, per remote source** (at the bottom of the page, editor-in-chief):

- **Record this source** (on by default).
- **Category** the recording gets.
- **Straight to the library**: as soon as the recording is finished (it can still be trimmed afterwards; the library is
  then updated). Off: it waits on *Ready to check*.
- **Repeat automatically**: fixed times relative to the day of the broadcast (same day, next day, after n days) on the
  same or another channel, e.g. *next day 10:00* and *next day 19:00*. They are planned once the recording is in the
  library.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Media library / folder | first library, `Recordings` | Where finished recordings go. |
| Drop-out time | 90 s | A stream that returns within this time stays one recording. |
| Keep recording after the programme | 120 s | After the live item in the schedule ends. |
| Minimum length | 30 s | Shorter recordings are thrown away. |
| Keep local copy | 7 days | After it went into the library (to trim again); then the copy on the management node is removed. |
| Minimum free space | 5 GB | No new recordings below this. |

## Storage and requirements

- Recordings are stored on the management node in `/var/lib/tvsm/management/recordings` while they are recorded and
  checked. Plan about **2.7 GB per hour** at 6 Mbit/s. They are not part of the backup (the library copy is on the UNAS).
- The management node needs `ffmpeg` (already a dependency of the package) and the studio node's ingest server must
  accept the management node as a reader. This is the case for studio nodes installed with `-ManagementHost` (same as
  for remote sources and stream output; RTMP port 1935 from the management node).
- SRT streams are read back over RTMP from the ingest server. Use H.264 (or H.265) video and AAC audio, as recommended
  for remote sources.
