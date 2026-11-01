/** Beeldkrant data straight from the database (no network): used by the timeline loader and the RSS module. */
import type { Db } from "@tvsm/platform";
import { beeldkrantDuration, beeldkrantSchema, buildPages, type BeeldkrantSettings, type StoredItem } from "./rsslogic.js";
import type { BeeldkrantRef } from "./timeline.js";

export function beeldkrantSettings(db: Db, id: number): { name: string; settings: BeeldkrantSettings; feedIds: number[] } | undefined {
  const b = db.prepare("SELECT name, settings FROM beeldkranten WHERE id = ?").get(id) as { name: string; settings: string } | undefined;
  if (!b) return undefined;
  const feedIds = (db.prepare("SELECT feed_id FROM beeldkrant_feeds WHERE beeldkrant_id = ? ORDER BY position, feed_id").all(id) as { feed_id: number }[]).map((r) => r.feed_id);
  return { name: b.name, settings: beeldkrantSchema.parse(JSON.parse(b.settings || "{}")), feedIds };
}

/** Pages of a beeldkrant; pictures point at `<imageBase>/beeldkrant/img/<item id>` (the management node caches them). */
export function beeldkrantPages(db: Db, settings: BeeldkrantSettings, feedIds: number[], imageBase = "", now = Date.now()) {
  if (!feedIds.length) return [];
  const marks = feedIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, feed_id, title, summary, body, image_url, categories, published_at, seen_at FROM rss_items WHERE feed_id IN (${marks})`).all(...feedIds) as Record<string, unknown>[];
  const items: StoredItem[] = rows.map((r) => ({
    id: Number(r.id),
    feedId: Number(r.feed_id),
    title: String(r.title),
    summary: String(r.summary ?? ""),
    body: String(r.body ?? ""),
    imageUrl: (r.image_url as string) || null,
    categories: JSON.parse(String(r.categories || "[]")),
    publishedAt: (r.published_at as string) || null,
    seenAt: String(r.seen_at),
  }));
  const names = new Map((db.prepare(`SELECT id, name FROM rss_feeds WHERE id IN (${marks})`).all(...feedIds) as { id: number; name: string }[]).map((f) => [f.id, f.name]));
  return buildPages(items, settings, names, now, (i) => `${imageBase}/beeldkrant/img/${i.id}`);
}

export function beeldkrantRef(db: Db, id: number): BeeldkrantRef | undefined {
  const b = beeldkrantSettings(db, id);
  if (!b) return undefined;
  return { id, name: b.name, durationMs: beeldkrantDuration(b.settings, beeldkrantPages(db, b.settings, b.feedIds).length), showOverlay: b.settings.showOverlay };
}
