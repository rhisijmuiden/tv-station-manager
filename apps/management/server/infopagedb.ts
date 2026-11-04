/** Info page data straight from the database: used by the timeline loader and the info page module. */
import type { Db } from "@tvsm/platform";
import { infoPageSchema } from "./infopagelogic.js";
import type { InfoPageRef } from "./timeline.js";

export interface InfoPageRow {
  id: number;
  name: string;
  settings: string;
  image: string | null;
  created_at: string;
  updated_at: string;
}

export function infoPageOf(db: Db, id: number) {
  const r = db.prepare("SELECT * FROM info_pages WHERE id = ?").get(id) as InfoPageRow | undefined;
  if (!r) return undefined;
  return { id: r.id, name: r.name, settings: infoPageSchema.parse(JSON.parse(r.settings || "{}")), image: r.image, row: r };
}

/** For the timeline loader: name, default length and overlay choice. */
export function infoPageRef(db: Db, id: number): InfoPageRef | undefined {
  const p = infoPageOf(db, id);
  return p ? { id, name: p.name, durationMs: p.settings.durationSec * 1000, showOverlay: p.settings.showOverlay } : undefined;
}

