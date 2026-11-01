# Week schedule and hour clocks

The management node plans the linear channel per week.

- **Categories** (Editorial → Categories): subjects such as Sport, Culture, News. Give media a category in the media library (per file, or a whole folder at once). Blocks can have a category too; it is used as the genre in the EPG.
- **Hour clocks** (Editorial → Hour clocks): the layout of every hour. Fixed blocks (ident, news, ad break) start at the same minute every hour; programme windows in between are filled with the slot's content. "Reserve" keeps a fixed amount of time for a block (e.g. 5:00 for ads); what is left over plays the channel filler.
- **Week board** (Editorial → Week board): recurring slots per channel and weekday, e.g. "Mon–Fri 18:00–20:00 Sport". A slot has a category (editors put the rundown together per date, or it is picked automatically from the category) or a fixed block (the same TV block every week). Each slot follows the channel's default hour clock, another clock, or no clock.
- **Day planning** (Editorial → Day planning): per week, every slot on every date with its state (fixed block, editor, automatic, empty), how full it is and what does not fit. Open one to put the rundown together; the timeline shows live where every item will start. Items are never split: an item that does not fit what is left of a window moves to the next window.

## Menu

The left menu follows the editor's work: **Editorial** (New hour block, Week board, Day planning, Hour blocks, Hour clocks, Media library, Categories, Ad breaks, Beeldkrant), **On air** (Control room, Schedule, Programme guide, Remote sources, Stream output) and **Setup** (Graphics, Channels, Devices; editors and admins). The dashboard shows the three editorial steps.

## New hour block (step by step)

Editorial → New hour block (`web/pages/NewHour.tsx`) walks an editor through four steps, without technical terms:

1. **Name and length**: name, subject (category), half an hour to two hours, and the fixed parts (the channel's hour clock, another clock, or none). The ring shows the room left for clips.
2. **Fill the hour**: drag clips (or blocks) from the library into the list or straight into a programme window of the hour. The hour preview shows when every clip starts; what does not fit is marked.
3. **Days and time**: weekday buttons (Mon–Fri, Weekend, Every day), start time per quarter hour, and a small week board with what already runs around it. Clashes are shown before saving. Planning can be skipped.
4. **Check and save**: makes a TV block and one week slot per chosen day (`POST /api/blocks`, `POST /api/week/slots`), and can switch the week schedule on for the channel.

## Series: one block on several days

Slots with the same start, length, content, clock and title on different weekdays form a series (`seriesKey` in `hourclock.ts`). Clicking a slot on the week board opens the whole series: switch days on or off, change the time or content for all days at once (`PUT /api/week/slots/:id/series`), or tick "only change this day" (the old per-slot `PUT /api/week/slots/:id`). Days that stay keep their rundowns; removed days lose theirs. `DELETE /api/week/slots/:id/series` removes every day.

## Clicking an hour clock together

The hour clock editor has a palette: one click adds an ident, news item, jingle (blocks of at most 10 minutes) or ad break as a fixed part. A new clock starts as one hour of programme.

## Publishing

With "Week schedule active" on, the node turns the next 14 days (setting `week.days`) into normal schedule entries (origin `week`), every 15 minutes and after every change. The director, the schedule page and the EPG play them like any other entry:

- every fixed part of the clock is its own entry with a hard start, so every hour starts on the second;
- the programme windows play part of the slot's rundown (`skip_items`/`take_items` on the schedule entry);
- the EPG shows one programme per slot, from its start to its end;
- manual entries in the schedule win: generated entries that start while a manual entry plays are left out (e.g. a live match);
- entries that already started are never changed.

Automatic picks take media of the slot's category, least recently picked first, first fit per window. "New suggestion" picks again; "Back to automatic" throws away an editor's rundown.

Station time is `Europe/Amsterdam` (setting `station.timezone`, `PUT /api/week/settings`); slots follow summer and winter time.

Pure logic (clock layout, windows, distribution, auto pick, time zones) is in `apps/management/server/hourclock.ts`; publishing and the API in `apps/management/server/weekplan.ts`.

## Drag and drop

The hour clocks, week schedule, editorial rundowns and TV blocks / ad breaks have the media library docked on the right (hide it with the button in its header). Drag clips, or several selected clips at once, or a block from the *Blocks* tab:

- **Rundown of a date**: drop between rows to insert, or on a programme window in the timeline to add it after what already plays there. Drag rows to reorder. On a fixed-block date the drop makes an own rundown for that date (the block plus the clips).
- **Week schedule**: drop on a slot and choose the date (next four); the clips go at the end of that date's rundown (`POST /api/week/occurrences/:slot/:date/append`). Drop on an empty spot to plan a new slot there with it (snapped to 15 minutes).
- **Hour clock**: drop on the clock or between the rows to add a fixed part. A clip becomes a block first (`POST /api/blocks/from-media`); the same clip again reuses that block.
- **Blocks**: drop between the rows; drag rows to reorder.

The `+` on a library row (or *Add* with a selection) does the same without dragging, for touch screens.
