# Coming up slide (programmes of the coming hour)

A **Coming up slide** is an item you place in an hour block (or a day rundown). On air it fills the screen and shows at
what time the programmes of the coming hour start, for example:

![Coming up slide](screenshots/lineup-slide.jpg)

- **Blocks page** → list *More* → *Coming up slide*. **Day rundown** → button *Coming up slide*. Default length 0:15,
  change it in the item's length field.
- The list is made from the schedule at the moment the slide goes on air: everything that starts after the slide,
  up to 60 minutes ahead (setting). Only **programme files** (category Programme, not inside an ad break) and **live
  items** are listed; commercials, jingles, bumpers, filler, beeldkrant and webcams are left out. Parts of one programme
  right after each other are one row.
- The name is the clip's title in the library, by default the **file name** (underscores become spaces).
- **Graphics page** → *Coming up slide* (per channel): heading (empty = "Straks op <channel>"), language on screen
  (Dutch / English), how far ahead, max. number of programmes, with a live preview of the real schedule.
- The channel overlay (logo, clock, ticker) steps aside while the slide is on air; audio under the block keeps playing.

How it works
- `block_items.type = 'lineup'` (no extra columns, `duration_ms` = length). Timeline leaf type `lineup`
  (`DEFAULT_LINEUP_MS` = 15 s in `server/timeline.ts`).
- `server/lineuplogic.ts` is pure: `lineupSchema` (stored in the channel's graphics JSON as `lineup`), `lineupRows`
  (which events become rows) and `lineupHtml` (the 1920x1080 page, times in the station time zone).
- `server/lineup.ts` serves `GET /lineup/page.html?channel=<id>&at=<epoch ms>` (public, for CasparCG); `at` is the
  slide's start, so a restart shows the same list. `preview=1` scales the page for the editor's iframe and `settings`
  (JSON) previews unsaved settings.
- The director plays it with the HTML producer on the playout layer (`lineupUrl` in `server/director.ts`). The page has
  no scripts or timers (only a one-off fade-in), so CasparCG's HTML producer has next to nothing to copy.
