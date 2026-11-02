# Audio under the broadcast

Sound that plays under what goes on air: for example the station's live radio behind the beeldkrant (which has no sound of its own), or a microphone/mixing desk on a physical input of the studio node. Menu: **On air → Audio**.

## Sources

| Type | Address | Notes |
| --- | --- | --- |
| Internet stream | The stream itself, e.g. `https://stream.example.nl/radio.mp3`, an Icecast/Shoutcast URL or an HLS `.m3u8` (also `rtmp://`, `rtsp://`, `srt://`). | Opened by CasparCG's FFmpeg producer on the studio node, so **the studio node** must be able to reach it. Played with `LOOP`: a stream that drops is opened again. **Listen** plays it in the browser (HLS only in Safari). |
| Sound card input | The Windows name of the recording device, e.g. `Line In (Realtek(R) Audio)` (Sound settings → Recording, or `Get-PnpDevice -Class AudioEndpoint`). | DirectShow: `PLAY <ch>-5 "dshow://audio=<name>"`. Only on channels that play on the chosen studio node. |
| DeckLink input | Device number as CasparCG counts it (1 = first). | `PLAY <ch>-5 DECKLINK <n>`: embedded SDI audio or the analogue breakout as set in Blackmagic Desktop Video. The input's picture is never shown. |

Volume 0–150 % (100 % = unchanged) is set per source. Deleting a source makes the blocks and beeldkranten that used it silent.

## Choosing the audio

- **Beeldkrant → Layout → Audio under the beeldkrant**: the default for every beeldkrant item.
- **Blocks → Audio under this block**: plays under all items of the block, including nested blocks (unless they choose their own). *Default* = the beeldkrant's own audio, otherwise only the item's own sound.
- **Per item** (the 🔊 selector on each row): *Like the block*, *No audio under it*, or another source. On an item that holds a nested block it overrides that block's own setting.

The nearest choice wins: item → block → parent block → beeldkrant default. Live items never get audio under them (they bring their own sound); neither do gaps (filler).

## On air

The director plays the source on CasparCG layer **5** of the channel (below the playout layer 10 and the overlay 20) with `MIXER OPACITY 0`, so only its sound is used, and `MIXER VOLUME` for the level. It mixes with the sound of a clip. Consecutive items with the same source keep it playing without a gap; a volume change only sends `MIXER VOLUME`. It stops (layer cleared) when an item without audio, a live item, a gap or a manual live takeover comes, and when automation is switched off. After a CasparCG restart it is started again; a source that fails is retried every 5 s, logged in the as-run log and shown in **Control room** ("Audio under it: …").

No change on the studio node is needed (AMCP only).

Code: `apps/management/server/audio.ts` (sources, routes, AMCP producer), resolution in `server/timeline.ts` (`pickAudio`, `expandBlock`), playout in `server/director.ts` (`syncAudio`), UI `web/pages/AudioSources.tsx`, `web/components/AudioSelect.tsx`. Tests: `test/audio.test.ts`.
