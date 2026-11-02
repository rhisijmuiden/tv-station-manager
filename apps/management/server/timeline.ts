/**
 * Pure timeline logic: expands TV blocks (which may contain media, live sources and nested blocks such as ad breaks)
 * into a flat list of playout events per channel. Schedule entries have a hard start: an entry that overruns is cut
 * when the next one starts; a gap until the next entry is filled with the channel filler.
 */

export interface MediaRef {
  id: number;
  name: string;
  title: string | null;
  path: string;
  durationMs: number | null;
  fps: number | null;
  category: string;
  missing: boolean;
}
export interface LiveRef {
  id: number;
  name: string;
  kind: "atem" | "rtmp";
}
export interface BlockItemRow {
  id?: number;
  type: "media" | "block" | "live" | "beeldkrant" | "webcam" | "auto" | "lineup";
  mediaId: number | null;
  childBlockId: number | null;
  liveSourceId: number | null;
  beeldkrantId?: number | null;
  webcamId?: number | null;
  /** "Newest clips" rule (type auto), stored as JSON. */
  autoRule?: string | null;
  durationMs: number | null;
  title: string | null;
  /** Audio under this item: null = follow the block, "none" = no audio, "<id>" = that audio source. */
  audio?: AudioSetting;
}
export interface BlockRef {
  id: number;
  name: string;
  kind: "program" | "commercial";
  items: BlockItemRow[];
  /** Audio under the whole block (nested blocks follow it unless they set their own). */
  audio?: AudioSetting;
}
/** Stored audio choice: null/undefined = follow the parent, "none" = no audio, "<id>" = an audio source. */
export type AudioSetting = string | null;
export interface Loader {
  block(id: number): BlockRef | undefined;
  media(id: number): MediaRef | undefined;
  live(id: number): LiveRef | undefined;
  /** Full-screen RSS news pages; `durationMs` is the default length (one pass of the pages, or a fixed time). */
  beeldkrant?(id: number): BeeldkrantRef | undefined;
  /** Webcams and external streams; `durationMs` is the default length set on the webcam. */
  webcam?(id: number): WebcamRef | undefined;
  /**
   * Dynamic item: the clips its rule picks at `asOf` (ms), in play order. `slot` names the broadcast (`key`) and the
   * item's place in it (`path`), so a pick is remembered and clips are not repeated within one broadcast.
   */
  autoMedia?(rule: string | null | undefined, asOf: number | undefined, slot?: { key: string; path: string }): MediaRef[];
}
export interface WebcamRef {
  id: number;
  name: string;
  durationMs: number;
  showOverlay: boolean;
}
export interface BeeldkrantRef {
  id: number;
  name: string;
  durationMs: number;
  showOverlay: boolean;
  /** Audio under the beeldkrant when the block or item does not choose one. */
  audioSourceId?: number | null;
}

export interface Leaf {
  type: "media" | "live" | "beeldkrant" | "webcam" | "lineup";
  durationMs: number;
  title: string;
  mediaId?: number;
  liveSourceId?: number;
  beeldkrantId?: number;
  webcamId?: number;
  /** Beeldkrant / webcam: the channel overlay (logo, clock, ticker) stays on top. */
  showOverlay?: boolean;
  /** Path relative to the media source root, e.g. "Programmas/Journaal.mp4". */
  path?: string;
  fps?: number | null;
  category?: string;
  /** Kind of the innermost block this item came from (ad breaks hide the channel logo). */
  blockKind: "program" | "commercial";
  blockName: string;
  /** Problems the editor should see (missing file, unknown duration). */
  warning?: "missing" | "no_duration";
  /** Audio source mixed under this item (radio stream, line input), null = none. */
  audioSourceId?: number | null;
  /** Picked by a "newest clips" rule (changes by itself when new clips arrive). */
  auto?: boolean;
}

export const DEFAULT_LIVE_MS = 30 * 60_000;
/** Default length of a "coming up" slide (the programme of the coming hour). */
export const DEFAULT_LINEUP_MS = 15_000;
const MAX_DEPTH = 8;

export class BlockCycleError extends Error {
  constructor(public blockId: number) {
    super(`block ${blockId} contains itself`);
  }
}

/** The nearest choice wins: an item's own setting, else its block's, else what the parent block passed down. */
export const pickAudio = (own: AudioSetting | undefined, inherited: AudioSetting | undefined): AudioSetting => (own == null || own === "" ? (inherited ?? null) : own);
/** Audio source id of a setting ("none" and "follow" give null). */
export const audioSourceOf = (a: AudioSetting | undefined): number | null => (a && /^\d+$/.test(a) ? Number(a) : null);
/** Normalises what the API accepts: null/"" = follow, "none", or a source id. */
export const audioIn = (a: string | number | null | undefined): AudioSetting => (a == null || a === "" ? null : a === "none" ? "none" : Number.isInteger(Number(a)) && Number(a) > 0 ? String(Number(a)) : null);

const mediaLeaf = (m: MediaRef, dur: number | null | undefined, title: string | null, block: BlockRef, audioSourceId: number | null): Leaf => ({
  type: "media",
  durationMs: dur ?? 0,
  title: title || m.title || m.name,
  mediaId: m.id,
  path: m.path,
  fps: m.fps,
  category: m.category,
  blockKind: block.kind,
  blockName: block.name,
  warning: m.missing ? "missing" : dur == null ? "no_duration" : undefined,
  audioSourceId,
});

/**
 * Flattens a block. Throws BlockCycleError when blocks contain each other.
 * `asOf` is when the block plays: "newest clips" items take the clips that existed then (default: now).
 */
export function expandBlock(loader: Loader, blockId: number, stack: number[] = [], inheritedAudio: AudioSetting = null, forcedAudio = false, asOf?: number, key?: string, path = `b${blockId}`): Leaf[] {
  if (stack.includes(blockId) || stack.length > MAX_DEPTH) throw new BlockCycleError(blockId);
  const block = loader.block(blockId);
  if (!block) return [];
  const out: Leaf[] = [];
  // A choice on the item that holds this block wins over the block's own setting.
  const blockAudio = forcedAudio ? inheritedAudio : pickAudio(block.audio, inheritedAudio);
  for (const [idx, it] of block.items.entries()) {
    const audio = pickAudio(it.audio, blockAudio);
    const audioSourceId = audioSourceOf(audio);
    if (it.type === "block" && it.childBlockId != null) {
      out.push(...expandBlock(loader, it.childBlockId, [...stack, blockId], audio, forcedAudio || (it.audio != null && it.audio !== ""), asOf, key, `${path}/${idx}`));
    } else if (it.type === "media" && it.mediaId != null) {
      const m = loader.media(it.mediaId);
      if (!m) continue;
      out.push(mediaLeaf(m, it.durationMs ?? m.durationMs, it.title, block, audioSourceId));
    } else if (it.type === "auto") {
      for (const m of loader.autoMedia?.(it.autoRule, asOf, key ? { key, path: `${path}/${idx}` } : undefined) ?? []) out.push({ ...mediaLeaf(m, m.durationMs, null, block, audioSourceId), auto: true });
    } else if (it.type === "live" && it.liveSourceId != null) {
      const l = loader.live(it.liveSourceId);
      if (!l) continue;
      // Live pictures come with their own sound: nothing is mixed under them.
      out.push({ type: "live", durationMs: it.durationMs ?? DEFAULT_LIVE_MS, title: it.title || l.name, liveSourceId: l.id, blockKind: block.kind, blockName: block.name, audioSourceId: null });
    } else if (it.type === "beeldkrant" && it.beeldkrantId != null) {
      const b = loader.beeldkrant?.(it.beeldkrantId);
      if (!b) continue;
      // A beeldkrant is silent: without a choice in the block it takes the beeldkrant's own audio setting.
      const bkAudio = audio == null ? (b.audioSourceId ?? null) : audioSourceId;
      out.push({ type: "beeldkrant", durationMs: it.durationMs ?? b.durationMs, title: it.title || b.name, beeldkrantId: b.id, showOverlay: b.showOverlay, blockKind: block.kind, blockName: block.name, audioSourceId: bkAudio });
    } else if (it.type === "lineup") {
      // Full-screen slide with the programmes of the coming hour, generated from the schedule when it goes on air.
      out.push({ type: "lineup", durationMs: it.durationMs ?? DEFAULT_LINEUP_MS, title: it.title || "", blockKind: block.kind, blockName: block.name, audioSourceId });
    } else if (it.type === "webcam" && it.webcamId != null) {
      const w = loader.webcam?.(it.webcamId);
      if (!w) continue;
      out.push({ type: "webcam", durationMs: it.durationMs ?? w.durationMs, title: it.title || w.name, webcamId: w.id, showOverlay: w.showOverlay, blockKind: block.kind, blockName: block.name, audioSourceId });
    }
  }
  return out;
}

export const blockDuration = (loader: Loader, blockId: number) => expandBlock(loader, blockId).reduce((s, l) => s + l.durationMs, 0);

export interface ScheduleEntry {
  id: number;
  channelId: number;
  start: number;
  blockId: number;
  title: string | null;
  description: string | null;
  inEpg: boolean;
  /** Plays only part of the block: leaves [skip, skip + take). Used by the week schedule to spread a programme over the windows of an hour clock. */
  skip?: number;
  take?: number | null;
  /** Entries of one week-schedule occurrence share a group, so the EPG shows them as one programme. */
  group?: string | null;
}

/** The leaves an entry plays (the whole block, or the part given by skip/take). */
export function entryLeaves(loader: Loader, entry: Pick<ScheduleEntry, "blockId" | "skip" | "take"> & { start?: number; id?: number; group?: string | null }): Leaf[] {
  // One broadcast = a week-schedule occurrence (all its parts) or a single schedule entry.
  const key = entry.group ? `occ:${entry.group}` : entry.id != null ? `entry:${entry.id}` : undefined;
  const all = expandBlock(loader, entry.blockId, [], null, false, entry.start, key);
  const skip = entry.skip ?? 0;
  return entry.take == null ? all.slice(skip) : all.slice(skip, skip + entry.take);
}

export interface TimelineEvent {
  /** Stable id: "<scheduleId>:<index>" or "filler:<start>". */
  key: string;
  scheduleId: number | null;
  start: number;
  end: number;
  type: "media" | "live" | "beeldkrant" | "webcam" | "lineup" | "filler";
  title: string;
  programTitle: string;
  /** Offset into the item when the event starts (only non-zero when the window cuts it). */
  offsetMs: number;
  leaf?: Leaf;
}

export interface CompiledEntry extends ScheduleEntry {
  programTitle: string;
  /** End of the content (may be after the next entry's start). */
  contentEnd: number;
  /** End on air: content end or the next entry's start, whichever is first. */
  end: number;
  overrunMs: number;
  gapAfterMs: number;
  warnings: number;
}

/**
 * Compiles schedule entries (any order) into on-air events between `from` and `to`.
 * Gaps become "filler" events.
 */
export function compile(loader: Loader, entries: ScheduleEntry[], from: number, to: number) {
  const sorted = [...entries].sort((a, b) => a.start - b.start || a.id - b.id);
  const events: TimelineEvent[] = [];
  const compiled: CompiledEntry[] = [];
  const filler = (start: number, end: number) => {
    const s = Math.max(start, from);
    const e = Math.min(end, to);
    if (e > s) events.push({ key: `filler:${start}`, scheduleId: null, start: s, end: e, type: "filler", title: "", programTitle: "", offsetMs: s - start });
  };
  if (sorted.length === 0) filler(from, to);
  else if (sorted[0]!.start > from) filler(from, sorted[0]!.start);

  sorted.forEach((entry, i) => {
    const nextStart = sorted[i + 1]?.start ?? Number.POSITIVE_INFINITY;
    let leaves: Leaf[] = [];
    try {
      leaves = entryLeaves(loader, entry);
    } catch {
      leaves = [];
    }
    const programTitle = entry.title || loader.block(entry.blockId)?.name || "";
    let cursor = entry.start;
    leaves.forEach((leaf, idx) => {
      const s = cursor;
      const e = cursor + leaf.durationMs;
      cursor = e;
      if (leaf.durationMs <= 0 || s >= nextStart) return;
      const onAirEnd = Math.min(e, nextStart);
      if (onAirEnd <= from || s >= to) return;
      const start = Math.max(s, from);
      events.push({ key: `${entry.id}:${idx}`, scheduleId: entry.id, start, end: Math.min(onAirEnd, to), type: leaf.type, title: leaf.title, programTitle, offsetMs: start - s, leaf });
    });
    const end = Math.min(cursor, nextStart);
    compiled.push({
      ...entry,
      programTitle,
      contentEnd: cursor,
      end,
      overrunMs: Number.isFinite(nextStart) ? Math.max(0, cursor - nextStart) : 0,
      gapAfterMs: Number.isFinite(nextStart) ? Math.max(0, nextStart - cursor) : 0,
      warnings: leaves.filter((l) => l.warning).length,
    });
    // Gap until the next entry (or until the end of the window after the last entry).
    filler(cursor, Math.min(nextStart, Number.isFinite(nextStart) ? nextStart : to));
  });
  events.sort((a, b) => a.start - b.start);
  return { events, entries: compiled };
}

/** The event on air at `t`, and the ones after it. */
export function at(events: TimelineEvent[], t: number) {
  return { current: events.find((e) => e.start <= t && t < e.end) ?? null, upcoming: events.filter((e) => e.start > t) };
}

/** CasparCG clip name: path relative to the media folder, forward slashes, without extension. */
export const casparClip = (path: string) => path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.[^./]+$/, "");

export interface EntryInfo {
  /** Week-schedule occurrence the entry belongs to (all parts of one hour block share it). */
  group: string | null;
  inEpg: boolean;
}

/**
 * The programme on air at `t` (the "hour block"): every event of the current schedule entry, or of all entries of the
 * same week-schedule occurrence (programme windows plus the fixed parts of the hour clock), with the filler gaps between
 * them. `index` is the position of the current event. Null while filler plays outside any programme.
 */
export function programAt(events: TimelineEvent[], t: number, info: (scheduleId: number) => EntryInfo | undefined, maxItems = 60) {
  const current = events.find((e) => e.start <= t && t < e.end);
  if (!current || current.scheduleId == null) return null;
  const group = info(current.scheduleId)?.group ?? null;
  const same = (e: TimelineEvent) => e.scheduleId != null && (e.scheduleId === current.scheduleId || (group != null && info(e.scheduleId)?.group === group));
  const own = events.filter(same);
  const start = own[0]!.start;
  const end = own[own.length - 1]!.end;
  let items = events.filter((e) => same(e) || (e.type === "filler" && e.start >= start && e.end <= end));
  let index = items.indexOf(current);
  if (items.length > maxItems) {
    // Long programmes: keep a few items before the current one and the rest after it.
    const from = Math.max(0, Math.min(index - 3, items.length - maxItems));
    items = items.slice(from, from + maxItems);
    index -= from;
  }
  const titled = own.find((e) => info(e.scheduleId!)?.inEpg && e.programTitle) ?? own.find((e) => e.programTitle);
  return { title: titled?.programTitle || current.programTitle || current.title, start, end, items, index };
}
