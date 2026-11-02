# Two studio nodes: playout + live

A channel can use two Windows CasparCG machines:

- **Playout node**: runs the schedule (clips, ad breaks, graphics). Set it as the channel's studio node under *Channels*, with the ATEM input its DeckLink output is cabled to (*Playout input*).
- **Live node**: takes RTMP/SRT streams from events (MediaMTX ingest). Create the remote source under *Remote sources* on this node, with the ATEM input its DeckLink output is cabled to.

Give each node its role under *Devices → Studio nodes* (Playout node / Live node / Playout + live). In the orchestrator the same roles can be assigned when approving a node.

## What the director does

Put the remote source in a TV block as a *live* item and schedule it. Then:

1. **30 s before** the live item the stream is started on the live node's DeckLink output. The ATEM stays on the playout node, and the channel's graphics overlay (logo, clock, …) is put on the live node too.
2. **At the start** the ATEM cuts to the live node. The playout node loops the channel's *filler* clip as standby.
3. **No stream (yet)?** The ATEM stays on (or goes back to) the playout node: filler clip, or the *fallback input* when there is no filler. As soon as the stream has played for 1.5 s on CasparCG the ATEM cuts to the live node. A dropped stream is mailed as an alert and logged in the as-run log.
4. **After the live item** the playout node continues with the schedule, the stream and overlay are taken off the live node.

The control room shows which node is on air and when a live item is waiting for its stream.

Set a filler clip on the channel: it is what viewers see while a live stream is missing.
