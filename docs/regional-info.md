# Regional info (traffic, events, council, 112)

Ready-made beeldkrant sources for Velsen, Beverwijk and Heemskerk. Editors find them under **Library > Beeldkranten > Regional**. Each source is one card: switch it on, check its settings and preview, then **Make beeldkrant** creates a beeldkrant (text layout) plus a one-item block that can go into any hour block. Items refresh by themselves. The sources can also feed the news ticker.

| Source | Data | Refresh |
| --- | --- | --- |
| Traffic jams & roadworks | NDW open data (DATEX II v3): `actueel_beeld.xml.gz` (jams, incidents, closures) and the planned works feed (cached 30 min). Situations are kept when they are on the chosen roads inside the IJmond area (VILD location codes) or name one of the municipalities. House and permit numbers are removed. | 5 min |
| Events | An iCal (.ics) or RSS link and/or a manual list. Upcoming events first. | 60 min |
| Council | Per municipality: iBabs (`/Calendar/GetAgendasForCalendar`), Notubiz API (`api.notubiz.nl/events`, organisation looked up by name) or an iCal link. Cancelled meetings get "Gaat niet door". | 60 min |
| 112 (P2000) | Region RSS from alarmeringen.nl (Kennemerland), filtered on place. | 2 min |

## 112 privacy rules

- On screen only the type and the place ("Woningbrand in IJmuiden. De brandweer is uitgerukt."). Never addresses, names, capcodes or medical details. The street is optional (off by default, never for ambulance).
- Defaults: fire and water rescue on; ambulance, police and helicopter off; automatic fire alarms skipped; 20-minute delay; editor approval on; items removed after 6 hours.
- Waiting items show under **Check alerts** with **Approve** / **Reject**. The original alert text is stored in `rss_items.note` and only shown to editors.

## Technical notes

- Stored as `rss_feeds` rows with `source` (`traffic`/`events`/`council`/`p2000`) and `config` (JSON, schemas in `server/regionallogic.ts`). Regular feed editing returns 409 `regional_feed`.
- `rss_items.rank` keeps the source's order on the beeldkrant, `hold` and `show_from` keep items off air, `note` is editor-only.
- A partly failing source (one council, the planned works feed) keeps working and shows a warning on the card.
- Known: alarmeringen.nl answered 403 to the server during development. The feed URL is a setting, so another P2000 feed can be used. Notubiz could not be reached from the development sandbox.
- Tests: `apps/management/test/regional.test.ts`.
