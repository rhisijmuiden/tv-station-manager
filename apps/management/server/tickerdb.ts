/** Ticker headlines straight from the database (the items of the last fetch of each feed). */
import type { Db } from "@tvsm/platform";
import { tickerHeadlines, type TickerHeadline, type TickerSettings } from "./tickerlogic.js";

export function tickerHeadlinesFromDb(db: Db, s: TickerSettings, now = Date.now(), timeZone?: string): string[] {
  if (s.source === "text" || !s.feedIds.length) return [];
  const marks = s.feedIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT i.id, i.title, i.published_at, i.seen_at, i.rank FROM rss_items i JOIN rss_feeds f ON f.id = i.feed_id WHERE f.enabled = 1 AND i.feed_id IN (${marks}) AND i.hold IS NULL AND (i.show_from IS NULL OR i.show_from <= ?)`)
    .all(...s.feedIds, new Date(now).toISOString()) as Record<string, unknown>[];
  const items: TickerHeadline[] = rows.map((r) => ({ id: Number(r.id), title: String(r.title ?? ""), publishedAt: (r.published_at as string) || null, seenAt: String(r.seen_at), rank: r.rank == null ? null : Number(r.rank) }));
  return tickerHeadlines(items, s, now, timeZone);
}
