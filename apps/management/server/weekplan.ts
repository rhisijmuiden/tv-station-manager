/**
 * Week schedule ("weekschema") with hour clocks ("uurklokken").
 *
 * An editor plans recurring slots per channel and weekday ("Mon 18:00–20:00 Sport"). Every hour of a slot follows an hour
 * clock: fixed blocks (ident, news, ad break) at the same minute every hour, and programme windows in between. The
 * content of a slot is a fixed block, or a rundown per date that an editor puts together (or that is picked
 * automatically from the slot's category). Publishing turns the next days into ordinary schedule entries (origin "week"),
 * so the director, the schedule page and the EPG need no special handling. Manual schedule entries win: generated
 * entries that start while a manual entry plays are left out.
 */
import type { Db, Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChannelRow } from "./content.js";
import { dbLoader, scheduleEntries } from "./content.js";
import {
  DAY_MIN,
  addDaysIso,
  autoPick,
  distribute,
  isValidTimeZone,
  layoutClock,
  occurrenceParts,
  overlaps,
  seriesChanges,
  seriesKey,
  stationDay,
  stationTime,
  weekdayOf,
  type ClockItemDef,
  type ClockLayout,
} from "./hourclock.js";
import { BlockCycleError, entryLeaves, expandBlock, type Leaf, type Loader } from "./timeline.js";

const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export interface SlotRow {
  id: number;
  channel_id: number;
  weekday: number;
  start_min: number;
  duration_min: number;
  clock_mode: "channel" | "clock" | "none";
  clock_id: number | null;
  block_id: number | null;
  category_id: number | null;
  title: string | null;
  description: string | null;
  in_epg: number;
}
interface FillRow {
  id: number;
  slot_id: number;
  date: string;
  block_id: number;
  mode: "auto" | "manual";
  ready: number;
  updated_by: string | null;
  updated_at: string;
}

export type ContentState = "block" | "manual" | "auto" | "empty";

export interface Occurrence {
  key: string;
  slot: SlotRow;
  date: string;
  start: number;
  end: number;
  clockId: number | null;
  layout: ClockLayout | null;
}

export interface Planned {
  start: number;
  kind: "fixed" | "program";
  blockId: number;
  skip: number;
  take: number | null;
  title: string | null;
  description: string | null;
  inEpg: boolean;
}

const tx = <T>(db: Db, fn: () => T): T => {
  if ((db as unknown as { isTransaction?: boolean }).isTransaction) return fn();
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};

const safeDuration = (loader: Loader, blockId: number) => {
  try {
    return expandBlock(loader, blockId).reduce((s, l) => s + l.durationMs, 0);
  } catch {
    return 0;
  }
};

export class WeekPlanner {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private started = false;
  lastPublish: { at: string; created: number; error: string | null } | null = null;

  constructor(
    private platform: Platform,
    private onScheduleChanged: () => void,
  ) {}

  get db() {
    return this.platform.ctx.db;
  }
  timezone() {
    return this.platform.ctx.settings.get("station.timezone", "Europe/Amsterdam");
  }
  horizonDays() {
    return this.platform.ctx.settings.get("week.days", 14);
  }

  start() {
    this.started = true;
    this.publishAll();
    this.timer = setInterval(() => this.publishAll(), 15 * 60_000);
  }
  stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = null;
  }
  /** Content changed somewhere (blocks, media, manual schedule): publish again shortly. */
  requestPublish() {
    if (!this.started) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.publishAll();
    }, 2000);
  }

  publishAll() {
    const ids = (this.db.prepare("SELECT id FROM channels WHERE week_enabled = 1").all() as { id: number }[]).map((r) => r.id);
    let created = 0;
    let error: string | null = null;
    for (const id of ids) {
      try {
        created += this.publish(id).created;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        this.platform.ctx.log.error({ err: e, channel: id }, "week schedule publish failed");
      }
    }
    this.cleanup();
    return { created, error };
  }

  // ---- clocks ----------------------------------------------------------------------

  clockItems(clockId: number): ClockItemDef[] {
    return (this.db.prepare("SELECT kind, block_id AS blockId, duration_ms AS durationMs, title FROM clock_items WHERE clock_id = ? ORDER BY position, id").all(clockId) as unknown as ClockItemDef[]).map((i) => ({ ...i }));
  }
  layout(clockId: number | null, loader: Loader = dbLoader(this.db)): ClockLayout | null {
    if (clockId == null) return null;
    if (!this.db.prepare("SELECT 1 FROM clocks WHERE id = ?").get(clockId)) return null;
    return layoutClock(this.clockItems(clockId), (id) => safeDuration(loader, id));
  }
  clockFor(slot: SlotRow, channel: Pick<ChannelRow, "clock_id">) {
    return slot.clock_mode === "none" ? null : slot.clock_mode === "clock" ? slot.clock_id : channel.clock_id;
  }

  // ---- occurrences ------------------------------------------------------------------

  channel(id: number) {
    const c = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
    if (!c) throw new HttpError(404, "not_found");
    return c;
  }
  slots(channelId: number) {
    return this.db.prepare("SELECT * FROM week_slots WHERE channel_id = ? ORDER BY weekday, start_min").all(channelId) as unknown as SlotRow[];
  }
  slot(id: number) {
    const s = this.db.prepare("SELECT * FROM week_slots WHERE id = ?").get(id) as SlotRow | undefined;
    if (!s) throw new HttpError(404, "not_found");
    return s;
  }

  occurrence(slot: SlotRow, date: string, channel: ChannelRow, loader?: Loader): Occurrence {
    const tz = this.timezone();
    const clockId = this.clockFor(slot, channel);
    return {
      key: `${slot.id}:${date}`,
      slot,
      date,
      start: stationTime(date, slot.start_min, tz),
      end: stationTime(date, slot.start_min + slot.duration_min, tz),
      clockId,
      layout: this.layout(clockId, loader),
    };
  }

  /** Occurrences of a channel whose start date is in [fromDate, fromDate + days). */
  occurrences(channelId: number, fromDate: string, days: number, loader: Loader = dbLoader(this.db)) {
    const channel = this.channel(channelId);
    const byDay = new Map<number, SlotRow[]>();
    for (const s of this.slots(channelId)) byDay.set(s.weekday, [...(byDay.get(s.weekday) ?? []), s]);
    const out: Occurrence[] = [];
    for (let i = 0; i < days; i++) {
      const date = addDaysIso(fromDate, i);
      for (const s of byDay.get(weekdayOf(date)) ?? []) out.push(this.occurrence(s, date, channel, loader));
    }
    return out;
  }

  fill(slotId: number, date: string) {
    return this.db.prepare("SELECT * FROM week_fills WHERE slot_id = ? AND date = ?").get(slotId, date) as FillRow | undefined;
  }

  /** Where the content of an occurrence comes from. Creates the automatic pick when `createAuto` is set. */
  content(occ: Occurrence, createAuto: boolean): { state: ContentState; blockId: number | null; fill: FillRow | undefined } {
    const fill = this.fill(occ.slot.id, occ.date);
    if (fill?.mode === "manual") return { state: "manual", blockId: fill.block_id, fill };
    if (occ.slot.block_id != null) return { state: "block", blockId: occ.slot.block_id, fill };
    if (occ.slot.category_id == null) return { state: "empty", blockId: null, fill };
    const items = fill ? (this.db.prepare("SELECT COUNT(*) AS n FROM block_items WHERE block_id = ?").get(fill.block_id) as { n: number }).n : 0;
    if (fill && items) return { state: "auto", blockId: fill.block_id, fill };
    if (!createAuto) return { state: "empty", blockId: null, fill };
    const blockId = this.autoFill(occ);
    return blockId ? { state: "auto", blockId, fill: this.fill(occ.slot.id, occ.date) } : { state: "empty", blockId: null, fill };
  }

  private windowsOf(occ: Occurrence) {
    return occurrenceParts(occ.start, occ.end, occ.layout, occ.slot.start_min % 60);
  }

  /** Picks media from the slot's category (least recently picked first) and stores it as the occurrence's rundown. */
  autoFill(occ: Occurrence, replace = false): number | null {
    const { db } = this;
    if (occ.slot.category_id == null) return null;
    const existing = this.fill(occ.slot.id, occ.date);
    if (existing?.mode === "manual" && !replace) return existing.block_id;
    const pool = db
      .prepare(
        `SELECT id, duration_ms AS durationMs FROM media
          WHERE category_id = ? AND missing = 0 AND category = 'program' AND duration_ms > 0
          ORDER BY last_auto_at IS NOT NULL, last_auto_at, id`,
      )
      .all(occ.slot.category_id) as { id: number; durationMs: number }[];
    const { windows } = this.windowsOf(occ);
    const picked = autoPick(pool, windows.map((w) => w.end - w.start));
    return tx(db, () => {
      const blockId = this.fillBlock(occ, existing);
      this.writeItems(blockId, picked.map((mediaId) => ({ type: "media", mediaId })));
      const at = new Date(occ.start).toISOString();
      const st = db.prepare("UPDATE media SET last_auto_at = ? WHERE id = ?");
      for (const id of picked) st.run(at, id);
      if (existing) db.prepare("UPDATE week_fills SET mode = 'auto', ready = 0, updated_by = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(existing.id);
      else db.prepare("INSERT INTO week_fills (slot_id, date, block_id, mode) VALUES (?, ?, ?, 'auto')").run(occ.slot.id, occ.date, blockId);
      return blockId;
    });
  }

  /** The hidden block that holds an occurrence's rundown (created when needed). */
  private fillBlock(occ: Occurrence, fill: FillRow | undefined) {
    if (fill) return fill.block_id;
    const cat = occ.slot.category_id != null ? (this.db.prepare("SELECT name, color FROM categories WHERE id = ?").get(occ.slot.category_id) as { name: string; color: string } | undefined) : undefined;
    const name = `${occ.slot.title || cat?.name || "Week"} ${occ.date}`;
    const r = this.db
      .prepare("INSERT INTO blocks (name, kind, color, description, genre, category_id, hidden) VALUES (?, 'program', ?, ?, '', ?, 1)")
      .run(name, cat?.color ?? "#3B6CFF", occ.slot.description ?? "", occ.slot.category_id);
    return Number(r.lastInsertRowid);
  }

  private writeItems(blockId: number, items: { type: "media" | "block" | "live" | "beeldkrant"; mediaId?: number | null; childBlockId?: number | null; liveSourceId?: number | null; beeldkrantId?: number | null; durationMs?: number | null; title?: string | null }[]) {
    const { db } = this;
    db.prepare("DELETE FROM block_items WHERE block_id = ?").run(blockId);
    const ins = db.prepare("INSERT INTO block_items (block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, duration_ms, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    items.forEach((it, i) => {
      if (it.type === "media" && !it.mediaId) throw new HttpError(400, "media_required");
      if (it.type === "block" && !it.childBlockId) throw new HttpError(400, "block_required");
      if (it.type === "live" && !it.liveSourceId) throw new HttpError(400, "live_source_required");
      if (it.type === "beeldkrant" && !it.beeldkrantId) throw new HttpError(400, "beeldkrant_required");
      ins.run(blockId, i, it.type, it.type === "media" ? it.mediaId! : null, it.type === "block" ? it.childBlockId! : null, it.type === "live" ? it.liveSourceId! : null, it.type === "beeldkrant" ? it.beeldkrantId! : null, it.durationMs ?? null, it.title || null);
    });
    try {
      expandBlock(dbLoader(db), blockId);
    } catch (e) {
      if (e instanceof BlockCycleError) throw new HttpError(400, "block_cycle");
      throw e;
    }
    db.prepare("UPDATE blocks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(blockId);
  }

  saveFill(occ: Occurrence, items: Parameters<WeekPlanner["writeItems"]>[1], ready: boolean, user: string) {
    tx(this.db, () => {
      const existing = this.fill(occ.slot.id, occ.date);
      const blockId = this.fillBlock(occ, existing);
      this.writeItems(blockId, items);
      if (existing) this.db.prepare("UPDATE week_fills SET mode = 'manual', ready = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(ready ? 1 : 0, user, existing.id);
      else this.db.prepare("INSERT INTO week_fills (slot_id, date, block_id, mode, ready, updated_by) VALUES (?, ?, ?, 'manual', ?, ?)").run(occ.slot.id, occ.date, blockId, ready ? 1 : 0, user);
    });
  }
  /**
   * Adds items to an occurrence's rundown (drag and drop from the media library). Starts from what is
   * planned now: the editor's rundown, the automatic pick or a copy of the fixed block. `at` inserts
   * at that position, otherwise at the end. The ready flag stays as it was.
   */
  appendFill(occ: Occurrence, items: Parameters<WeekPlanner["writeItems"]>[1], user: string, at?: number) {
    const content = this.content(occ, false);
    const current =
      content.blockId != null
        ? (this.db
            .prepare("SELECT type, media_id AS mediaId, child_block_id AS childBlockId, live_source_id AS liveSourceId, beeldkrant_id AS beeldkrantId, duration_ms AS durationMs, title FROM block_items WHERE block_id = ? ORDER BY position, id")
            .all(content.blockId) as unknown as Parameters<WeekPlanner["writeItems"]>[1])
        : [];
    const pos = at == null ? current.length : Math.max(0, Math.min(current.length, at));
    const next = [...current.slice(0, pos), ...items, ...current.slice(pos)];
    this.saveFill(occ, next, content.state === "manual" ? !!content.fill?.ready : false, user);
    return { added: items.length, total: next.length };
  }
  resetFill(occ: Occurrence) {
    const f = this.fill(occ.slot.id, occ.date);
    if (f) this.db.prepare("DELETE FROM blocks WHERE id = ?").run(f.block_id); // cascades to the fill
  }

  /** The schedule entries of an occurrence and how its content fits the clock. */
  plan(occ: Occurrence, loader: Loader, createAuto: boolean) {
    const content = this.content(occ, createAuto);
    const { fixed, windows } = this.windowsOf(occ);
    let leaves: Leaf[] = [];
    try {
      leaves = content.blockId != null ? expandBlock(loader, content.blockId) : [];
    } catch {
      leaves = [];
    }
    const blockName = content.blockId != null ? (loader.block(content.blockId)?.name ?? null) : null;
    const catName = occ.slot.category_id != null ? ((this.db.prepare("SELECT name FROM categories WHERE id = ?").get(occ.slot.category_id) as { name: string } | undefined)?.name ?? null) : null;
    const title = occ.slot.title || (content.state === "block" ? blockName : null) || catName || blockName;
    const durations = leaves.map((l) => l.durationMs);
    const noClock = !occ.layout;
    const dist = distribute(durations, windows);
    const entries: Planned[] = fixed.map((f) => ({ start: f.start, kind: "fixed", blockId: f.blockId, skip: 0, take: null, title: f.title, description: null, inEpg: false }));
    if (content.blockId != null)
      dist.placements.forEach((p) => {
        if (!p.take && !noClock) return;
        entries.push({
          start: windows[p.window]!.start,
          kind: "program",
          blockId: content.blockId!,
          skip: noClock ? 0 : p.skip,
          // Without a clock the whole block plays and is cut by the next entry.
          take: noClock ? null : p.take,
          title,
          description: occ.slot.description,
          inEpg: !!occ.slot.in_epg,
        });
      });
    entries.sort((a, b) => a.start - b.start);
    const capacityMs = windows.reduce((s, w) => s + (w.end - w.start), 0);
    const filledMs = dist.placements.reduce((s, p) => s + Math.min(p.usedMs, p.capacityMs), 0);
    return {
      content,
      title,
      fixed,
      windows,
      leaves,
      placements: dist.placements,
      entries,
      capacityMs,
      filledMs: noClock ? Math.min(capacityMs, durations.reduce((s, d) => s + d, 0)) : filledMs,
      overflowMs: noClock ? Math.max(0, durations.reduce((s, d) => s + d, 0) - capacityMs) : dist.overflowMs,
      overflowCount: noClock ? 0 : dist.overflowCount,
      tooLong: dist.placements.filter((p) => p.tooLong).length,
      warnings: leaves.filter((l) => l.warning).length,
    };
  }

  /** Replaces the generated schedule entries of a channel from now (or `from`) until the horizon. */
  publish(channelId: number, opts: { from?: number; to?: number } = {}) {
    const { db } = this;
    const channel = this.channel(channelId);
    const now = Date.now();
    const cutoff = Math.max(now, opts.from ?? now);
    const end = opts.to ?? now + this.horizonDays() * 86400_000;
    const iso = (t: number) => new Date(t).toISOString();
    if (!channel.week_enabled) {
      const removed = Number(db.prepare("DELETE FROM schedule WHERE channel_id = ? AND origin = 'week' AND start_at >= ?").run(channelId, iso(cutoff)).changes);
      if (removed) this.onScheduleChanged();
      return { created: 0, removed, planned: 0 };
    }
    const tz = this.timezone();
    const loader = dbLoader(db);
    const fromDate = addDaysIso(stationDay(cutoff, tz).date, -1);
    const days = Math.round((Date.parse(stationDay(end, tz).date) - Date.parse(fromDate)) / 86400_000) + 1;
    const occs = this.occurrences(channelId, fromDate, days, loader).filter((o) => o.end > cutoff && o.start < end);
    // Manual entries win: no generated entry starts while one of them is on air.
    const manual = scheduleEntries(db, channelId, cutoff - 86400_000, end)
      .filter((e) => (db.prepare("SELECT origin FROM schedule WHERE id = ?").get(e.id) as { origin: string } | undefined)?.origin === "manual")
      .map((e) => {
        let len = 0;
        try {
          len = entryLeaves(loader, e).reduce((s, l) => s + l.durationMs, 0);
        } catch {
          /* cycle: nothing plays */
        }
        return { start: e.start, end: e.start + len };
      });
    const covered = (t: number) => manual.some((m) => t >= m.start && t < m.end);
    let created = 0;
    let removed = 0;
    tx(db, () => {
      // Only rows that changed are replaced, so entries keep their id (the director has preloaded the next one by id).
      const sig = (r: { start_at: string; block_id: number; title: string | null; description: string | null; in_epg: number; week_slot_id: number; occurrence: string; skip_items: number; take_items: number | null }) =>
        JSON.stringify([r.start_at, r.block_id, r.title, r.description, r.in_epg, r.week_slot_id, r.occurrence, r.skip_items, r.take_items]);
      const existing = new Map<string, number[]>();
      for (const r of db.prepare("SELECT * FROM schedule WHERE channel_id = ? AND origin = 'week' AND start_at >= ? AND start_at < ?").all(channelId, iso(cutoff), iso(end)) as unknown as (Parameters<typeof sig>[0] & { id: number })[]) {
        const k = sig(r);
        existing.set(k, [...(existing.get(k) ?? []), r.id]);
      }
      const ins = db.prepare(
        "INSERT INTO schedule (channel_id, start_at, block_id, title, description, in_epg, created_by, origin, week_slot_id, occurrence, skip_items, take_items) VALUES (?, ?, ?, ?, ?, ?, 'week', 'week', ?, ?, ?, ?)",
      );
      for (const occ of occs) {
        const plan = this.plan(occ, loader, true);
        for (const e of plan.entries) {
          if (e.start < cutoff || e.start >= end || e.start >= occ.end || covered(e.start)) continue;
          const row = { start_at: iso(e.start), block_id: e.blockId, title: e.title, description: e.description, in_epg: e.inEpg ? 1 : 0, week_slot_id: occ.slot.id, occurrence: occ.key, skip_items: e.skip, take_items: e.take };
          const same = existing.get(sig(row));
          if (same?.length) {
            same.shift();
            continue;
          }
          ins.run(channelId, row.start_at, row.block_id, row.title, row.description, row.in_epg, row.week_slot_id, row.occurrence, row.skip_items, row.take_items);
          created++;
        }
      }
      const del = db.prepare("DELETE FROM schedule WHERE id = ?");
      for (const ids of existing.values()) for (const id of ids) removed += Number(del.run(id).changes);
    });
    if (created || removed) this.onScheduleChanged();
    this.lastPublish = { at: new Date().toISOString(), created, error: null };
    return { created, removed, planned: (db.prepare("SELECT COUNT(*) AS n FROM schedule WHERE channel_id = ? AND origin = 'week' AND start_at >= ?").get(channelId, iso(cutoff)) as { n: number }).n };
  }

  /** Removes rundowns (hidden blocks) of occurrences more than 60 days ago. */
  cleanup() {
    const before = addDaysIso(new Date().toISOString().slice(0, 10), -60);
    this.db.prepare("DELETE FROM blocks WHERE hidden = 1 AND id IN (SELECT block_id FROM week_fills WHERE date < ?)").run(before);
    this.db.prepare("DELETE FROM blocks WHERE hidden = 1 AND id NOT IN (SELECT block_id FROM week_fills) AND updated_at < ?").run(`${before}T00:00:00.000Z`);
  }
}

// ---- routes ---------------------------------------------------------------------------

const clockItemIn = z.object({
  kind: z.enum(["block", "program"]),
  blockId: z.number().int().nullable().optional(),
  durationMs: z.number().int().min(0).max(3600_000).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
});
const clockIn = z.object({ name: z.string().trim().min(1).max(120), color: COLOR.default("#3B6CFF"), items: z.array(clockItemIn).max(60).default([]) });
const slotBase = z.object({
  startMin: z.number().int().min(0).max(DAY_MIN - 1),
  durationMin: z.number().int().min(1).max(DAY_MIN),
  clockMode: z.enum(["channel", "clock", "none"]).default("channel"),
  clockId: z.number().int().nullable().optional(),
  blockId: z.number().int().nullable().optional(),
  categoryId: z.number().int().nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  inEpg: z.boolean().default(true),
});
const fillItemIn = z.object({
  type: z.enum(["media", "block", "live", "beeldkrant"]),
  mediaId: z.number().int().nullable().optional(),
  childBlockId: z.number().int().nullable().optional(),
  liveSourceId: z.number().int().nullable().optional(),
  beeldkrantId: z.number().int().nullable().optional(),
  durationMs: z.number().int().min(0).max(24 * 3600_000).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
});
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const slotOut = (s: SlotRow) => ({
  id: s.id,
  channelId: s.channel_id,
  weekday: s.weekday,
  startMin: s.start_min,
  durationMin: s.duration_min,
  clockMode: s.clock_mode,
  clockId: s.clock_id,
  blockId: s.block_id,
  categoryId: s.category_id,
  title: s.title,
  description: s.description,
  inEpg: !!s.in_epg,
});

export function registerWeek(app: FastifyInstance, platform: Platform, planner: WeekPlanner) {
  const { db, settings } = platform.ctx;
  const pid = (req: { params: unknown }) => Number((req.params as { id: string }).id);
  const republish = (channelId: number) => {
    const c = db.prepare("SELECT week_enabled FROM channels WHERE id = ?").get(channelId) as { week_enabled: number } | undefined;
    if (c?.week_enabled) planner.publish(channelId);
  };
  const republishAll = () => planner.publishAll();

  // ---- categories --------------------------------------------------------------------
  const categoryIn = z.object({ name: z.string().trim().min(1).max(80), color: COLOR.default("#3B6CFF") });
  app.get("/api/categories", async () => ({
    categories: db
      .prepare(
        `SELECT c.id, c.name, c.color,
                (SELECT COUNT(*) FROM media m WHERE m.category_id = c.id AND m.missing = 0) AS mediaCount,
                (SELECT COALESCE(SUM(m.duration_ms), 0) FROM media m WHERE m.category_id = c.id AND m.missing = 0) AS mediaMs,
                (SELECT COUNT(*) FROM blocks b WHERE b.category_id = c.id AND b.hidden = 0) AS blockCount,
                (SELECT COUNT(*) FROM week_slots s WHERE s.category_id = c.id) AS slotCount
           FROM categories c ORDER BY c.name COLLATE NOCASE`,
      )
      .all(),
  }));
  app.post("/api/categories", async (req) => {
    requireRole(req, "editor");
    const b = categoryIn.parse(req.body);
    return { id: Number(db.prepare("INSERT INTO categories (name, color) VALUES (?, ?)").run(b.name, b.color).lastInsertRowid) };
  });
  app.put("/api/categories/:id", async (req) => {
    requireRole(req, "editor");
    const b = categoryIn.parse(req.body);
    if (!db.prepare("UPDATE categories SET name = ?, color = ? WHERE id = ?").run(b.name, b.color, pid(req)).changes) throw new HttpError(404, "not_found");
    republishAll();
    return { ok: true };
  });
  app.delete("/api/categories/:id", async (req) => {
    requireRole(req, "editor");
    db.prepare("DELETE FROM categories WHERE id = ?").run(pid(req));
    republishAll();
    return { ok: true };
  });

  // ---- hour clocks -----------------------------------------------------------------------
  const clockOut = (c: Record<string, unknown>) => {
    const loader = dbLoader(db);
    const items = (
      db
        .prepare(
          `SELECT i.kind, i.block_id AS blockId, i.duration_ms AS durationMs, i.title, b.name AS blockName, b.color AS blockColor, b.kind AS blockKind
             FROM clock_items i LEFT JOIN blocks b ON b.id = i.block_id WHERE i.clock_id = ? ORDER BY i.position, i.id`,
        )
        .all(Number(c.id)) as Record<string, unknown>[]
    ).map((i) => ({ ...i, blockDurationMs: i.blockId != null ? safeDuration(loader, Number(i.blockId)) : null }));
    const layout = layoutClock(items as unknown as ClockItemDef[], (id) => safeDuration(loader, id));
    const usage = (db.prepare("SELECT (SELECT COUNT(*) FROM channels WHERE clock_id = ?) + (SELECT COUNT(*) FROM week_slots WHERE clock_mode = 'clock' AND clock_id = ?) AS n").get(Number(c.id), Number(c.id)) as { n: number }).n;
    return { id: c.id, name: c.name, color: c.color, items, layout, usage };
  };
  app.get("/api/clocks", async () => ({ clocks: (db.prepare("SELECT * FROM clocks ORDER BY name COLLATE NOCASE").all() as Record<string, unknown>[]).map(clockOut) }));
  app.get("/api/clocks/:id", async (req) => {
    const c = db.prepare("SELECT * FROM clocks WHERE id = ?").get(pid(req)) as Record<string, unknown> | undefined;
    if (!c) throw new HttpError(404, "not_found");
    return clockOut(c);
  });
  const saveClockItems = (clockId: number, items: z.infer<typeof clockItemIn>[]) => {
    db.prepare("DELETE FROM clock_items WHERE clock_id = ?").run(clockId);
    const ins = db.prepare("INSERT INTO clock_items (clock_id, position, kind, block_id, duration_ms, title) VALUES (?, ?, ?, ?, ?, ?)");
    items.forEach((it, i) => {
      if (it.kind === "block" && !it.blockId) throw new HttpError(400, "block_required");
      ins.run(clockId, i, it.kind, it.kind === "block" ? it.blockId! : null, it.durationMs ?? null, it.title || null);
    });
  };
  app.post("/api/clocks", async (req) => {
    requireRole(req, "editor");
    const b = clockIn.parse(req.body);
    const id = tx(db, () => {
      const id = Number(db.prepare("INSERT INTO clocks (name, color) VALUES (?, ?)").run(b.name, b.color).lastInsertRowid);
      saveClockItems(id, b.items);
      return id;
    });
    return { id };
  });
  app.put("/api/clocks/:id", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const b = clockIn.parse(req.body);
    tx(db, () => {
      if (!db.prepare("UPDATE clocks SET name = ?, color = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(b.name, b.color, id).changes) throw new HttpError(404, "not_found");
      saveClockItems(id, b.items);
    });
    republishAll();
    return { id };
  });
  app.post("/api/clocks/:id/duplicate", async (req) => {
    requireRole(req, "editor");
    const src = db.prepare("SELECT * FROM clocks WHERE id = ?").get(pid(req)) as { id: number; name: string; color: string } | undefined;
    if (!src) throw new HttpError(404, "not_found");
    const id = tx(db, () => {
      const id = Number(db.prepare("INSERT INTO clocks (name, color) VALUES (?, ?)").run(`${src.name} (copy)`, src.color).lastInsertRowid);
      db.prepare("INSERT INTO clock_items (clock_id, position, kind, block_id, duration_ms, title) SELECT ?, position, kind, block_id, duration_ms, title FROM clock_items WHERE clock_id = ?").run(id, src.id);
      return id;
    });
    return { id };
  });
  app.delete("/api/clocks/:id", async (req) => {
    requireRole(req, "editor");
    db.prepare("DELETE FROM clocks WHERE id = ?").run(pid(req));
    republishAll();
    return { ok: true };
  });

  // ---- settings ---------------------------------------------------------------------------
  app.get("/api/week/settings", async () => ({ timezone: planner.timezone(), horizonDays: planner.horizonDays(), lastPublish: planner.lastPublish }));
  app.put("/api/week/settings", async (req) => {
    requireRole(req, "admin");
    const b = z.object({ timezone: z.string().min(1).max(64).refine(isValidTimeZone, "invalid time zone"), horizonDays: z.number().int().min(1).max(28) }).parse(req.body);
    settings.set("station.timezone", b.timezone);
    settings.set("week.days", b.horizonDays);
    republishAll();
    return { ok: true };
  });

  // ---- week slots ------------------------------------------------------------------------
  app.get("/api/week", async (req) => {
    const { channel } = z.object({ channel: z.coerce.number().int() }).parse(req.query);
    const c = planner.channel(channel);
    const generated = db.prepare("SELECT COUNT(*) AS n, MAX(start_at) AS last FROM schedule WHERE channel_id = ? AND origin = 'week' AND start_at >= ?").get(channel, new Date().toISOString()) as { n: number; last: string | null };
    return {
      channel: { id: c.id, name: c.name, clockId: c.clock_id, weekEnabled: !!c.week_enabled },
      slots: planner.slots(channel).map(slotOut),
      timezone: planner.timezone(),
      horizonDays: planner.horizonDays(),
      generated: { entries: generated.n, until: generated.last },
      lastPublish: planner.lastPublish,
    };
  });
  app.put("/api/week/channels/:id", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ weekEnabled: z.boolean(), clockId: z.number().int().nullable() }).parse(req.body);
    const c = planner.channel(pid(req));
    db.prepare("UPDATE channels SET week_enabled = ?, clock_id = ? WHERE id = ?").run(b.weekEnabled ? 1 : 0, b.clockId, c.id);
    return planner.publish(c.id);
  });

  const checkSlot = (channelId: number, s: { id?: number; weekday: number; startMin: number; durationMin: number }, ignore: number[] = []) => {
    const other = planner.slots(channelId).find((o) => o.id !== s.id && !ignore.includes(o.id) && overlaps({ weekday: o.weekday, startMin: o.start_min, durationMin: o.duration_min }, s));
    if (other) throw new HttpError(409, "slot_overlap", `${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][other.weekday]} ${String(Math.floor(other.start_min / 60)).padStart(2, "0")}:${String(other.start_min % 60).padStart(2, "0")}`);
  };
  const slotValues = (b: z.infer<typeof slotBase>) => [
    b.startMin,
    b.durationMin,
    b.clockMode,
    b.clockMode === "clock" ? (b.clockId ?? null) : null,
    b.blockId ?? null,
    b.blockId ? null : (b.categoryId ?? null),
    b.title || null,
    b.description || null,
    b.inEpg ? 1 : 0,
  ];
  app.post("/api/week/slots", async (req) => {
    requireRole(req, "editor");
    const b = slotBase.extend({ channelId: z.number().int(), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).parse(req.body);
    if (b.clockMode === "clock" && !b.clockId) throw new HttpError(400, "clock_required");
    planner.channel(b.channelId);
    const weekdays = [...new Set(b.weekdays)];
    const ids = tx(db, () =>
      weekdays.map((weekday) => {
        checkSlot(b.channelId, { weekday, startMin: b.startMin, durationMin: b.durationMin });
        const r = db
          .prepare("INSERT INTO week_slots (channel_id, weekday, start_min, duration_min, clock_mode, clock_id, block_id, category_id, title, description, in_epg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(b.channelId, weekday, ...slotValues(b));
        return Number(r.lastInsertRowid);
      }),
    );
    republish(b.channelId);
    return { ids };
  });
  app.put("/api/week/slots/:id", async (req) => {
    requireRole(req, "editor");
    const s = planner.slot(pid(req));
    const b = slotBase.extend({ weekday: z.number().int().min(0).max(6) }).parse(req.body);
    if (b.clockMode === "clock" && !b.clockId) throw new HttpError(400, "clock_required");
    checkSlot(s.channel_id, { id: s.id, weekday: b.weekday, startMin: b.startMin, durationMin: b.durationMin });
    db.prepare("UPDATE week_slots SET weekday = ?, start_min = ?, duration_min = ?, clock_mode = ?, clock_id = ?, block_id = ?, category_id = ?, title = ?, description = ?, in_epg = ? WHERE id = ?").run(b.weekday, ...slotValues(b), s.id);
    // Rundowns already made stay with the slot; dates that no longer match its weekday are dropped.
    for (const f of db.prepare("SELECT id, date, block_id FROM week_fills WHERE slot_id = ?").all(s.id) as { id: number; date: string; block_id: number }[]) if (weekdayOf(f.date) !== b.weekday) db.prepare("DELETE FROM blocks WHERE id = ?").run(f.block_id);
    republish(s.channel_id);
    return { ok: true };
  });
  app.delete("/api/week/slots/:id", async (req) => {
    requireRole(req, "editor");
    const s = planner.slot(pid(req));
    tx(db, () => {
      db.prepare("DELETE FROM blocks WHERE hidden = 1 AND id IN (SELECT block_id FROM week_fills WHERE slot_id = ?)").run(s.id);
      db.prepare("DELETE FROM week_slots WHERE id = ?").run(s.id);
    });
    republish(s.channel_id);
    return { ok: true };
  });
  // ---- series: the same slot on several weekdays, edited as one ("runs on Mon, Wed, Fri") ------------
  const seriesRows = (s: SlotRow) => {
    const key = seriesKey(slotOut(s));
    return planner.slots(s.channel_id).filter((o) => seriesKey(slotOut(o)) === key);
  };
  const dropFills = (slotId: number) => db.prepare("DELETE FROM blocks WHERE hidden = 1 AND id IN (SELECT block_id FROM week_fills WHERE slot_id = ?)").run(slotId);
  app.get("/api/week/slots/:id/series", async (req) => {
    const rows = seriesRows(planner.slot(pid(req)));
    return { slots: rows.map((r) => ({ id: r.id, weekday: r.weekday })) };
  });
  /**
   * Changes a whole series: every day gets the new settings, days no longer chosen are removed (with their rundowns),
   * new days are added. Rundowns of days that stay are kept.
   */
  app.put("/api/week/slots/:id/series", async (req) => {
    requireRole(req, "editor");
    const s = planner.slot(pid(req));
    const b = slotBase.extend({ weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).parse(req.body);
    if (b.clockMode === "clock" && !b.clockId) throw new HttpError(400, "clock_required");
    const current = seriesRows(s);
    const ids = current.map((c) => c.id);
    const ch = seriesChanges(current, b.weekdays);
    const days = [...ch.keep.map((k) => k.weekday), ...ch.add];
    const out = tx(db, () => {
      for (const r of ch.remove) {
        dropFills(r.id);
        db.prepare("DELETE FROM week_slots WHERE id = ?").run(r.id);
      }
      for (const wd of days) {
        const t = { weekday: wd, startMin: b.startMin, durationMin: b.durationMin };
        checkSlot(s.channel_id, t, ids);
        // Days of the series must not run into each other (a slot longer than the gap to the next day).
        const clash = days.find((o) => o !== wd && overlaps({ weekday: o, startMin: b.startMin, durationMin: b.durationMin }, t));
        if (clash != null) throw new HttpError(409, "slot_overlap", `${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][clash]} ${String(Math.floor(b.startMin / 60)).padStart(2, "0")}:${String(b.startMin % 60).padStart(2, "0")}`);
      }
      const kept = ch.keep.map((k) => {
        db.prepare("UPDATE week_slots SET start_min = ?, duration_min = ?, clock_mode = ?, clock_id = ?, block_id = ?, category_id = ?, title = ?, description = ?, in_epg = ? WHERE id = ?").run(...slotValues(b), k.id);
        return k.id;
      });
      const added = ch.add.map((weekday) => {
        const r = db
          .prepare("INSERT INTO week_slots (channel_id, weekday, start_min, duration_min, clock_mode, clock_id, block_id, category_id, title, description, in_epg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(s.channel_id, weekday, ...slotValues(b));
        return Number(r.lastInsertRowid);
      });
      return { ids: [...kept, ...added], added: added.length, removed: ch.remove.length };
    });
    republish(s.channel_id);
    return out;
  });
  app.delete("/api/week/slots/:id/series", async (req) => {
    requireRole(req, "editor");
    const s = planner.slot(pid(req));
    const rows = seriesRows(s);
    tx(db, () => {
      for (const r of rows) {
        dropFills(r.id);
        db.prepare("DELETE FROM week_slots WHERE id = ?").run(r.id);
      }
    });
    republish(s.channel_id);
    return { removed: rows.length };
  });
  /** Copies the slots of one weekday to other weekdays. */
  app.post("/api/week/copy-day", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ channelId: z.number().int(), from: z.number().int().min(0).max(6), to: z.array(z.number().int().min(0).max(6)).min(1).max(6), replace: z.boolean().default(false) }).parse(req.body);
    const src = planner.slots(b.channelId).filter((s) => s.weekday === b.from);
    let copied = 0;
    tx(db, () => {
      for (const wd of b.to.filter((d) => d !== b.from)) {
        if (b.replace) {
          db.prepare("DELETE FROM blocks WHERE hidden = 1 AND id IN (SELECT f.block_id FROM week_fills f JOIN week_slots s ON s.id = f.slot_id WHERE s.channel_id = ? AND s.weekday = ?)").run(b.channelId, wd);
          db.prepare("DELETE FROM week_slots WHERE channel_id = ? AND weekday = ?").run(b.channelId, wd);
        }
        for (const s of src) {
          checkSlot(b.channelId, { weekday: wd, startMin: s.start_min, durationMin: s.duration_min });
          db.prepare("INSERT INTO week_slots (channel_id, weekday, start_min, duration_min, clock_mode, clock_id, block_id, category_id, title, description, in_epg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            b.channelId,
            wd,
            s.start_min,
            s.duration_min,
            s.clock_mode,
            s.clock_id,
            s.block_id,
            s.category_id,
            s.title,
            s.description,
            s.in_epg,
          );
          copied++;
        }
      }
    });
    republish(b.channelId);
    return { copied };
  });
  app.post("/api/week/publish", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ channelId: z.number().int() }).parse(req.body);
    return planner.publish(b.channelId);
  });

  // ---- occurrences: the editor's work list -----------------------------------------------------
  const occSummary = (occ: Occurrence, loader: Loader) => {
    const p = planner.plan(occ, loader, false);
    return {
      key: occ.key,
      slotId: occ.slot.id,
      date: occ.date,
      startAt: new Date(occ.start).toISOString(),
      endAt: new Date(occ.end).toISOString(),
      title: p.title,
      categoryId: occ.slot.category_id,
      blockId: occ.slot.block_id,
      clockId: occ.clockId,
      state: p.content.state,
      ready: !!p.content.fill?.ready,
      updatedBy: p.content.fill?.mode === "manual" ? p.content.fill.updated_by : null,
      updatedAt: p.content.fill?.updated_at ?? null,
      capacityMs: p.capacityMs,
      filledMs: p.filledMs,
      overflowMs: p.overflowMs,
      overflowCount: p.overflowCount,
      tooLong: p.tooLong,
      warnings: p.warnings,
      itemCount: p.leaves.length,
    };
  };
  app.get("/api/week/occurrences", async (req) => {
    const q = z.object({ channel: z.coerce.number().int(), from: DATE, days: z.coerce.number().int().min(1).max(31).default(7) }).parse(req.query);
    const loader = dbLoader(db);
    return { timezone: planner.timezone(), occurrences: planner.occurrences(q.channel, q.from, q.days, loader).map((o) => occSummary(o, loader)) };
  });

  const getOcc = (req: { params: unknown }) => {
    const { id, date } = z.object({ id: z.coerce.number().int(), date: DATE }).parse(req.params);
    const slot = planner.slot(id);
    if (weekdayOf(date) !== slot.weekday) throw new HttpError(400, "wrong_weekday");
    return planner.occurrence(slot, date, planner.channel(slot.channel_id));
  };
  app.get("/api/week/occurrences/:id/:date", async (req) => {
    const occ = getOcc(req);
    const loader = dbLoader(db);
    const p = planner.plan(occ, loader, false);
    // Timeline per hour: fixed parts and windows with the items placed in them.
    const parts = [
      ...p.fixed.map((f) => ({ type: "fixed" as const, start: f.start, end: f.end, title: f.title || loader.block(f.blockId)?.name || "", blockId: f.blockId, items: [] as { index: number; title: string; start: number; durationMs: number; warning?: string }[] })),
      ...p.windows.map((w, wi) => {
        const pl = p.placements[wi]!;
        let cursor = w.start;
        const items = p.leaves.slice(pl.skip, pl.skip + pl.take).map((l, k) => {
          const it = { index: pl.skip + k, title: l.title, start: cursor, durationMs: l.durationMs, warning: l.warning };
          cursor += l.durationMs;
          return it;
        });
        return { type: "window" as const, start: w.start, end: w.end, title: "", blockId: null, items, usedMs: pl.usedMs, tooLong: pl.tooLong };
      }),
    ].sort((a, b) => a.start - b.start);
    const used = p.placements.reduce((s, x) => s + x.take, 0);
    const items =
      p.content.blockId != null && p.content.state !== "block"
        ? (db
            .prepare(
              `SELECT i.type, i.media_id AS mediaId, i.child_block_id AS childBlockId, i.live_source_id AS liveSourceId, i.beeldkrant_id AS beeldkrantId, i.duration_ms AS durationMs, i.title,
                      m.name AS mediaName, m.title AS mediaTitle, m.path AS mediaPath, m.duration_ms AS mediaDurationMs, m.missing AS mediaMissing,
                      cb.name AS childName, ls.name AS liveName, bk.name AS beeldkrantName
                 FROM block_items i LEFT JOIN media m ON m.id = i.media_id LEFT JOIN blocks cb ON cb.id = i.child_block_id LEFT JOIN live_sources ls ON ls.id = i.live_source_id LEFT JOIN beeldkranten bk ON bk.id = i.beeldkrant_id
                WHERE i.block_id = ? ORDER BY i.position, i.id`,
            )
            .all(p.content.blockId) as Record<string, unknown>[])
        : [];
    return {
      occurrence: occSummary(occ, loader),
      slot: slotOut(occ.slot),
      layout: occ.layout,
      parts: parts.map((x) => ({ ...x, startAt: new Date(x.start).toISOString(), endAt: new Date(x.end).toISOString(), items: x.items.map((i) => ({ ...i, startAt: new Date(i.start).toISOString() })) })),
      overflow: occ.layout ? p.leaves.slice(used).map((l) => ({ title: l.title, durationMs: l.durationMs })) : [],
      items: items.map((i) => ({
        ...i,
        mediaMissing: !!i.mediaMissing,
        effectiveDurationMs: i.type === "block" && i.childBlockId ? safeDuration(loader, Number(i.childBlockId)) : ((i.durationMs as number | null) ?? (i.mediaDurationMs as number | null) ?? (i.type === "live" ? 30 * 60_000 : i.type === "beeldkrant" && i.beeldkrantId ? (loader.beeldkrant?.(Number(i.beeldkrantId))?.durationMs ?? null) : null)),
      })),
      windowsMs: p.windows.map((w) => w.end - w.start),
    };
  });
  app.put("/api/week/occurrences/:id/:date", async (req) => {
    requireRole(req, "editor");
    const occ = getOcc(req);
    const b = z.object({ items: z.array(fillItemIn).max(500), ready: z.boolean().default(false) }).parse(req.body);
    planner.saveFill(occ, b.items, b.ready, req.user!.username);
    republish(occ.slot.channel_id);
    return { ok: true };
  });
  /** Drop media or blocks into the rundown of one date. */
  app.post("/api/week/occurrences/:id/:date/append", async (req) => {
    requireRole(req, "editor");
    const occ = getOcc(req);
    const b = z.object({ items: z.array(fillItemIn).min(1).max(500), at: z.number().int().min(0).optional() }).parse(req.body);
    const r = planner.appendFill(occ, b.items, req.user!.username, b.at);
    republish(occ.slot.channel_id);
    return { ok: true, ...r };
  });
  /** Back to the slot's own content: the fixed block, or an automatic pick from the category. */
  app.delete("/api/week/occurrences/:id/:date", async (req) => {
    requireRole(req, "editor");
    const occ = getOcc(req);
    planner.resetFill(occ);
    republish(occ.slot.channel_id);
    return { ok: true };
  });
  /** A new automatic pick from the category (replaces what is there). */
  app.post("/api/week/occurrences/:id/:date/suggest", async (req) => {
    requireRole(req, "editor");
    const occ = getOcc(req);
    if (occ.slot.category_id == null) throw new HttpError(400, "no_category");
    planner.resetFill(occ);
    planner.autoFill(occ, true);
    republish(occ.slot.channel_id);
    return { ok: true };
  });
}
