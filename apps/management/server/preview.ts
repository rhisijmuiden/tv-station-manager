/**
 * Stream preview on the dashboard: a small player that shows what a channel puts out, e.g. the station's Owncast
 * page (`https://owncast.example.org/embed/video`) or an HLS playlist (`.m3u8`). The URL is set per channel
 * (settings key `dashboard.previews`). When none is set, a stream output of the channel to an own RTMP server
 * suggests the usual Owncast player URL on that host.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const KEY = "dashboard.previews";
/** Owncast serves its web player on port 8080 unless it was changed. */
const OWNCAST_WEB_PORT = 8080;

/** rtmp://stream.example.org:1935/live -> http://stream.example.org:8080/embed/video (Owncast defaults). */
export function owncastGuess(rtmpUrl: string): string | null {
  const m = /^rtmps?:\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^:/]+)/i.exec(rtmpUrl.trim());
  if (!m) return null;
  return `http://${m[1]}:${OWNCAST_WEB_PORT}/embed/video`;
}

/** What the dashboard does with a URL: a playlist or file plays in a video element, anything else is a web page. */
export const previewKind = (url: string): "video" | "page" => (/\.(m3u8|mp4|webm)(\?|#|$)/i.test(url) ? "video" : "page");

const urlIn = z.object({
  url: z
    .string()
    .trim()
    .max(500)
    .refine((u) => u === "" || /^https?:\/\/[^\s]+$/i.test(u), "preview_url"),
});

export function registerPreview(app: FastifyInstance, platform: Platform) {
  const { db, settings } = platform.ctx;
  const all = () => settings.get<Record<string, string>>(KEY, {});

  const suggestion = (channelId: number) => {
    const ch = db.prepare("SELECT studio_id, caspar_channel FROM channels WHERE id = ?").get(channelId) as { studio_id: number | null; caspar_channel: number } | undefined;
    if (!ch?.studio_id) return null;
    const rows = db
      .prepare(
        `SELECT d.url FROM stream_outputs o
         JOIN stream_output_destinations od ON od.output_id = o.id
         JOIN stream_destinations d ON d.id = od.destination_id
         WHERE o.source = 'channel' AND o.studio_id = ? AND o.caspar_channel = ? AND d.platform = 'custom' AND d.enabled = 1
         ORDER BY o.active DESC, d.id`,
      )
      .all(ch.studio_id, ch.caspar_channel) as { url: string }[];
    for (const r of rows) {
      const g = owncastGuess(r.url);
      if (g) return g;
    }
    return null;
  };

  app.get("/api/dashboard/previews", async () => {
    const saved = all();
    const channels = db.prepare("SELECT id FROM channels WHERE enabled = 1 ORDER BY id").all() as { id: number }[];
    return {
      previews: channels.map((c) => {
        const url = saved[String(c.id)] || null;
        return { channelId: c.id, url, kind: url ? previewKind(url) : null, suggestion: url ? null : suggestion(c.id) };
      }),
    };
  });

  app.put("/api/dashboard/previews/:id", async (req) => {
    requireRole(req, "editor");
    const id = Number((req.params as { id: string }).id);
    if (!db.prepare("SELECT 1 FROM channels WHERE id = ?").get(id)) throw new HttpError(404, "not_found");
    const { url } = urlIn.parse(req.body);
    const next = { ...all() };
    if (url) next[String(id)] = url;
    else delete next[String(id)];
    settings.set(KEY, next);
    return { ok: true };
  });
}
