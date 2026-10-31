import type { Platform } from "@tvsm/platform";
import { HttpError, randomToken, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { dbLoader, scheduleEntries, type ChannelRow } from "./content.js";
import { publicUrl } from "./director.js";
import { compile } from "./timeline.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** XMLTV time: 20261031140000 +0000 */
const xmltvTime = (t: number) => `${new Date(t).toISOString().replace(/[-:T]/g, "").slice(0, 14)} +0000`;

export interface Programme {
  channelId: number;
  start: number;
  end: number;
  title: string;
  description: string | null;
  genre: string | null;
}

export function epgProgrammes(platform: Platform, channels: ChannelRow[], from: number, to: number): Programme[] {
  const { db } = platform.ctx;
  const genres = new Map((db.prepare("SELECT id, genre FROM blocks").all() as { id: number; genre: string }[]).map((b) => [b.id, b.genre || null]));
  const descriptions = new Map((db.prepare("SELECT id, description FROM blocks").all() as { id: number; description: string }[]).map((b) => [b.id, b.description || null]));
  const out: Programme[] = [];
  for (const ch of channels) {
    const { entries } = compile(dbLoader(db), scheduleEntries(db, ch.id, from, to), from, to);
    for (const e of entries) {
      if (!e.inEpg || e.end <= from || e.start >= to || e.end <= e.start) continue;
      out.push({ channelId: ch.id, start: e.start, end: e.end, title: e.programTitle, description: e.description ?? descriptions.get(e.blockId) ?? null, genre: genres.get(e.blockId) ?? null });
    }
  }
  return out.sort((a, b) => a.channelId - b.channelId || a.start - b.start);
}

export function toXmltv(channels: { id: number; name: string }[], programmes: Programme[], lang = "nl") {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE tv SYSTEM "xmltv.dtd">', '<tv generator-info-name="TV Station Manager">'];
  for (const c of channels) lines.push(`  <channel id="tvsm.${c.id}">`, `    <display-name>${esc(c.name)}</display-name>`, "  </channel>");
  for (const p of programmes) {
    lines.push(`  <programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.end)}" channel="tvsm.${p.channelId}">`);
    lines.push(`    <title lang="${lang}">${esc(p.title)}</title>`);
    if (p.description) lines.push(`    <desc lang="${lang}">${esc(p.description)}</desc>`);
    if (p.genre) lines.push(`    <category lang="${lang}">${esc(p.genre)}</category>`);
    lines.push("  </programme>");
  }
  lines.push("</tv>", "");
  return lines.join("\n");
}

export function registerEpgAndGraphics(app: FastifyInstance, platform: Platform, onChange: () => void) {
  const { db, settings, config } = platform.ctx;
  const graphicsDir = join(config.dataDir, "graphics");
  if (!existsSync(graphicsDir)) mkdirSync(graphicsDir, { recursive: true });
  const token = () => {
    let t = settings.get<string>("epg.token", "");
    if (!t) settings.set("epg.token", (t = randomToken(18)));
    return t;
  };
  const channels = () => db.prepare("SELECT * FROM channels WHERE enabled = 1 ORDER BY id").all() as unknown as ChannelRow[];

  // ---- settings shown on the EPG / graphics pages ------------------------------
  app.get("/api/management/settings", async () => ({ publicUrl: settings.get("management.publicUrl", ""), effectivePublicUrl: publicUrl(platform), epgToken: token(), epgDays: settings.get("epg.days", 7) }));
  app.put("/api/management/settings", async (req) => {
    requireRole(req, "admin");
    const b = z.object({ publicUrl: z.union([z.url(), z.literal("")]), epgDays: z.number().int().min(1).max(21).default(7), regenerateToken: z.boolean().optional() }).parse(req.body);
    settings.set("management.publicUrl", b.publicUrl);
    settings.set("epg.days", b.epgDays);
    if (b.regenerateToken) settings.set("epg.token", randomToken(18));
    onChange();
    return { ok: true };
  });

  // ---- EPG -------------------------------------------------------------------------
  app.get("/api/epg", async (req) => {
    const q = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).parse(req.query);
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    if (to <= from || to - from > 8 * 86400_000) throw new HttpError(400, "invalid_range");
    const chans = channels();
    return {
      channels: chans.map((c) => ({ id: c.id, name: c.name, color: c.color })),
      programmes: epgProgrammes(platform, chans, from, to).map((p) => ({ ...p, startAt: new Date(p.start).toISOString(), endAt: new Date(p.end).toISOString() })),
    };
  });

  /** Public XMLTV feed (for set-top boxes, websites, IPTV middleware). Protected by a token in the URL. */
  app.get("/epg/xmltv.xml", async (req, reply) => {
    const { token: t } = z.object({ token: z.string().default("") }).parse(req.query);
    const a = Buffer.from(t);
    const b = Buffer.from(token());
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, "forbidden");
    const now = Date.now();
    const days = settings.get("epg.days", 7);
    const chans = channels();
    reply.header("Content-Type", "application/xml; charset=utf-8").header("Cache-Control", "max-age=300");
    return toXmltv(chans, epgProgrammes(platform, chans, now - 6 * 3600_000, now + days * 86400_000));
  });

  // ---- graphics: logo per channel -------------------------------------------------
  const MIME: Record<string, string> = { png: "image/png", svg: "image/svg+xml", webp: "image/webp", jpg: "image/jpeg" };
  app.post("/api/channels/:id/logo", async (req) => {
    requireRole(req, "editor");
    const id = Number((req.params as { id: string }).id);
    const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
    if (!ch) throw new HttpError(404, "not_found");
    const { dataUrl } = z.object({ dataUrl: z.string().max(4_000_000) }).parse(req.body);
    const m = /^data:image\/(png|svg\+xml|webp|jpeg);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new HttpError(400, "unsupported_image");
    const ext = ({ png: "png", "svg+xml": "svg", webp: "webp", jpeg: "jpg" } as Record<string, string>)[m[1]!]!;
    for (const f of readdirSync(graphicsDir)) if (f.startsWith(`${id}-logo.`)) rmSync(join(graphicsDir, f));
    const file = `${id}-logo.${ext}`;
    writeFileSync(join(graphicsDir, file), Buffer.from(m[2]!, "base64"));
    const g = JSON.parse(ch.graphics || "{}");
    g.logo = { ...(g.logo ?? {}), file: `${file}#${Date.now()}` };
    db.prepare("UPDATE channels SET graphics = ? WHERE id = ?").run(JSON.stringify(g), id);
    onChange();
    return { ok: true };
  });

  /** Public: the CasparCG overlay template on the studio node loads the logo from here. */
  app.get("/graphics/:id/logo", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const file = readdirSync(graphicsDir).find((f) => f.startsWith(`${id}-logo.`));
    if (!file) throw new HttpError(404, "not_found");
    const ext = file.split(".").pop()!;
    reply.header("Content-Type", MIME[ext] ?? "application/octet-stream").header("Cache-Control", "max-age=60").header("Access-Control-Allow-Origin", "*");
    if (ext === "svg") reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    return readFileSync(join(graphicsDir, file));
  });

  return { graphicsDir };
}
