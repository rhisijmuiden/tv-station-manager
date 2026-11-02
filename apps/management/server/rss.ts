/**
 * RSS feeds and beeldkranten (full-screen news pages).
 * - Feeds: a WordPress site (REST API with featured images, RSS as fallback; optionally only some categories) or any
 *   RSS/Atom feed. Fetched every `refresh_min` minutes; the items of the last fetch are kept.
 * - Beeldkranten: pages built from the newest items of one or more feeds, with time per page, layout and maximum
 *   text length. A beeldkrant is an item in a block, so it is planned like any other programme (schedule, hour
 *   clocks, week schedule). On air the director plays `/beeldkrant/page.html?id=…&start=…` with the CasparCG HTML
 *   producer on the playout layer; the page fetches its pages from `/beeldkrant/<id>/data.json`.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BEELDKRANT_PAGE } from "./beeldkrant-page.js";
import { publicUrl } from "./director.js";
import { beeldkrantPages, beeldkrantSettings } from "./beeldkrantdb.js";
import { beeldkrantDuration, beeldkrantSchema, mergeItems, parseFeed, wpPostsToItems, wpSite, wpUrls, type BeeldkrantSettings, type FeedItem, type WpCategory } from "./rsslogic.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_CACHE_DAYS = 14;
const UA = "TV Station Manager (beeldkrant)";

export interface FeedRow {
  id: number;
  name: string;
  kind: "wordpress" | "rss";
  url: string;
  categories: string;
  enabled: number;
  refresh_min: number;
  max_items: number;
  last_fetch_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  via: string | null;
}
const feedOut = (r: FeedRow, itemCount: number) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  url: r.url,
  categories: JSON.parse(r.categories || "[]") as WpCategory[],
  enabled: !!r.enabled,
  refreshMinutes: r.refresh_min,
  maxItems: r.max_items,
  lastFetchAt: r.last_fetch_at,
  lastOkAt: r.last_ok_at,
  lastError: r.last_error,
  via: r.via,
  itemCount,
});

async function fetchLimited(url: string, accept: string, max: number) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are supported");
  const res = await fetch(u, { headers: { "User-Agent": UA, Accept: accept }, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${u.host}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) throw new Error("response too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error("response too large");
  return { buf, type: res.headers.get("content-type") ?? "" };
}
const fetchText = async (url: string, accept: string) => (await fetchLimited(url, accept, MAX_FEED_BYTES)).buf.toString("utf8");

/** Fetches a feed. WordPress: REST API first (featured images, clean excerpts), RSS when the API is closed. */
export async function loadFeed(kind: "wordpress" | "rss", url: string, categories: WpCategory[], max: number): Promise<{ items: FeedItem[]; via: "wp-json" | "rss"; title: string }> {
  if (kind === "wordpress") {
    const urls = wpUrls(url, categories, max);
    try {
      const json = JSON.parse(await fetchText(urls.rest, "application/json"));
      return { items: wpPostsToItems(json).slice(0, max), via: "wp-json", title: "" };
    } catch (restError) {
      try {
        const feeds = await Promise.all(urls.rss.map(async (u) => parseFeed(await fetchText(u, "application/rss+xml, application/xml, text/xml"))));
        return { items: mergeItems(feeds.map((f) => f.items), max), via: "rss", title: feeds[0]?.title ?? "" };
      } catch {
        throw restError;
      }
    }
  }
  const feed = parseFeed(await fetchText(url, "application/rss+xml, application/atom+xml, application/xml, text/xml"));
  return { items: feed.items.slice(0, max), via: "rss", title: feed.title };
}

export class RssFeeds {
  private timer: NodeJS.Timeout | null = null;
  private busy = new Set<number>();
  readonly cacheDir: string;

  constructor(
    private platform: Platform,
    private onChange: () => void,
  ) {
    this.cacheDir = join(platform.ctx.config.dataDir, "rss-cache");
    mkdirSync(this.cacheDir, { recursive: true });
  }

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => void this.due(), intervalMs);
    this.timer.unref();
    setTimeout(() => void this.due(), 2000).unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private feeds() {
    return this.platform.ctx.db.prepare("SELECT * FROM rss_feeds ORDER BY name COLLATE NOCASE").all() as unknown as FeedRow[];
  }

  /** Fetches the feeds whose refresh time has come. */
  async due() {
    const now = Date.now();
    for (const f of this.feeds()) {
      if (!f.enabled) continue;
      const last = f.last_fetch_at ? Date.parse(f.last_fetch_at) : 0;
      if (now - last >= f.refresh_min * 60_000) await this.refresh(f.id).catch(() => undefined);
    }
    this.cleanCache();
  }

  /** Fetches one feed now and stores its items. Returns the number of items. */
  async refresh(id: number) {
    const { db } = this.platform.ctx;
    const f = db.prepare("SELECT * FROM rss_feeds WHERE id = ?").get(id) as FeedRow | undefined;
    if (!f) throw new HttpError(404, "not_found");
    if (this.busy.has(id)) return this.count(id);
    this.busy.add(id);
    const at = new Date().toISOString();
    try {
      const r = await loadFeed(f.kind, f.url, JSON.parse(f.categories || "[]"), f.max_items);
      const before = this.signature(id);
      this.store(id, r.items);
      db.prepare("UPDATE rss_feeds SET last_fetch_at = ?, last_ok_at = ?, last_error = NULL, via = ? WHERE id = ?").run(at, at, r.via, id);
      // A beeldkrant without a fixed length lasts one pass of its pages: the schedule may shift.
      if (this.signature(id) !== before) this.onChange();
      return this.count(id);
    } catch (e) {
      const message = (e as Error).message || String(e);
      db.prepare("UPDATE rss_feeds SET last_fetch_at = ?, last_error = ? WHERE id = ?").run(at, message.slice(0, 500), id);
      if (f.last_error !== message.slice(0, 500)) this.platform.ctx.log.warn({ feed: f.name, err: message }, "rss feed failed");
      throw new HttpError(502, "feed_failed", message);
    } finally {
      this.busy.delete(id);
    }
  }

  private count(id: number) {
    return (this.platform.ctx.db.prepare("SELECT COUNT(*) AS n FROM rss_items WHERE feed_id = ?").get(id) as { n: number }).n;
  }
  private signature(id: number) {
    return (this.platform.ctx.db.prepare("SELECT group_concat(guid, '|') AS s FROM (SELECT guid FROM rss_items WHERE feed_id = ? ORDER BY guid)").get(id) as { s: string | null }).s ?? "";
  }

  /** Keeps exactly the items of the last fetch; existing items keep their id (and cached picture). */
  store(feedId: number, items: FeedItem[]) {
    const { db } = this.platform.ctx;
    const valid = items.filter((i) => i.guid && i.title);
    db.exec("BEGIN");
    try {
      const up = db.prepare(
        `INSERT INTO rss_items (feed_id, guid, title, summary, body, link, image_url, author, categories, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (feed_id, guid) DO UPDATE SET title = excluded.title, summary = excluded.summary, body = excluded.body, link = excluded.link,
           image_url = excluded.image_url, author = excluded.author, categories = excluded.categories, published_at = excluded.published_at`,
      );
      for (const i of valid) up.run(feedId, i.guid.slice(0, 1000), i.title.slice(0, 1000), i.summary.slice(0, 5000), i.body.slice(0, 20000), i.link, i.imageUrl, i.author, JSON.stringify(i.categories.slice(0, 20)), i.publishedAt);
      const keep = new Set(valid.map((i) => i.guid.slice(0, 1000)));
      for (const r of db.prepare("SELECT id, guid FROM rss_items WHERE feed_id = ?").all(feedId) as { id: number; guid: string }[]) if (!keep.has(r.guid)) db.prepare("DELETE FROM rss_items WHERE id = ?").run(r.id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- pictures ----------------------------------------------------------------------

  private cachePath(url: string) {
    return join(this.cacheDir, createHash("sha1").update(url).digest("hex"));
  }
  /** A feed picture, fetched once and kept on disk (the studio node may have no internet, and feeds can be slow). */
  async image(url: string) {
    const file = this.cachePath(url);
    if (existsSync(file) && existsSync(`${file}.type`)) return { buf: readFileSync(file), type: readFileSync(`${file}.type`, "utf8") };
    const r = await fetchLimited(url, "image/*", MAX_IMAGE_BYTES);
    const type = r.type.split(";")[0]!.trim();
    if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) throw new HttpError(415, "not_an_image");
    writeFileSync(file, r.buf);
    writeFileSync(`${file}.type`, type);
    return { buf: r.buf, type };
  }
  private cleanCache() {
    const old = Date.now() - IMAGE_CACHE_DAYS * 86400_000;
    try {
      for (const f of readdirSync(this.cacheDir)) {
        const p = join(this.cacheDir, f);
        if (statSync(p).mtimeMs < old) rmSync(p, { force: true });
      }
    } catch {
      /* ignore */
    }
  }

  // ---- beeldkranten ------------------------------------------------------------------

  settingsOf(id: number) {
    return beeldkrantSettings(this.platform.ctx.db, id);
  }

  /** The pages of a beeldkrant with the given settings and feeds. */
  pages(settings: BeeldkrantSettings, feedIds: number[], absoluteUrls = true) {
    return beeldkrantPages(this.platform.ctx.db, settings, feedIds, absoluteUrls ? publicUrl(this.platform) : "");
  }
}

export function registerRss(app: FastifyInstance, platform: Platform, rss: RssFeeds, onChange: () => void) {
  const { db } = platform.ctx;
  const pid = (req: { params: unknown }) => Number((req.params as { id: string }).id);
  const count = (id: number) => (db.prepare("SELECT COUNT(*) AS n FROM rss_items WHERE feed_id = ?").get(id) as { n: number }).n;
  const getFeed = (id: number) => {
    const r = db.prepare("SELECT * FROM rss_feeds WHERE id = ?").get(id) as FeedRow | undefined;
    if (!r) throw new HttpError(404, "not_found");
    return r;
  };

  const category = z.object({ id: z.number().int(), slug: z.string().max(200), name: z.string().max(200) });
  const feedIn = z.object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["wordpress", "rss"]),
    url: z.url().max(1000),
    categories: z.array(category).max(50).default([]),
    enabled: z.boolean().default(true),
    refreshMinutes: z.number().int().min(1).max(24 * 60).default(10),
    maxItems: z.number().int().min(1).max(100).default(20),
  });
  const normal = (b: z.infer<typeof feedIn>) => ({ ...b, url: b.kind === "wordpress" ? wpSite(b.url) : b.url, categories: b.kind === "wordpress" ? b.categories : [] });

  // ---- feeds --------------------------------------------------------------------------
  app.get("/api/rss/feeds", async () => ({ feeds: (db.prepare("SELECT * FROM rss_feeds ORDER BY name COLLATE NOCASE").all() as unknown as FeedRow[]).map((f) => feedOut(f, count(f.id))) }));
  app.post("/api/rss/feeds", async (req) => {
    requireRole(req, "editor");
    const b = normal(feedIn.parse(req.body));
    const r = db.prepare("INSERT INTO rss_feeds (name, kind, url, categories, enabled, refresh_min, max_items) VALUES (?, ?, ?, ?, ?, ?, ?)").run(b.name, b.kind, b.url, JSON.stringify(b.categories), b.enabled ? 1 : 0, b.refreshMinutes, b.maxItems);
    const id = Number(r.lastInsertRowid);
    await rss.refresh(id).catch(() => undefined);
    return feedOut(getFeed(id), count(id));
  });
  app.put("/api/rss/feeds/:id", async (req) => {
    requireRole(req, "editor");
    const f = getFeed(pid(req));
    const b = normal(feedIn.parse(req.body));
    const source = f.kind !== b.kind || f.url !== b.url || f.categories !== JSON.stringify(b.categories) || f.max_items !== b.maxItems;
    db.prepare("UPDATE rss_feeds SET name = ?, kind = ?, url = ?, categories = ?, enabled = ?, refresh_min = ?, max_items = ? WHERE id = ?").run(b.name, b.kind, b.url, JSON.stringify(b.categories), b.enabled ? 1 : 0, b.refreshMinutes, b.maxItems, f.id);
    if (source) await rss.refresh(f.id).catch(() => undefined);
    onChange();
    return feedOut(getFeed(f.id), count(f.id));
  });
  app.delete("/api/rss/feeds/:id", async (req) => {
    requireRole(req, "editor");
    db.prepare("DELETE FROM rss_feeds WHERE id = ?").run(pid(req));
    onChange();
    return { ok: true };
  });
  app.post("/api/rss/feeds/:id/refresh", async (req) => {
    requireRole(req, "editor");
    const n = await rss.refresh(getFeed(pid(req)).id);
    return { ok: true, itemCount: n };
  });
  app.get("/api/rss/feeds/:id/items", async (req) => {
    const f = getFeed(pid(req));
    return {
      items: (db.prepare("SELECT id, title, summary, link, image_url AS imageUrl, author, categories, published_at AS publishedAt FROM rss_items WHERE feed_id = ? ORDER BY published_at DESC, id DESC").all(f.id) as Record<string, unknown>[]).map((i) => ({
        ...i,
        categories: JSON.parse(String(i.categories || "[]")),
      })),
    };
  });
  /** Tries a feed without saving it: shows what would come in. */
  app.post("/api/rss/test", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ kind: z.enum(["wordpress", "rss"]), url: z.url().max(1000), categories: z.array(category).max(50).default([]), maxItems: z.number().int().min(1).max(100).default(10) }).parse(req.body);
    try {
      const r = await loadFeed(b.kind, b.url, b.categories, b.maxItems);
      return { via: r.via, title: r.title, items: r.items.map(({ title, summary, imageUrl, publishedAt, categories }) => ({ title, summary: summary.slice(0, 300), imageUrl, publishedAt, categories })) };
    } catch (e) {
      throw new HttpError(502, "feed_failed", (e as Error).message);
    }
  });
  /** Categories of a WordPress site (to pick category feeds). */
  app.post("/api/rss/wordpress/categories", async (req) => {
    requireRole(req, "editor");
    const { url } = z.object({ url: z.url().max(1000) }).parse(req.body);
    try {
      const list = JSON.parse(await fetchText(wpUrls(url, [], 1).categories, "application/json")) as { id: number; name: string; slug: string; count?: number }[];
      if (!Array.isArray(list)) throw new Error("not a WordPress site");
      return { site: wpSite(url), categories: list.map((c) => ({ id: c.id, slug: c.slug, name: c.name.replace(/&amp;/g, "&"), count: c.count ?? null })) };
    } catch (e) {
      throw new HttpError(502, "wordpress_failed", (e as Error).message);
    }
  });

  // ---- beeldkranten -------------------------------------------------------------------
  const bkIn = z.object({ name: z.string().trim().min(1).max(120), feedIds: z.array(z.number().int()).max(50).default([]), settings: beeldkrantSchema });
  const bkOut = (id: number) => {
    const b = rss.settingsOf(id);
    if (!b) throw new HttpError(404, "not_found");
    const pages = rss.pages(b.settings, b.feedIds, false).length;
    const usedIn = (db.prepare("SELECT COUNT(DISTINCT block_id) AS n FROM block_items WHERE beeldkrant_id = ?").get(id) as { n: number }).n;
    return { id, name: b.name, feedIds: b.feedIds, settings: b.settings, pageCount: pages, durationMs: beeldkrantDuration(b.settings, pages), usedIn, pageUrl: `${publicUrl(platform)}/beeldkrant/page.html?id=${id}` };
  };
  const saveFeeds = (id: number, feedIds: number[]) => {
    db.prepare("DELETE FROM beeldkrant_feeds WHERE beeldkrant_id = ?").run(id);
    const ins = db.prepare("INSERT OR IGNORE INTO beeldkrant_feeds (beeldkrant_id, feed_id, position) SELECT ?, id, ? FROM rss_feeds WHERE id = ?");
    feedIds.forEach((f, i) => ins.run(id, i, f));
  };
  app.get("/api/beeldkranten", async () => ({ beeldkranten: (db.prepare("SELECT id FROM beeldkranten ORDER BY name COLLATE NOCASE").all() as { id: number }[]).map((b) => bkOut(b.id)) }));
  app.get("/api/beeldkranten/:id", async (req) => bkOut(pid(req)));
  app.post("/api/beeldkranten", async (req) => {
    requireRole(req, "editor");
    const b = bkIn.parse(req.body);
    const r = db.prepare("INSERT INTO beeldkranten (name, settings) VALUES (?, ?)").run(b.name, JSON.stringify(b.settings));
    const id = Number(r.lastInsertRowid);
    saveFeeds(id, b.feedIds);
    return bkOut(id);
  });
  app.put("/api/beeldkranten/:id", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const b = bkIn.parse(req.body);
    const r = db.prepare("UPDATE beeldkranten SET name = ?, settings = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(b.name, JSON.stringify(b.settings), id);
    if (!r.changes) throw new HttpError(404, "not_found");
    saveFeeds(id, b.feedIds);
    onChange();
    return bkOut(id);
  });
  app.delete("/api/beeldkranten/:id", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const { force } = z.object({ force: z.coerce.boolean().optional() }).parse(req.query);
    const used = (db.prepare("SELECT COUNT(*) AS n FROM block_items WHERE beeldkrant_id = ?").get(id) as { n: number }).n;
    if (used && !force) throw new HttpError(409, "beeldkrant_in_use", String(used));
    db.prepare("DELETE FROM beeldkranten WHERE id = ?").run(id);
    onChange();
    return { ok: true };
  });
  /** A block holding just this beeldkrant, to drop into the schedule, an hour clock or the week schedule. */
  app.post("/api/beeldkranten/:id/block", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const b = rss.settingsOf(id);
    if (!b) throw new HttpError(404, "not_found");
    const existing = db
      .prepare(
        `SELECT b.id FROM blocks b WHERE b.hidden = 0 AND (SELECT COUNT(*) FROM block_items i WHERE i.block_id = b.id) = 1
           AND EXISTS (SELECT 1 FROM block_items i WHERE i.block_id = b.id AND i.type = 'beeldkrant' AND i.beeldkrant_id = ?) ORDER BY b.id LIMIT 1`,
      )
      .get(id) as { id: number } | undefined;
    if (existing) return { id: existing.id, created: false };
    db.exec("BEGIN");
    try {
      const r = db.prepare("INSERT INTO blocks (name, kind, color, description, genre) VALUES (?, 'program', ?, '', '')").run(b.name.slice(0, 120), b.settings.colors.accent);
      const blockId = Number(r.lastInsertRowid);
      db.prepare("INSERT INTO block_items (block_id, position, type, beeldkrant_id) VALUES (?, 0, 'beeldkrant', ?)").run(blockId, id);
      db.exec("COMMIT");
      onChange();
      return { id: blockId, created: true };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
  /** Pages for unsaved settings (live preview in the editor). */
  app.post("/api/beeldkranten/preview", async (req) => {
    const b = z.object({ feedIds: z.array(z.number().int()).max(50), settings: beeldkrantSchema }).parse(req.body);
    const pages = rss.pages(b.settings, b.feedIds, false);
    return { pages, durationMs: beeldkrantDuration(b.settings, pages.length) };
  });

  // ---- public (CasparCG HTML producer on the studio node) ------------------------------
  const frameable = async (_req: unknown, reply: { header: (k: string, v: string) => unknown }) => {
    // The editor shows the page in an iframe as a preview; CasparCG does not care.
    reply.header("X-Frame-Options", "SAMEORIGIN");
  };
  app.get("/beeldkrant/page.html", { onSend: frameable }, async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-cache");
    return BEELDKRANT_PAGE;
  });
  app.get("/beeldkrant/:id/data.json", async (req, reply) => {
    const b = rss.settingsOf(pid(req));
    if (!b) throw new HttpError(404, "not_found");
    const base = publicUrl(platform);
    const graphicsDir = join(platform.ctx.config.dataDir, "graphics");
    const logo = b.settings.logoChannelId != null && existsSync(graphicsDir) && readdirSync(graphicsDir).some((f) => f.startsWith(`${b.settings.logoChannelId}-logo.`));
    reply.header("Cache-Control", "no-cache").header("Access-Control-Allow-Origin", "*");
    return { name: b.name, settings: b.settings, pages: rss.pages(b.settings, b.feedIds), logoUrl: logo ? `${base}/graphics/${b.settings.logoChannelId}/logo` : null, serverTime: Date.now() };
  });
  app.get("/beeldkrant/img/:id", async (req, reply) => {
    const row = db.prepare("SELECT image_url FROM rss_items WHERE id = ?").get(pid(req)) as { image_url: string | null } | undefined;
    if (!row?.image_url) throw new HttpError(404, "not_found");
    try {
      const img = await rss.image(row.image_url);
      reply.header("Content-Type", img.type).header("Cache-Control", "max-age=86400").header("Access-Control-Allow-Origin", "*");
      return img.buf;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, "image_failed", (e as Error).message);
    }
  });
}
