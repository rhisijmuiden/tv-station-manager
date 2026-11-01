# Week schedule and hour clocks

The management node plans the linear channel per week.

- **Categories** (Planning → Categories): subjects such as Sport, Culture, News. Give media a category in the media library (per file, or a whole folder at once). Blocks can have a category too; it is used as the genre in the EPG.
- **Hour clocks** (Planning → Hour clocks): the layout of every hour. Fixed blocks (ident, news, ad break) start at the same minute every hour; programme windows in between are filled with the slot's content. "Reserve" keeps a fixed amount of time for a block (e.g. 5:00 for ads); what is left over plays the channel filler.
- **Week schedule** (Planning → Week schedule): recurring slots per channel and weekday, e.g. "Mon–Fri 18:00–20:00 Sport". A slot has a category (editors put the rundown together per date, or it is picked automatically from the category) or a fixed block (the same TV block every week). Each slot follows the channel's default hour clock, another clock, or no clock.
- **Editorial** (Planning → Editorial): per week, every slot on every date with its state (fixed block, editor, automatic, empty), how full it is and what does not fit. Open one to put the rundown together; the timeline shows live where every item will start. Items are never split: an item that does not fit what is left of a window moves to the next window.

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
