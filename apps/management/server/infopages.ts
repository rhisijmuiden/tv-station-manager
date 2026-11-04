/**
 * Info pages: fixed full-screen pages made by the editors (contact details, station info), block item type `info`.
 *
 *   /api/infopages            list / create / edit / delete (editors)
 *   /api/infopages/:id/image  upload (data URL) or remove the picture
 *   /api/infopages/preview    the finished page for unsaved settings (the editor's live preview)
 *   /infopage/page.html?id=<id>&channel=<channel id>   public: CasparCG's HTML producer plays this
 *   /infopage/img/<id>        public: the page's picture
 *
 * Like a webcam, every info page gets its own one-item block, so it can be dragged from the library into an hour
 * block, the week or a rundown. Its default length is set on the page (`durationSec`).
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { channelOut, type ChannelRow } from "./content.js";
import { publicUrl } from "./director.js";
import { infoPageHtml, infoPageSchema, type InfoPageSettings } from "./infopagelogic.js";
import { infoPageOf } from "./infopagedb.js";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

const pageIn = z.object({ name: z.string().trim().min(1).max(120), settings: infoPageSchema.prefault({}) });

export function registerInfoPages(app: FastifyInstance, platform: Platform, onChange: () => void) {
  const { db, config } = platform.ctx;
  const dir = join(config.dataDir, "infopages");
  mkdirSync(dir, { recursive: true });
  const graphicsDir = join(config.dataDir, "graphics");
  const BLOCK_COLOR = "#2FA6DF";
  const pid = (req: { params: unknown }) => Number((req.params as { id: string }).id);
  const imageFile = (image: string | null) => (image ? image.split("#")[0]! : null);

  const blockOf = (id: number) =>
    db
      .prepare(
        `SELECT b.id, b.name, b.color FROM blocks b WHERE b.hidden = 0 AND (SELECT COUNT(*) FROM block_items i WHERE i.block_id = b.id) = 1
           AND EXISTS (SELECT 1 FROM block_items i WHERE i.block_id = b.id AND i.type = 'info' AND i.info_page_id = ?) ORDER BY b.id LIMIT 1`,
      )
      .get(id) as { id: number; name: string; color: string } | undefined;
  /** Every info page has its own block (one item), so it can be dragged into an hour block, the week or a rundown. */
  const ensureBlock = (id: number, name: string) => {
    const b = blockOf(id);
    if (b) {
      if (b.name !== name) db.prepare("UPDATE blocks SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(name.slice(0, 120), b.id);
      return b.id;
    }
    const r = db.prepare("INSERT INTO blocks (name, kind, color, description, genre) VALUES (?, 'program', ?, '', 'info')").run(name.slice(0, 120), BLOCK_COLOR);
    const blockId = Number(r.lastInsertRowid);
    db.prepare("INSERT INTO block_items (block_id, position, type, info_page_id) VALUES (?, 0, 'info', ?)").run(blockId, id);
    return blockId;
  };

  const out = (id: number) => {
    const p = infoPageOf(db, id);
    if (!p) throw new HttpError(404, "not_found");
    const block = blockOf(id);
    const own = block?.id ?? -1;
    const usedIn = (db.prepare("SELECT COUNT(DISTINCT block_id) AS n FROM block_items WHERE info_page_id = ? AND block_id != ?").get(id, own) as { n: number }).n;
    const planned = block ? (db.prepare("SELECT (SELECT COUNT(*) FROM block_items WHERE child_block_id = ?) + (SELECT COUNT(*) FROM schedule WHERE block_id = ?) AS n").get(own, own) as { n: number }).n : 0;
    return {
      id,
      name: p.name,
      settings: p.settings,
      durationMs: p.settings.durationSec * 1000,
      imageUrl: p.image ? `/infopage/img/${id}?v=${encodeURIComponent(p.image.split("#")[1] ?? "")}` : null,
      usedIn: usedIn + planned,
      updatedAt: p.row.updated_at,
      // In the shape of a block summary, for the library (drag into an hour block / the week / a rundown).
      block: block ? { id: block.id, name: block.name, kind: "program" as const, color: block.color, description: "", genre: "info", categoryId: null, updatedAt: p.row.updated_at, itemCount: 1, durationMs: p.settings.durationSec * 1000, warnings: 0, cycle: false } : null,
    };
  };

  /** The channel whose house style (colours, logo, language) a page is shown in: the given one, else the first. */
  const channelFor = (channelId?: number) =>
    ((channelId ? db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) : undefined) ?? db.prepare("SELECT * FROM channels ORDER BY id LIMIT 1").get()) as ChannelRow | undefined;

  const render = (id: number | null, settings: InfoPageSettings, image: string | null, channelId: number | undefined, opts: { preview?: boolean; absolute?: boolean }) => {
    const ch = channelFor(channelId);
    const lineup = ch ? channelOut(ch).graphics.lineup : undefined;
    const base = opts.absolute ? publicUrl(platform) : "";
    const hasLogo = ch && existsSync(graphicsDir) && readdirSync(graphicsDir).some((f) => f.startsWith(`${ch.id}-logo.`));
    return infoPageHtml({
      settings,
      colors: lineup?.colors ?? { background: "#2A1430", panel: "#713C80", accent: "#E92E7F", text: "#FFFFFF" },
      language: lineup?.language ?? "nl",
      imageUrl: id != null && image ? `${base}/infopage/img/${id}?v=${encodeURIComponent(image.split("#")[1] ?? "")}` : null,
      logoUrl: hasLogo ? `${base}/graphics/${ch!.id}/logo` : null,
      preview: opts.preview,
    });
  };

  app.get("/api/infopages", async () => ({ pages: (db.prepare("SELECT id FROM info_pages ORDER BY name COLLATE NOCASE").all() as { id: number }[]).map((r) => out(r.id)) }));
  app.get("/api/infopages/:id", async (req) => out(pid(req)));

  app.post("/api/infopages", async (req) => {
    requireRole(req, "editor");
    const b = pageIn.parse(req.body);
    db.exec("BEGIN");
    let id: number;
    try {
      id = Number(db.prepare("INSERT INTO info_pages (name, settings) VALUES (?, ?)").run(b.name, JSON.stringify(b.settings)).lastInsertRowid);
      ensureBlock(id, b.name);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    onChange();
    return out(id);
  });
  app.put("/api/infopages/:id", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    if (!infoPageOf(db, id)) throw new HttpError(404, "not_found");
    const b = pageIn.parse(req.body);
    db.prepare("UPDATE info_pages SET name = ?, settings = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(b.name, JSON.stringify(b.settings), id);
    ensureBlock(id, b.name);
    onChange();
    return out(id);
  });
  app.post("/api/infopages/:id/duplicate", async (req) => {
    requireRole(req, "editor");
    const p = infoPageOf(db, pid(req));
    if (!p) throw new HttpError(404, "not_found");
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    db.exec("BEGIN");
    let id: number;
    try {
      id = Number(db.prepare("INSERT INTO info_pages (name, settings) VALUES (?, ?)").run(name, JSON.stringify(p.settings)).lastInsertRowid);
      const file = imageFile(p.image);
      if (file && existsSync(join(dir, file))) {
        const copy = `${id}.${file.split(".").pop()}`;
        writeFileSync(join(dir, copy), readFileSync(join(dir, file)));
        db.prepare("UPDATE info_pages SET image = ? WHERE id = ?").run(`${copy}#${Date.now()}`, id);
      }
      ensureBlock(id, name);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    onChange();
    return out(id);
  });
  app.delete("/api/infopages/:id", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const p = infoPageOf(db, id);
    if (!p) throw new HttpError(404, "not_found");
    const { force } = z.object({ force: z.coerce.boolean().optional() }).parse(req.query);
    const { usedIn } = out(id);
    if (usedIn && !force) throw new HttpError(409, "info_page_in_use", String(usedIn));
    const own = blockOf(id);
    db.exec("BEGIN");
    try {
      if (own) db.prepare("DELETE FROM blocks WHERE id = ?").run(own.id);
      db.prepare("DELETE FROM info_pages WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    const file = imageFile(p.image);
    if (file) rmSync(join(dir, file), { force: true });
    onChange();
    return { ok: true };
  });

  app.post("/api/infopages/:id/image", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const p = infoPageOf(db, id);
    if (!p) throw new HttpError(404, "not_found");
    const { dataUrl } = z.object({ dataUrl: z.string().max(4_800_000) }).parse(req.body);
    const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new HttpError(400, "unsupported_image");
    const ext = m[1] === "jpeg" ? "jpg" : m[1]!;
    const old = imageFile(p.image);
    if (old) rmSync(join(dir, old), { force: true });
    const file = `${id}.${ext}`;
    writeFileSync(join(dir, file), Buffer.from(m[2]!, "base64"));
    db.prepare("UPDATE info_pages SET image = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(`${file}#${Date.now()}`, id);
    onChange();
    return out(id);
  });
  app.delete("/api/infopages/:id/image", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const p = infoPageOf(db, id);
    if (!p) throw new HttpError(404, "not_found");
    const old = imageFile(p.image);
    if (old) rmSync(join(dir, old), { force: true });
    db.prepare("UPDATE info_pages SET image = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
    onChange();
    return out(id);
  });

  // The editor's live preview: the page as it will look, for settings that are not saved yet.
  app.post("/api/infopages/preview", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ id: z.number().int().nullable().optional(), settings: infoPageSchema.prefault({}), channelId: z.number().int().optional() }).parse(req.body);
    const p = b.id ? infoPageOf(db, b.id) : undefined;
    return { html: render(p?.id ?? null, b.settings, p?.image ?? null, b.channelId, { preview: true }) };
  });

  // ---- public (CasparCG on the studio node) ------------------------------------------------
  // The editor shows the page in an iframe (the platform forbids framing by default); CasparCG does not care.
  const frameable = async (_req: unknown, reply: { header: (k: string, v: string) => unknown }) => {
    reply.header("X-Frame-Options", "SAMEORIGIN");
  };
  app.get("/infopage/page.html", { onSend: frameable }, async (req, reply) => {
    const q = z.object({ id: z.coerce.number().int(), channel: z.coerce.number().int().optional(), preview: z.string().optional() }).parse(req.query);
    const p = infoPageOf(db, q.id);
    if (!p) throw new HttpError(404, "not_found");
    // preview=1: scaled to the editor's iframe, with links relative to the browser's address.
    const preview = q.preview === "1";
    reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-cache");
    return render(p.id, p.settings, p.image, q.channel, { absolute: !preview, preview });
  });
  app.get("/infopage/img/:id", async (req, reply) => {
    const p = infoPageOf(db, pid(req));
    const file = imageFile(p?.image ?? null);
    if (!file || !existsSync(join(dir, file))) throw new HttpError(404, "not_found");
    reply.header("Content-Type", MIME[file.split(".").pop()!] ?? "application/octet-stream").header("Cache-Control", "max-age=86400").header("Access-Control-Allow-Origin", "*");
    return readFileSync(join(dir, file));
  });
}
