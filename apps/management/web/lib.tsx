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
}
export type Position = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export interface Graphics {
  enabled: boolean;
  template: string;
  layer: number;
  logo: { enabled: boolean; position: Position; file: string | null; opacity: number };
  clock: { enabled: boolean; position: Position };
  upNext: { enabled: boolean; secondsBeforeEnd: number; durationSeconds: number };
  ticker: { enabled: boolean; text: string };
  hideInCommercials: boolean;
}
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
}
export interface BlockSummary {
  id: number;
  name: string;
  kind: "program" | "commercial";
  color: string;
  description: string;
  genre: string;
  itemCount: number;
  durationMs: number;
  warnings: number;
  cycle: boolean;
}
export interface LiveSource {
  id: number;
  name: string;
  kind: "atem" | "rtmp";
  atemInput: number;
  studioId: number | null;
  casparChannel: number | null;
  url: string | null;
}
export interface AtemStatus {
  connected: boolean;
  model: string | null;
  productName: string | null;
  mixEffects: number;
  inputs: { id: number; longName: string; shortName: string; external: boolean }[];
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
