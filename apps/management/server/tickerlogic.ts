/**
 * Pure: the news ticker of the channel overlay (a scrolling line at the bottom of the picture).
 * Its text is a fixed text, the newest headlines of one or more RSS feeds (the feeds of the Beeldkrant page), or both.
 * The director turns the settings into the overlay's `ticker` data with `tickerItems`; the overlay scrolls the items
 * with the separator between them, at `speed` pixels per second.
 */
import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const TICKER_COLORS = { background: "#2A1430", text: "#FFFFFF", accent: "#E92E7F", labelText: "#FFFFFF" };

export const tickerSchema = z.object({
  enabled: z.boolean().default(false),
  /** Fixed text (used with source "text" or "both"). */
  text: z.string().max(2000).default(""),
  /** What the ticker shows: the fixed text, RSS headlines, or the fixed text followed by the headlines. */
  source: z.enum(["text", "rss", "both"]).default("text"),
  feedIds: z.array(z.number().int().positive()).max(20).default([]),
  /** At most this many headlines (newest first). */
  maxItems: z.number().int().min(1).max(50).default(10),
  /** Leave out headlines older than this (0 = no limit). */
  maxAgeHours: z.number().int().min(0).max(24 * 30).default(24),
  /** Put the time of the article in front of the headline ("09:12"). */
  showTime: z.boolean().default(false),
  /** Shown between two headlines. */
  separator: z.string().max(12).default("•"),
  /** Fixed tag on the left, e.g. "NIEUWS" (empty = none). */
  label: z.string().max(30).default(""),
  /** Scroll speed in pixels per second (1920 px = the width of the picture). */
  speed: z.number().int().min(20).max(600).default(120),
  /** Letter size in pixels on a 1920x1080 picture; the bar's height follows it. */
  fontSize: z.number().int().min(18).max(64).default(30),
  bold: z.boolean().default(false),
  uppercase: z.boolean().default(false),
  /** How often the ticker picks up new headlines from the feeds (the feeds themselves are fetched on their own interval). */
  refreshMinutes: z.number().int().min(1).max(240).default(5),
  colors: z
    .object({ background: hex.default(TICKER_COLORS.background), text: hex.default(TICKER_COLORS.text), accent: hex.default(TICKER_COLORS.accent), labelText: hex.default(TICKER_COLORS.labelText) })
    .default(TICKER_COLORS),
  /** Opacity of the bar's background. */
  backgroundOpacity: z.number().min(0.2).max(1).default(0.92),
});
export type TickerSettings = z.infer<typeof tickerSchema>;

export interface TickerHeadline {
  id: number;
  title: string;
  publishedAt: string | null;
  seenAt: string;
  /** Fixed order of a regional source (traffic, events): current, in this order, without a time in front. */
  rank?: number | null;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The newest headlines, newest first: not older than `maxAgeHours`, the same title once (an article in two
 * categories), at most `maxItems`. With `showTime` the time is put in front ("09:12 Title") in the given time zone.
 */
export function tickerHeadlines(items: TickerHeadline[], s: Pick<TickerSettings, "maxItems" | "maxAgeHours" | "showTime">, now: number, timeZone?: string): string[] {
  const minDate = s.maxAgeHours > 0 ? now - s.maxAgeHours * 3600_000 : -Infinity;
  const seen = new Set<string>();
  const fmt = new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) });
  return items
    .map((i) => ({ i, title: clean(i.title), at: i.rank != null ? now - i.rank : Date.parse(i.publishedAt ?? i.seenAt), timed: i.rank == null }))
    .filter(({ title, at }) => title && !(at < minDate))
    .sort((a, b) => b.at - a.at || b.i.id - a.i.id)
    .filter(({ title }) => {
      const key = title.toLowerCase();
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .slice(0, s.maxItems)
    .map(({ title, at, timed }) => (s.showTime && timed && Number.isFinite(at) ? `${fmt.format(at)} ${title}` : title));
}

/** The pieces of text the overlay scrolls, in order. A fixed text is split on new lines into separate pieces. */
export function tickerItems(s: Pick<TickerSettings, "source" | "text">, headlines: string[]): string[] {
  const fixed = s.source === "rss" ? [] : s.text.split(/\r?\n/).map(clean).filter(Boolean);
  const news = s.source === "text" ? [] : headlines;
  return [...fixed, ...news];
}

/** Height of the bar in pixels (1080p) for a letter size: the overlay and the beeldkrant page both use it. */
export const tickerHeight = (fontSize: number) => Math.round(fontSize * 2) + 4;

/** The overlay's ticker data. */
export function tickerData(s: TickerSettings, enabled: boolean, headlines: string[]) {
  const items = tickerItems(s, headlines);
  return {
    enabled: enabled && items.length > 0,
    items,
    // Older overlays (before RSS) only read `text`.
    text: items.join(`   ${s.separator}   `),
    separator: s.separator,
    label: s.label,
    speed: s.speed,
    fontSize: s.fontSize,
    height: tickerHeight(s.fontSize),
    bold: s.bold,
    uppercase: s.uppercase,
    colors: s.colors,
    backgroundOpacity: s.backgroundOpacity,
  };
}
