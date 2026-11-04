/**
 * Dynamic block items: instead of a fixed clip the item holds a rule, and every time the block is played it picks
 * clips from a category or folder. Three ways to pick:
 * - newest: the newest N clips (news block); new clips push the oldest ones out.
 * - rotate: in turn, the clip that was picked longest ago first (ads, bumpers), never twice in one broadcast.
 * - random: a random clip, not the ones picked most recently, never twice in one broadcast.
 * - mix: the newest clip(s) first, the rest random (an hour of programme items from all week folders: always the
 *   newest report first, then a few random others). The newest part is decided again for every broadcast, so a clip
 *   that comes in at 14:30 opens the 15:00 hour.
 * Pure: the database query and the memory of what was picked live in the timeline loader (`content.ts`).
 */
import { z } from "zod";

export const autoRuleSchema = z.object({
  /** Where the clips come from: a content category (Sport, News …) or a folder of the media library. */
  source: z.enum(["category", "folder"]).default("category"),
  categoryId: z.number().int().positive().nullable().default(null),
  /** Folder path as shown in the library ("News/Daily"); subfolders count too. */
  folder: z.string().max(500).default(""),
  /**
   * Folder source only. "all": every clip in the folder and its subfolders. "newest": only the newest subfolder, so a
   * parent like "Programma/2026 Reportages" with a folder per week ("wk 44", "wk 45") always plays this week's items
   * without editing the block every week (see `newestFolders`).
   */
  subfolders: z.enum(["all", "newest"]).default("all"),
  /** How many clips at most: the newest N, older ones drop out by themselves. */
  count: z.number().int().min(1).max(50).default(5),
  /** Skip clips older than this many days (null = no limit). */
  maxAgeDays: z.number().int().min(1).max(365).nullable().default(null),
  /** Stop adding clips once the block part would get longer than this (null = no limit). */
  maxMinutes: z.number().int().min(1).max(240).nullable().default(null),
  /** How clips are picked: newest, in turn (longest not picked first) or random. */
  pick: z.enum(["newest", "rotate", "random", "mix"]).default("newest"),
  /** Mix pick only: how many of the `count` clips are the newest ones (played first); the rest is random. */
  newestCount: z.number().int().min(1).max(10).default(1),
  /** Play order of the chosen clips (newest pick only). */
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
  /** Last time a rotate/random rule picked this clip (ms), null = never. */
  lastPickAt?: number | null;
}

const DAY = 86_400_000;

/** Small deterministic PRNG (mulberry32) seeded from a string, so a "random" pick is the same every time it is computed. */
export function seeded(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The clips a rule plays at `asOf`, in play order. Only clips that already existed then count (so a block on air does
 * not change when a clip arrives), within `maxAgeDays`, at most `count` and `maxMinutes` (at least one clip). Clips
 * without a known length are skipped (they are still being checked). `exclude` holds clips already picked for the same
 * broadcast (no bumper twice in one hour, unless there is nothing else); `seed` makes a random pick repeatable.
 */
/** Mix pick: how many of the picked clips are the newest ones; the rest of the list is the random part. */
export const mixNewest = (rule: AutoRule) => (rule.pick === "mix" ? Math.min(rule.newestCount, rule.count) : 0);

/** Random order of `pool` from `seed`, with the `backN` most recently picked clips moved to the back. */
function shuffle(pool: AutoCandidate[], seed: string, backN: number): AutoCandidate[] {
  const rnd = seeded(seed);
  const shuffled = [...pool].sort((a, b) => a.id - b.id);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  // The most recently picked clips go to the back, so the same one does not come back right away.
  const recentN = Math.min(backN, Math.max(0, shuffled.length - backN));
  const recent = new Set([...shuffled].filter((c) => c.lastPickAt != null).sort((a, b) => b.lastPickAt! - a.lastPickAt!).slice(0, recentN).map((c) => c.id));
  return [...shuffled.filter((c) => !recent.has(c.id)), ...shuffled.filter((c) => recent.has(c.id))];
}

/**
 * `keep` (mix pick only): the random part remembered for this broadcast. It is played again as long as every clip in it
 * is still usable and none of them has become one of the newest; otherwise the random part is picked again.
 */
export function pickClips(candidates: AutoCandidate[], rule: AutoRule, asOf: number, opts: { exclude?: ReadonlySet<number>; seed?: string; keep?: readonly number[] } = {}): number[] {
  const minAt = rule.maxAgeDays != null ? asOf - rule.maxAgeDays * DAY : -Infinity;
  const usable = candidates.filter((c) => c.durationMs != null && c.durationMs > 0 && c.addedAt <= asOf && c.addedAt >= minAt);
  const fresh = usable.filter((c) => !opts.exclude?.has(c.id));
  // Repeating within a broadcast is better than an empty slot.
  const pool = fresh.length ? fresh : usable;
  let ordered: AutoCandidate[];
  if (rule.pick === "rotate") {
    // Longest not picked first; never picked = first of all (newest of those first, so a new ad starts soon).
    ordered = [...pool].sort((a, b) => (a.lastPickAt ?? -Infinity) - (b.lastPickAt ?? -Infinity) || b.addedAt - a.addedAt || a.id - b.id);
  } else if (rule.pick === "random") {
    ordered = shuffle(pool, opts.seed ?? String(asOf), rule.count);
  } else if (rule.pick === "mix") {
    const byAge = [...pool].sort((a, b) => b.addedAt - a.addedAt || b.id - a.id);
    const n = mixNewest(rule);
    const newest = byAge.slice(0, n);
    const rest = byAge.slice(n);
    const restIds = new Map(rest.map((c) => [c.id, c]));
    const kept = opts.keep?.length && opts.keep.every((id) => restIds.has(id)) ? opts.keep.map((id) => restIds.get(id)!) : null;
    const keptSet = new Set(kept?.map((c) => c.id));
    // Kept clips first in their order, the others random behind them (only used when the count went up).
    ordered = [...newest, ...(kept ?? []), ...shuffle(rest.filter((c) => !keptSet.has(c.id)), opts.seed ?? String(asOf), rule.count - n)];
  } else {
    ordered = [...pool].sort((a, b) => b.addedAt - a.addedAt || b.id - a.id);
  }
  const out: AutoCandidate[] = [];
  let total = 0;
  const cap = rule.maxMinutes != null ? rule.maxMinutes * 60_000 : Infinity;
  for (const c of ordered) {
    if (out.length >= rule.count) break;
    // Always at least one clip, even when it alone is longer than the limit.
    if (out.length > 0 && total + c.durationMs! > cap) break;
    out.push(c);
    total += c.durationMs!;
  }
  if (rule.pick === "newest" && rule.order === "oldest_first") out.reverse();
  return out.map((c) => c.id);
}

// ---- newest subfolder ("a folder per week") ------------------------------------

/** The week number in a folder name: "wk 45", "Wk45", "week 7", "Week_03", "w 2" → 45, 45, 7, 3, 2; null when none. */
export function weekOfName(name: string): number | null {
  const m = /(?:^|[^a-z])(?:wk|week|w)[\s._-]*0*(\d{1,2})(?!\d)/i.exec(name);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 53 ? n : null;
}

/** A year (2000-2099) in a folder path, the one nearest to the end: "Programma/2026 Reportages/wk 45" → 2026. */
export function yearOfPath(path: string): number | null {
  const all = [...path.matchAll(/(?<!\d)(20\d\d)(?!\d)/g)];
  return all.length ? Number(all[all.length - 1]![1]) : null;
}

/** ISO 8601 week of a calendar date ("2026-11-02" → { year: 2026, week: 45 }); the week of 1 January may belong to the year before. */
export function isoWeek(date: string): { year: number; week: number } {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  const dow = (t.getUTCDay() + 6) % 7; // 0 = Monday
  t.setUTCDate(t.getUTCDate() - dow + 3); // the Thursday of this week decides the year
  const year = t.getUTCFullYear();
  const week = 1 + Math.floor((t.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY));
  return { year, week };
}

export interface FolderCandidate {
  /** Full folder path in the library ("Programma/2026 Reportages/wk 45"). */
  folder: string;
  /** When the newest playable clip in this folder (not its subfolders) came in (ms). */
  newestAt: number;
}

/**
 * Which subfolders of `parent` an "only the newest subfolder" rule plays from, given the folders below it that hold
 * playable clips. Folders named after a week ("wk 45") are ordered by week: the year comes from the path ("2026
 * Reportages"), else a week number above the current one is last year's (so "wk 52" sorts before "wk 1" after New
 * Year). A week that has not started yet is skipped, so next week's folder can be filled in advance. All folders of
 * the newest week count (with parent "Programma": "2026 Reportages/wk 45" and "2026 Sport/wk 45" together). Without
 * week names the folder with the most recently added clip wins. The parent's own clips never count here.
 */
export function newestFolders(candidates: FolderCandidate[], parent: string, today: { year: number; week: number }): string[] {
  const below = candidates.filter((c) => c.folder.startsWith(`${parent}/`));
  const now = today.year * 100 + today.week;
  const dated = below.flatMap((c) => {
    const rest = c.folder.slice(parent.length + 1);
    const week = weekOfName(rest.split("/").pop()!);
    if (week == null) return [];
    const year = yearOfPath(c.folder) ?? (week > today.week ? today.year - 1 : today.year);
    const key = year * 100 + week;
    return key <= now ? [{ ...c, key }] : [];
  });
  if (dated.length) {
    const best = Math.max(...dated.map((c) => c.key));
    return dated.filter((c) => c.key === best).map((c) => c.folder).sort();
  }
  const undated = below.filter((c) => weekOfName(c.folder.slice(parent.length + 1).split("/").pop()!) == null);
  if (!undated.length) return [];
  const top = undated.reduce((a, b) => (b.newestAt > a.newestAt || (b.newestAt === a.newestAt && b.folder > a.folder) ? b : a));
  return [top.folder];
}
