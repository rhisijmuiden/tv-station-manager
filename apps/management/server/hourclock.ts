/**
 * Pure logic for the week schedule: hour clocks, slot occurrences, spreading content over the programme windows of a clock,
 * picking media from a category, and station-time (time zone) helpers. No database access here, so it is easy to test.
 *
 * Terms:
 * - Hour clock: the fixed layout of every hour, e.g. 00:00 station ident, 00:15 headlines, programme, 55:00 ad break.
 *   Items are either a fixed block (same every hour) or a programme window (filled with the slot's content).
 * - Week slot: a recurring time on a weekday ("Monday 18:00–20:00: Sport"), with a fixed block or a category.
 * - Occurrence: a slot on a concrete date. Its content is spread over the programme windows of every hour.
 */

export const HOUR_MS = 3600_000;
export const DAY_MIN = 1440;
export const WEEK_MIN = 7 * DAY_MIN;

export interface ClockItemDef {
  kind: "block" | "program";
  blockId: number | null;
  /** Fixed block: reserved length (default: the block's own length). Programme window: fixed length, or null to share the rest of the hour. */
  durationMs: number | null;
  title: string | null;
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
  /** Fixed parts are longer than an hour, or there is no time left for the programme. */
  overbooked: boolean;
}

/** Lays out an hour clock: fixed items in order, flexible programme windows share the rest of the hour equally. */
export function layoutClock(items: ClockItemDef[], blockDuration: (id: number) => number, hourMs = HOUR_MS): ClockLayout {
  const fixedLen = (it: ClockItemDef) => (it.kind === "block" ? (it.durationMs ?? (it.blockId != null ? blockDuration(it.blockId) : 0)) : (it.durationMs ?? 0));
  const fixedMs = items.reduce((s, it) => s + fixedLen(it), 0);
  const flex = items.filter((it) => it.kind === "program" && it.durationMs == null).length;
  const rest = Math.max(0, hourMs - fixedMs);
  // Spread the rest over the flexible windows; whole seconds, the last one takes the remainder.
  const share = flex ? Math.floor(rest / flex / 1000) * 1000 : 0;
  let flexLeft = flex;
  let offset = 0;
  const segments: ClockSegment[] = items.map((it, index) => {
    let durationMs = fixedLen(it);
    if (it.kind === "program" && it.durationMs == null) durationMs = --flexLeft === 0 ? rest - share * (flex - 1) : share;
    const seg = { index, kind: it.kind, blockId: it.blockId, title: it.title, offsetMs: offset, durationMs };
    offset += durationMs;
    return seg;
  });
  const programMs = segments.filter((s) => s.kind === "program").reduce((s, x) => s + x.durationMs, 0);
  return { segments, fixedMs, programMs, overbooked: fixedMs > hourMs || (items.some((i) => i.kind === "program") && programMs <= 0) };
}

export interface Window {
  start: number;
  end: number;
  /** Start of the clock hour this window belongs to. */
  hour: number;
  segment: number;
}
export interface FixedPart {
  start: number;
  end: number;
  hour: number;
  segment: number;
  blockId: number;
  title: string | null;
}

/**
 * The fixed parts and programme windows of an occurrence [start, end). Clock hours follow the wall clock:
 * `minuteOfHour` is the station-time minute of `start` (a slot starting at 18:30 begins halfway through the 18:00 clock).
 * Without a clock the whole occurrence is one programme window.
 */
export function occurrenceParts(start: number, end: number, layout: ClockLayout | null, minuteOfHour = 0): { fixed: FixedPart[]; windows: Window[] } {
  if (!layout || !layout.segments.length) return { fixed: [], windows: end > start ? [{ start, end, hour: start, segment: -1 }] : [] };
  const fixed: FixedPart[] = [];
  const windows: Window[] = [];
  for (let hour = start - minuteOfHour * 60_000; hour < end; hour += HOUR_MS) {
    for (const seg of layout.segments) {
      const s = hour + seg.offsetMs;
      const e = Math.min(s + seg.durationMs, hour + HOUR_MS);
      if (e <= s) continue;
      if (seg.kind === "block") {
        // A fixed part plays from its start only; one that started before the occurrence is skipped.
        if (s >= start && s < end && seg.blockId != null) fixed.push({ start: s, end: Math.min(e, end), hour, segment: seg.index, blockId: seg.blockId, title: seg.title });
      } else {
        const ws = Math.max(s, start);
        const we = Math.min(e, end);
        if (we > ws) windows.push({ start: ws, end: we, hour, segment: seg.index });
      }
    }
  }
  return { fixed, windows };
}

export interface Placement {
  window: number;
  /** First leaf and number of leaves in this window. */
  skip: number;
  take: number;
  usedMs: number;
  capacityMs: number;
  /** A single item longer than the window: it is cut when the next fixed part starts. */
  tooLong: boolean;
}

/** Items within this margin still count as fitting (frame rounding, measured durations). */
export const FIT_TOLERANCE_MS = 2000;

/**
 * Pours content (leaf durations, in order) into the windows. Items are never split: an item that does not fit in what is
 * left of a window moves to the next window. An item longer than every remaining window goes into the next empty window (flagged:
 * it is cut when the next fixed part starts).
 */
export function distribute(durations: number[], windows: { start: number; end: number }[]) {
  let i = 0;
  // Largest window from here on: an item that fits nowhere goes into the first empty window; otherwise it waits for one that fits.
  const maxFrom = windows.map((_, idx) => Math.max(...windows.slice(idx).map((w) => w.end - w.start)));
  const placements: Placement[] = windows.map((w, idx) => {
    const capacityMs = w.end - w.start;
    const skip = i;
    let usedMs = 0;
    while (i < durations.length) {
      const d = durations[i]!;
      if (usedMs + d <= capacityMs + FIT_TOLERANCE_MS || (usedMs === 0 && d > maxFrom[idx]! + FIT_TOLERANCE_MS)) {
        usedMs += d;
        i++;
        if (usedMs > capacityMs + FIT_TOLERANCE_MS) break;
      } else break;
    }
    return { window: idx, skip, take: i - skip, usedMs, capacityMs, tooLong: usedMs > capacityMs + FIT_TOLERANCE_MS };
  });
  const overflow = durations.slice(i);
  return { placements, overflowCount: overflow.length, overflowMs: overflow.reduce((s, d) => s + d, 0) };
}

/**
 * Picks media for an occurrence from a category pool (ordered least recently used first): per window, first fit,
 * no item twice. Returns media ids in play order.
 */
export function autoPick(pool: { id: number; durationMs: number }[], windowsMs: number[]): number[] {
  const used = new Set<number>();
  const out: number[] = [];
  for (const cap of windowsMs) {
    let left = cap;
    for (const m of pool) {
      if (used.has(m.id) || m.durationMs <= 0) continue;
      if (m.durationMs <= left + FIT_TOLERANCE_MS) {
        used.add(m.id);
        out.push(m.id);
        left -= m.durationMs;
        if (left < 5_000) break;
      }
    }
  }
  return out;
}

// ---- week slots ------------------------------------------------------------------

export interface SlotTime {
  id?: number;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  startMin: number;
  durationMin: number;
}

/** Slots of one channel may not overlap anywhere in the week (a slot may run past midnight). */
export function overlaps(a: SlotTime, b: SlotTime) {
  const as = a.weekday * DAY_MIN + a.startMin;
  const bs = b.weekday * DAY_MIN + b.startMin;
  // Compare on a circular week: shift b by -1, 0, +1 week.
  return [-WEEK_MIN, 0, WEEK_MIN].some((k) => as < bs + k + b.durationMin && bs + k < as + a.durationMin);
}

// ---- station time ------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const parts = (t: number, tz: string) => {
  let f = fmtCache.get(tz);
  if (!f) fmtCache.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })));
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return o;
};
const tzOffset = (t: number, tz: string) => {
  const p = parts(t, tz);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000;
};

export const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** UTC time of `minutes` after midnight of `date` (yyyy-mm-dd) in time zone `tz`. Minutes may exceed a day. */
export function stationTime(date: string, minutes: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, 0, minutes);
  const o1 = tzOffset(guess - 0, tz);
  let t = guess - o1;
  const o2 = tzOffset(t, tz);
  if (o2 !== o1) t = guess - o2;
  return t;
}

const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
/** Station-time date, weekday (0 = Monday) and minute of the day of a UTC time. */
export function stationDay(t: number, tz: string) {
  const p = parts(t, tz);
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: WD[p.weekday!] ?? 0, minute: Number(p.hour) * 60 + Number(p.minute) };
}

export const addDaysIso = (date: string, n: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
};
/** 0 = Monday … 6 = Sunday. */
export const weekdayOf = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
