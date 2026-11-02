/**
 * "Newest clips" in a block (e.g. a news block): instead of a fixed clip the block item holds a rule, and every time
 * the block is played it takes the newest clips of a category or folder. New clips push the oldest ones out.
 * Pure: the database query lives in the timeline loader (`content.ts`).
 */
import { z } from "zod";

export const autoRuleSchema = z.object({
  /** Where the clips come from: a content category (Sport, News …) or a folder of the media library. */
  source: z.enum(["category", "folder"]).default("category"),
  categoryId: z.number().int().positive().nullable().default(null),
  /** Folder path as shown in the library ("News/Daily"); subfolders count too. */
  folder: z.string().max(500).default(""),
  /** How many clips at most: the newest N, older ones drop out by themselves. */
  count: z.number().int().min(1).max(50).default(5),
  /** Skip clips older than this many days (null = no limit). */
  maxAgeDays: z.number().int().min(1).max(365).nullable().default(null),
  /** Stop adding clips once the block part would get longer than this (null = no limit). */
  maxMinutes: z.number().int().min(1).max(240).nullable().default(null),
  /** Play order of the chosen clips. */
  order: z.enum(["newest_first", "oldest_first"]).default("newest_first"),
});
export type AutoRule = z.infer<typeof autoRuleSchema>;

/** Parses a stored rule; a broken or empty value gives the defaults (which select nothing until a source is set). */
export function parseAutoRule(v: unknown): AutoRule {
  let raw = v;
  if (typeof v === "string") {
    try {
      raw = JSON.parse(v);
    } catch {
      raw = {};
    }
  }
  const r = autoRuleSchema.safeParse(raw ?? {});
  return r.success ? r.data : autoRuleSchema.parse({});
}

/** A rule only selects something once its source is filled in. */
export const ruleReady = (r: AutoRule) => (r.source === "category" ? r.categoryId != null : r.folder.trim() !== "");

export interface AutoCandidate {
  id: number;
  /** When the clip counts as new: the file's modification time, else when it came into the library (ms). */
  addedAt: number;
  durationMs: number | null;
}

const DAY = 86_400_000;

/**
 * The clips a rule plays at `asOf`: only clips that already existed then (so a block on air does not change when a
 * clip arrives), newest first, at most `count`, within `maxAgeDays` and `maxMinutes`. Clips without a known length are
 * skipped (they are still being checked). Returns ids in play order.
 */
export function pickClips(candidates: AutoCandidate[], rule: AutoRule, asOf: number): number[] {
  const minAt = rule.maxAgeDays != null ? asOf - rule.maxAgeDays * DAY : -Infinity;
  const pool = candidates
    .filter((c) => c.durationMs != null && c.durationMs > 0 && c.addedAt <= asOf && c.addedAt >= minAt)
    .sort((a, b) => b.addedAt - a.addedAt || b.id - a.id);
  const out: AutoCandidate[] = [];
  let total = 0;
  const cap = rule.maxMinutes != null ? rule.maxMinutes * 60_000 : Infinity;
  for (const c of pool) {
    if (out.length >= rule.count) break;
    // Always at least one clip, even when it alone is longer than the limit.
    if (out.length > 0 && total + c.durationMs! > cap) break;
    out.push(c);
    total += c.durationMs!;
  }
  if (rule.order === "oldest_first") out.reverse();
  return out.map((c) => c.id);
}
