import { ApiError, get } from "@tvsm/ui";
import { useCallback, useEffect, useRef, useState } from "react";

/** 3723000 -> "1:02:03", 63000 -> "1:03" */
export function fmtDuration(ms: number | null | undefined) {
  if (ms == null) return "–";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
/** "1:02:03" / "62:03" / "45" (seconds) -> ms */
export function parseDuration(v: string): number | null {
  const parts = v.trim().split(":").map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((a, p) => a * 60 + p, 0) * 1000;
}
/** Locale for dates and times: follows the UI language, always 24-hour clock. */
export const locale = () => (document.documentElement.lang === "nl" ? "nl-NL" : "en-GB");
export const fmtTime = (iso: string | number, seconds = false) => new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(seconds ? { second: "2-digit" } : {}) });
export const fmtDate = (d: Date) => d.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" });
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short", hourCycle: "h23" });

/** Local midnight of the given date. */
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** yyyy-mm-dd in local time, for <input type="date">. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** GET with optional polling. */
export function useGet<T>(url: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef(url);
  urlRef.current = url;
  const reload = useCallback(async () => {
    if (!urlRef.current) return;
    try {
      const d = await get<T>(urlRef.current);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : String(e));
    }
  }, []);
  useEffect(() => {
    setData(null);
    void reload();
    if (!pollMs) return;
    const t = setInterval(() => void reload(), pollMs);
    return () => clearInterval(t);
  }, [url, pollMs, reload]);
  return { data, error, reload, setData };
}

export const errorText = (t: (k: string, o?: Record<string, unknown>) => string, e: unknown) =>
  t(`mgmt.errors.${e instanceof ApiError ? e.code : "generic"}`, { message: e instanceof Error ? e.message : "", defaultValue: e instanceof ApiError && e.message && e.message !== e.code ? e.message : t("mgmt.errors.generic") });

export const CATEGORIES = ["program", "commercial", "jingle", "bumper", "filler"] as const;
export type Category = (typeof CATEGORIES)[number];
export const categoryTone = (c: string) => (({ program: "brand", commercial: "warn", jingle: "ok", bumper: "neutral", filler: "neutral" }) as Record<string, "brand" | "warn" | "ok" | "neutral">)[c] ?? "neutral";

export interface Channel {
  id: number;
  name: string;
  color: string;
  enabled: boolean;
  automation: boolean;
  atemId: number | null;
  atemMe: number;
  transition: "cut" | "mix";
  studioId: number | null;
  casparChannel: number;
  playoutInput: number | null;
  fallbackInput: number | null;
  fillerMediaId: number | null;
  graphics: Graphics;
  clockId: number | null;
  weekEnabled: boolean;
}
export type Position = "top-left" | "top-right" | "bottom-left" | "bottom-right";
/** Logo size (height in px on the 1920x1080 frame) and offset limits; the server checks the same (content.ts). */
export const LOGO_SIZE = { min: 24, max: 600, default: 96 } as const;
export const LOGO_OFFSET = { min: -96, max: 900 } as const;
/** The logo settings with the fields older saved settings lack filled in. */
export const logoOf = (l: Graphics["logo"]): Required<Graphics["logo"]> => ({ size: LOGO_SIZE.default, offsetX: 0, offsetY: 0, fullFrame: false, ...l });
export interface Graphics {
  enabled: boolean;
  template: string;
  layer: number;
  /** size = height in px on the 1920x1080 frame; offsetX/offsetY move it from its corner; fullFrame = 1920x1080 file as is. */
  logo: { enabled: boolean; position: Position; file: string | null; opacity: number; size?: number; offsetX?: number; offsetY?: number; fullFrame?: boolean };
  clock: { enabled: boolean; position: Position };
  upNext: { enabled: boolean; secondsBeforeEnd: number; durationSeconds: number };
  ticker: TickerSettings;
  subtitles: { enabled: boolean; size: "small" | "medium" | "large" };
  hideInCommercials: boolean;
  /** "Coming up" slide (block item type lineup). */
  lineup?: LineupSettings;
  /** "Every hour begins with": a block in front of every hour block. */
  hourStart?: { enabled: boolean; blockId: number | null };
  /** Which parts of the base layer stay on air per kind of content. */
  layers?: Layers;
}
/** News ticker (server/tickerlogic.ts): fixed text and/or RSS headlines. */
export interface TickerSettings {
  enabled: boolean;
  text: string;
  source: "text" | "rss" | "both";
  feedIds: number[];
  maxItems: number;
  maxAgeHours: number;
  showTime: boolean;
  separator: string;
  label: string;
  speed: number;
  fontSize: number;
  bold: boolean;
  uppercase: boolean;
  refreshMinutes: number;
  colors: { background: string; text: string; accent: string; labelText: string };
  backgroundOpacity: number;
}
export const TICKER_COLORS: TickerSettings["colors"] = { background: "#2A1430", text: "#FFFFFF", accent: "#E92E7F", labelText: "#FFFFFF" };
export const TICKER_DEFAULTS: TickerSettings = {
  enabled: false,
  text: "",
  source: "text",
  feedIds: [],
  maxItems: 10,
  maxAgeHours: 24,
  showTime: false,
  separator: "•",
  label: "",
  speed: 120,
  fontSize: 30,
  bold: false,
  uppercase: false,
  refreshMinutes: 5,
  colors: TICKER_COLORS,
  backgroundOpacity: 0.92,
};
export const tickerOf = (g: Graphics | undefined | null): TickerSettings => ({ ...TICKER_DEFAULTS, ...(g?.ticker ?? {}), colors: { ...TICKER_COLORS, ...(g?.ticker?.colors ?? {}) } });
export const LAYER_KINDS = ["media", "beeldkrant", "webcam", "live", "lineup", "info", "commercial", "filler"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];
export interface LayerRule {
  logo: boolean;
  clock: boolean;
  ticker: boolean;
}
export type Layers = Record<LayerKind, LayerRule>;
const on = { logo: true, clock: true, ticker: true };
const off = { logo: false, clock: false, ticker: false };
/** The server's defaults (server/layers.ts): a beeldkrant, webcam, coming-up slide, info page or commercial hides the base layer. */
export const LAYER_DEFAULTS: Layers = { media: on, beeldkrant: off, webcam: off, live: on, lineup: off, info: off, commercial: off, filler: on };
export const layersOf = (g: Graphics | undefined | null): Layers => ({ ...LAYER_DEFAULTS, ...(g?.layers ?? {}) });
/** The kind of content a block item is, for the layer rules (items of an ad break count as commercials). */
export const itemLayerKind = (type: string, commercial?: boolean): LayerKind =>
  commercial ? "commercial" : type === "beeldkrant" || type === "webcam" || type === "live" || type === "lineup" || type === "info" ? type : "media";
export interface LineupSettings {
  heading: string;
  language: "nl" | "en";
  minutesAhead: number;
  maxRows: number;
  colors: { background: string; panel: string; accent: string; text: string };
}
export const LINEUP_DEFAULTS: LineupSettings = { heading: "", language: "nl", minutesAhead: 60, maxRows: 7, colors: { background: "#2A1430", panel: "#713C80", accent: "#E92E7F", text: "#FFFFFF" } };
export interface MediaItem {
  id: number;
  sourceId: number;
  path: string;
  name: string;
  title: string | null;
  folder: string;
  size: number | null;
  durationMs: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  category: Category;
  probeStatus: "pending" | "ok" | "failed" | "manual";
  probeError: string | null;
  missing: boolean;
  subtitlePath: string | null;
  categoryId: number | null;
}
export interface BlockSummary {
  id: number;
  name: string;
  kind: "program" | "commercial";
  color: string;
  description: string;
  genre: string;
  categoryId: number | null;
  itemCount: number;
  durationMs: number;
  warnings: number;
  cycle: boolean;
  /** Begins with the channel's fixed hour start. */
  hourStart?: boolean;
}
export interface LiveSource {
  id: number;
  name: string;
  kind: "atem" | "rtmp";
  atemInput: number;
  studioId: number | null;
  casparChannel: number | null;
  url: string | null;
  /** Remote sources (kind "rtmp") only. */
  mode?: "push" | "pull";
  push?: { host: string; rtmpServer: string; streamKey: string; rtmpUrl: string; srtUrl: string } | null;
  status?: { state: "pull" | "unknown" | "waiting" | "live"; onlineSince: string | null; tracks: string[]; kbps: number | null };
  onOutput?: boolean;
  outputError?: string | null;
}
export interface AtemStatus {
  connected: boolean;
  model: string | null;
  productName: string | null;
  mixEffects: number;
  inputs: { id: number; longName: string; shortName: string; external: boolean; port?: string | null; namesDefault?: boolean }[];
  program: (number | null)[];
  preview: (number | null)[];
}

export function useChannels() {
  const r = useGet<{ channels: Channel[] }>("/api/channels");
  return { channels: r.data?.channels ?? null, reload: r.reload };
}

/** Remembers the selected channel across pages. */
export function useChannelSelection(channels: Channel[] | null) {
  const [id, setId] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem("tvsm.channel")) || null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (channels?.length && !channels.some((c) => c.id === id)) setId(channels[0]!.id);
  }, [channels, id]);
  const select = (v: number) => {
    setId(v);
    try {
      localStorage.setItem("tvsm.channel", String(v));
    } catch {
      /* ignore */
    }
  };
  return [channels?.find((c) => c.id === id) ?? null, select] as const;
}

/** Content category of programmes and media (sport, culture, news…). */
export interface ContentCategory {
  id: number;
  name: string;
  color: string;
  mediaCount: number;
  mediaMs: number;
  blockCount: number;
  slotCount: number;
}
export function useCategories() {
  const r = useGet<{ categories: ContentCategory[] }>("/api/categories");
  return { categories: r.data?.categories ?? null, reload: r.reload };
}

export interface ClockItem {
  kind: "block" | "program";
  blockId: number | null;
  durationMs: number | null;
  title: string | null;
  blockName?: string | null;
  blockColor?: string | null;
  blockKind?: string | null;
  blockDurationMs?: number | null;
}
export interface ClockSegment {
  index: number;
  kind: "block" | "program";
  blockId: number | null;
  title: string | null;
  offsetMs: number;
  durationMs: number;
}
export interface ClockLayout {
  segments: ClockSegment[];
  fixedMs: number;
  programMs: number;
  overbooked: boolean;
}
export interface HourClock {
  id: number;
  name: string;
  color: string;
  items: ClockItem[];
  layout: ClockLayout;
  usage: number;
}

/** 0 = Monday … 6 = Sunday, localised. */
export const weekdayName = (wd: number, style: "long" | "short" = "long") => new Date(Date.UTC(2026, 10, 2 + wd, 12)).toLocaleDateString(locale(), { weekday: style, timeZone: "UTC" });
/** 1110 -> "18:30" */
export const fmtMinutes = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** "18:30" -> 1110 */
export const parseMinutes = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null;
};
/** Monday of the week of `d` (local time). */
export const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
/** 0 = Monday … 6 = Sunday for a yyyy-mm-dd date. */
export const weekdayOfIso = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

/** "Coming up" slide with the programmes of the coming hour (default length as on the server). */
export const LINEUP_MS = 15_000;
export const lineupItem = (t: (k: string) => string) => ({ type: "lineup" as const, label: t("mgmt.lineup.item"), sub: t("mgmt.lineup.itemSub"), durationMs: null, effectiveDurationMs: LINEUP_MS });
