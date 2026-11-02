/**
 * Public page of the "coming up" slide (block item type `lineup`), played by the CasparCG HTML producer:
 *   PLAY <ch>-10 [HTML] "<management>/lineup/page.html?channel=<id>&at=<epoch ms of the slide's start>"
 * The rows come from the schedule of that channel after `at` (see lineuplogic.ts), so a restart of the slide shows the
 * same list. `preview=1` scales the page for the editor's iframe; `settings` (JSON) previews unsaved settings.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { channelOut, dbLoader, scheduleEntries, type ChannelRow } from "./content.js";
import { publicUrl } from "./director.js";
import { lineupHtml, lineupRows, lineupSchema, type LineupSettings } from "./lineuplogic.js";
import { compile } from "./timeline.js";

/** The finished slide of a channel at `at`. */
export function lineupPage(platform: Platform, ch: ChannelRow, at: number, opts: { preview?: boolean; settings?: LineupSettings } = {}) {
  const { db, settings: store, config } = platform.ctx;
  const s = opts.settings ?? channelOut(ch).graphics.lineup;
  const to = at + s.minutesAhead * 60_000;
  const { events } = compile(dbLoader(db), scheduleEntries(db, ch.id, at, to), at, to);
  const graphicsDir = join(config.dataDir, "graphics");
  const logo = existsSync(graphicsDir) && readdirSync(graphicsDir).some((f) => f.startsWith(`${ch.id}-logo.`));
  return lineupHtml({
    channel: ch.name,
    settings: s,
    rows: lineupRows(events, at, s),
    at,
    timeZone: store.get("station.timezone", "Europe/Amsterdam"),
    logoUrl: logo ? `${opts.preview ? "" : publicUrl(platform)}/graphics/${ch.id}/logo` : null,
    preview: opts.preview,
  });
}

export function registerLineup(app: FastifyInstance, platform: Platform) {
  const { db } = platform.ctx;
  // The editor shows the page in an iframe as a preview (the platform forbids framing by default); CasparCG does not care.
  const frameable = async (_req: unknown, reply: { header: (k: string, v: string) => unknown }) => {
    reply.header("X-Frame-Options", "SAMEORIGIN");
  };
  app.get("/lineup/page.html", { onSend: frameable }, async (req, reply) => {
    const q = z.object({ channel: z.coerce.number().int(), at: z.coerce.number().int().optional(), preview: z.string().optional(), settings: z.string().max(4000).optional() }).parse(req.query);
    const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(q.channel) as ChannelRow | undefined;
    if (!ch) throw new HttpError(404, "not_found");
    let settings: LineupSettings | undefined;
    if (q.settings) {
      try {
        settings = lineupSchema.parse(JSON.parse(q.settings));
      } catch {
        throw new HttpError(400, "invalid_settings");
      }
    }
    reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-cache");
    return lineupPage(platform, ch, q.at ?? Date.now(), { preview: q.preview === "1", settings });
  });
}
