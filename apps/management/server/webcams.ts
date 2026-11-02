/**
 * Webcams and external streams as media: a local webcam (a page on a site like webcam.nl, an IP camera over RTSP,
 * an HLS stream, RTMP/SRT, MJPEG or a snapshot picture) that editors click into a programme like a beeldkrant.
 * - Inspect: paste any link; a web page is searched for the stream behind it (one level of embedded players deep).
 * - Test: ffmpeg grabs one frame (thumbnail) and reads codec, size and sound.
 * - A webcam is an item in a block (`block_items.type = 'webcam'`); every webcam gets its own block, so it can be
 *   dragged from the library into an hour clock, the week schedule or a rundown.
 * - On air the director plays the stream on the playout layer. By default the management node relays video streams
 *   (`/webcam/<id>/live.ts`, `ffmpeg -c copy` to MPEG-TS): the studio node needs no internet access and RTSP goes
 *   over TCP. Pictures and MJPEG are shown by `/webcam/page.html` (CasparCG HTML producer). A caption
 *   ("LIVE · Strand Wijk aan Zee") goes on the layer above.
 * - Every webcam is checked every 10 minutes (online/offline, new thumbnail).
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import { spawn, type ChildProcess } from "node:child_process";
import type { FastifyInstance, FastifyReply } from "fastify";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { publicUrl } from "./director.js";
import { WEBCAM_PAGE } from "./webcam-page.js";
import { webcamOf, type WebcamRow } from "./webcamdb.js";
import {
  WEBCAM_KINDS,
  captionText,
  detectKind,
  isVideoKind,
  isYouTube,
  kindFromContentType,
  normaliseUrl,
  parseFfmpegInfo,
  relayArgs,
  scanPage,
  snapshotArgs,
  webcamSettingsSchema,
  type Candidate,
  type StreamInfo,
  type WebcamKind,
} from "./webcamlogic.js";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 20_000;
const CHECK_EVERY_MS = 10 * 60_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 TVStationManager";

export type Spawner = (cmd: string, args: string[]) => ChildProcess;

export interface ProbeResult {
  ok: boolean;
  info: StreamInfo | null;
  thumbnail: Buffer | null;
  error: string | null;
}

const hideSecrets = (s: string) => s.replace(/(\/\/)[^/@\s]+@/g, "$1***@");
const withoutCredentials = (url: string) => {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = "***";
    u.password = "";
    return u.toString().replace("***:@", "***@");
  } catch {
    return url;
  }
};

async function fetchLimited(url: string, max: number, accept = "*/*") {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const type = res.headers.get("content-type") ?? "";
  // A camera stream never ends: only the start is read.
  const reader = res.body?.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  if (reader) {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
      if (type.includes("multipart/x-mixed-replace")) break;
    }
    await reader.cancel().catch(() => undefined);
  }
  return { buf: Buffer.concat(chunks), type, finalUrl: res.url || url };
}

export class Webcams {
  private timer: NodeJS.Timeout | null = null;
  private checking = new Map<number, Promise<ProbeResult | undefined>>();
  private relays = new Set<ChildProcess>();
  readonly dir: string;
  spawner: Spawner = (cmd, args) => spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  ffmpeg = process.env.TVSM_FFMPEG || "ffmpeg";

  constructor(
    private platform: Platform,
    private onChange: () => void,
  ) {
    this.dir = join(platform.ctx.config.dataDir, "webcams");
    mkdirSync(this.dir, { recursive: true });
  }

  start(intervalMs = 60_000) {
    this.timer = setInterval(() => void this.due(), intervalMs);
    this.timer.unref();
    setTimeout(() => void this.due(), 5000).unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const p of this.relays) p.kill("SIGKILL");
    this.relays.clear();
  }

  private get db() {
    return this.platform.ctx.db;
  }
  thumbFile(id: number) {
    return join(this.dir, `${id}.jpg`);
  }

  /** Webcams whose last check is older than CHECK_EVERY_MS, one at a time. */
  async due() {
    const before = new Date(Date.now() - CHECK_EVERY_MS).toISOString();
    const rows = this.db.prepare("SELECT id FROM webcams WHERE last_check_at IS NULL OR last_check_at < ? ORDER BY last_check_at LIMIT 3").all(before) as { id: number }[];
    for (const r of rows) await this.check(r.id).catch(() => undefined);
  }

  /**
   * What is behind a link: the kind, and for a web page the streams in it (also inside embedded players).
   * Returns the best candidate as `kind`/`url`; `candidates` lists everything that was found.
   */
  async inspect(raw: string): Promise<{ url: string; kind: WebcamKind; pageUrl: string | null; title: string | null; candidates: Candidate[]; youtube: boolean }> {
    const url = normaliseUrl(raw);
    if (isYouTube(url)) return { url, kind: "page", pageUrl: url, title: null, candidates: [], youtube: true };
    let kind = detectKind(url);
    if (!url.startsWith("http")) return { url, kind, pageUrl: null, title: null, candidates: [], youtube: false };
    if (kind !== "page") return { url, kind, pageUrl: null, title: null, candidates: [], youtube: false };
    const first = await fetchLimited(url, MAX_PAGE_BYTES, "text/html,application/xhtml+xml,*/*;q=0.8");
    kind = kindFromContentType(first.type) ?? "page";
    if (kind !== "page") return { url, kind, pageUrl: null, title: null, candidates: [], youtube: false };
    const html = first.buf.toString("utf8");
    const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim().replace(/\s+/g, " ") ?? null;
    const found = scanPage(html, first.finalUrl);
    let youtube = found.length === 0 && /youtube(-nocookie)?\.com\/embed|youtu\.be\//i.test(html);
    // Embedded players (iframes): look one level deeper for the stream itself.
    const frames = found.filter((c) => c.kind === "page").slice(0, 4);
    for (const f of frames) {
      try {
        const sub = await fetchLimited(f.url, MAX_PAGE_BYTES, "text/html,*/*;q=0.8");
        const k = kindFromContentType(sub.type);
        if (k && k !== "page") {
          found.push({ url: f.url, kind: k, found: "iframe" });
          continue;
        }
        const inner = sub.buf.toString("utf8");
        if (/youtube(-nocookie)?\.com\/embed|youtu\.be\//i.test(inner)) youtube = true;
        for (const c of scanPage(inner, sub.finalUrl)) if (c.kind !== "page" && !found.some((x) => x.url === c.url)) found.push({ ...c, found: "iframe" });
      } catch {
        /* an embedded page that cannot be read is simply skipped */
      }
    }
    const rank = (c: Candidate) => WEBCAM_KINDS.indexOf(c.kind);
    const candidates = found.filter((c) => c.kind !== "page").sort((a, b) => rank(a) - rank(b));
    const best = candidates[0];
    return best ? { url: best.url, kind: best.kind, pageUrl: url, title, candidates, youtube: false } : { url, kind: "page", pageUrl: url, title, candidates: [], youtube };
  }

  /** One frame (as JPEG) and the details of a stream; pictures are fetched directly. */
  async probe(kind: WebcamKind, url: string): Promise<ProbeResult> {
    if (kind === "page") {
      try {
        await fetchLimited(url, 256 * 1024, "text/html,*/*;q=0.8");
        return { ok: true, info: null, thumbnail: null, error: null };
      } catch (e) {
        return { ok: false, info: null, thumbnail: null, error: (e as Error).message };
      }
    }
    if (kind === "image") {
      try {
        const r = await fetchLimited(url, MAX_IMAGE_BYTES, "image/*");
        if (!r.type.startsWith("image/")) throw new Error(`not a picture (${r.type || "unknown type"})`);
        return { ok: true, info: null, thumbnail: r.buf, error: null };
      } catch (e) {
        return { ok: false, info: null, thumbnail: null, error: (e as Error).message };
      }
    }
    return new Promise<ProbeResult>((resolve) => {
      let proc: ChildProcess;
      try {
        proc = this.spawner(this.ffmpeg, snapshotArgs(kind, url).map((a) => (a === "error" ? "info" : a)));
      } catch (e) {
        return resolve({ ok: false, info: null, thumbnail: null, error: (e as Error).message });
      }
      const out: Buffer[] = [];
      let err = "";
      proc.stdout?.on("data", (d: Buffer) => out.push(d));
      proc.stderr?.on("data", (d: Buffer) => {
        if (err.length < 64_000) err += d.toString();
      });
      const kill = setTimeout(() => proc.kill("SIGKILL"), PROBE_TIMEOUT_MS);
      proc.on("error", (e) => {
        clearTimeout(kill);
        resolve({ ok: false, info: null, thumbnail: null, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? "ffmpeg is not installed on the management node" : e.message });
      });
      proc.on("close", (code) => {
        clearTimeout(kill);
        const buf = Buffer.concat(out);
        const info = parseFfmpegInfo(err);
        if (buf.length > 100) return resolve({ ok: true, info, thumbnail: buf, error: null });
        const last = err
          .trim()
          .split("\n")
          .filter((l) => !/^\s*(Input|Output|Stream|Duration|Metadata|  )/.test(l))
          .pop();
        resolve({ ok: false, info: info.videoCodec ? info : null, thumbnail: null, error: hideSecrets(last || (code === null ? "no picture within 20 seconds" : `ffmpeg exited (${code})`)) });
      });
    });
  }

  /** Checks a saved webcam: status, details and a new thumbnail. */
  check(id: number): Promise<ProbeResult | undefined> {
    const running = this.checking.get(id);
    if (running) return running;
    const p = this.runCheck(id).finally(() => this.checking.delete(id));
    this.checking.set(id, p);
    return p;
  }
  private async runCheck(id: number) {
    const w = webcamOf(this.db, id);
    if (!w) return undefined;
    const r = await this.probe(w.kind, w.url);
    const now = new Date().toISOString();
    if (r.thumbnail) writeFileSync(this.thumbFile(id), r.thumbnail);
    this.db
      .prepare("UPDATE webcams SET status = ?, info = ?, last_check_at = ?, last_error = ?, thumb_at = COALESCE(?, thumb_at) WHERE id = ?")
      .run(r.ok ? "online" : "offline", JSON.stringify(r.info ?? JSON.parse(w.row.info || "{}")), now, r.error, r.thumbnail ? now : null, id);
    return r;
  }

  /** The stream as MPEG-TS for CasparCG on the studio node (relay: `ffmpeg -c copy`, stopped when CasparCG hangs up). */
  relay(id: number, reply: FastifyReply) {
    const w = webcamOf(this.db, id);
    if (!w || !isVideoKind(w.kind)) throw new HttpError(404, "not_found");
    const proc = this.spawner(this.ffmpeg, relayArgs(w.kind, w.url, w.settings.audio));
    this.relays.add(proc);
    let err = "";
    proc.stderr?.on("data", (d: Buffer) => {
      if (err.length < 8000) err += d.toString();
    });
    const stop = () => {
      this.relays.delete(proc);
      if (proc.exitCode == null) proc.kill("SIGKILL");
    };
    proc.on("error", stop);
    proc.on("close", (code) => {
      this.relays.delete(proc);
      if (code && err) this.platform.ctx.log.warn({ webcam: w.name, err: hideSecrets(err.trim().split("\n").pop() ?? "") }, "webcam relay stopped");
    });
    reply.raw.on("close", stop);
    reply.header("Content-Type", "video/mp2t").header("Cache-Control", "no-cache");
    return reply.send(proc.stdout!);
  }

  get activeRelays() {
    return this.relays.size;
  }
  changed() {
    this.onChange();
  }
}

const settingsIn = webcamSettingsSchema;
const webcamIn = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(WEBCAM_KINDS),
  url: z.string().trim().min(1).max(2000),
  pageUrl: z.string().trim().max(2000).nullable().optional(),
  settings: settingsIn.prefault({}),
});

export function registerWebcams(app: FastifyInstance, platform: Platform, cams: Webcams, onChange: () => void) {
  const { db } = platform.ctx;
  const pid = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  const blockOf = (id: number) =>
    db
      .prepare(
        `SELECT b.id, b.name, b.color FROM blocks b WHERE b.hidden = 0 AND (SELECT COUNT(*) FROM block_items i WHERE i.block_id = b.id) = 1
           AND EXISTS (SELECT 1 FROM block_items i WHERE i.block_id = b.id AND i.type = 'webcam' AND i.webcam_id = ?) ORDER BY b.id LIMIT 1`,
      )
      .get(id) as { id: number; name: string; color: string } | undefined;
  /** Every webcam has its own block (one item), so it can be dragged into an hour clock, the week or a rundown. */
  const ensureBlock = (id: number, name: string) => {
    const b = blockOf(id);
    if (b) {
      if (b.name !== name) db.prepare("UPDATE blocks SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(name.slice(0, 120), b.id);
      return { id: b.id, created: false };
    }
    const r = db.prepare("INSERT INTO blocks (name, kind, color, description, genre) VALUES (?, 'program', '#0EA5A4', '', 'webcam')").run(name.slice(0, 120));
    const blockId = Number(r.lastInsertRowid);
    db.prepare("INSERT INTO block_items (block_id, position, type, webcam_id) VALUES (?, 0, 'webcam', ?)").run(blockId, id);
    return { id: blockId, created: true };
  };

  const out = (id: number) => {
    const w = webcamOf(db, id);
    if (!w) throw new HttpError(404, "not_found");
    const r: WebcamRow = w.row;
    const usedIn = (db.prepare("SELECT COUNT(DISTINCT block_id) AS n FROM block_items WHERE webcam_id = ?").get(id) as { n: number }).n;
    const block = blockOf(id);
    return {
      id,
      name: w.name,
      kind: w.kind,
      url: withoutCredentials(w.url),
      hasCredentials: withoutCredentials(w.url) !== w.url,
      pageUrl: w.pageUrl,
      settings: w.settings,
      durationMs: w.settings.durationSec * 1000,
      status: r.status,
      info: JSON.parse(r.info || "{}") as Partial<StreamInfo>,
      lastCheckAt: r.last_check_at,
      lastError: r.last_error,
      thumbnailUrl: r.thumb_at && existsSync(cams.thumbFile(id)) ? `/api/webcams/${id}/thumbnail?v=${encodeURIComponent(r.thumb_at)}` : null,
      usedIn,
      // In the shape of a block summary, for the library (drag into a clock / the week / a rundown).
      block: block ? { id: block.id, name: block.name, kind: "program" as const, color: block.color, description: "", genre: "webcam", categoryId: null, updatedAt: r.updated_at, itemCount: 1, durationMs: w.settings.durationSec * 1000, warnings: 0, cycle: false } : null,
      pageUrlOnAir: `${publicUrl(platform)}/webcam/page.html?id=${id}`,
    };
  };
  /** A URL sent back from the UI with "***" keeps the stored password. */
  const keepCredentials = (incoming: string, stored: string | null) => {
    if (!stored || !incoming.includes("***")) return incoming;
    return withoutCredentials(stored) === incoming ? stored : incoming;
  };
  const checkUrl = (kind: WebcamKind, url: string) => {
    try {
      return normaliseUrl(url);
    } catch (e) {
      throw new HttpError(400, "invalid_url", (e as Error).message);
    }
  };

  app.get("/api/webcams", async () => ({ webcams: (db.prepare("SELECT id FROM webcams ORDER BY name COLLATE NOCASE").all() as { id: number }[]).map((r) => out(r.id)) }));
  app.get("/api/webcams/:id", async (req) => out(pid(req)));

  app.post("/api/webcams/inspect", async (req) => {
    requireRole(req, "editor");
    const { url } = z.object({ url: z.string().trim().min(1).max(2000) }).parse(req.body);
    try {
      return await cams.inspect(url);
    } catch (e) {
      throw new HttpError(502, "inspect_failed", hideSecrets((e as Error).message));
    }
  });
  app.post("/api/webcams/test", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ kind: z.enum(WEBCAM_KINDS), url: z.string().trim().min(1).max(2000), id: z.number().int().optional() }).parse(req.body);
    const stored = b.id ? webcamOf(db, b.id)?.url ?? null : null;
    const url = checkUrl(b.kind, keepCredentials(b.url, stored));
    const r = await cams.probe(b.kind, url);
    return { ok: r.ok, info: r.info, error: r.error, thumbnail: r.thumbnail ? `data:image/jpeg;base64,${r.thumbnail.toString("base64")}` : null };
  });

  app.post("/api/webcams", async (req) => {
    requireRole(req, "editor");
    const b = webcamIn.parse(req.body);
    const url = checkUrl(b.kind, b.url);
    db.exec("BEGIN");
    let id: number;
    try {
      const r = db.prepare("INSERT INTO webcams (name, kind, url, page_url, settings) VALUES (?, ?, ?, ?, ?)").run(b.name, b.kind, url, b.pageUrl || null, JSON.stringify(b.settings));
      id = Number(r.lastInsertRowid);
      ensureBlock(id, b.name);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    onChange();
    void cams.check(id).catch(() => undefined);
    return out(id);
  });
  app.put("/api/webcams/:id", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const cur = webcamOf(db, id);
    if (!cur) throw new HttpError(404, "not_found");
    const b = webcamIn.parse(req.body);
    const url = checkUrl(b.kind, keepCredentials(b.url, cur.url));
    const moved = url !== cur.url || b.kind !== cur.kind;
    db.prepare("UPDATE webcams SET name = ?, kind = ?, url = ?, page_url = ?, settings = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(b.name, b.kind, url, b.pageUrl || null, JSON.stringify(b.settings), id);
    ensureBlock(id, b.name);
    if (moved) db.prepare("UPDATE webcams SET status = 'unknown', last_check_at = NULL WHERE id = ?").run(id);
    onChange();
    if (moved) void cams.check(id).catch(() => undefined);
    return out(id);
  });
  app.delete("/api/webcams/:id", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    const { force } = z.object({ force: z.coerce.boolean().optional() }).parse(req.query);
    const own = blockOf(id);
    // Used anywhere else than in its own block (or its own block is planned)?
    const used = (db.prepare("SELECT (SELECT COUNT(*) FROM block_items WHERE webcam_id = ? AND block_id != ?) + (SELECT COUNT(*) FROM blocks WHERE fill = ?) AS n").get(id, own?.id ?? -1, `webcam:${id}`) as { n: number }).n;
    const planned = own ? (db.prepare("SELECT COUNT(*) AS n FROM block_items WHERE child_block_id = ?").get(own.id) as { n: number }).n + (db.prepare("SELECT COUNT(*) AS n FROM schedule WHERE block_id = ?").get(own.id) as { n: number }).n : 0;
    if ((used || planned) && !force) throw new HttpError(409, "webcam_in_use", String(used + planned));
    db.exec("BEGIN");
    try {
      if (own) db.prepare("DELETE FROM blocks WHERE id = ?").run(own.id);
      db.prepare("DELETE FROM webcams WHERE id = ?").run(id);
      db.prepare("UPDATE blocks SET fill = NULL WHERE fill = ?").run(`webcam:${id}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    rmSync(cams.thumbFile(id), { force: true });
    onChange();
    return { ok: true };
  });
  app.post("/api/webcams/:id/check", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    if (!webcamOf(db, id)) throw new HttpError(404, "not_found");
    await cams.check(id);
    return out(id);
  });
  app.post("/api/webcams/:id/block", async (req) => {
    requireRole(req, "editor");
    const w = webcamOf(db, pid(req));
    if (!w) throw new HttpError(404, "not_found");
    const r = ensureBlock(w.id, w.name);
    if (r.created) onChange();
    return r;
  });
  app.get("/api/webcams/:id/thumbnail", async (req, reply) => {
    const f = cams.thumbFile(pid(req));
    if (!existsSync(f)) throw new HttpError(404, "not_found");
    reply.header("Content-Type", "image/jpeg").header("Cache-Control", "max-age=86400");
    return readFileSync(f);
  });

  // ---- public (CasparCG on the studio node) ------------------------------------------------
  const frameable = async (_req: unknown, r: { header: (k: string, v: string) => unknown }) => {
    r.header("X-Frame-Options", "SAMEORIGIN");
  };
  app.get("/webcam/page.html", { onSend: frameable }, async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-cache");
    return WEBCAM_PAGE;
  });
  app.get("/webcam/:id/data.json", async (req, reply) => {
    const w = webcamOf(db, pid(req));
    if (!w) throw new HttpError(404, "not_found");
    const lang = platform.ctx.settings.get<string>("webcams.language", "nl");
    reply.header("Cache-Control", "no-cache").header("Access-Control-Allow-Origin", "*");
    return {
      id: w.id,
      name: w.name,
      kind: w.kind,
      mode: isVideoKind(w.kind) || w.kind === "page" ? "stream" : "picture",
      caption: captionText(w.name, w.settings),
      settings: w.settings,
      imageUrl: `/webcam/${w.id}/snapshot`,
      mjpegUrl: `/webcam/${w.id}/mjpeg`,
      liveWord: "Live",
      offlineText: lang === "en" ? "The picture is not available right now." : "Het beeld is op dit moment niet beschikbaar.",
      colors: { bg: "#2A1430", panel: "#713C80", accent: "#E92E7F", text: "#FFFFFF" },
      serverTime: Date.now(),
    };
  });
  /** The current picture of a snapshot camera, fetched by the management node (or the last thumbnail). */
  app.get("/webcam/:id/snapshot", async (req, reply) => {
    const w = webcamOf(db, pid(req));
    if (!w) throw new HttpError(404, "not_found");
    reply.header("Cache-Control", "no-store").header("Access-Control-Allow-Origin", "*");
    if (w.kind === "image") {
      try {
        const r = await fetchLimited(w.url, MAX_IMAGE_BYTES, "image/*");
        return reply.header("Content-Type", r.type || "image/jpeg").send(r.buf);
      } catch {
        /* fall back to the last thumbnail */
      }
    }
    const f = cams.thumbFile(w.id);
    if (!existsSync(f)) throw new HttpError(404, "not_found");
    return reply.header("Content-Type", "image/jpeg").send(readFileSync(f));
  });
  /** MJPEG camera passed through the management node (the browser on the studio node shows it in an <img>). */
  app.get("/webcam/:id/mjpeg", async (req, reply) => {
    const w = webcamOf(db, pid(req));
    if (!w || w.kind !== "mjpeg") throw new HttpError(404, "not_found");
    const ctrl = new AbortController();
    reply.raw.on("close", () => ctrl.abort());
    let res: Response;
    try {
      res = await fetch(w.url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    } catch (e) {
      throw new HttpError(502, "webcam_offline", hideSecrets((e as Error).message));
    }
    if (!res.ok || !res.body) throw new HttpError(502, "webcam_offline", `HTTP ${res.status}`);
    reply.header("Content-Type", res.headers.get("content-type") ?? "multipart/x-mixed-replace").header("Cache-Control", "no-store").header("Access-Control-Allow-Origin", "*");
    return reply.send(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream));
  });
  app.get("/webcam/:id/live.ts", async (req, reply) => cams.relay(pid(req), reply));
}
