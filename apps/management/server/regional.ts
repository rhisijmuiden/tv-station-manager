/**
 * Regional information (docs/regional-info.md): four ready-made sources for the beeldkrant and the ticker, stored as
 * ordinary feeds (`rss_feeds.source` + `config`, items in `rss_items`):
 * - traffic: NDW open data (current situation every few minutes, planning feed of roadworks and event closures
 *   cached for 30 minutes; both DATEX II v3, gzip, streamed because the planning feed is ~200 MB).
 * - events: an iCal / RSS feed and a list kept by the editors.
 * - council: meetings of the municipal councils (iBabs public portal, Notubiz API, or an iCal link).
 * - p2000: alerts from alarmeringen.nl, filtered to the IJmond, without addresses; delay + editor approval.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { z } from "zod";
import {
  REGIONAL_SOURCES,
  councilItems,
  eventItems,
  ibabsMeetings,
  manualToEvent,
  notubizMeetings,
  notubizOrganisationId,
  p2000Items,
  parseIcal,
  parseRegional,
  parseSituation,
  regionalSchemas,
  situationMayMatter,
  trafficItems,
  type CouncilSettings,
  type DatexSituation,
  type EventsSettings,
  type Meeting,
  type P2000Settings,
  type RegionalItem,
  type RegionalSource,
  type TrafficSettings,
} from "./regionallogic.js";
import { parseFeed } from "./rsslogic.js";
import type { RssFeeds } from "./rss.js";

const UA = "TV Station Manager (regional info)";
const TIMEOUT_MS = 30_000;
const MAX_TEXT = 8 * 1024 * 1024;
const PLANNED_CACHE_MS = 30 * 60_000;
/** Notubiz API; tests point it at a local server. */
const notubizApi = () => (process.env.TVSM_NOTUBIZ_API ?? "https://api.notubiz.nl").replace(/\/$/, "");
const NOTUBIZ_VERSION = "1.10.8";

async function fetchText(url: string, accept = "*/*") {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_TEXT) throw new Error("response too large");
  return buf.toString("utf8");
}
const fetchJson = async (url: string) => JSON.parse(await fetchText(url, "application/json")) as unknown;

/** Streams a DATEX II file (gzip or plain) and keeps the situations that may concern the area. */
export async function loadSituations(url: string, municipalities: string[], timeoutMs = 180_000): Promise<DatexSituation[]> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const raw = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  // NDW serves .xml.gz files as they are (no Content-Encoding): unzip them here.
  const gz = /\.gz($|\?)/.test(new URL(url).pathname) || /gzip/.test(res.headers.get("content-type") ?? "");
  const text = gz ? raw.pipe(createGunzip()) : raw;
  text.setEncoding("utf8");
  const out: DatexSituation[] = [];
  let rest = "";
  for await (const piece of text) {
    rest += piece as string;
    let end: number;
    while ((end = rest.indexOf("</sit:situation>")) >= 0) {
      const start = rest.lastIndexOf("<sit:situation ", end);
      const chunk = start >= 0 ? rest.slice(start, end + 16) : "";
      rest = rest.slice(end + 16);
      if (chunk && situationMayMatter(chunk, municipalities)) {
        const s = parseSituation(chunk);
        if (s) out.push(s);
      }
    }
  }
  return out;
}

const plannedCache = new Map<string, { at: number; situations: DatexSituation[] }>();
const orgCache = new Map<string, number>();

export interface RegionalResult {
  items: RegionalItem[];
  /** Part of the source failed (one municipality, the planning feed): shown to the editors. */
  warning: string | null;
}

/** Fetches a regional source and turns it into items. */
export async function loadRegional(source: RegionalSource, config: unknown, timeZone: string, now = Date.now()): Promise<RegionalResult> {
  const parsed = { ...(parseRegional(source, config) as object), timeZone } as never;
  if (source === "traffic") {
    const s = parsed as TrafficSettings;
    const current = await loadSituations(s.currentUrl, s.municipalities, 60_000);
    let planned: DatexSituation[] = [];
    let warning: string | null = null;
    if (s.roadworks || s.eventClosures) {
      const hit = plannedCache.get(s.plannedUrl);
      if (hit && now - hit.at < PLANNED_CACHE_MS) planned = hit.situations;
      else {
        try {
          planned = await loadSituations(s.plannedUrl, s.municipalities);
          plannedCache.set(s.plannedUrl, { at: now, situations: planned });
        } catch (e) {
          planned = hit?.situations ?? [];
          warning = `roadworks: ${(e as Error).message}`;
        }
      }
    }
    return { items: trafficItems(current, planned, s, now), warning };
  }
  if (source === "events") {
    const s = parsed as EventsSettings;
    const events = s.manual.map((m) => manualToEvent(m, s.timeZone));
    let extra: RegionalItem[] = [];
    if (s.feedUrl) {
      const text = await fetchText(s.feedUrl, "text/calendar, application/rss+xml, application/xml, */*");
      if (/BEGIN:VCALENDAR/i.test(text)) events.push(...parseIcal(text, s.timeZone));
      else {
        // An RSS feed of announcements: in the order of the feed, after the dated events.
        extra = parseFeed(text).items.map((i) => ({ ...i, rank: null, hold: null, showFrom: null, note: null }));
      }
    }
    const dated = eventItems(events, s, now);
    return { items: [...dated, ...extra.map((x, i) => ({ ...x, rank: dated.length + i }))], warning: null };
  }
  if (source === "council") {
    const s = parsed as CouncilSettings;
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const from = now - 86400_000;
    const to = now + (s.daysAhead + 1) * 86400_000;
    const meetings: Meeting[] = [];
    const errors: string[] = [];
    for (const m of s.municipalities.filter((x) => x.enabled)) {
      try {
        if (m.system === "ibabs") {
          if (!m.url) throw new Error("no portal address");
          meetings.push(...ibabsMeetings(await fetchJson(`${m.url.replace(/\/$/, "")}/Calendar/GetAgendasForCalendar?start=${day(from)}&end=${day(to)}`), m, s.timeZone));
        } else if (m.system === "notubiz") {
          let org = m.organisationId ?? orgCache.get(m.name.toLowerCase()) ?? null;
          if (!org) {
            org = notubizOrganisationId(await fetchJson(`${notubizApi()}/organisations?format=json&version=${NOTUBIZ_VERSION}`), m.name);
            if (!org) throw new Error("municipality not found at Notubiz");
            orgCache.set(m.name.toLowerCase(), org);
          }
          const q = new URLSearchParams({ organisation_id: String(org), date_from: `${day(from)} 00:00:00`, date_to: `${day(to)} 23:59:59`, format: "json", version: NOTUBIZ_VERSION });
          meetings.push(...notubizMeetings(await fetchJson(`${notubizApi()}/events?${q}`), m, s.timeZone));
        } else {
          if (!m.url) throw new Error("no calendar address");
          meetings.push(
            ...parseIcal(await fetchText(m.url, "text/calendar"), s.timeZone).map((e) => ({ id: `ical:${m.name}:${e.uid}`, municipality: m.name, title: e.title, start: e.start, end: e.end, location: e.location, cancelled: e.cancelled, url: e.url })),
          );
        }
      } catch (e) {
        errors.push(`${m.name}: ${(e as Error).message}`);
      }
    }
    if (errors.length && errors.length === s.municipalities.filter((x) => x.enabled).length) throw new Error(errors.join("; "));
    return { items: councilItems(meetings, s, now), warning: errors.length ? errors.join("; ") : null };
  }
  const s = parsed as P2000Settings;
  const feed = parseFeed(await fetchText(s.feedUrl, "application/rss+xml, application/xml"));
  return { items: p2000Items(feed.items.map((i) => ({ guid: i.guid, raw: i.title, description: i.summary, link: i.link, publishedAt: i.publishedAt })), s, now), warning: null };
}

// ---- defaults per source --------------------------------------------------------------------------

export const SOURCE_DEFAULTS: Record<RegionalSource, { name: { nl: string; en: string }; url: string; refreshMinutes: number; maxItems: number; header: { nl: string; en: string }; accent: string }> = {
  traffic: { name: { nl: "Verkeer IJmond", en: "Traffic IJmond" }, url: "https://opendata.ndw.nu/", refreshMinutes: 5, maxItems: 40, header: { nl: "Verkeer", en: "Traffic" }, accent: "#F59E0B" },
  events: { name: { nl: "Evenementen", en: "Events" }, url: "manual:events", refreshMinutes: 60, maxItems: 60, header: { nl: "Uitagenda", en: "What's on" }, accent: "#E92E7F" },
  council: { name: { nl: "Gemeenteraad", en: "Council meetings" }, url: "manual:council", refreshMinutes: 60, maxItems: 40, header: { nl: "Gemeenteraad", en: "Council" }, accent: "#3B82F6" },
  p2000: { name: { nl: "112 IJmond", en: "Emergency IJmond" }, url: "https://alarmeringen.nl/", refreshMinutes: 2, maxItems: 40, header: { nl: "112 IJmond", en: "Emergency services" }, accent: "#EF4444" },
};

const sourceUrl = (source: RegionalSource, config: Record<string, unknown>) =>
  source === "traffic" ? String(config.currentUrl ?? SOURCE_DEFAULTS.traffic.url) : source === "p2000" ? String(config.feedUrl ?? SOURCE_DEFAULTS.p2000.url) : source === "events" && config.feedUrl ? String(config.feedUrl) : SOURCE_DEFAULTS[source].url;

export function registerRegional(app: FastifyInstance, platform: Platform, rss: RssFeeds, onChange: () => void) {
  const { db, settings: store } = platform.ctx;
  const sourceParam = (req: { params: unknown }) => {
    const s = (req.params as { source: string }).source as RegionalSource;
    if (!REGIONAL_SOURCES.includes(s)) throw new HttpError(404, "not_found");
    return s;
  };
  const feedOf = (source: RegionalSource) => db.prepare("SELECT id FROM rss_feeds WHERE source = ? ORDER BY id LIMIT 1").get(source) as { id: number } | undefined;
  const timeZone = () => store.get("station.timezone", "Europe/Amsterdam") as string;

  app.get("/api/regional", async () => {
    const counts = db.prepare("SELECT f.source AS source, SUM(i.hold = 'pending') AS pending FROM rss_items i JOIN rss_feeds f ON f.id = i.feed_id WHERE f.source IS NOT NULL GROUP BY f.source").all() as { source: string; pending: number }[];
    return {
      sources: REGIONAL_SOURCES.map((source) => {
        const f = feedOf(source);
        return { source, feed: f ? rss.feedInfo(f.id) : null, defaults: regionalSchemas[source].parse({}), pending: Number(counts.find((c) => c.source === source)?.pending ?? 0) };
      }),
    };
  });

  const body = z.object({ config: z.record(z.string(), z.unknown()).default({}), name: z.string().trim().min(1).max(120).optional(), enabled: z.boolean().optional(), refreshMinutes: z.number().int().min(1).max(24 * 60).optional() });
  const parseConfig = (source: RegionalSource, config: unknown) => {
    const r = regionalSchemas[source].safeParse(config);
    if (!r.success) throw new HttpError(400, "invalid_config", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data as Record<string, unknown>;
  };

  /** Switches a source on: one feed per source, with sensible defaults. */
  app.post("/api/regional/:source", async (req) => {
    requireRole(req, "editor");
    const source = sourceParam(req);
    const b = body.parse(req.body ?? {});
    const existing = feedOf(source);
    if (existing) return rss.feedInfo(existing.id);
    const d = SOURCE_DEFAULTS[source];
    const lang: "nl" | "en" = (b.config.language as string) === "en" ? "en" : "nl";
    const config = parseConfig(source, { language: lang, ...b.config });
    const r = db
      .prepare("INSERT INTO rss_feeds (name, kind, url, categories, enabled, refresh_min, max_items, source, config) VALUES (?, 'rss', ?, '[]', 1, ?, ?, ?, ?)")
      .run(b.name ?? d.name[lang], sourceUrl(source, config), b.refreshMinutes ?? d.refreshMinutes, d.maxItems, source, JSON.stringify(config));
    const id = Number(r.lastInsertRowid);
    await rss.refresh(id).catch(() => undefined);
    return rss.feedInfo(id);
  });

  app.put("/api/regional/:source", async (req) => {
    requireRole(req, "editor");
    const source = sourceParam(req);
    const f = feedOf(source);
    if (!f) throw new HttpError(404, "not_found");
    const b = body.parse(req.body ?? {});
    const config = parseConfig(source, b.config);
    db.prepare("UPDATE rss_feeds SET config = ?, url = ?, name = COALESCE(?, name), enabled = COALESCE(?, enabled), refresh_min = COALESCE(?, refresh_min) WHERE id = ?").run(
      JSON.stringify(config),
      sourceUrl(source, config),
      b.name ?? null,
      b.enabled == null ? null : b.enabled ? 1 : 0,
      b.refreshMinutes ?? null,
      f.id,
    );
    await rss.refresh(f.id).catch(() => undefined);
    onChange();
    return rss.feedInfo(f.id);
  });

  /** What the source gives with these settings, without saving. */
  app.post("/api/regional/:source/test", async (req) => {
    requireRole(req, "editor");
    const source = sourceParam(req);
    const config = parseConfig(source, body.parse(req.body ?? {}).config);
    try {
      const r = await loadRegional(source, config, timeZone());
      return { items: r.items.slice(0, 30).map((i) => ({ title: i.title, summary: i.summary, category: i.categories[0] ?? null, publishedAt: i.publishedAt, pending: i.hold === "pending", note: i.note })), warning: r.warning };
    } catch (e) {
      throw new HttpError(502, "feed_failed", (e as Error).message);
    }
  });

  /** Items of a source for the editors: on air now, waiting (delay / approval) and rejected. */
  app.get("/api/regional/:source/items", async (req) => {
    const f = feedOf(sourceParam(req));
    if (!f) return { items: [] };
    const now = new Date().toISOString();
    const rows = db
      .prepare("SELECT id, title, summary, categories, published_at, hold, show_from, note FROM rss_items WHERE feed_id = ? ORDER BY COALESCE(rank, 1e9), published_at DESC, id DESC")
      .all(f.id) as Record<string, unknown>[];
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        title: String(r.title),
        summary: String(r.summary ?? ""),
        category: (JSON.parse(String(r.categories || "[]")) as string[])[0] ?? null,
        publishedAt: (r.published_at as string) || null,
        state: r.hold === "pending" ? "pending" : r.hold === "rejected" ? "rejected" : r.show_from && String(r.show_from) > now ? "delayed" : "on_air",
        showFrom: (r.show_from as string) || null,
        note: (r.note as string) || null,
      })),
    };
  });

  const setHold = (hold: string | null) => async (req: { params: unknown }) => {
    requireRole(req as never, "editor");
    const id = Number((req.params as { id: string }).id);
    const r = db.prepare("UPDATE rss_items SET hold = ? WHERE id = ? AND feed_id IN (SELECT id FROM rss_feeds WHERE source IS NOT NULL)").run(hold, id);
    if (!r.changes) throw new HttpError(404, "not_found");
    onChange();
    return { ok: true };
  };
  app.post("/api/regional/items/:id/approve", setHold(null));
  app.post("/api/regional/items/:id/reject", setHold("rejected"));

  /** A beeldkrant (and a block to plan it) showing just this source, in a fitting style. */
  app.post("/api/regional/:source/beeldkrant", async (req) => {
    requireRole(req, "editor");
    const source = sourceParam(req);
    const f = feedOf(source);
    if (!f) throw new HttpError(404, "not_found");
    const d = SOURCE_DEFAULTS[source];
    const lang = (JSON.parse((db.prepare("SELECT config FROM rss_feeds WHERE id = ?").get(f.id) as { config: string }).config || "{}").language ?? "nl") as "nl" | "en";
    const settings = {
      layout: "text",
      // Short messages: several on one screen (the editor can change it on the beeldkrant).
      itemsPerPage: source === "events" ? 3 : 4,
      secondsPerPage: 15,
      maxItems: source === "p2000" ? 12 : 16,
      maxAgeHours: source === "p2000" ? 6 : 0,
      maxTextChars: 300,
      headerText: d.header[lang],
      emptyText: lang === "en" ? "Nothing to report right now." : source === "traffic" ? "Geen files of wegwerkzaamheden in de IJmond." : "Op dit moment niets te melden.",
      language: lang,
      show: { image: false, date: source === "traffic" || source === "p2000", category: true, source: false, pageNumber: true, clock: true, progress: true },
      colors: { background: "#2A1430", panel: "#713C80", accent: d.accent, text: "#FFFFFF" },
    };
    const name = (db.prepare("SELECT name FROM rss_feeds WHERE id = ?").get(f.id) as { name: string }).name;
    db.exec("BEGIN");
    try {
      const bk = Number(db.prepare("INSERT INTO beeldkranten (name, settings) VALUES (?, ?)").run(name, JSON.stringify(rss.parseSettings(settings))).lastInsertRowid);
      db.prepare("INSERT INTO beeldkrant_feeds (beeldkrant_id, feed_id, position) VALUES (?, ?, 0)").run(bk, f.id);
      const block = Number(db.prepare("INSERT INTO blocks (name, kind, color, description, genre) VALUES (?, 'program', ?, '', '')").run(name.slice(0, 120), d.accent).lastInsertRowid);
      db.prepare("INSERT INTO block_items (block_id, position, type, beeldkrant_id) VALUES (?, 0, 'beeldkrant', ?)").run(block, bk);
      db.exec("COMMIT");
      onChange();
      return { beeldkrantId: bk, blockId: block };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
}
