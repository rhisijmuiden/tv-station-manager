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
  type: "media" | "block" | "live";
  mediaId: number | null;
  childBlockId: number | null;
  liveSourceId: number | null;
  durationMs: number | null;
  title: string | null;
}
export interface BlockRef {
  id: number;
  name: string;
  kind: "program" | "commercial";
  items: BlockItemRow[];
}
export interface Loader {
  block(id: number): BlockRef | undefined;
  media(id: number): MediaRef | undefined;
  live(id: number): LiveRef | undefined;
}

export interface Leaf {
  type: "media" | "live";
  durationMs: number;
  title: string;
  mediaId?: number;
  liveSourceId?: number;
  /** Path relative to the media source root, e.g. "Programmas/Journaal.mp4". */
  path?: string;
  fps?: number | null;
  category?: string;
  /** Kind of the innermost block this item came from (ad breaks hide the channel logo). */
  blockKind: "program" | "commercial";
  blockName: string;
  /** Problems the editor should see (missing file, unknown duration). */
  warning?: "missing" | "no_duration";
}

export const DEFAULT_LIVE_MS = 30 * 60_000;
const MAX_DEPTH = 8;

export class BlockCycleError extends Error {
  constructor(public blockId: number) {
    super(`block ${blockId} contains itself`);
  }
}

/** Flattens a block. Throws BlockCycleError when blocks contain each other. */
export function expandBlock(loader: Loader, blockId: number, stack: number[] = []): Leaf[] {
  if (stack.includes(blockId) || stack.length > MAX_DEPTH) throw new BlockCycleError(blockId);
  const block = loader.block(blockId);
  if (!block) return [];
  const out: Leaf[] = [];
  for (const it of block.items) {
    if (it.type === "block" && it.childBlockId != null) {
      out.push(...expandBlock(loader, it.childBlockId, [...stack, blockId]));
    } else if (it.type === "media" && it.mediaId != null) {
      const m = loader.media(it.mediaId);
      if (!m) continue;
      const dur = it.durationMs ?? m.durationMs;
      out.push({
        type: "media",
        durationMs: dur ?? 0,
        title: it.title || m.title || m.name,
        mediaId: m.id,
        path: m.path,
        fps: m.fps,
        category: m.category,
        blockKind: block.kind,
        blockName: block.name,
        warning: m.missing ? "missing" : dur == null ? "no_duration" : undefined,
      });
    } else if (it.type === "live" && it.liveSourceId != null) {
      const l = loader.live(it.liveSourceId);
      if (!l) continue;
      out.push({ type: "live", durationMs: it.durationMs ?? DEFAULT_LIVE_MS, title: it.title || l.name, liveSourceId: l.id, blockKind: block.kind, blockName: block.name });
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
export function entryLeaves(loader: Loader, entry: Pick<ScheduleEntry, "blockId" | "skip" | "take">): Leaf[] {
  const all = expandBlock(loader, entry.blockId);
  const skip = entry.skip ?? 0;
  return entry.take == null ? all.slice(skip) : all.slice(skip, skip + entry.take);
}

export interface TimelineEvent {
  /** Stable id: "<scheduleId>:<index>" or "filler:<start>". */
  key: string;
  scheduleId: number | null;
  start: number;
  end: number;
  type: "media" | "live" | "filler";
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
