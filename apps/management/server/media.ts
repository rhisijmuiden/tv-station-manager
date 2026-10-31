import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SUB_EXT, matchSubtitles, parseSubtitles, type Cue } from "./subtitles.js";

/**
 * Media library. Files are read from the UniFi UNAS Pro (or any SMB server) with `smbclient`, which works inside
 * an unprivileged LXC where CIFS mounts are not allowed. Durations are measured with ffprobe, streaming the file
 * from the share. A "local" source (a folder on this machine, e.g. a bind mount) is supported as well.
 */

export const VIDEO_EXT = /\.(mp4|m4v|mov|mxf|mkv|ts|m2ts|mts|mpg|mpeg|avi|webm|wmv|flv)$/i;
const MASK = "********";

const smbConfig = z.object({
  host: z.string().trim().min(1).max(255),
  share: z.string().trim().min(1).max(255),
  path: z.string().trim().max(1024).default(""),
  username: z.string().max(255).default(""),
  password: z.string().max(1024).default(""),
  domain: z.string().max(255).default(""),
  protocol: z.enum(["SMB3", "SMB2"]).default("SMB3"),
});
const localConfig = z.object({ path: z.string().trim().min(1).max(1024) });
const sourceInput = z.discriminatedUnion("type", [
  z.object({ name: z.string().trim().min(1).max(80), type: z.literal("smb"), enabled: z.boolean().default(true), config: smbConfig }),
  z.object({ name: z.string().trim().min(1).max(80), type: z.literal("local"), enabled: z.boolean().default(true), config: localConfig }),
]);
type SmbConfig = z.infer<typeof smbConfig>;
type SourceInput = z.infer<typeof sourceInput>;

export interface ListedFile {
  path: string;
  size: number;
  mtime: string;
}

export interface ProbeResult {
  durationMs: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
}

/** Guesses a category from the folder name, so a folder "Reclame" or "Jingles" is sorted automatically. */
export function guessCategory(path: string): "program" | "commercial" | "jingle" | "bumper" | "filler" {
  const p = path.toLowerCase();
  if (/(^|\/)(reclame|commercials?|ads?|advert\w*|spots?)(\/|$)/.test(p)) return "commercial";
  if (/(^|\/)jingles?(\/|$)/.test(p)) return "jingle";
  if (/(^|\/)(bumpers?|idents?|leaders?|promos?)(\/|$)/.test(p)) return "bumper";
  if (/(^|\/)(fillers?|vulling|opvulling|loops?)(\/|$)/.test(p)) return "filler";
  return "program";
}

/** Parses `smbclient -c "recurse ON; ls"` output into video and subtitle files (paths relative to `base`). */
export function parseSmbListing(out: string, base = ""): ListedFile[] {
  const files: ListedFile[] = [];
  let dir = "";
  const root = base.replace(/\//g, "\\").replace(/^\\+|\\+$/g, "");
  for (const raw of out.split(/\r?\n/)) {
    if (raw.startsWith("\\")) {
      let d = raw.trim().replace(/^\\+/, "");
      if (root && d.toLowerCase().startsWith(root.toLowerCase())) d = d.slice(root.length).replace(/^\\+/, "");
      dir = d.replace(/\\/g, "/");
      continue;
    }
    const m = /^\s{2}(.*?)\s+([A-Z]{0,8})\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/.exec(raw);
    if (!m) continue;
    const [, name, attrs, size, date] = m;
    if (!name || name === "." || name === ".." || attrs!.includes("D")) continue;
    if (!VIDEO_EXT.test(name) && !SUB_EXT.test(name)) continue;
    const t = new Date(date!.replace(/\s+/g, " "));
    files.push({ path: dir ? `${dir}/${name}` : name, size: Number(size), mtime: Number.isNaN(t.getTime()) ? date! : t.toISOString() });
  }
  return files;
}

export function parseProbe(json: string): ProbeResult {
  const j = JSON.parse(json) as { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string }[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const rate = (r?: string) => {
    if (!r) return null;
    const [a, b] = r.split("/").map(Number);
    return a && b ? Math.round((a / b) * 1000) / 1000 : null;
  };
  const dur = Number(j.format?.duration ?? v?.duration);
  return {
    durationMs: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : null,
    fps: rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate),
    width: v?.width ?? null,
    height: v?.height ?? null,
    codec: v?.codec_name ?? null,
  };
}

const run = (cmd: string, args: string[], timeoutMs: number) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new HttpError(500, "missing_tool", `${cmd} is not installed`) : e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

/** Runs a function with a temporary smbclient credentials file (so the password is not visible in `ps`). */
function withAuthFile<T>(cfg: SmbConfig, fn: (args: string[]) => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), "tvsm-smb-"));
  const file = join(dir, "auth");
  writeFileSync(file, `username = ${cfg.username || "guest"}\npassword = ${cfg.password}\n${cfg.domain ? `domain = ${cfg.domain}\n` : ""}`, { mode: 0o600 });
  const args = [`//${cfg.host}/${cfg.share}`, "-A", file, "-m", cfg.protocol, ...(cfg.username ? [] : ["-N"])];
  return fn(args).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const smbQuote = (p: string) => {
  if (/["\n\r]/.test(p)) throw new HttpError(400, "unsupported_file_name");
  return `"${p.replace(/\//g, "\\")}"`;
};
const smbError = (stderr: string, stdout: string) => {
  const m = /NT_STATUS_\w+/.exec(stderr + stdout);
  return m ? m[0] : (stderr || stdout).trim().split("\n").pop() || "smbclient failed";
};

export async function listSmb(cfg: SmbConfig): Promise<ListedFile[]> {
  return withAuthFile(cfg, async (args) => {
    const cd = cfg.path ? `cd ${smbQuote(cfg.path)}; ` : "";
    const r = await run("smbclient", [...args, "-c", `${cd}recurse ON; prompt OFF; ls`], 10 * 60_000);
    if (r.code !== 0 || /NT_STATUS_/.test(r.stdout.split("\n")[0] ?? "")) throw new HttpError(502, "smb_failed", smbError(r.stderr, r.stdout));
    return parseSmbListing(r.stdout, cfg.path);
  });
}

export function listLocal(root: string): ListedFile[] {
  const files: ListedFile[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 20) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && (VIDEO_EXT.test(e.name) || SUB_EXT.test(e.name))) {
        const st = statSync(full);
        files.push({ path: relative(root, full).split(sep).join("/"), size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  };
  walk(root, 0);
  return files;
}

const FFPROBE = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams"];

async function probeLocal(file: string) {
  const r = await run("ffprobe", [...FFPROBE, file], 120_000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "ffprobe failed");
  return parseProbe(r.stdout);
}

/** Streams the file from the share into ffprobe. ffprobe stops reading as soon as it has the header. */
async function probeSmb(cfg: SmbConfig, path: string) {
  return withAuthFile(cfg, (args) => {
    const full = cfg.path ? `${cfg.path.replace(/\/+$/, "")}/${path}` : path;
    return new Promise<ProbeResult>((resolve, reject) => {
      const smb = spawn("smbclient", [...args, "-c", `get ${smbQuote(full)} -`], { stdio: ["ignore", "pipe", "pipe"] });
      const ff = spawn("ffprobe", [...FFPROBE, "-i", "pipe:0"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let smbErr = "";
      const timer = setTimeout(() => {
        smb.kill("SIGKILL");
        ff.kill("SIGKILL");
      }, 15 * 60_000);
      smb.stdout.pipe(ff.stdin);
      ff.stdin.on("error", () => undefined);
      smb.stderr.on("data", (d) => (smbErr += d));
      ff.stdout.on("data", (d) => (out += d));
      ff.stderr.on("data", (d) => (err += d));
      const fail = (e: Error) => {
        clearTimeout(timer);
        smb.kill();
        reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error("smbclient or ffprobe is not installed") : e);
      };
      smb.on("error", fail);
      ff.on("error", fail);
      ff.on("close", (code) => {
        clearTimeout(timer);
        smb.kill();
        try {
          const res = code === 0 ? parseProbe(out) : null;
          if (res?.durationMs) resolve(res);
          else reject(new Error(smbError(smbErr, "") !== "smbclient failed" && /NT_STATUS/.test(smbErr) ? smbError(smbErr, "") : err.trim().split("\n").pop() || "no duration found"));
        } catch (e) {
          reject(e as Error);
        }
      });
    });
  });
}

/** Reads a small file (subtitles) from the share. */
async function readSmb(cfg: SmbConfig, path: string): Promise<Buffer> {
  return withAuthFile(cfg, (args) => {
    const full = cfg.path ? `${cfg.path.replace(/\/+$/, "")}/${path}` : path;
    return new Promise<Buffer>((resolve, reject) => {
      const p = spawn("smbclient", [...args, "-c", `get ${smbQuote(full)} -`], { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let err = "";
      const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
      p.stdout.on("data", (d: Buffer) => chunks.push(d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(smbError(err, "")));
      });
    });
  });
}

/** Subtitle files are often saved in Windows-1252 rather than UTF-8. */
export function decodeText(buf: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

interface SourceRow {
  id: number;
  name: string;
  type: "smb" | "local";
  config: string;
  enabled: number;
  scan_status: string;
  last_scan_at: string | null;
  last_error: string | null;
}

export function registerMedia(app: FastifyInstance, platform: Platform, onChange: () => void) {
  const { db, secrets, log } = platform.ctx;

  const readConfig = (row: SourceRow) => {
    const c = JSON.parse(row.config) as Record<string, unknown>;
    if (row.type === "smb") return { ...smbConfig.parse(c), password: secrets.decrypt(String(c.password ?? "")) };
    return localConfig.parse(c);
  };
  const pub = (row: SourceRow) => {
    const cfg = readConfig(row) as Record<string, unknown>;
    if (row.type === "smb") cfg.password = cfg.password ? MASK : "";
    const counts = db.prepare("SELECT COUNT(*) AS files, COUNT(*) FILTER (WHERE probe_status = 'pending' AND missing = 0) AS pending, COUNT(*) FILTER (WHERE missing = 1) AS missing FROM media WHERE source_id = ?").get(row.id) as Record<string, number>;
    return { id: row.id, name: row.name, type: row.type, enabled: !!row.enabled, config: cfg, scanStatus: row.scan_status, lastScanAt: row.last_scan_at, lastError: row.last_error, ...counts };
  };
  const getRow = (id: number) => {
    const r = db.prepare("SELECT * FROM media_sources WHERE id = ?").get(id) as SourceRow | undefined;
    if (!r) throw new HttpError(404, "not_found");
    return r;
  };
  const storeConfig = (input: SourceInput, existing?: SourceRow) => {
    if (input.type === "local") return JSON.stringify(input.config);
    let pw = input.config.password;
    if (pw === MASK && existing) pw = String((readConfig(existing) as SmbConfig).password);
    return JSON.stringify({ ...input.config, password: pw ? secrets.encrypt(pw) : "" });
  };

  const list = (row: SourceRow) => {
    const cfg = readConfig(row);
    return row.type === "smb" ? listSmb(cfg as SmbConfig) : Promise.resolve(listLocal((cfg as { path: string }).path));
  };

  // ---- scanning and probing ----------------------------------------------

  const scanning = new Set<number>();
  const scan = async (id: number) => {
    if (scanning.has(id)) return;
    scanning.add(id);
    const row = getRow(id);
    db.prepare("UPDATE media_sources SET scan_status = 'scanning', last_error = NULL WHERE id = ?").run(id);
    try {
      const listed = await list(row);
      const files = listed.filter((f) => VIDEO_EXT.test(f.path));
      const subtitles = matchSubtitles(
        files.map((f) => f.path),
        listed.filter((f) => SUB_EXT.test(f.path)).map((f) => f.path),
      );
      const seen = new Set<string>();
      db.exec("BEGIN");
      try {
        const find = db.prepare("SELECT id, size, mtime FROM media WHERE source_id = ? AND path = ?");
        const ins = db.prepare("INSERT INTO media (source_id, path, name, folder, size, mtime, category, subtitle_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        const sub = db.prepare("UPDATE media SET subtitle_path = ? WHERE id = ?");
        const upd = db.prepare("UPDATE media SET size = ?, mtime = ?, missing = 0, probe_status = CASE WHEN probe_status = 'manual' THEN 'manual' WHEN size IS ? AND mtime IS ? THEN probe_status ELSE 'pending' END WHERE id = ?");
        for (const f of files) {
          seen.add(f.path);
          const cur = find.get(id, f.path) as { id: number; size: number; mtime: string } | undefined;
          const slash = f.path.lastIndexOf("/");
          const name = f.path.slice(slash + 1).replace(/\.[^.]+$/, "");
          if (!cur) ins.run(id, f.path, name, slash > 0 ? f.path.slice(0, slash) : "", f.size, f.mtime, guessCategory(f.path), subtitles.get(f.path) ?? null);
          else {
            upd.run(f.size, f.mtime, f.size, f.mtime, cur.id);
            sub.run(subtitles.get(f.path) ?? null, cur.id);
          }
        }
        const all = db.prepare("SELECT id, path FROM media WHERE source_id = ? AND missing = 0").all(id) as { id: number; path: string }[];
        const miss = db.prepare("UPDATE media SET missing = 1 WHERE id = ?");
        for (const m of all) if (!seen.has(m.path)) miss.run(m.id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      db.prepare("UPDATE media_sources SET scan_status = 'idle', last_scan_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
      log.info({ source: row.name, files: files.length }, "media scan finished");
      onChange();
      void probeQueue();
    } catch (e) {
      db.prepare("UPDATE media_sources SET scan_status = 'error', last_error = ? WHERE id = ?").run((e as Error).message, id);
      log.warn({ source: row.name, err: (e as Error).message }, "media scan failed");
    } finally {
      scanning.delete(id);
    }
  };

  let probing = false;
  const probeQueue = async () => {
    if (probing) return;
    probing = true;
    try {
      for (;;) {
        const m = db.prepare("SELECT m.id, m.path, m.source_id FROM media m JOIN media_sources s ON s.id = m.source_id WHERE m.probe_status = 'pending' AND m.missing = 0 AND s.enabled = 1 ORDER BY m.id LIMIT 1").get() as
          | { id: number; path: string; source_id: number }
          | undefined;
        if (!m) break;
        const row = getRow(m.source_id);
        try {
          const cfg = readConfig(row);
          const r = row.type === "smb" ? await probeSmb(cfg as SmbConfig, m.path) : await probeLocal(join((cfg as { path: string }).path, m.path));
          db.prepare("UPDATE media SET duration_ms = ?, fps = ?, width = ?, height = ?, codec = ?, probe_status = 'ok', probe_error = NULL WHERE id = ? AND probe_status = 'pending'").run(
            r.durationMs,
            r.fps,
            r.width,
            r.height,
            r.codec,
            m.id,
          );
          onChange();
        } catch (e) {
          db.prepare("UPDATE media SET probe_status = 'failed', probe_error = ? WHERE id = ? AND probe_status = 'pending'").run((e as Error).message.slice(0, 500), m.id);
        }
      }
    } finally {
      probing = false;
    }
  };

  // Rescan every 15 minutes so new files on the UNAS show up by themselves.
  const timer = setInterval(() => {
    for (const s of db.prepare("SELECT id FROM media_sources WHERE enabled = 1").all() as { id: number }[]) void scan(s.id);
  }, 15 * 60_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
  setTimeout(() => void probeQueue(), 2000).unref();

  // ---- API -----------------------------------------------------------------

  app.get("/api/media/sources", async () => ({ sources: (db.prepare("SELECT * FROM media_sources ORDER BY name").all() as unknown as SourceRow[]).map(pub) }));

  app.post("/api/media/sources", async (req) => {
    requireRole(req, "editor");
    const b = sourceInput.parse(req.body);
    const r = db.prepare("INSERT INTO media_sources (name, type, config, enabled) VALUES (?, ?, ?, ?)").run(b.name, b.type, storeConfig(b), b.enabled ? 1 : 0);
    const id = Number(r.lastInsertRowid);
    void scan(id);
    return pub(getRow(id));
  });

  app.put("/api/media/sources/:id", async (req) => {
    requireRole(req, "editor");
    const row = getRow(Number((req.params as { id: string }).id));
    const b = sourceInput.parse(req.body);
    db.prepare("UPDATE media_sources SET name = ?, type = ?, config = ?, enabled = ? WHERE id = ?").run(b.name, b.type, storeConfig(b, row), b.enabled ? 1 : 0, row.id);
    return pub(getRow(row.id));
  });

  app.delete("/api/media/sources/:id", async (req) => {
    requireRole(req, "editor");
    db.prepare("DELETE FROM media_sources WHERE id = ?").run(Number((req.params as { id: string }).id));
    onChange();
    return { ok: true };
  });

  /** Tries the connection settings without saving them. */
  app.post("/api/media/sources/test", async (req) => {
    requireRole(req, "editor");
    const b = sourceInput.parse(req.body);
    let cfg = b.config;
    if (b.type === "smb" && b.config.password === MASK) {
      const existingId = Number((req.body as { id?: number }).id ?? 0);
      cfg = { ...b.config, password: existingId ? String((readConfig(getRow(existingId)) as SmbConfig).password) : "" };
    }
    const started = Date.now();
    const files = (b.type === "smb" ? await listSmb(cfg as SmbConfig) : listLocal((cfg as { path: string }).path)).filter((f) => VIDEO_EXT.test(f.path));
    return { ok: true, files: files.length, sample: files.slice(0, 5).map((f) => f.path), ms: Date.now() - started };
  });

  app.post("/api/media/sources/:id/scan", async (req) => {
    requireRole(req, "editor");
    const row = getRow(Number((req.params as { id: string }).id));
    void scan(row.id);
    return { ok: true };
  });

  const listQuery = z.object({
    q: z.string().max(200).optional(),
    source: z.coerce.number().int().optional(),
    category: z.enum(["program", "commercial", "jingle", "bumper", "filler"]).optional(),
    folder: z.string().max(1024).optional(),
    missing: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  });
  app.get("/api/media", async (req) => {
    const q = listQuery.parse(req.query);
    const where = ["1 = 1"];
    const args: (string | number)[] = [];
    if (!q.missing) where.push("m.missing = 0");
    if (q.source) where.push("m.source_id = ?"), args.push(q.source);
    if (q.category) where.push("m.category = ?"), args.push(q.category);
    if (q.folder !== undefined && q.folder !== "") where.push("(m.folder = ? OR m.folder LIKE ?)"), args.push(q.folder, `${q.folder}/%`);
    if (q.q) where.push("(m.name LIKE ? OR m.title LIKE ? OR m.path LIKE ?)"), args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
    const w = where.join(" AND ");
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM media m WHERE ${w}`).get(...args) as { n: number }).n;
    const items = db
      .prepare(
        `SELECT m.id, m.source_id AS sourceId, m.path, m.name, m.title, m.folder, m.size, m.mtime, m.duration_ms AS durationMs, m.fps, m.width, m.height, m.codec,
                m.category, m.probe_status AS probeStatus, m.probe_error AS probeError, m.missing, m.subtitle_path AS subtitlePath
           FROM media m WHERE ${w} ORDER BY m.folder COLLATE NOCASE, m.name COLLATE NOCASE LIMIT ? OFFSET ?`,
      )
      .all(...args, q.limit, q.offset)
      .map((r) => ({ ...r, missing: !!(r as { missing: number }).missing }));
    const folders = (db.prepare("SELECT DISTINCT folder FROM media WHERE missing = 0 AND folder != '' ORDER BY folder COLLATE NOCASE").all() as { folder: string }[]).map((f) => f.folder);
    return { total, items, folders };
  });

  app.put("/api/media/:id", async (req) => {
    requireRole(req, "editor");
    const id = Number((req.params as { id: string }).id);
    const b = z
      .object({
        category: z.enum(["program", "commercial", "jingle", "bumper", "filler"]),
        title: z.string().max(200).nullable().optional(),
        durationMs: z.number().int().min(0).max(48 * 3600_000).nullable().optional(),
      })
      .parse(req.body);
    const cur = db.prepare("SELECT duration_ms FROM media WHERE id = ?").get(id) as { duration_ms: number | null } | undefined;
    if (!cur) throw new HttpError(404, "not_found");
    db.prepare("UPDATE media SET category = ?, title = ? WHERE id = ?").run(b.category, b.title || null, id);
    if (b.durationMs !== undefined && b.durationMs !== cur.duration_ms) db.prepare("UPDATE media SET duration_ms = ?, probe_status = 'manual' WHERE id = ?").run(b.durationMs, id);
    onChange();
    return { ok: true };
  });

  app.post("/api/media/:id/probe", async (req) => {
    requireRole(req, "editor");
    db.prepare("UPDATE media SET probe_status = 'pending' WHERE id = ?").run(Number((req.params as { id: string }).id));
    void probeQueue();
    return { ok: true };
  });

  app.post("/api/media/bulk-category", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ ids: z.array(z.number().int()).max(1000), category: z.enum(["program", "commercial", "jingle", "bumper", "filler"]) }).parse(req.body);
    const st = db.prepare("UPDATE media SET category = ? WHERE id = ?");
    for (const id of b.ids) st.run(b.category, id);
    onChange();
    return { ok: true };
  });

  // ---- subtitles ---------------------------------------------------------------

  const cueCache = new Map<string, Cue[]>();
  const cues = async (mediaId: number): Promise<Cue[]> => {
    const m = db.prepare("SELECT source_id, subtitle_path, mtime FROM media WHERE id = ?").get(mediaId) as { source_id: number; subtitle_path: string | null; mtime: string | null } | undefined;
    if (!m?.subtitle_path) throw new HttpError(404, "not_found");
    const key = `${mediaId}:${m.subtitle_path}:${m.mtime}`;
    const hit = cueCache.get(key);
    if (hit) return hit;
    const row = getRow(m.source_id);
    const cfg = readConfig(row);
    const text = decodeText(row.type === "smb" ? await readSmb(cfg as SmbConfig, m.subtitle_path) : readFileSync(join((cfg as { path: string }).path, m.subtitle_path)));
    const parsed = parseSubtitles(text);
    if (cueCache.size > 50) cueCache.delete(cueCache.keys().next().value!);
    cueCache.set(key, parsed);
    return parsed;
  };

  /** Public: the CasparCG overlay on the studio node loads the cues of the clip on air from here. */
  app.get("/graphics/subtitles/:id", async (req, reply) => {
    const list = await cues(Number((req.params as { id: string }).id));
    reply.header("Access-Control-Allow-Origin", "*").header("Cache-Control", "max-age=60");
    return { cues: list };
  });

  return { scan, probeQueue };
}
