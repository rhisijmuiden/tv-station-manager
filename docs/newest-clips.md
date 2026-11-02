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
