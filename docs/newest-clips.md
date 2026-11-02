# Newest clips (dynamic news block)

A block can hold a **Newest clips** item instead of fixed clips. Every time the block plays, the item takes the newest
clips of a **category** (e.g. News) or a **folder** of the media library (subfolders count too). When a new clip comes
in, the oldest one drops out by itself.

Blocks page → *Newest clips*: choose the category or folder, how many clips, and optionally *not older than (days)*,
*at most (minutes)* and the play order (newest first, or in the order they came in). The dialog shows what would play
right now. Fixed items (intro, outro) can sit before and after it.

How it works
- Stored as `block_items.type = 'auto'` with the rule in `block_items.auto_rule` (JSON, `autoRuleSchema` in
  `apps/management/server/autofill.ts`).
- `pickClips` (pure, tested) picks the clips: "new" = file modification time, else the time the clip entered the library.
  Clips without a known length (still being probed) are skipped.
- The timeline (`expandBlock(..., asOf)`) passes the start time of the schedule entry: a block that is on air only plays
  clips that existed when it started, so it never changes halfway. Later broadcasts pick up new clips automatically
  (a library scan triggers a recompile and a new week publish).
- `POST /api/blocks/auto-preview` returns what a rule would play now.

## Dynamic parts: build an hour from folders

The same item can pick in three ways (`pick` in the rule):
- **newest**: the newest N clips (above).
- **rotate** (in turn): the clip picked longest ago first, so every ad or bumper gets its turn.
- **random**: a seeded random clip, avoiding the most recently picked ones.

Example hour block: *ad in turn from Reclames*, *bumper in turn from Bumpers*, *newest item from Programma*,
*random bumper from Bumpers*. Within one broadcast (a week-schedule occurrence, key `occ:<occurrence>`, or a single
schedule entry, `entry:<id>`) a clip is never picked twice unless the folder has nothing else.

Rotate/random picks are remembered in `auto_picks` (key, item path in the block tree, rule, media ids) once the broadcast
starts within `PICK_MEMO_AHEAD_MS` (3 h), and `media.last_pick_at` is updated; until then they are a forecast. So the
director, the EPG and the week planner see the same clips, and a block on air never changes. Changing the rule picks
again. The blocks page and the wizard "New hour programme" preview all parts together (`POST /api/blocks/auto-previews`).
