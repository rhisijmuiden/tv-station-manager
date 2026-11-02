/** Webcam data straight from the database: used by the timeline loader, the director and the webcam module. */
import type { Db } from "@tvsm/platform";
import { webcamSettingsSchema, type WebcamKind, type WebcamSettings } from "./webcamlogic.js";
import type { WebcamRef } from "./timeline.js";

export interface WebcamRow {
  id: number;
  name: string;
  kind: WebcamKind;
  url: string;
  page_url: string | null;
  settings: string;
  status: "unknown" | "online" | "offline";
  info: string;
  last_check_at: string | null;
  last_error: string | null;
  thumb_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface Webcam {
  id: number;
  name: string;
  kind: WebcamKind;
  url: string;
  pageUrl: string | null;
  settings: WebcamSettings;
  row: WebcamRow;
}

export function webcamOf(db: Db, id: number): Webcam | undefined {
  const r = db.prepare("SELECT * FROM webcams WHERE id = ?").get(id) as WebcamRow | undefined;
  if (!r) return undefined;
  return { id: r.id, name: r.name, kind: r.kind, url: r.url, pageUrl: r.page_url, settings: webcamSettingsSchema.parse(JSON.parse(r.settings || "{}")), row: r };
}

export function webcamRef(db: Db, id: number): WebcamRef | undefined {
  const w = webcamOf(db, id);
  return w ? { id, name: w.name, durationMs: w.settings.durationSec * 1000, showOverlay: w.settings.showOverlay } : undefined;
}
