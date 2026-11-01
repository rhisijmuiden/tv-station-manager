import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BlockCycleError, compile, expandBlock, type BlockRef, type Loader, type ScheduleEntry } from "./timeline.js";
import type { Db } from "@tvsm/platform";
import { beeldkrantRef } from "./beeldkrantdb.js";

// ---- graphics settings (per channel) ------------------------------------------

const position = z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]);
export const graphicsSchema = z.object({
  enabled: z.boolean().default(true),
  /** CasparCG template name (HTML template shipped with the studio node). */
  template: z.string().max(200).default("tvsm/overlay"),
  layer: z.number().int().min(1).max(999).default(20),
  logo: z.object({ enabled: z.boolean().default(true), position: position.default("top-right"), file: z.string().max(200).nullable().default(null), opacity: z.number().min(0.1).max(1).default(0.9) }).default({ enabled: true, position: "top-right", file: null, opacity: 0.9 }),
  clock: z.object({ enabled: z.boolean().default(true), position: position.default("top-left") }).default({ enabled: true, position: "top-left" }),
  upNext: z.object({ enabled: z.boolean().default(true), secondsBeforeEnd: z.number().int().min(5).max(600).default(60), durationSeconds: z.number().int().min(3).max(120).default(12) }).default({ enabled: true, secondsBeforeEnd: 60, durationSeconds: 12 }),
  ticker: z.object({ enabled: z.boolean().default(false), text: z.string().max(2000).default("") }).default({ enabled: false, text: "" }),
  /** Subtitles from a .srt/.vtt file next to the clip on the media share. */
  subtitles: z.object({ enabled: z.boolean().default(true), size: z.enum(["small", "medium", "large"]).default("medium") }).default({ enabled: true, size: "medium" }),
  /** No logo, clock or ticker during commercial breaks. */
  hideInCommercials: z.boolean().default(true),
});
export type Graphics = z.infer<typeof graphicsSchema>;

export interface ChannelRow {
  id: number;
  name: string;
  color: string;
  enabled: number;
  automation: number;
  atem_id: number | null;
  atem_me: number;
  transition: "cut" | "mix";
  studio_id: number | null;
  caspar_channel: number;
  playout_input: number | null;
  fallback_input: number | null;
  filler_media_id: number | null;
  graphics: string;
  clock_id: number | null;
  week_enabled: number;
}
export const channelOut = (r: ChannelRow) => ({
  id: r.id,
  name: r.name,
  color: r.color,
  enabled: !!r.enabled,
  automation: !!r.automation,
  atemId: r.atem_id,
  atemMe: r.atem_me,
  transition: r.transition,
  studioId: r.studio_id,
  casparChannel: r.caspar_channel,
  playoutInput: r.playout_input,
  fallbackInput: r.fallback_input,
  fillerMediaId: r.filler_media_id,
  graphics: graphicsSchema.parse(JSON.parse(r.graphics || "{}")),
  clockId: r.clock_id ?? null,
  weekEnabled: !!r.week_enabled,
});

// ---- loader over the database -------------------------------------------------

export function dbLoader(db: Db): Loader {
  const blocks = new Map<number, BlockRef | undefined>();
  const bk = new Map<number, ReturnType<NonNullable<Loader["beeldkrant"]>>>();
  return {
    block(id) {
      if (!blocks.has(id)) {
        const b = db.prepare("SELECT id, name, kind FROM blocks WHERE id = ?").get(id) as { id: number; name: string; kind: "program" | "commercial" } | undefined;
        blocks.set(
          id,
          b && {
            ...b,
            items: db
              .prepare("SELECT type, media_id AS mediaId, child_block_id AS childBlockId, live_source_id AS liveSourceId, beeldkrant_id AS beeldkrantId, duration_ms AS durationMs, title FROM block_items WHERE block_id = ? ORDER BY position, id")
              .all(id) as unknown as BlockRef["items"],
          },
        );
      }
      return blocks.get(id);
    },
    media(id) {
      const m = db.prepare("SELECT id, name, title, path, duration_ms AS durationMs, fps, category, missing FROM media WHERE id = ?").get(id) as (Record<string, unknown> & { missing: number }) | undefined;
      return m ? ({ ...m, missing: !!m.missing } as ReturnType<Loader["media"]>) : undefined;
    },
    live(id) {
      return db.prepare("SELECT id, name, kind FROM live_sources WHERE id = ?").get(id) as ReturnType<Loader["live"]>;
    },
    beeldkrant(id) {
      if (!bk.has(id)) bk.set(id, beeldkrantRef(db, id));
      return bk.get(id);
    },
  };
}

export const scheduleEntries = (db: Db, channelId: number, from: number, to: number): ScheduleEntry[] =>
  (
    db
      .prepare(
        // One entry before the window too: it may still be on air.
        `SELECT * FROM (SELECT * FROM schedule WHERE channel_id = ? AND start_at < ? ORDER BY start_at DESC LIMIT 1)
         UNION SELECT * FROM schedule WHERE channel_id = ? AND start_at >= ? AND start_at < ?
         UNION SELECT * FROM (SELECT * FROM schedule WHERE channel_id = ? AND start_at >= ? ORDER BY start_at LIMIT 1)`,
      )
      .all(channelId, new Date(from).toISOString(), channelId, new Date(from).toISOString(), new Date(to).toISOString(), channelId, new Date(to).toISOString()) as Record<string, unknown>[]
  ).map((r) => ({
    id: Number(r.id),
    channelId: Number(r.channel_id),
    start: Date.parse(String(r.start_at)),
    blockId: Number(r.block_id),
    title: (r.title as string) || null,
    description: (r.description as string) || null,
    inEpg: !!r.in_epg,
    skip: Number(r.skip_items ?? 0),
    take: r.take_items == null ? null : Number(r.take_items),
    group: (r.occurrence as string) || null,
  }));

export function registerContent(app: FastifyInstance, platform: Platform, onChange: () => void) {
  const { db } = platform.ctx;
  const pid = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  // ---- channels ---------------------------------------------------------------
  const channelIn = z.object({
    name: z.string().trim().min(1).max(80),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3B6CFF"),
    enabled: z.boolean().default(true),
    atemId: z.number().int().nullable(),
    atemMe: z.number().int().min(0).max(7).default(0),
    transition: z.enum(["cut", "mix"]).default("cut"),
    studioId: z.number().int().nullable(),
    casparChannel: z.number().int().min(1).max(16).default(1),
    playoutInput: z.number().int().min(0).max(65535).nullable(),
    fallbackInput: z.number().int().min(0).max(65535).nullable().optional(),
    fillerMediaId: z.number().int().nullable().optional(),
  });
  const getChannel = (id: number) => {
    const r = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
    if (!r) throw new HttpError(404, "not_found");
    return r;
  };
  app.get("/api/channels", async () => ({ channels: (db.prepare("SELECT * FROM channels ORDER BY id").all() as unknown as ChannelRow[]).map(channelOut) }));
  app.post("/api/channels", async (req) => {
    requireRole(req, "admin");
    const b = channelIn.parse(req.body);
    const r = db
      .prepare("INSERT INTO channels (name, color, enabled, atem_id, atem_me, transition, studio_id, caspar_channel, playout_input, fallback_input, filler_media_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(b.name, b.color, b.enabled ? 1 : 0, b.atemId, b.atemMe, b.transition, b.studioId, b.casparChannel, b.playoutInput, b.fallbackInput ?? null, b.fillerMediaId ?? null);
    onChange();
    return channelOut(getChannel(Number(r.lastInsertRowid)));
  });
  app.put("/api/channels/:id", async (req) => {
    requireRole(req, "admin");
    const c = getChannel(pid(req));
    const b = channelIn.parse(req.body);
    db.prepare("UPDATE channels SET name = ?, color = ?, enabled = ?, atem_id = ?, atem_me = ?, transition = ?, studio_id = ?, caspar_channel = ?, playout_input = ?, fallback_input = ?, filler_media_id = ? WHERE id = ?").run(
      b.name,
      b.color,
      b.enabled ? 1 : 0,
      b.atemId,
      b.atemMe,
      b.transition,
      b.studioId,
      b.casparChannel,
      b.playoutInput,
      b.fallbackInput ?? null,
      b.fillerMediaId ?? null,
      c.id,
    );
    onChange();
    return channelOut(getChannel(c.id));
  });
  app.delete("/api/channels/:id", async (req) => {
    requireRole(req, "admin");
    db.prepare("DELETE FROM channels WHERE id = ?").run(pid(req));
    onChange();
    return { ok: true };
  });
  app.put("/api/channels/:id/graphics", async (req) => {
    requireRole(req, "editor");
    const c = getChannel(pid(req));
    const g = graphicsSchema.parse(req.body);
    db.prepare("UPDATE channels SET graphics = ? WHERE id = ?").run(JSON.stringify(g), c.id);
    onChange();
    return channelOut(getChannel(c.id));
  });

  // ---- blocks -------------------------------------------------------------------
  const itemIn = z.object({
    type: z.enum(["media", "block", "live", "beeldkrant"]),
    mediaId: z.number().int().nullable().optional(),
    childBlockId: z.number().int().nullable().optional(),
    liveSourceId: z.number().int().nullable().optional(),
    beeldkrantId: z.number().int().nullable().optional(),
    durationMs: z.number().int().min(0).max(24 * 3600_000).nullable().optional(),
    title: z.string().max(200).nullable().optional(),
  });
  const blockIn = z.object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["program", "commercial"]).default("program"),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3B6CFF"),
    description: z.string().max(4000).default(""),
    genre: z.string().max(80).default(""),
    categoryId: z.number().int().nullable().optional(),
    items: z.array(itemIn).max(2000).default([]),
  });

  const blockSummary = (loader: Loader, b: Record<string, unknown>) => {
    let durationMs = 0;
    let warnings = 0;
    let cycle = false;
    try {
      const leaves = expandBlock(loader, Number(b.id));
      durationMs = leaves.reduce((s, l) => s + l.durationMs, 0);
      warnings = leaves.filter((l) => l.warning).length;
    } catch (e) {
      cycle = e instanceof BlockCycleError;
    }
    const itemCount = (db.prepare("SELECT COUNT(*) AS n FROM block_items WHERE block_id = ?").get(Number(b.id)) as { n: number }).n;
    return { id: b.id, name: b.name, kind: b.kind, color: b.color, description: b.description, genre: b.genre, categoryId: b.category_id ?? null, updatedAt: b.updated_at, itemCount, durationMs, warnings, cycle };
  };

  app.get("/api/blocks", async (req) => {
    const { kind } = z.object({ kind: z.enum(["program", "commercial"]).optional() }).parse(req.query);
    const loader = dbLoader(db);
    const rows = db.prepare(`SELECT * FROM blocks WHERE hidden = 0 ${kind ? "AND kind = ?" : ""} ORDER BY name COLLATE NOCASE`).all(...(kind ? [kind] : [])) as Record<string, unknown>[];
    return { blocks: rows.map((b) => blockSummary(loader, b)) };
  });

  app.get("/api/blocks/:id", async (req) => {
    const b = db.prepare("SELECT * FROM blocks WHERE id = ?").get(pid(req)) as Record<string, unknown> | undefined;
    if (!b) throw new HttpError(404, "not_found");
    const loader = dbLoader(db);
    const items = (
      db
        .prepare(
          `SELECT i.id, i.type, i.media_id AS mediaId, i.child_block_id AS childBlockId, i.live_source_id AS liveSourceId, i.beeldkrant_id AS beeldkrantId, i.duration_ms AS durationMs, i.title,
                  m.name AS mediaName, m.title AS mediaTitle, m.path AS mediaPath, m.duration_ms AS mediaDurationMs, m.category AS mediaCategory, m.missing AS mediaMissing,
                  cb.name AS childName, cb.kind AS childKind, ls.name AS liveName, ls.kind AS liveKind, bk.name AS beeldkrantName
             FROM block_items i
             LEFT JOIN media m ON m.id = i.media_id
             LEFT JOIN blocks cb ON cb.id = i.child_block_id
             LEFT JOIN live_sources ls ON ls.id = i.live_source_id
             LEFT JOIN beeldkranten bk ON bk.id = i.beeldkrant_id
            WHERE i.block_id = ? ORDER BY i.position, i.id`,
        )
        .all(Number(b.id)) as Record<string, unknown>[]
    ).map((i) => {
      let effective = (i.durationMs as number | null) ?? (i.mediaDurationMs as number | null);
      if (i.type === "block" && i.childBlockId) {
        try {
          effective = expandBlock(loader, Number(i.childBlockId)).reduce((s, l) => s + l.durationMs, 0);
        } catch {
          effective = null;
        }
      }
      if (i.type === "live") effective = (i.durationMs as number | null) ?? 30 * 60_000;
      if (i.type === "beeldkrant") effective = (i.durationMs as number | null) ?? (i.beeldkrantId ? (loader.beeldkrant?.(Number(i.beeldkrantId))?.durationMs ?? null) : null);
      return { ...i, mediaMissing: !!i.mediaMissing, effectiveDurationMs: effective };
    });
    return { block: blockSummary(loader, b), items };
  });

  const saveItems = (blockId: number, items: z.infer<typeof itemIn>[]) => {
    db.prepare("DELETE FROM block_items WHERE block_id = ?").run(blockId);
    const ins = db.prepare("INSERT INTO block_items (block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, duration_ms, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    items.forEach((it, i) => {
      if (it.type === "media" && !it.mediaId) throw new HttpError(400, "media_required");
      if (it.type === "block" && !it.childBlockId) throw new HttpError(400, "block_required");
      if (it.type === "live" && !it.liveSourceId) throw new HttpError(400, "live_source_required");
      if (it.type === "beeldkrant" && !it.beeldkrantId) throw new HttpError(400, "beeldkrant_required");
      ins.run(blockId, i, it.type, it.type === "media" ? it.mediaId! : null, it.type === "block" ? it.childBlockId! : null, it.type === "live" ? it.liveSourceId! : null, it.type === "beeldkrant" ? it.beeldkrantId! : null, it.durationMs ?? null, it.title || null);
    });
    // Reject blocks that contain themselves (directly or through other blocks).
    try {
      expandBlock(dbLoader(db), blockId);
    } catch (e) {
      if (e instanceof BlockCycleError) throw new HttpError(400, "block_cycle");
      throw e;
    }
  };
  const tx = <T>(fn: () => T): T => {
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

  app.post("/api/blocks", async (req) => {
    requireRole(req, "editor");
    const b = blockIn.parse(req.body);
    const id = tx(() => {
      const r = db.prepare("INSERT INTO blocks (name, kind, color, description, genre, category_id) VALUES (?, ?, ?, ?, ?, ?)").run(b.name, b.kind, b.color, b.description, b.genre, b.categoryId ?? null);
      const id = Number(r.lastInsertRowid);
      saveItems(id, b.items);
      return id;
    });
    onChange();
    return { id };
  });
  /**
   * A block for media dropped where only blocks fit (an hour clock, an empty spot in the week).
   * One clip reuses an existing visible block that holds just that clip; otherwise a new block is made.
   */
  app.post("/api/blocks/from-media", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ mediaIds: z.array(z.number().int()).min(1).max(200), kind: z.enum(["program", "commercial"]).optional() }).parse(req.body);
    const media = b.mediaIds.map((id) => {
      const m = db.prepare("SELECT id, name, title, category, category_id FROM media WHERE id = ?").get(id) as { id: number; name: string; title: string | null; category: string; category_id: number | null } | undefined;
      if (!m) throw new HttpError(404, "media_not_found");
      return m;
    });
    const kind = b.kind ?? (media.every((m) => m.category === "commercial") ? "commercial" : "program");
    if (media.length === 1) {
      const existing = db
        .prepare(
          `SELECT b.id FROM blocks b
            WHERE b.hidden = 0 AND b.kind = ?
              AND (SELECT COUNT(*) FROM block_items i WHERE i.block_id = b.id) = 1
              AND EXISTS (SELECT 1 FROM block_items i WHERE i.block_id = b.id AND i.type = 'media' AND i.media_id = ? AND i.duration_ms IS NULL)
            ORDER BY b.id LIMIT 1`,
        )
        .get(kind, media[0]!.id) as { id: number } | undefined;
      if (existing) return { id: existing.id, created: false };
    }
    const label = (m: (typeof media)[number]) => m.title || m.name.replace(/\.[^.]+$/, "");
    const name = (media.length === 1 ? label(media[0]!) : `${label(media[0]!)} +${media.length - 1}`).slice(0, 120);
    const categoryId = media.every((m) => m.category_id === media[0]!.category_id) ? media[0]!.category_id : null;
    const cat = categoryId != null ? (db.prepare("SELECT color FROM categories WHERE id = ?").get(categoryId) as { color: string } | undefined) : undefined;
    const color = cat?.color ?? (kind === "commercial" ? "#F5A524" : "#3B6CFF");
    const id = tx(() => {
      const r = db.prepare("INSERT INTO blocks (name, kind, color, description, genre, category_id) VALUES (?, ?, ?, '', '', ?)").run(name, kind, color, categoryId);
      const id = Number(r.lastInsertRowid);
      saveItems(id, media.map((m) => ({ type: "media" as const, mediaId: m.id })));
      return id;
    });
    onChange();
    return { id, created: true };
  });
  app.put("/api/blocks/:id", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const b = blockIn.parse(req.body);
    tx(() => {
      const r = db
        .prepare("UPDATE blocks SET name = ?, kind = ?, color = ?, description = ?, genre = ?, category_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .run(b.name, b.kind, b.color, b.description, b.genre, b.categoryId ?? null, id);
      if (!r.changes) throw new HttpError(404, "not_found");
      saveItems(id, b.items);
    });
    onChange();
    return { id };
  });
  app.post("/api/blocks/:id/duplicate", async (req) => {
    requireRole(req, "editor");
    const src = db.prepare("SELECT * FROM blocks WHERE id = ?").get(pid(req)) as Record<string, string> | undefined;
    if (!src) throw new HttpError(404, "not_found");
    const id = tx(() => {
      const r = db.prepare("INSERT INTO blocks (name, kind, color, description, genre, category_id) VALUES (?, ?, ?, ?, ?, ?)").run(`${src.name} (copy)`, src.kind!, src.color!, src.description!, src.genre!, (src.category_id as unknown as number) ?? null);
      const id = Number(r.lastInsertRowid);
      db.prepare("INSERT INTO block_items (block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, duration_ms, title) SELECT ?, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, duration_ms, title FROM block_items WHERE block_id = ?").run(id, src.id!);
      return id;
    });
    return { id };
  });
  app.delete("/api/blocks/:id", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const used = (db.prepare("SELECT COUNT(*) AS n FROM schedule WHERE block_id = ? AND start_at > ?").get(id, new Date().toISOString()) as { n: number }).n;
    const { force } = z.object({ force: z.coerce.boolean().optional() }).parse(req.query);
    if (used && !force) throw new HttpError(409, "block_in_use", String(used));
    db.prepare("DELETE FROM blocks WHERE id = ?").run(id);
    onChange();
    return { ok: true };
  });

  // ---- schedule -------------------------------------------------------------------
  const entryIn = z.object({
    channelId: z.number().int(),
    startAt: z.iso.datetime({ offset: true }),
    blockId: z.number().int(),
    title: z.string().max(200).nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
    inEpg: z.boolean().default(true),
  });

  app.get("/api/schedule", async (req) => {
    const q = z.object({ channel: z.coerce.number().int(), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).parse(req.query);
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    if (to <= from || to - from > 31 * 86400_000) throw new HttpError(400, "invalid_range");
    const loader = dbLoader(db);
    const entries = scheduleEntries(db, q.channel, from, to);
    const { entries: compiled } = compile(loader, entries, from, to);
    const blocks = new Map((db.prepare("SELECT b.id, b.name, b.kind, b.color, COALESCE(c.name, b.genre) AS genre, b.hidden FROM blocks b LEFT JOIN categories c ON c.id = b.category_id").all() as { id: number }[]).map((b) => [b.id, b]));
    const origins = new Map((db.prepare("SELECT id, origin, week_slot_id FROM schedule WHERE channel_id = ? AND start_at < ? AND start_at >= ?").all(q.channel, new Date(to).toISOString(), new Date(from - 86400_000).toISOString()) as { id: number; origin: string; week_slot_id: number | null }[]).map((r) => [r.id, r]));
    return {
      entries: compiled
        .filter((e) => e.end > from && e.start < to)
        .map((e) => ({
          id: e.id,
          startAt: new Date(e.start).toISOString(),
          endAt: new Date(e.end).toISOString(),
          contentEndAt: new Date(e.contentEnd).toISOString(),
          blockId: e.blockId,
          block: blocks.get(e.blockId) ?? null,
          title: e.title,
          programTitle: e.programTitle,
          description: e.description,
          inEpg: e.inEpg,
          overrunMs: e.overrunMs,
          gapAfterMs: e.gapAfterMs,
          warnings: e.warnings,
          origin: origins.get(e.id)?.origin ?? "manual",
          weekSlotId: origins.get(e.id)?.week_slot_id ?? null,
          occurrence: e.group ?? null,
        })),
    };
  });

  app.post("/api/schedule", async (req) => {
    requireRole(req, "editor");
    const b = entryIn.parse(req.body);
    const r = db
      .prepare("INSERT INTO schedule (channel_id, start_at, block_id, title, description, in_epg, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(b.channelId, new Date(b.startAt).toISOString(), b.blockId, b.title || null, b.description || null, b.inEpg ? 1 : 0, req.user!.username);
    onChange();
    return { id: Number(r.lastInsertRowid) };
  });
  /** Entries generated from the week schedule are changed there (they would come back on the next publish). */
  const notFromWeek = (id: number) => {
    const r = db.prepare("SELECT origin FROM schedule WHERE id = ?").get(id) as { origin: string } | undefined;
    if (r?.origin === "week") throw new HttpError(409, "week_entry");
  };
  app.put("/api/schedule/:id", async (req) => {
    requireRole(req, "editor");
    notFromWeek(pid(req));
    const b = entryIn.parse(req.body);
    const r = db
      .prepare("UPDATE schedule SET channel_id = ?, start_at = ?, block_id = ?, title = ?, description = ?, in_epg = ? WHERE id = ?")
      .run(b.channelId, new Date(b.startAt).toISOString(), b.blockId, b.title || null, b.description || null, b.inEpg ? 1 : 0, pid(req));
    if (!r.changes) throw new HttpError(404, "not_found");
    onChange();
    return { ok: true };
  });
  app.delete("/api/schedule/:id", async (req) => {
    requireRole(req, "editor");
    notFromWeek(pid(req));
    db.prepare("DELETE FROM schedule WHERE id = ?").run(pid(req));
    onChange();
    return { ok: true };
  });

  /** Places entries back to back: each starts when the previous one ends (from `from`). */
  app.post("/api/schedule/append", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ channelId: z.number().int(), blockIds: z.array(z.number().int()).min(1).max(200), startAt: z.iso.datetime({ offset: true }).optional() }).parse(req.body);
    const loader = dbLoader(db);
    let cursor: number;
    if (b.startAt) cursor = Date.parse(b.startAt);
    else {
      const last = db.prepare("SELECT start_at, block_id FROM schedule WHERE channel_id = ? ORDER BY start_at DESC LIMIT 1").get(b.channelId) as { start_at: string; block_id: number } | undefined;
      cursor = last ? Date.parse(last.start_at) + expandBlock(loader, last.block_id).reduce((s, l) => s + l.durationMs, 0) : Math.ceil(Date.now() / 60_000) * 60_000;
    }
    const ids: number[] = [];
    tx(() => {
      for (const blockId of b.blockIds) {
        const r = db.prepare("INSERT INTO schedule (channel_id, start_at, block_id, created_by) VALUES (?, ?, ?, ?)").run(b.channelId, new Date(cursor).toISOString(), blockId, req.user!.username);
        ids.push(Number(r.lastInsertRowid));
        cursor += expandBlock(loader, blockId).reduce((s, l) => s + l.durationMs, 0);
      }
    });
    onChange();
    return { ids, nextStartAt: new Date(cursor).toISOString() };
  });

  /** Copies all entries of one day to other days (same times). */
  app.post("/api/schedule/copy-day", async (req) => {
    requireRole(req, "editor");
    const b = z
      .object({ channelId: z.number().int(), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), targets: z.array(z.iso.datetime({ offset: true })).min(1).max(62), replace: z.boolean().default(false) })
      .parse(req.body);
    const from = Date.parse(b.from);
    const to = Date.parse(b.to);
    const span = to - from;
    if (span <= 0 || span > 86400_000 * 1.1) throw new HttpError(400, "invalid_range");
    const src = db.prepare("SELECT * FROM schedule WHERE channel_id = ? AND origin = 'manual' AND start_at >= ? AND start_at < ?").all(b.channelId, new Date(from).toISOString(), new Date(to).toISOString()) as Record<string, unknown>[];
    let copied = 0;
    tx(() => {
      for (const t of b.targets) {
        const target = Date.parse(t);
        if (b.replace) db.prepare("DELETE FROM schedule WHERE channel_id = ? AND origin = 'manual' AND start_at >= ? AND start_at < ?").run(b.channelId, new Date(target).toISOString(), new Date(target + span).toISOString());
        for (const e of src) {
          const start = target + (Date.parse(String(e.start_at)) - from);
          db.prepare("INSERT INTO schedule (channel_id, start_at, block_id, title, description, in_epg, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            b.channelId,
            new Date(start).toISOString(),
            Number(e.block_id),
            (e.title as string) ?? null,
            (e.description as string) ?? null,
            Number(e.in_epg),
            req.user!.username,
          );
          copied++;
        }
      }
    });
    onChange();
    return { copied };
  });
}
