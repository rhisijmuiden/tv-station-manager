/**
 * Pure RSS / beeldkrant logic (tested): parsing RSS 2.0, RSS 1.0 and Atom feeds and WordPress REST posts into items,
 * turning HTML into plain text, cutting text to a maximum length and building the pages of a beeldkrant.
 */
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

export interface FeedItem {
  guid: string;
  title: string;
  /** Short text (excerpt / description), plain text. */
  summary: string;
  /** Full article text (content:encoded / content), plain text. */
  body: string;
  link: string | null;
  imageUrl: string | null;
  author: string | null;
  categories: string[];
  publishedAt: string | null;
}
export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

// ---- text -----------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", euro: "€", copy: "©", reg: "®", trade: "™", deg: "°", middot: "·", bull: "•", eacute: "é", egrave: "è", euml: "ë", ecirc: "ê",
  aacute: "á", agrave: "à", auml: "ä", acirc: "â", iacute: "í", iuml: "ï", oacute: "ó", ouml: "ö", ocirc: "ô", uacute: "ú", uuml: "ü", ccedil: "ç", ntilde: "ñ",
  Eacute: "É", Euml: "Ë", Ouml: "Ö", Uuml: "Ü", szlig: "ß", shy: "",
};
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return NAMED[e] ?? m;
  });
}

/** WordPress adds "The post X appeared first on Y." / "Het bericht X verscheen eerst op Y." to feed texts. */
const WP_FOOTER = /(Het bericht|The post|Der Beitrag|L['’]article)\s.{1,400}?\s(verscheen eerst op|appeared first on|erschien zuerst auf|est apparu en premier sur)\s.{1,200}?\.\s*$/is;

/** HTML (or text) to clean plain text: paragraphs become line breaks, tags, scripts, "[…]" and the WordPress footer go. */
/** Feeds without CDATA send their HTML escaped ("&lt;p&gt;"): undo that once so the tags can be removed. */
const unescapeHtml = (s: string) => (!/<[a-z!/]/i.test(s) && /&lt;/i.test(s) ? decodeEntities(s) : s);

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = unescapeHtml(String(html))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(script|style|figure|figcaption|iframe|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .replace(/ /g, " ")
    .replace(/\[(…|\.\.\.)\]/g, "…")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  s = s.replace(WP_FOOTER, "").trim();
  // A "…" right after the WordPress excerpt cut-off is kept; a lonely one is not.
  return s === "…" ? "" : s;
}

/**
 * Cuts text to at most `max` characters. Prefers a full sentence when one ends in the last 40%, otherwise cuts at a
 * word and adds "…". `max` 0 means no text.
 */
export function truncate(text: string, max: number): string {
  const t = text.trim();
  if (max <= 0) return "";
  if (t.length <= max) return t;
  const room = t.slice(0, max);
  const sentence = Math.max(room.lastIndexOf(". "), room.lastIndexOf("! "), room.lastIndexOf("? "), room.lastIndexOf(".\n"));
  if (sentence >= max * 0.6) return room.slice(0, sentence + 1).trim();
  const cut = t.slice(0, max - 1);
  const space = cut.search(/\s\S*$/);
  const base = (space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "");
  return `${base}…`;
}

// ---- feeds -------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: false,
  processEntities: true,
  htmlEntities: false,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => ["item", "entry", "category", "link", "enclosure", "media:content", "media:thumbnail"].includes(name),
});

const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text((v as Record<string, unknown>)["#text"] ?? "");
  return "";
};
const attr = (v: unknown, name: string) => (v && typeof v === "object" ? text((v as Record<string, unknown>)[`@${name}`]) : "");
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const isoDate = (v: string) => {
  const d = Date.parse(v);
  return Number.isFinite(d) ? new Date(d).toISOString() : null;
};
const firstImg = (html: string) => {
  const m = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/i.exec(unescapeHtml(html));
  return m ? decodeEntities(m[1]!) : null;
};
const absolute = (u: string | null, base: string | null) => {
  if (!u) return null;
  try {
    return new URL(u, base ?? undefined).toString();
  } catch {
    return null;
  }
};

/** Picks a picture: enclosure / media:content / media:thumbnail of an image type, else the first <img> of the content. */
function imageOf(it: Record<string, unknown>, html: string, base: string | null): string | null {
  for (const e of arr(it.enclosure as unknown[])) {
    const type = attr(e, "type");
    const url = attr(e, "url");
    if (url && (!type || type.startsWith("image/"))) return absolute(url, base);
  }
  for (const key of ["media:content", "media:thumbnail"]) {
    for (const e of arr(it[key] as unknown[])) {
      const url = attr(e, "url");
      const medium = attr(e, "medium");
      const type = attr(e, "type");
      if (url && (key === "media:thumbnail" || medium === "image" || type.startsWith("image/") || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url))) return absolute(url, base);
    }
  }
  const group = it["media:group"] as Record<string, unknown> | undefined;
  if (group) {
    const g = imageOf(group, "", base);
    if (g) return g;
  }
  return absolute(firstImg(html), base);
}

/** Parses RSS 2.0, RSS 1.0 (RDF) and Atom. Throws on something that is not a feed. */
export function parseFeed(xml: string): ParsedFeed {
  const doc = parser.parse(xml) as Record<string, Record<string, unknown>>;
  if (doc.rss || doc["rdf:RDF"]) {
    const root = doc.rss ? (doc.rss.channel as Record<string, unknown>) : doc["rdf:RDF"]!;
    const channel = (doc.rss ? root : root.channel) as Record<string, unknown> | undefined;
    const base = text(channel?.link) || null;
    const items = arr((root.item ?? channel?.item) as Record<string, unknown>[]).map((it): FeedItem => {
      const content = text(it["content:encoded"]);
      const description = text(it.description);
      const link = absolute(text(it.link) || null, base);
      return {
        guid: text(it.guid) || attr(it, "rdf:about") || link || text(it.title),
        title: htmlToText(text(it.title)),
        summary: htmlToText(description),
        body: htmlToText(content || description),
        link,
        imageUrl: imageOf(it, content || description, base),
        author: htmlToText(text(it["dc:creator"]) || text(it.author)) || null,
        categories: arr(it.category as unknown[]).map((c) => htmlToText(text(c))).filter(Boolean),
        publishedAt: isoDate(text(it.pubDate) || text(it["dc:date"])),
      };
    });
    return { title: htmlToText(text(channel?.title)), items };
  }
  if (doc.feed) {
    const feed = doc.feed;
    const linkOf = (v: unknown, rel = "alternate") => {
      const links = arr(v as unknown[]);
      const l = links.find((x) => (attr(x, "rel") || "alternate") === rel) ?? (rel === "alternate" ? links[0] : undefined);
      return l ? attr(l, "href") || text(l) : "";
    };
    const base = linkOf(feed.link) || null;
    const items = arr(feed.entry as Record<string, unknown>[]).map((it): FeedItem => {
      const content = text(it.content);
      const summary = text(it.summary);
      const link = absolute(linkOf(it.link) || null, base);
      const enclosure = arr(it.link as unknown[]).find((x) => attr(x, "rel") === "enclosure" && attr(x, "type").startsWith("image/"));
      return {
        guid: text(it.id) || link || text(it.title),
        title: htmlToText(text(it.title)),
        summary: htmlToText(summary || content),
        body: htmlToText(content || summary),
        link,
        imageUrl: enclosure ? absolute(attr(enclosure, "href"), base) : imageOf(it, content || summary, base),
        author: htmlToText(text((it.author as Record<string, unknown> | undefined)?.name)) || null,
        categories: arr(it.category as unknown[]).map((c) => attr(c, "label") || attr(c, "term")).filter(Boolean),
        publishedAt: isoDate(text(it.published) || text(it.updated)),
      };
    });
    return { title: htmlToText(text(feed.title)), items };
  }
  throw new Error("not an RSS or Atom feed");
}

// ---- WordPress ---------------------------------------------------------------------

export interface WpCategory {
  id: number;
  slug: string;
  name: string;
}

/** The site root of a WordPress URL: "https://www.ijmond360.nl/category/sport/feed/" -> "https://www.ijmond360.nl". */
export function wpSite(url: string) {
  const u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
  const path = u.pathname.replace(/\/(wp-json|feed|category|tag)(\/.*)?$/, "").replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** REST URL for the posts (with featured image and terms) and the RSS URLs to fall back to. */
export function wpUrls(siteUrl: string, categories: WpCategory[], perPage: number) {
  const site = wpSite(siteUrl);
  const q = new URLSearchParams({ per_page: String(Math.min(100, Math.max(1, perPage))), _embed: "wp:featuredmedia,wp:term", status: "publish" });
  if (categories.length) q.set("categories", categories.map((c) => c.id).join(","));
  return {
    rest: `${site}/wp-json/wp/v2/posts?${q}`,
    categories: `${site}/wp-json/wp/v2/categories?per_page=100&orderby=count&order=desc&_fields=id,name,slug,count`,
    rss: categories.length ? categories.map((c) => `${site}/category/${encodeURIComponent(c.slug)}/feed/`) : [`${site}/feed/`],
  };
}

type WpPost = {
  id: number;
  date_gmt?: string;
  date?: string;
  link?: string;
  guid?: { rendered?: string };
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
  _embedded?: {
    author?: { name?: string }[];
    "wp:featuredmedia"?: { source_url?: string; media_details?: { width?: number; sizes?: Record<string, { source_url?: string; width?: number }> } }[];
    "wp:term"?: { taxonomy?: string; name?: string }[][];
  };
};

/** A picture of at least ~1200 px wide when WordPress has one (sharp on 1080p, smaller than the original). */
function wpImage(fm: NonNullable<NonNullable<WpPost["_embedded"]>["wp:featuredmedia"]>[number] | undefined) {
  if (!fm?.source_url) return null;
  const sizes = Object.values(fm.media_details?.sizes ?? {}).filter((s) => s.source_url && s.width);
  const big = sizes.filter((s) => s.width! >= 1200).sort((a, b) => a.width! - b.width!)[0];
  return big?.source_url ?? fm.source_url;
}

export function wpPostsToItems(posts: unknown): FeedItem[] {
  if (!Array.isArray(posts)) throw new Error("WordPress did not return a list of posts");
  return (posts as WpPost[]).map((p) => {
    const terms = (p._embedded?.["wp:term"] ?? []).flat().filter((t) => t?.taxonomy === "category");
    const content = p.content?.rendered ?? "";
    return {
      guid: String(p.guid?.rendered || p.id),
      title: htmlToText(p.title?.rendered),
      summary: htmlToText(p.excerpt?.rendered),
      body: htmlToText(content),
      link: p.link ?? null,
      imageUrl: wpImage(p._embedded?.["wp:featuredmedia"]?.[0]) ?? absolute(firstImg(content), p.link ?? null),
      author: p._embedded?.author?.[0]?.name ?? null,
      categories: terms.map((t) => decodeEntities(t.name ?? "")).filter(Boolean),
      publishedAt: p.date_gmt ? isoDate(`${p.date_gmt}Z`) : p.date ? isoDate(p.date) : null,
    };
  });
}

/** RSS fallback for several category feeds: one list, newest first, without doubles. */
export function mergeItems(lists: FeedItem[][], max: number) {
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((i) => (seen.has(i.guid) ? false : (seen.add(i.guid), true)))
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, max);
}

// ---- beeldkrant -------------------------------------------------------------------

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const LAYOUTS = ["photo-left", "photo-right", "photo-top", "photo-full", "text"] as const;
export const beeldkrantSchema = z.object({
  /** How long each page (news item) stays on screen. */
  secondsPerPage: z.number().int().min(3).max(300).default(12),
  /** Most recent items shown (over all feeds). */
  maxItems: z.number().int().min(1).max(100).default(10),
  /** Items older than this are left out (0 = no limit). */
  maxAgeHours: z.number().int().min(0).max(24 * 90).default(72),
  maxTitleChars: z.number().int().min(10).max(300).default(90),
  /** Maximum amount of text on a page (0 = title only). */
  maxTextChars: z.number().int().min(0).max(3000).default(420),
  /** Summary = the excerpt / description of the feed, body = the start of the full article. */
  textSource: z.enum(["summary", "body"]).default("summary"),
  layout: z.enum(LAYOUTS).default("photo-left"),
  textSize: z.enum(["small", "medium", "large"]).default("medium"),
  transition: z.enum(["fade", "slide", "none"]).default("fade"),
  show: z
    .object({
      image: z.boolean().default(true),
      date: z.boolean().default(true),
      category: z.boolean().default(true),
      source: z.boolean().default(false),
      pageNumber: z.boolean().default(true),
      clock: z.boolean().default(true),
      progress: z.boolean().default(true),
    })
    .default({ image: true, date: true, category: true, source: false, pageNumber: true, clock: true, progress: true }),
  headerText: z.string().max(80).default("Nieuws"),
  footerText: z.string().max(200).default(""),
  /** Logo in the header: the logo uploaded for this channel on the Graphics page (null = none). */
  logoChannelId: z.number().int().nullable().default(null),
  emptyText: z.string().max(200).default("Er is op dit moment geen nieuws."),
  /** Language of dates on screen ("Vandaag 09:00" / "Today 09:00"). */
  language: z.enum(["nl", "en"]).default("nl"),
  colors: z
    .object({ background: hex.default("#2A1430"), panel: hex.default("#713C80"), accent: hex.default("#E92E7F"), text: hex.default("#FFFFFF") })
    .default({ background: "#2A1430", panel: "#713C80", accent: "#E92E7F", text: "#FFFFFF" }),
  /** Length of a beeldkrant item in a block when no duration is set there: one pass of all pages, or a fixed time. */
  duration: z
    .object({ mode: z.enum(["cycle", "fixed"]).default("cycle"), fixedSeconds: z.number().int().min(10).max(24 * 3600).default(600) })
    .default({ mode: "cycle", fixedSeconds: 600 }),
  /** Keep the channel overlay (logo, clock, ticker) on top of the beeldkrant. */
  showOverlay: z.boolean().default(false),
});
export type BeeldkrantSettings = z.infer<typeof beeldkrantSchema>;

export interface StoredItem {
  id: number;
  feedId: number;
  title: string;
  summary: string;
  body: string;
  imageUrl: string | null;
  categories: string[];
  publishedAt: string | null;
  seenAt: string;
}
export interface Page {
  id: number;
  title: string;
  text: string;
  image: string | null;
  date: string | null;
  category: string | null;
  source: string | null;
}

/** The pages of a beeldkrant: newest items of its feeds, not too old, cut to the configured lengths. */
export function buildPages(items: StoredItem[], s: BeeldkrantSettings, feedNames: Map<number, string>, now: number, imageUrl: (item: StoredItem) => string | null): Page[] {
  const minDate = s.maxAgeHours > 0 ? now - s.maxAgeHours * 3600_000 : -Infinity;
  const seen = new Set<string>();
  return items
    .map((i) => ({ i, at: Date.parse(i.publishedAt ?? i.seenAt) }))
    .filter(({ at }) => !(at < minDate))
    .sort((a, b) => b.at - a.at || b.i.id - a.i.id)
    .filter(({ i }) => {
      // The same article in two feeds (e.g. two categories) is shown once.
      const key = i.title.toLowerCase();
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .slice(0, s.maxItems)
    .map(({ i }) => {
      const source = s.textSource === "body" ? i.body || i.summary : i.summary || i.body;
      // An excerpt that repeats the title adds nothing.
      const textOnly = source.startsWith(i.title) ? source.slice(i.title.length).replace(/^[\s.:!?–—-]+/, "") : source;
      return {
        id: i.id,
        title: truncate(i.title, s.maxTitleChars),
        // A text the feed already cut off ("… ") ends at its last full sentence when there is one.
        text: truncate(/…$/.test(textOnly) ? truncate(textOnly, textOnly.length - 1) : textOnly, s.maxTextChars),
        image: s.show.image && s.layout !== "text" && i.imageUrl ? imageUrl(i) : null,
        date: i.publishedAt,
        category: i.categories[0] ?? null,
        source: feedNames.get(i.feedId) ?? null,
      };
    });
}

/** Default on-air length of a beeldkrant: one pass of all pages (at least one page), or the fixed time. */
export function beeldkrantDuration(s: BeeldkrantSettings, pageCount: number) {
  return s.duration.mode === "fixed" ? s.duration.fixedSeconds * 1000 : Math.max(1, pageCount) * s.secondsPerPage * 1000;
}

/** The page on screen at `now` for a beeldkrant that started at `start` (pages loop). */
export function pageAt(start: number, now: number, pageCount: number, secondsPerPage: number) {
  if (pageCount <= 0) return { index: 0, elapsedMs: 0 };
  const per = secondsPerPage * 1000;
  const t = Math.max(0, now - start);
  return { index: Math.floor(t / per) % pageCount, elapsedMs: t % per };
}
