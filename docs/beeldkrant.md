# Beeldkrant (RSS news pages)

Full-screen news pages ("beeldkrant") built from RSS feeds and played on the studio node by CasparCG. Menu: **Planning → Beeldkrant**.

## Feeds (tab "Feeds")

- **WordPress site**: enter the site address (e.g. `www.ijmond360.nl`). Posts come in through the WordPress REST API (`/wp-json/wp/v2/posts?_embed`) with their featured image, clean excerpt and categories. **Load categories** lists the site's categories; pick some to only take those posts (empty = all posts). If the REST API is closed, the RSS feed (`/feed/` or `/category/<slug>/feed/`) is used instead.
- **RSS / Atom feed**: any other feed (e.g. NOS). Pictures come from `enclosure`, `media:content` / `media:thumbnail` or the first `<img>` in the text.
- Every feed is fetched every *n* minutes (default 10). The items of the last fetch are kept (default 20); removed posts disappear. **Test** shows what would come in without saving.
- Pictures are fetched once by the management node and served to the studio node from `/beeldkrant/img/<item>` (cached in `<dataDir>/rss-cache`, 14 days), so the studio node needs no internet access.

## Beeldkranten (tab "Beeldkranten")

A beeldkrant combines one or more feeds. Settings:

| Setting | Meaning |
| --- | --- |
| Time per page | Seconds each news item stays on screen (3–120). |
| Maximum number of pages / maximum age | The newest items of all feeds together; older items are left out. The same article in two feeds is shown once. |
| Maximum text length / title length | Texts are cut at the last full sentence (or word, with "…"). 0 = title only. Text comes from the summary (excerpt) or the start of the article. Text that still does not fit is made smaller and cut at whole lines. |
| Layout | Photo left, photo right, photo on top, full-screen photo, text only. Items without a picture use "text only". |
| Show | Picture, category, date/time ("Vandaag 09:00"), feed name, clock and date, page number, progress bar. |
| Header, footer, logo, colours, language | Logo = the logo uploaded for a channel on the Graphics page. Colours default to the house style. |
| Length in the schedule | One pass of all pages (pages × time per page) or a fixed length. A duration set on the block item wins. Pages keep looping until the item ends. |
| Channel overlay on top | Off by default: the beeldkrant has its own clock and header, the channel logo/clock/ticker step aside. |

The editor shows a live preview (the real on-air page, scaled) with page controls.

## Planning

A beeldkrant is an item in a TV block (`block_items.type = 'beeldkrant'`). **Make block** creates a block with just the beeldkrant; drag that block into an hour clock, the week schedule or a rundown, or add **+ Beeldkrant** to any block. The duration field of the item can be left empty (= length of the beeldkrant).

## On air

The director plays `PLAY <ch>-10 [HTML] "<publicUrl>/beeldkrant/page.html?id=<id>&start=<epoch ms>"` on the playout layer and keeps the ATEM on the playout input. The page (1920×1080) loads `/beeldkrant/<id>/data.json` every minute and shows page `floor((now - start) / secondsPerPage) mod pages`, corrected with the management node's clock, so a restart picks up the same page. Set **Settings → public URL** of the management node so the studio node can reach it.

Code: `server/rsslogic.ts` (pure: parsing, WordPress, text cutting, pages), `server/rss.ts` (feeds, fetching, routes), `server/beeldkrantdb.ts`, `server/beeldkrant-page.ts` (the HTML page), `web/pages/Beeldkrant.tsx`. Tests: `test/beeldkrant.test.ts`.
