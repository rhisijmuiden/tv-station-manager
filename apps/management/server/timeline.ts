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
  /** What fills the rest of the hour when the block's material ends early ("beeldkrant:<id>", "webcam:<id>"); null = the channel filler. */
  fill?: string | null;
  /** Starts with the channel's fixed hour start ("every hour begins with", e.g. the coming-up slide and a tune). */
  hourStart?: boolean;
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
  /** The block every hour of this channel begins with (graphics setting `hourStart`), or null when switched off. */
  hourStart?(channelId: number): number | null;
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
  /** Part of the channel's fixed hour start, played before the block's own items. */
  hourStart?: boolean;
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

/** Parses a stored "rest of the hour" choice: a beeldkrant or webcam, or null (the channel filler). */
export function parseFill(fill: string | null | undefined): { type: "beeldkrant" | "webcam"; id: number } | null {
  const m = /^(beeldkrant|webcam):(\d+)$/.exec(fill ?? "");
  return m ? { type: m[1] as "beeldkrant" | "webcam", id: Number(m[2]) } : null;
}
/** Normalises what the API accepts for a block's "rest of the hour" setting. */
export const fillIn = (fill: string | null | undefined): string | null => {
  const f = parseFill(fill);
  return f ? `${f.type}:${f.id}` : null;
};

/**
 * The "rest of the hour" choice of a block: its own, else the one of the first nested block that has one
 * (an editor's rundown for a date holds the planned hour block as its first item).
 */
export function blockFill(loader: Loader, blockId: number): string | null {
  const b = loader.block(blockId);
  if (!b) return null;
  if (parseFill(b.fill)) return b.fill!;
  for (const it of b.items) {
    if (it.type !== "block" || it.childBlockId == null || it.childBlockId === blockId) continue;
    const child = loader.block(it.childBlockId);
    if (child && parseFill(child.fill)) return child.fill!;
  }
  return null;
}

/** The leaf that plays a "rest of the hour" choice, or undefined when it no longer exists. */
export function fillLeaf(loader: Loader, fill: string | null | undefined, blockName: string): Leaf | undefined {
  const f = parseFill(fill);
  if (f?.type === "beeldkrant") {
    const b = loader.beeldkrant?.(f.id);
    if (b) return { type: "beeldkrant", durationMs: 0, title: b.name, beeldkrantId: b.id, showOverlay: b.showOverlay, blockKind: "program", blockName, audioSourceId: b.audioSourceId ?? null };
  } else if (f?.type === "webcam") {
    const w = loader.webcam?.(f.id);
    if (w) return { type: "webcam", durationMs: 0, title: w.name, webcamId: w.id, showOverlay: w.showOverlay, blockKind: "program", blockName, audioSourceId: null };
  }
  return undefined;
}

/** The next whole hour after `t` (station time is a whole number of hours from UTC). */
export const nextHour = (t: number) => Math.floor(t / 3600_000) * 3600_000 + 3600_000;

/**
 * Whether a block starts with the channel's fixed hour start: its own setting, or that of its first nested block
 * (an editor's rundown for a date holds the planned hour block as its first item).
 */
export function blockHourStart(loader: Loader, blockId: number): boolean {
  const b = loader.block(blockId);
  if (!b) return false;
  if (b.hourStart) return true;
  const first = b.items[0];
  return first?.type === "block" && first.childBlockId != null && first.childBlockId !== blockId && !!loader.block(first.childBlockId)?.hourStart;
}

/** The leaves of the channel's fixed hour start for an entry that plays this block, or [] (none, or not wanted). */
export function hourStartLeaves(loader: Loader, channelId: number | undefined, blockId: number, asOf?: number, key?: string): Leaf[] {
  if (channelId == null || !loader.hourStart) return [];
  const opener = loader.hourStart(channelId);
  if (opener == null || opener === blockId || !blockHourStart(loader, blockId)) return [];
  try {
    return expandBlock(loader, opener, [blockId], null, false, asOf, key, `h${opener}`).map((l) => ({ ...l, hourStart: true }));
  } catch {
    return [];
  }
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
export function entryLeaves(loader: Loader, entry: Pick<ScheduleEntry, "blockId" | "skip" | "take"> & { start?: number; id?: number; group?: string | null; channelId?: number }): Leaf[] {
  // One broadcast = a week-schedule occurrence (all its parts) or a single schedule entry.
  const key = entry.group ? `occ:${entry.group}` : entry.id != null ? `entry:${entry.id}` : undefined;
  const all = expandBlock(loader, entry.blockId, [], null, false, entry.start, key);
  const skip = entry.skip ?? 0;
  // The fixed hour start goes in front of a whole block (not of a part an hour clock spreads over its windows).
  if (skip === 0 && entry.take == null) return [...hourStartLeaves(loader, entry.channelId, entry.blockId, entry.start, key), ...all];
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
  /** Fills the rest of the hour after the programme's material (the block's "rest of the hour" choice). */
  fill?: boolean;
}

export interface CompiledEntry extends ScheduleEntry {
  programTitle: string;
  /** End of the content (may be after the next entry's start). */
  contentEnd: number;
  /** End on air: content end or the next entry's start, whichever is first. */
  end: number;
  /** Time after the content filled by the block's "rest of the hour" choice (beeldkrant / webcam). */
  fillMs: number;
  overrunMs: number;
  gapAfterMs: number;
  warnings: number;
}

/**
 * Compiles schedule entries (any order) into on-air events between `from` and `to`.
 * Gaps become "filler" events. When the entry's block has a "rest of the hour" choice (a beeldkrant or webcam), the gap
 * after its content plays that until the next entry or the next whole hour, whichever is first; the rest is filler.
 * Entries of one week-schedule occurrence share the choice (the fixed parts of the clock follow the hour block).
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

  const fills = new Map<number, string | null>();
  for (const e of sorted) fills.set(e.id, blockFill(loader, e.blockId));
  const groupFill = new Map<string, string>();
  for (const e of sorted) {
    const f = fills.get(e.id);
    if (e.group && f && !groupFill.has(e.group)) groupFill.set(e.group, f);
  }

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
    // Rest of the hour: the block's choice from the end of the content to the next entry or the next whole hour.
    const fill = fills.get(entry.id) ?? (entry.group ? groupFill.get(entry.group) : undefined);
    const fLeaf = cursor < nextStart ? fillLeaf(loader, fill, programTitle) : undefined;
    const fillEnd = fLeaf ? Math.min(nextStart, nextHour(cursor)) : cursor;
    if (fLeaf && fillEnd > from && cursor < to) {
      const start = Math.max(cursor, from);
      events.push({ key: `fill:${entry.id}`, scheduleId: entry.id, start, end: Math.min(fillEnd, to), type: fLeaf.type, title: fLeaf.title, programTitle, offsetMs: start - cursor, leaf: { ...fLeaf, durationMs: fillEnd - cursor }, fill: true });
    }
    compiled.push({
      ...entry,
      programTitle,
      contentEnd: cursor,
      end,
      overrunMs: Number.isFinite(nextStart) ? Math.max(0, cursor - nextStart) : 0,
      gapAfterMs: Number.isFinite(nextStart) ? Math.max(0, nextStart - fillEnd) : 0,
      fillMs: fillEnd - cursor,
      warnings: leaves.filter((l) => l.warning).length,
    });
    // Gap until the next entry (or until the end of the window after the last entry).
    filler(fillEnd, Math.min(nextStart, Number.isFinite(nextStart) ? nextStart : to));
  });
  events.sort((a, b) => a.start - b.start);
  return { events, entries: compiled };
}

/** The event on air at `t`, and the ones after it. */
/**
 * Skips an item on air from `at` on (its file could not be found): the item ends at `at`, the rest of its programme
 * (same schedule entry) moves up by the time that was left, and the "rest of the hour" fill of that entry starts that
 * much earlier. Without such a fill the channel filler covers the time freed at the end, so the next programme still
 * starts at its own time. Calling it again with the same key and time changes nothing.
 */
export function skipEvent(events: TimelineEvent[], key: string, at: number): TimelineEvent[] {
  const ev = events.find((e) => e.key === key);
  if (!ev || at >= ev.end || at < ev.start) return events;
  const shift = ev.end - at;
  const sid = ev.scheduleId;
  const later = (e: TimelineEvent) => sid != null && e.scheduleId === sid && e !== ev && e.start >= ev.end;
  let hasFill = false;
  let lastEnd = at;
  const out = events.map((e) => {
    if (e === ev) return { ...e, end: at };
    if (!later(e)) return e;
    if (e.fill) {
      hasFill = true;
      return { ...e, start: e.start - shift };
    }
    const moved = { ...e, start: e.start - shift, end: e.end - shift };
    lastEnd = Math.max(lastEnd, moved.end);
    return moved;
  });
  if (!hasFill) out.push({ key: `filler:${lastEnd}`, scheduleId: null, start: lastEnd, end: lastEnd + shift, type: "filler", title: "", programTitle: "", offsetMs: 0 });
  return out.sort((a, b) => a.start - b.start);
}

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

/**
 * What plays between `from` and `to`: two events with the same signature show the same picture there (keys, schedule
 * ids and where the event was cut may differ).
 */
const eventSig = (e: TimelineEvent, from: number, to: number) => {
  const l = e.leaf;
  return [e.type, Math.max(e.start, from), Math.min(e.end, to), e.start - e.offsetMs, e.title, l?.path ?? null, l?.mediaId ?? null, l?.liveSourceId ?? null, l?.beeldkrantId ?? null, l?.webcamId ?? null, l?.audioSourceId ?? null, l?.showOverlay ?? null].join("|");
};

/**
 * Changes to the programme on air wait for the next hour. `held` is the timeline as it was compiled before the
 * change, `fresh` the new one. Until `until` (the next whole hour) the held events stay; from `until` on the fresh
 * ones take over (an event running across `until` is cut and starts there at the right offset).
 *
 * `differs`: something between `now` and `until` would be different (also when only keys changed, e.g. the week
 * schedule was published again with new rows: that would restart the clip on air too). `changed`: the picture
 * itself would change, which is what the editors see as "goes on air at <until>".
 */
export function holdUntil(held: TimelineEvent[], fresh: TimelineEvent[], now: number, until: number) {
  const inWindow = (e: TimelineEvent) => e.end > now && e.start < until;
  const a = held.filter(inWindow).map((e) => ({ key: e.key, sig: eventSig(e, now, until) }));
  const b = fresh.filter(inWindow).map((e) => ({ key: e.key, sig: eventSig(e, now, until) }));
  const changed = a.length !== b.length || a.some((x, i) => x.sig !== b[i]!.sig);
  const differs = changed || a.some((x, i) => x.key !== b[i]!.key);
  if (!differs) return { events: fresh, differs: false, changed: false };
  const before = held.filter((e) => e.start < until).map((e) => (e.end > until ? { ...e, end: until } : e));
  const last = held.find((e) => e.start < until && e.end > until);
  const after = fresh
    .filter((e) => e.end > until)
    .map((e) => {
      if (e.start >= until) return e;
      const cut = { ...e, start: until, offsetMs: e.offsetMs + (until - e.start) };
      // The same item running on across the hour keeps playing; anything else is a new item at the hour.
      const same = last && last.key === e.key && eventSig(last, until, Infinity) === eventSig(e, until, Infinity);
      return same ? cut : { ...cut, key: `${e.key}@${until}` };
    });
  return { events: [...before, ...after], differs: true, changed };
}
