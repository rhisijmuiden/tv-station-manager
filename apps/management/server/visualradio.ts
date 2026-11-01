/**
 * Visual Radio: a TV channel that follows the radio.
 *
 * - The radio playout reports every item (`/visualradio/<token>/nowplaying`, JSON / XML / text / query string).
 * - For music the matching videoclip is looked up (vrlogic.ts) and played without sound on the Visual Radio studio
 *   node (CasparCG); the radio mix is the channel's sound, fed to the ATEM by the radio desk.
 * - The radio desk (fader start / GPO) or the playout reports microphones (`/visualradio/<token>/mic`); an open
 *   microphone puts its camera on air.
 * - Every 100 ms the rules in `decideShot` pick the ATEM input; only changes are sent to the ATEM.
 * While a station is enabled the director leaves its channel alone.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer, type Server } from "node:net";
import { z } from "zod";
import type { DeviceHub } from "./devices.js";
import { publicUrl } from "./director.js";
import { casparClip } from "./timeline.js";
import { ClipIndex, decideShot, matchKey, micLive, parseClipName, parseNowPlaying, truthy, type ClipMatch, type MicState, type NowPlaying, type Shot, type ShotConfig } from "./vrlogic.js";

export const VR_LAYER = 10;
const TICK_MS = 100;
/** Metadata older than the item's duration plus this is considered stale (playout stopped or lost). */
const STALE_GRACE_MS = 15_000;
/** Without a duration, an item is considered stale after this long. */
const STALE_NO_DURATION_MS = 15 * 60_000;
const LOG_SIZE = 40;

export interface StationRow {
  id: number;
  name: string;
  enabled: number;
  channel_id: number | null;
  studio_id: number | null;
  caspar_channel: number;
  clip_input: number | null;
  wide_input: number | null;
  loop_input: number | null;
  fallback: "loop" | "wide";
  transition: "cut" | "mix";
  open_delay_ms: number;
  close_delay_ms: number;
  min_shot_ms: number;
  fuzzy_threshold: number;
  clip_source_id: number | null;
  clip_folder: string;
  rds_port: number | null;
  token: string;
}
interface MicRow {
  id: number;
  station_id: number;
  key: string;
  name: string;
  atem_input: number;
  priority: number;
}
interface ClipRow {
  id: number;
  media_id: number;
  artist: string;
  title: string;
  song_id: string | null;
  offset_ms: number;
  enabled: number;
  path: string;
  duration_ms: number | null;
  fps: number | null;
}

interface StationLive {
  np: (NowPlaying & { startedAt: number; receivedAt: number }) | null;
  match: (ClipMatch & { mediaId: number; path: string }) | null;
  clip: { clipId: number; title: string; endsAt: number | null } | null;
  mics: Map<string, MicState>;
  manualInput: number | null;
  paused: boolean;
  current: { input: number; since: number } | null;
  shot: Shot | null;
  lastError: string | null;
  log: { at: string; kind: string; text: string }[];
  /** Bumps on every now-playing message, so a slow CasparCG call for an older song is not applied late. */
  seq: number;
}

export const newToken = () => randomBytes(18).toString("base64url");

export class VisualRadio {
  private stations: StationRow[] = [];
  private mics = new Map<number, MicRow[]>();
  private live = new Map<number, StationLive>();
  private indexes = new Map<number, ClipIndex>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private listening = false;
  private rds = new Map<number, { stationId: number; tcp: Server; udp: UdpSocket }>();
  now = () => Date.now();

  constructor(
    private platform: Platform,
    private hub: DeviceHub,
  ) {
    this.reload();
  }

  start(intervalMs = TICK_MS) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    this.listening = true;
    this.syncRds();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.listening = false;
    this.syncRds();
  }

  /**
   * RDS listeners: playouts such as Zenlex send song info to an RDS encoder ("RT=Artist - Title") over TCP or UDP.
   * Pointing that output (or a second one) at this port gives Visual Radio the same information.
   */
  syncRds() {
    const want = new Map(this.listening ? this.stations.filter((s) => s.enabled && s.rds_port).map((s) => [s.rds_port!, s.id]) : []);
    for (const [port, l] of this.rds)
      if (want.get(port) !== l.stationId) {
        l.tcp.close();
        l.udp.close();
        this.rds.delete(port);
      }
    for (const [port, stationId] of want) {
      if (this.rds.has(port)) continue;
      const { log } = this.platform.ctx;
      const tcp = createServer((sock) => {
        let buf = "";
        sock.setEncoding("latin1");
        sock.on("data", (d: string) => {
          buf += d;
          const lines = buf.split(/\r\n|\r|\n/);
          buf = lines.pop() ?? "";
          if (buf.length > 4096) buf = "";
          for (const line of lines) if (line.trim()) void this.rdsLine(stationId, line), sock.write("OK\r\n");
        });
        sock.on("error", () => undefined);
      });
      tcp.on("error", (e) => log.warn({ port, err: e.message }, "visual radio RDS listener (tcp)"));
      tcp.listen(port);
      const udp = createSocket({ type: "udp4", reuseAddr: true });
      udp.on("message", (msg) => void this.rdsLine(stationId, msg.toString("latin1")));
      udp.on("error", (e) => log.warn({ port, err: e.message }, "visual radio RDS listener (udp)"));
      udp.bind(port);
      this.rds.set(port, { stationId, tcp, udp });
    }
  }

  /** One RDS command from the playout. Encoders get the same text repeatedly; only a new song counts. */
  async rdsLine(stationId: number, line: string) {
    const st = this.station(stationId);
    if (!st) return;
    const np = parseNowPlaying(line.trim());
    if (!np || !np.title) return;
    const cur = this.state(st.id).np;
    if (cur && cur.artist === np.artist && cur.title === np.title && this.playing(this.state(st.id), this.now()) != null) return;
    await this.nowPlaying(st, np);
  }

  /** Station or microphone settings changed. */
  reload() {
    const { db } = this.platform.ctx;
    this.stations = db.prepare("SELECT * FROM vr_stations ORDER BY name").all() as unknown as StationRow[];
    this.mics.clear();
    for (const m of db.prepare("SELECT * FROM vr_mics ORDER BY priority DESC, name").all() as unknown as MicRow[]) {
      const list = this.mics.get(m.station_id) ?? [];
      list.push(m);
      this.mics.set(m.station_id, list);
    }
    for (const id of this.live.keys()) if (!this.stations.some((s) => s.id === id)) this.live.delete(id);
    this.syncRds();
  }
  /** Clips of a station changed: the match index is rebuilt on the next lookup. */
  invalidateClips(stationId?: number) {
    if (stationId == null) this.indexes.clear();
    else this.indexes.delete(stationId);
  }

  /** The director skips channels that an enabled Visual Radio station drives. */
  owns(channelId: number) {
    return this.stations.some((s) => s.enabled && s.channel_id === channelId);
  }
  list() {
    return this.stations;
  }
  station(id: number) {
    return this.stations.find((s) => s.id === id);
  }
  byToken(token: string) {
    return this.stations.find((s) => s.token === token);
  }
  micsOf(id: number) {
    return this.mics.get(id) ?? [];
  }

  state(id: number): StationLive {
    let s = this.live.get(id);
    if (!s) {
      s = { np: null, match: null, clip: null, mics: new Map(), manualInput: null, paused: false, current: null, shot: null, lastError: null, log: [], seq: 0 };
      this.live.set(id, s);
    }
    return s;
  }
  private note(s: StationLive, kind: string, text: string) {
    s.log.unshift({ at: new Date(this.now()).toISOString(), kind, text });
    s.log.length = Math.min(s.log.length, LOG_SIZE);
  }

  index(st: StationRow) {
    let idx = this.indexes.get(st.id);
    if (!idx) {
      const { db } = this.platform.ctx;
      const clips = db
        .prepare("SELECT c.id, c.artist, c.title, c.song_id AS songId, m.duration_ms AS durationMs FROM vr_clips c JOIN media m ON m.id = c.media_id WHERE c.station_id = ? AND c.enabled = 1 AND m.missing = 0")
        .all(st.id) as unknown as { id: number; artist: string; title: string; songId: string | null; durationMs: number | null }[];
      const links = new Map((db.prepare("SELECT match_key, clip_id FROM vr_songs WHERE station_id = ? AND clip_id IS NOT NULL").all(st.id) as { match_key: string; clip_id: number }[]).map((r) => [r.match_key, r.clip_id]));
      idx = new ClipIndex(clips, links);
      this.indexes.set(st.id, idx);
    }
    return idx;
  }

  /** Clip for a song, with what is needed to play it. */
  find(st: StationRow, artist: string, title: string, songId: string | null) {
    const m = this.index(st).match(artist, title, songId, st.fuzzy_threshold);
    if (!m) return null;
    const row = this.platform.ctx.db.prepare("SELECT c.id, c.media_id, c.offset_ms, m.path, m.duration_ms, m.fps FROM vr_clips c JOIN media m ON m.id = c.media_id WHERE c.id = ?").get(m.clip.id) as
      | Pick<ClipRow, "id" | "media_id" | "offset_ms" | "path" | "duration_ms" | "fps">
      | undefined;
    return row ? { ...m, row } : null;
  }

  // ---- input from the radio -------------------------------------------------------

  async nowPlaying(st: StationRow, np: NowPlaying) {
    const s = this.state(st.id);
    const now = this.now();
    const seq = ++s.seq;
    // A start time in the future or far in the past (clock skew) is ignored.
    const startedAt = np.startedAt != null && np.startedAt <= now + 2000 && now - np.startedAt < 10 * 60_000 ? Math.min(np.startedAt, now) : now;
    s.np = { ...np, startedAt, receivedAt: now };
    const label = np.artist ? `${np.artist} - ${np.title}` : np.title;
    let found: ReturnType<VisualRadio["find"]> = null;
    if (np.type === "music" && np.title) {
      found = this.find(st, np.artist, np.title, np.songId);
      this.remember(st, np);
    }
    s.match = found ? { ...found, mediaId: found.row.media_id, path: found.row.path } : null;
    this.note(s, "song", found ? `${label} → ${found.clip.artist} - ${found.clip.title} (${found.how})` : `${label} (${np.type}${np.type === "music" ? ", no clip" : ""})`);
    const p = this.hub.playout(st.studio_id);
    if (!found) {
      s.clip = null;
      await p?.stop(st.caspar_channel, VR_LAYER).catch(() => undefined);
      return { label, clip: null };
    }
    const seekMs = Math.max(0, now - startedAt) + found.row.offset_ms;
    const duration = found.row.duration_ms;
    if (duration != null && seekMs >= duration - 1000) {
      s.clip = null;
      return { label, clip: null };
    }
    try {
      if (!p) throw new Error("no Visual Radio node (studio node) set for this station");
      const fps = found.row.fps || 25;
      await p.play(st.caspar_channel, VR_LAYER, casparClip(found.row.path), { seek: seekMs > 500 ? Math.floor((seekMs / 1000) * fps) : 0 });
      await p.volume?.(st.caspar_channel, VR_LAYER, 0).catch(() => undefined);
      if (seq !== s.seq) return { label, clip: found.clip };
      const played = this.now();
      s.clip = { clipId: found.clip.id, title: `${found.clip.artist} - ${found.clip.title}`, endsAt: duration != null ? played + duration - seekMs : null };
      s.lastError = null;
      this.platform.ctx.db.prepare("UPDATE vr_clips SET plays = plays + 1, last_played_at = ? WHERE id = ?").run(new Date(played).toISOString(), found.clip.id);
      if (st.channel_id) this.platform.ctx.db.prepare("INSERT INTO asrun (channel_id, kind, title, detail, ok) VALUES (?, 'visualradio', ?, ?, 1)").run(st.channel_id, s.clip.title, label);
    } catch (e) {
      s.clip = null;
      s.lastError = (e as Error).message;
      this.note(s, "error", s.lastError);
    }
    return { label, clip: found.clip };
  }

  /** Songs are kept so editors can see what is played without a clip and link one. */
  private remember(st: StationRow, np: NowPlaying) {
    const key = matchKey(np.artist, np.title);
    this.platform.ctx.db
      .prepare(
        `INSERT INTO vr_songs (station_id, match_key, artist, title, song_id, plays, last_at) VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (station_id, match_key) DO UPDATE SET plays = plays + 1, last_at = excluded.last_at, song_id = COALESCE(excluded.song_id, song_id), artist = excluded.artist, title = excluded.title`,
      )
      .run(st.id, key, np.artist, np.title, np.songId, new Date(this.now()).toISOString());
  }

  mic(st: StationRow, key: string, open: boolean) {
    const s = this.state(st.id);
    const now = this.now();
    const cur = s.mics.get(key);
    if (cur && cur.open === open) return;
    const wasLive = !!cur?.open && now - cur.since >= st.open_delay_ms;
    s.mics.set(key, { open, since: now, wasLive: open ? false : wasLive });
    const name = this.micsOf(st.id).find((m) => m.key === key)?.name ?? key;
    this.note(s, "mic", `${name} ${open ? "open" : "closed"}`);
  }

  // ---- the loop -----------------------------------------------------------------------

  config(st: StationRow): ShotConfig {
    return {
      clipInput: st.clip_input,
      wideInput: st.wide_input,
      loopInput: st.loop_input,
      fallback: st.fallback,
      openDelayMs: st.open_delay_ms,
      closeDelayMs: st.close_delay_ms,
      minShotMs: st.min_shot_ms,
      mics: this.micsOf(st.id).map((m) => ({ key: m.key, input: m.atem_input, priority: m.priority })),
    };
  }

  playing(s: StationLive, now: number) {
    if (!s.np) return null;
    const limit = s.np.durationMs != null ? s.np.startedAt + s.np.durationMs + STALE_GRACE_MS : s.np.receivedAt + STALE_NO_DURATION_MS;
    return now > limit ? null : s.np.type;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const st of this.stations) if (st.enabled) await this.step(st);
    } finally {
      this.busy = false;
    }
  }

  async step(st: StationRow) {
    const s = this.state(st.id);
    const now = this.now();
    const shot = decideShot(this.config(st), {
      now,
      manualInput: s.manualInput,
      mics: s.mics,
      playing: this.playing(s, now),
      clipRunning: !!s.clip && (s.clip.endsAt == null || now < s.clip.endsAt),
      current: s.current,
    });
    s.shot = shot;
    if (s.paused || shot.input == null || shot.input === s.current?.input) return;
    const ch = st.channel_id ? (this.platform.ctx.db.prepare("SELECT atem_id, atem_me FROM channels WHERE id = ?").get(st.channel_id) as { atem_id: number | null; atem_me: number } | undefined) : undefined;
    const sw = this.hub.switcher(ch?.atem_id);
    if (!ch || !sw) {
      if (s.lastError !== "no_atem") this.note(s, "error", "No ATEM linked to the station's channel");
      s.lastError = "no_atem";
      return;
    }
    try {
      await sw.program(shot.input, ch.atem_me, st.transition);
      s.current = { input: shot.input, since: now };
      if (s.lastError === "no_atem" || s.lastError?.startsWith("ATEM")) s.lastError = null;
      this.note(s, "shot", `${shot.reason}${shot.mic ? ` (${shot.mic})` : ""} → input ${shot.input}`);
    } catch (e) {
      const msg = `ATEM: ${(e as Error).message}`;
      if (s.lastError !== msg) this.note(s, "error", msg);
      s.lastError = msg;
    }
  }

  /** What the Live tab shows. */
  status(st: StationRow) {
    const s = this.state(st.id);
    const now = this.now();
    const cfg = this.config(st);
    return {
      enabled: !!st.enabled,
      nowPlaying: s.np && { artist: s.np.artist, title: s.np.title, type: s.np.type, songId: s.np.songId, durationMs: s.np.durationMs, startedAt: new Date(s.np.startedAt).toISOString(), stale: this.playing(s, now) == null },
      match: s.match && { clipId: s.match.clip.id, artist: s.match.clip.artist, title: s.match.clip.title, how: s.match.how, score: s.match.score },
      clip: s.clip && { ...s.clip, running: s.clip.endsAt == null || now < s.clip.endsAt, endsAt: s.clip.endsAt && new Date(s.clip.endsAt).toISOString() },
      mics: this.micsOf(st.id).map((m) => {
        const ms = s.mics.get(m.key);
        return { key: m.key, name: m.name, input: m.atem_input, open: !!ms?.open, live: micLive(ms, now, cfg) };
      }),
      shot: s.shot,
      onAir: s.current,
      manualInput: s.manualInput,
      paused: s.paused,
      lastError: s.lastError,
      log: s.log,
      clips: this.index(st).size,
    };
  }
}


// ---- clip library helpers ---------------------------------------------------------------

/** Splits one CSV line; `;` or `,`, double quotes for fields that contain the separator. */
export function csvSplit(line: string, sep: string) {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) out.push(cur.trim()), (cur = "");
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}
export interface CsvClip {
  artist: string;
  title: string;
  path: string;
  songId: string | null;
  offsetMs: number;
}
/** CSV with columns artist;title;path;songId;offsetMs (header row optional, any order when there is a header). */
export function parseClipCsv(text: string): CsvClip[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = (lines[0]!.match(/;/g)?.length ?? 0) >= (lines[0]!.match(/,/g)?.length ?? 0) ? ";" : ",";
  const first = csvSplit(lines[0]!, sep).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const hasHeader = first.includes("path") || first.includes("artist") || first.includes("file");
  const col = (names: string[], fallback: number) => {
    const i = first.findIndex((h) => names.includes(h));
    return hasHeader ? i : fallback;
  };
  const ci = { artist: col(["artist", "artiest"], 0), title: col(["title", "titel"], 1), path: col(["path", "file", "pad", "bestand"], 2), songId: col(["songid", "id", "externalid"], 3), offset: col(["offsetms", "offset"], 4) };
  return (hasHeader ? lines.slice(1) : lines)
    .map((l) => csvSplit(l, sep))
    .map((f) => ({
      artist: ci.artist >= 0 ? (f[ci.artist] ?? "") : "",
      title: ci.title >= 0 ? (f[ci.title] ?? "") : "",
      path: ci.path >= 0 ? (f[ci.path] ?? "") : "",
      songId: ci.songId >= 0 ? f[ci.songId] || null : null,
      offsetMs: ci.offset >= 0 ? Math.max(0, Math.round(Number(f[ci.offset] ?? 0)) || 0) : 0,
    }))
    .filter((r) => r.path && (r.artist || r.title));
}

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();

// ---- routes -------------------------------------------------------------------------------------

const input = z.number().int().min(0).max(100_000).nullable().optional();
const stationIn = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(false),
  channelId: z.number().int().nullable().optional(),
  studioId: z.number().int().nullable().optional(),
  casparChannel: z.number().int().min(1).max(64).default(1),
  clipInput: input,
  wideInput: input,
  loopInput: input,
  fallback: z.enum(["loop", "wide"]).default("loop"),
  transition: z.enum(["cut", "mix"]).default("cut"),
  openDelayMs: z.number().int().min(0).max(10_000).default(250),
  closeDelayMs: z.number().int().min(0).max(30_000).default(1500),
  minShotMs: z.number().int().min(0).max(60_000).default(3000),
  fuzzyThreshold: z.number().min(0.5).max(1).default(0.82),
  clipSourceId: z.number().int().nullable().optional(),
  clipFolder: z.string().trim().max(500).default(""),
  rdsPort: z.number().int().min(1024).max(65535).nullable().optional(),
  mics: z
    .array(z.object({ key: z.string().trim().min(1).max(40).regex(/^[\w.-]+$/), name: z.string().trim().min(1).max(80), input: z.number().int().min(0).max(100_000), priority: z.number().int().min(0).max(100).default(0) }))
    .max(16)
    .default([]),
});

export function registerVisualRadio(app: FastifyInstance, platform: Platform, vr: VisualRadio, onChannelsChanged: () => void) {
  const { db } = platform.ctx;
  const id = (req: { params: unknown }) => Number((req.params as { id: string }).id);
  const station = (req: { params: unknown }) => {
    const st = vr.station(id(req));
    if (!st) throw new HttpError(404, "not_found");
    return st;
  };
  const urls = (st: StationRow) => {
    const base = `${publicUrl(platform)}/visualradio/${st.token}`;
    return { nowPlaying: `${base}/nowplaying`, mic: `${base}/mic` };
  };
  const out = (st: StationRow) => ({
    id: st.id,
    name: st.name,
    enabled: !!st.enabled,
    channelId: st.channel_id,
    studioId: st.studio_id,
    casparChannel: st.caspar_channel,
    clipInput: st.clip_input,
    wideInput: st.wide_input,
    loopInput: st.loop_input,
    fallback: st.fallback,
    transition: st.transition,
    openDelayMs: st.open_delay_ms,
    closeDelayMs: st.close_delay_ms,
    minShotMs: st.min_shot_ms,
    fuzzyThreshold: st.fuzzy_threshold,
    clipSourceId: st.clip_source_id,
    clipFolder: st.clip_folder,
    rdsPort: st.rds_port,
    mics: vr.micsOf(st.id).map((m) => ({ key: m.key, name: m.name, input: m.atem_input, priority: m.priority })),
    urls: urls(st),
  });

  // ---- public ingest (secret token in the URL, no login: called by the radio playout / desk) ----
  app.register(async (scope) => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
    scope.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
    const byToken = (req: FastifyRequest) => {
      const st = vr.byToken((req.params as { token: string }).token);
      if (!st) throw new HttpError(404, "not_found");
      return st;
    };
    scope.route({
      method: ["GET", "POST", "PUT"],
      url: "/visualradio/:token/nowplaying",
      handler: async (req) => {
        const st = byToken(req);
        const np = parseNowPlaying(req.body, req.query as Record<string, unknown>);
        if (!np) throw new HttpError(400, "no_metadata");
        const r = await vr.nowPlaying(st, np);
        return { ok: true, type: np.type, item: r.label, clip: r.clip && `${r.clip.artist} - ${r.clip.title}` };
      },
    });
    const micHandler = async (req: FastifyRequest) => {
      const st = byToken(req);
      const p = req.params as { mic?: string; state?: string };
      const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const q = req.query as Record<string, unknown>;
      const key = String(p.mic ?? b.mic ?? q.mic ?? "").trim();
      const state = p.state ?? b.open ?? b.state ?? q.open ?? q.state;
      if (!key || state == null) throw new HttpError(400, "mic_required");
      vr.mic(st, key, truthy(state));
      return { ok: true };
    };
    scope.route({ method: ["GET", "POST", "PUT"], url: "/visualradio/:token/mic", handler: micHandler });
    scope.route({ method: ["GET", "POST", "PUT"], url: "/visualradio/:token/mic/:mic/:state", handler: micHandler });
  });

  // ---- stations ----
  app.get("/api/visualradio/stations", async () => ({ stations: vr.list().map(out) }));
  const save = (b: z.infer<typeof stationIn>, existing?: StationRow) => {
    if (b.rdsPort && vr.list().some((s) => s.rds_port === b.rdsPort && s.id !== existing?.id)) throw new HttpError(409, "port_in_use");
    const vals = [b.name, b.enabled ? 1 : 0, b.channelId ?? null, b.studioId ?? null, b.casparChannel, b.clipInput ?? null, b.wideInput ?? null, b.loopInput ?? null, b.fallback, b.transition, b.openDelayMs, b.closeDelayMs, b.minShotMs, b.fuzzyThreshold, b.clipSourceId ?? null, b.clipFolder, b.rdsPort ?? null];
    let sid: number;
    if (existing) {
      db.prepare(
        "UPDATE vr_stations SET name = ?, enabled = ?, channel_id = ?, studio_id = ?, caspar_channel = ?, clip_input = ?, wide_input = ?, loop_input = ?, fallback = ?, transition = ?, open_delay_ms = ?, close_delay_ms = ?, min_shot_ms = ?, fuzzy_threshold = ?, clip_source_id = ?, clip_folder = ?, rds_port = ? WHERE id = ?",
      ).run(...vals, existing.id);
      sid = existing.id;
    } else {
      const r = db
        .prepare(
          "INSERT INTO vr_stations (name, enabled, channel_id, studio_id, caspar_channel, clip_input, wide_input, loop_input, fallback, transition, open_delay_ms, close_delay_ms, min_shot_ms, fuzzy_threshold, clip_source_id, clip_folder, rds_port, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(...vals, newToken());
      sid = Number(r.lastInsertRowid);
    }
    db.prepare("DELETE FROM vr_mics WHERE station_id = ?").run(sid);
    const ins = db.prepare("INSERT INTO vr_mics (station_id, key, name, atem_input, priority) VALUES (?, ?, ?, ?, ?)");
    const seen = new Set<string>();
    for (const m of b.mics) if (!seen.has(m.key)) seen.add(m.key), ins.run(sid, m.key, m.name, m.input, m.priority);
    vr.reload();
    vr.invalidateClips(sid);
    onChannelsChanged();
    return sid;
  };
  app.post("/api/visualradio/stations", async (req) => {
    requireRole(req, "admin");
    return { ok: true, id: save(stationIn.parse(req.body)) };
  });
  app.put("/api/visualradio/stations/:id", async (req) => {
    requireRole(req, "admin");
    return { ok: true, id: save(stationIn.parse(req.body), station(req)) };
  });
  app.delete("/api/visualradio/stations/:id", async (req) => {
    requireRole(req, "admin");
    db.prepare("DELETE FROM vr_stations WHERE id = ?").run(id(req));
    vr.reload();
    onChannelsChanged();
    return { ok: true };
  });
  app.post("/api/visualradio/stations/:id/token", async (req) => {
    requireRole(req, "admin");
    const st = station(req);
    db.prepare("UPDATE vr_stations SET token = ? WHERE id = ?").run(newToken(), st.id);
    vr.reload();
    return { ok: true, urls: urls(vr.station(st.id)!) };
  });

  // ---- live ----
  app.get("/api/visualradio/stations/:id/live", async (req) => vr.status(station(req)));
  app.post("/api/visualradio/stations/:id/manual", async (req) => {
    requireRole(req, "operator");
    const b = z.object({ input: z.number().int().min(0).nullable().optional(), paused: z.boolean().optional() }).parse(req.body);
    const s = vr.state(station(req).id);
    if (b.input !== undefined) s.manualInput = b.input;
    if (b.paused !== undefined) s.paused = b.paused;
    return { ok: true };
  });
  // Test buttons in the UI: the same as a message from the playout or the desk.
  app.post("/api/visualradio/stations/:id/simulate", async (req) => {
    requireRole(req, "operator");
    const st = station(req);
    const b = z
      .object({ artist: z.string().max(200).default(""), title: z.string().max(200).default(""), type: z.enum(["music", "jingle", "ad", "news", "voice", "other"]).default("music"), mic: z.string().max(40).optional(), open: z.boolean().optional() })
      .parse(req.body);
    if (b.mic) {
      vr.mic(st, b.mic, !!b.open);
      return { ok: true };
    }
    const r = await vr.nowPlaying(st, { artist: b.artist, title: b.title, type: b.type, songId: null, durationMs: null, startedAt: null });
    return { ok: true, clip: r.clip && `${r.clip.artist} - ${r.clip.title}` };
  });
  app.get("/api/visualradio/stations/:id/match", async (req) => {
    const st = station(req);
    const q = z.object({ artist: z.string().default(""), title: z.string().default(""), songId: z.string().optional() }).parse(req.query);
    const m = vr.find(st, q.artist, q.title, q.songId ?? null);
    return { match: m && { clipId: m.clip.id, artist: m.clip.artist, title: m.clip.title, how: m.how, score: m.score }, key: matchKey(q.artist, q.title) };
  });

  // ---- clip library ----
  app.get("/api/visualradio/stations/:id/clips", async (req) => {
    const st = station(req);
    const q = z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    const where = ["c.station_id = ?"];
    const args: (string | number)[] = [st.id];
    if (q.q) {
      where.push("(c.artist LIKE ? OR c.title LIKE ? OR m.path LIKE ?)");
      args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
    }
    const clips = db
      .prepare(
        `SELECT c.id, c.artist, c.title, c.song_id AS songId, c.offset_ms AS offsetMs, c.enabled, c.manual, c.plays, c.last_played_at AS lastPlayedAt, m.path, m.duration_ms AS durationMs, m.missing
         FROM vr_clips c JOIN media m ON m.id = c.media_id WHERE ${where.join(" AND ")} ORDER BY c.artist COLLATE NOCASE, c.title COLLATE NOCASE LIMIT ?`,
      )
      .all(...args, q.limit) as Record<string, unknown>[];
    const total = (db.prepare("SELECT COUNT(*) AS n FROM vr_clips WHERE station_id = ?").get(st.id) as { n: number }).n;
    return { total, clips: clips.map((c) => ({ ...c, enabled: !!c.enabled, manual: !!c.manual, missing: !!c.missing })) };
  });
  /** Builds the clip list from the media library: every file in the clip folder named "Artist - Title". */
  app.post("/api/visualradio/stations/:id/clips/scan", async (req) => {
    requireRole(req, "editor");
    const st = station(req);
    if (!st.clip_source_id) throw new HttpError(400, "no_clip_source");
    const folder = normPath(st.clip_folder).replace(/\/+$/, "");
    const media = (db.prepare("SELECT id, path, name FROM media WHERE source_id = ? AND missing = 0").all(st.clip_source_id) as { id: number; path: string; name: string }[]).filter(
      (m) => !folder || normPath(m.path).startsWith(`${folder}/`),
    );
    const find = db.prepare("SELECT id, manual FROM vr_clips WHERE station_id = ? AND media_id = ?");
    const ins = db.prepare("INSERT INTO vr_clips (station_id, media_id, artist, title) VALUES (?, ?, ?, ?)");
    const upd = db.prepare("UPDATE vr_clips SET artist = ?, title = ? WHERE id = ?");
    let added = 0;
    let updated = 0;
    let unnamed = 0;
    for (const m of media) {
      const parsed = parseClipName(m.path);
      if (!parsed) {
        unnamed++;
        continue;
      }
      const cur = find.get(st.id, m.id) as { id: number; manual: number } | undefined;
      if (!cur) ins.run(st.id, m.id, parsed.artist, parsed.title), added++;
      else if (!cur.manual) upd.run(parsed.artist, parsed.title, cur.id), updated++;
    }
    vr.invalidateClips(st.id);
    return { ok: true, files: media.length, added, updated, unnamed };
  });
  /** CSV export of an existing clip database: artist;title;path;songId;offsetMs. Paths are matched to the media library. */
  app.post("/api/visualradio/stations/:id/clips/import", async (req) => {
    requireRole(req, "editor");
    const st = station(req);
    const b = z.object({ csv: z.string().max(20_000_000) }).parse(req.body);
    const rows = parseClipCsv(b.csv);
    const media = db.prepare(`SELECT id, path FROM media WHERE missing = 0 ${st.clip_source_id ? "AND source_id = ?" : ""}`).all(...(st.clip_source_id ? [st.clip_source_id] : [])) as { id: number; path: string }[];
    const byPath = new Map(media.map((m) => [normPath(m.path), m.id]));
    const byName = new Map<string, number | null>();
    for (const m of media) {
      const n = normPath(m.path).replace(/^.*\//, "");
      byName.set(n, byName.has(n) ? null : m.id); // ambiguous names are not used
    }
    const upsert = db.prepare(
      `INSERT INTO vr_clips (station_id, media_id, artist, title, song_id, offset_ms, manual) VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (station_id, media_id) DO UPDATE SET artist = excluded.artist, title = excluded.title, song_id = excluded.song_id, offset_ms = excluded.offset_ms, manual = 1`,
    );
    let imported = 0;
    const notFound: string[] = [];
    for (const r of rows) {
      const p = normPath(r.path);
      const mediaId = byPath.get(p) ?? [...byPath.entries()].find(([k]) => k.endsWith(`/${p}`) || p.endsWith(`/${k}`))?.[1] ?? byName.get(p.replace(/^.*\//, "")) ?? null;
      if (mediaId == null) {
        if (notFound.length < 50) notFound.push(r.path);
        continue;
      }
      const name = r.artist && r.title ? r : (parseClipName(r.path) ?? r);
      upsert.run(st.id, mediaId, name.artist, name.title, r.songId, r.offsetMs);
      imported++;
    }
    vr.invalidateClips(st.id);
    return { ok: true, rows: rows.length, imported, notFound };
  });
  app.put("/api/visualradio/clips/:id", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ artist: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(200), songId: z.string().trim().max(100).nullable().optional(), offsetMs: z.number().int().min(0).max(600_000).default(0), enabled: z.boolean().default(true) }).parse(req.body);
    const r = db.prepare("UPDATE vr_clips SET artist = ?, title = ?, song_id = ?, offset_ms = ?, enabled = ?, manual = 1 WHERE id = ?").run(b.artist, b.title, b.songId || null, b.offsetMs, b.enabled ? 1 : 0, id(req));
    if (!r.changes) throw new HttpError(404, "not_found");
    vr.invalidateClips();
    return { ok: true };
  });

  // ---- songs without a clip ----
  app.get("/api/visualradio/stations/:id/missing", async (req) => {
    const st = station(req);
    const idx = vr.index(st);
    const songs = (db.prepare("SELECT id, match_key AS matchKey, artist, title, song_id AS songId, plays, last_at AS lastAt FROM vr_songs WHERE station_id = ? AND clip_id IS NULL ORDER BY plays DESC, last_at DESC LIMIT 1000").all(st.id) as {
      id: number;
      artist: string;
      title: string;
      songId: string | null;
    }[]).filter((s) => !idx.match(s.artist, s.title, s.songId, st.fuzzy_threshold));
    return { songs: songs.slice(0, 200), total: songs.length };
  });
  app.post("/api/visualradio/songs/:id/link", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ clipId: z.number().int().nullable() }).parse(req.body);
    const song = db.prepare("SELECT station_id FROM vr_songs WHERE id = ?").get(id(req)) as { station_id: number } | undefined;
    if (!song) throw new HttpError(404, "not_found");
    if (b.clipId != null && !db.prepare("SELECT 1 FROM vr_clips WHERE id = ? AND station_id = ?").get(b.clipId, song.station_id)) throw new HttpError(400, "no_such_clip");
    db.prepare("UPDATE vr_songs SET clip_id = ? WHERE id = ?").run(b.clipId, id(req));
    vr.invalidateClips(song.station_id);
    return { ok: true };
  });
  app.delete("/api/visualradio/songs/:id", async (req) => {
    requireRole(req, "editor");
    db.prepare("DELETE FROM vr_songs WHERE id = ?").run(id(req));
    return { ok: true };
  });
}
