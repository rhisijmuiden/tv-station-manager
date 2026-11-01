/**
 * Stream output: sends a CasparCG channel (the programme with logo and graphics) or a remote source (a live event as
 * it comes in) over RTMP(S) to one or more destinations: the station's own stream server for the website, YouTube,
 * Facebook, Twitch or any RTMP server.
 *
 * - Channel: CasparCG encodes the channel once (`ADD <ch>-<700+id> STREAM ...`) and publishes it to the ingest server
 *   (MediaMTX) on its own studio node at `program/out-<id>`. Nothing new has to be installed on the studio node.
 * - Remote source: the stream the contributor pushes to `live/<key>` is used as is (no second encode).
 * - This management node runs one `ffmpeg -c copy` relay per destination that pulls the stream from the ingest
 *   server and pushes it to the destination, so one encode feeds every destination and a destination that fails
 *   (wrong key, platform down) does not affect the others. Relays restart with a back-off.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { spawn, type ChildProcess } from "node:child_process";
import type { DeviceHub } from "./devices.js";
import { INGEST_API_USER, streamPath, type LiveRow, type RemoteSources } from "./remote.js";

export const OUTPUT_CONSUMER_BASE = 700;
/** CasparCG did not get the encoder to publish within this time: remove and add it again. */
const ENCODER_START_MS = 20_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export type DestinationPlatform = "custom" | "youtube" | "facebook" | "twitch";
export const PLATFORM_SERVERS: Record<Exclude<DestinationPlatform, "custom">, string> = {
  youtube: "rtmp://a.rtmp.youtube.com/live2",
  facebook: "rtmps://live-api-s.facebook.com:443/rtmp",
  twitch: "rtmp://live.twitch.tv/app",
};

export interface DestinationRow {
  id: number;
  name: string;
  platform: DestinationPlatform;
  url: string;
  stream_key: string;
  enabled: number;
}
export interface OutputRow {
  id: number;
  name: string;
  source: "channel" | "remote";
  studio_id: number | null;
  caspar_channel: number | null;
  live_source_id: number | null;
  encoder: "x264" | "nvenc";
  video_kbps: number;
  audio_kbps: number;
  resolution: "source" | "720p";
  deinterlace: number;
  extra_args: string;
  active: number;
}

/** Server URL + stream key -> the URL ffmpeg publishes to. */
export function destinationUrl(d: Pick<DestinationRow, "platform" | "url" | "stream_key">) {
  const base = (d.url || (d.platform !== "custom" ? PLATFORM_SERVERS[d.platform] : "")).trim().replace(/\/+$/, "");
  return d.stream_key ? `${base}/${d.stream_key}` : base;
}
/** The destination URL without its secret, for the UI and the log. */
export function maskedUrl(d: Pick<DestinationRow, "platform" | "url" | "stream_key">) {
  const full = destinationUrl(d);
  if (d.stream_key) return full.slice(0, full.length - d.stream_key.length) + "••••" + d.stream_key.slice(-4);
  return full.replace(/\/\/([^/@]+)@/, "//••••@");
}
const hideSecrets = (text: string, secrets: string[]) => secrets.filter((s) => s.length >= 4).reduce((t, s) => t.split(s).join("••••"), text);

/** Options for CasparCG's FFmpeg (STREAM) consumer. */
export function encoderArgs(o: Pick<OutputRow, "encoder" | "video_kbps" | "audio_kbps" | "resolution" | "deinterlace" | "extra_args">) {
  // yuv420p: players and platforms do not accept the 4:4:4 that CasparCG's BGRA frames would otherwise give.
  const filters = [o.deinterlace ? "yadif=0:-1:0" : null, o.resolution === "720p" ? "scale=1280:720" : null, "format=yuv420p"].filter(Boolean).join(",");
  const v = o.video_kbps;
  const codec = o.encoder === "nvenc" ? "-codec:v h264_nvenc -preset:v p4 -tune:v ll -rc:v cbr" : "-codec:v libx264 -preset:v veryfast -tune:v zerolatency";
  return [`-format flv -filter:v ${filters}`, codec, `-b:v ${v}k -maxrate:v ${v}k -bufsize:v ${v * 2}k -g:v 50 -codec:a aac -b:a ${o.audio_kbps}k`, o.extra_args.trim()].filter(Boolean).join(" ");
}

export const programPath = (outputId: number) => `program/out-${outputId}`;

export type RelayState = "starting" | "live" | "retrying";
interface Relay {
  outputId: number;
  destId: number;
  src: string;
  dst: string;
  secrets: string[];
  proc: ChildProcess | null;
  state: RelayState;
  startedAt: number;
  liveSince: string | null;
  kbps: number | null;
  error: string | null;
  restarts: number;
  nextTry: number;
}
interface Encoder {
  studioId: number;
  channel: number;
  args: string;
  session: number | undefined;
  addedAt: number;
  error: string | null;
  failedAt: number;
}

export type Spawner = (cmd: string, args: string[]) => ChildProcess;

export interface OutputStatus {
  state: "off" | "waiting" | "starting" | "live" | "error";
  /** Why the source cannot be streamed yet (no studio node, CasparCG offline, stream not coming in). */
  reason: string | null;
  encoderError: string | null;
  destinations: { id: number; state: RelayState | "off" | "disabled"; liveSince: string | null; kbps: number | null; error: string | null; restarts: number }[];
}

export class StreamOutputs {
  private relays = new Map<string, Relay>();
  private encoders = new Map<number, Encoder>();
  private reasons = new Map<number, string | null>();
  private busy = false;
  spawner: Spawner = (cmd, args) => spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  ffmpeg = process.env.TVSM_FFMPEG || "ffmpeg";

  constructor(
    private platform: Platform,
    private hub: DeviceHub,
    private remote: RemoteSources,
  ) {
    remote.afterPoll.push(() => this.reconcile());
  }

  private get db() {
    return this.platform.ctx.db;
  }
  outputs() {
    return this.db.prepare("SELECT * FROM stream_outputs ORDER BY name").all() as unknown as OutputRow[];
  }
  output(id: number) {
    return this.db.prepare("SELECT * FROM stream_outputs WHERE id = ?").get(id) as OutputRow | undefined;
  }
  destinations() {
    return this.db.prepare("SELECT * FROM stream_destinations ORDER BY name").all() as unknown as DestinationRow[];
  }
  destinationIds(outputId: number) {
    return (this.db.prepare("SELECT destination_id AS id FROM stream_output_destinations WHERE output_id = ? ORDER BY destination_id").all(outputId) as { id: number }[]).map((r) => r.id);
  }

  private studio(id: number | null) {
    return id == null ? undefined : (this.db.prepare("SELECT id, host FROM studio_nodes WHERE id = ? AND enabled = 1").get(id) as { id: number; host: string } | undefined);
  }
  /** URL the relays read from on the studio node's ingest server (they log in as the management node). */
  private ingestUrl(host: string, path: string) {
    return `rtmp://${host}:1935/${path}?user=${INGEST_API_USER}&pass=${this.remote.apiToken()}`;
  }

  /** Where the relays read this output from, or why there is nothing to read yet. */
  private source(o: OutputRow): { url: string | null; reason: string | null; secrets: string[] } {
    const token = this.remote.apiToken();
    if (o.source === "channel") {
      const s = this.studio(o.studio_id);
      if (!s || !o.caspar_channel) return { url: null, reason: "no_studio", secrets: [] };
      const enc = this.encoders.get(o.id);
      if (!enc || enc.session === undefined) return { url: null, reason: enc?.error ? "encoder_failed" : "casparcg_offline", secrets: [] };
      const st = this.remote.pathStatus(s.id, programPath(o.id));
      if (st === undefined || (st && !st.online)) return { url: null, reason: "encoder_starting", secrets: [] };
      return { url: this.ingestUrl(s.host, programPath(o.id)), reason: null, secrets: [token] };
    }
    const live = o.live_source_id == null ? undefined : (this.db.prepare("SELECT * FROM live_sources WHERE id = ?").get(o.live_source_id) as LiveRow | undefined);
    if (!live || live.kind !== "rtmp") return { url: null, reason: "no_source", secrets: [] };
    if (live.url) return { url: live.url, reason: null, secrets: [] };
    const s = this.studio(live.studio_id);
    if (!s || !live.stream_key) return { url: null, reason: "no_studio", secrets: [] };
    const st = this.remote.status(live).state;
    if (st === "waiting") return { url: null, reason: "waiting_for_stream", secrets: [] };
    return { url: this.ingestUrl(s.host, streamPath(live.stream_key)), reason: null, secrets: [token, live.stream_key] };
  }

  /** Brings encoders and relays in line with the active outputs. Runs after every ingest poll and after changes. */
  async reconcile() {
    if (this.busy) return;
    this.busy = true;
    try {
      const outputs = this.outputs();
      const active = outputs.filter((o) => o.active);
      // 1. CasparCG encoders for channel outputs.
      for (const [id, enc] of this.encoders) {
        const o = active.find((x) => x.id === id);
        if (!o || o.source !== "channel" || o.studio_id !== enc.studioId || o.caspar_channel !== enc.channel || encoderArgs(o) !== enc.args) await this.removeEncoder(id);
      }
      for (const o of active) if (o.source === "channel") await this.ensureEncoder(o);
      // 2. Relays: one per active output and enabled destination, while the source is there.
      const dests = new Map(this.destinations().map((d) => [d.id, d]));
      const wanted = new Map<string, { o: OutputRow; d: DestinationRow; src: string; secrets: string[] }>();
      this.reasons.clear();
      for (const o of active) {
        const src = this.source(o);
        this.reasons.set(o.id, src.reason);
        if (!src.url) continue;
        for (const did of this.destinationIds(o.id)) {
          const d = dests.get(did);
          if (d?.enabled) wanted.set(`${o.id}:${d.id}`, { o, d, src: src.url, secrets: [...src.secrets, d.stream_key] });
        }
      }
      for (const [key, r] of this.relays) {
        const w = wanted.get(key);
        if (!w || w.src !== r.src || destinationUrl(w.d) !== r.dst) this.kill(key);
      }
      const now = Date.now();
      for (const [key, w] of wanted) {
        let r = this.relays.get(key);
        if (!r) {
          r = { outputId: w.o.id, destId: w.d.id, src: w.src, dst: destinationUrl(w.d), secrets: w.secrets, proc: null, state: "starting", startedAt: 0, liveSince: null, kbps: null, error: null, restarts: 0, nextTry: 0 };
          this.relays.set(key, r);
        }
        if (!r.proc && now >= r.nextTry) this.startRelay(key, r);
      }
    } finally {
      this.busy = false;
    }
  }

  private async ensureEncoder(o: OutputRow) {
    const p = this.hub.playout(o.studio_id);
    const info = p?.info();
    const args = encoderArgs(o);
    let enc = this.encoders.get(o.id);
    if (!p || !info?.connected || !o.studio_id || !o.caspar_channel) {
      if (enc) enc.session = undefined;
      return;
    }
    if (!enc) {
      enc = { studioId: o.studio_id, channel: o.caspar_channel, args, session: undefined, addedAt: 0, error: null, failedAt: 0 };
      this.encoders.set(o.id, enc);
    }
    const st = this.remote.pathStatus(o.studio_id, programPath(o.id));
    const stalled = enc.session !== undefined && st !== null && !st?.online && Date.now() - enc.addedAt > ENCODER_START_MS;
    if (enc.session === info.session && !stalled) return;
    if (enc.error && Date.now() - enc.failedAt < RETRY_MAX_MS / 2) return;
    const index = OUTPUT_CONSUMER_BASE + o.id;
    // Stalled, or first time since this node started: an old consumer may still be there. After a CasparCG restart
    // it is gone anyway.
    if (enc.session === info.session || enc.addedAt === 0) await p.removeConsumer(o.caspar_channel, index).catch(() => undefined);
    try {
      await p.addConsumer(o.caspar_channel, index, "STREAM", `rtmp://127.0.0.1:1935/${programPath(o.id)} ${args}`);
      enc.session = info.session;
      enc.addedAt = Date.now();
      enc.error = stalled ? "the encoder did not start publishing; added again" : null;
      this.platform.ctx.log.info({ output: o.name, channel: o.caspar_channel }, "stream output encoder started on CasparCG");
    } catch (e) {
      const msg = (e as Error).message;
      if (enc.error !== msg) this.platform.ctx.log.warn({ output: o.name, err: msg }, "could not start stream output encoder");
      enc.session = undefined;
      enc.error = msg;
      enc.failedAt = Date.now();
    }
  }

  private async removeEncoder(id: number) {
    const enc = this.encoders.get(id);
    this.encoders.delete(id);
    if (!enc || enc.session === undefined) return;
    const p = this.hub.playout(enc.studioId);
    if (p?.info().connected && p.info().session === enc.session) await p.removeConsumer(enc.channel, OUTPUT_CONSUMER_BASE + id).catch(() => undefined);
  }

  private startRelay(key: string, r: Relay) {
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-rw_timeout", "15000000", "-i", r.src, "-c", "copy", "-f", "flv", "-flvflags", "no_duration_filesize", "-progress", "pipe:1", "-nostats", r.dst];
    let proc: ChildProcess;
    try {
      proc = this.spawner(this.ffmpeg, args);
    } catch (e) {
      r.error = (e as Error).message;
      r.state = "retrying";
      r.nextTry = Date.now() + RETRY_MAX_MS;
      return;
    }
    r.proc = proc;
    r.state = "starting";
    r.startedAt = Date.now();
    r.kbps = null;
    let lastErr = "";
    let buf = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const [k, v] = line.trim().split("=", 2);
        if (k === "bitrate") {
          const n = Number.parseFloat(v ?? "");
          r.kbps = Number.isFinite(n) ? Math.round(n) : r.kbps;
        } else if (k === "total_size" && Number(v) > 0 && r.state !== "live" && r.proc === proc) {
          r.state = "live";
          r.liveSince = new Date().toISOString();
          r.error = null;
        }
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const l = chunk.toString().trim().split("\n").filter(Boolean).pop();
      if (l) lastErr = hideSecrets(l, r.secrets).slice(0, 300);
    });
    const done = (code: number | null, err?: Error) => {
      if (r.proc !== proc) return;
      r.proc = null;
      if (this.relays.get(key) !== r) return;
      const ranFor = Date.now() - r.startedAt;
      if (ranFor > RETRY_MAX_MS) r.restarts = 0;
      r.restarts++;
      r.state = "retrying";
      r.liveSince = null;
      r.kbps = null;
      r.error = err ? hideSecrets(err.message, r.secrets) : lastErr || `ffmpeg exited (${code ?? "signal"})`;
      r.nextTry = Date.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(r.restarts - 1, 4));
      this.platform.ctx.log.warn({ output: r.outputId, destination: r.destId, err: r.error }, "stream output relay stopped; retrying");
    };
    proc.on("exit", (code) => done(code));
    proc.on("error", (e) => done(null, (e as NodeJS.ErrnoException).code === "ENOENT" ? new Error("ffmpeg is not installed on the management node") : e));
  }

  private kill(key: string) {
    const r = this.relays.get(key);
    this.relays.delete(key);
    if (r?.proc && r.proc.exitCode === null) r.proc.kill("SIGTERM");
  }

  async setActive(id: number, on: boolean) {
    this.db.prepare("UPDATE stream_outputs SET active = ? WHERE id = ?").run(on ? 1 : 0, id);
    for (const key of [...this.relays.keys()]) if (key.startsWith(`${id}:`)) this.relays.get(key)!.nextTry = 0;
    await this.reconcile();
  }

  /** Forgets everything of this output (before it is deleted or changed). */
  async drop(id: number) {
    for (const key of [...this.relays.keys()]) if (key.startsWith(`${id}:`)) this.kill(key);
    await this.removeEncoder(id);
  }

  status(o: OutputRow): OutputStatus {
    const dests = new Map(this.destinations().map((d) => [d.id, d]));
    const enc = this.encoders.get(o.id);
    const ds = this.destinationIds(o.id).map((id) => {
      const d = dests.get(id);
      const r = this.relays.get(`${o.id}:${id}`);
      if (!o.active || !d) return { id, state: "off" as const, liveSince: null, kbps: null, error: null, restarts: 0 };
      if (!d.enabled) return { id, state: "disabled" as const, liveSince: null, kbps: null, error: null, restarts: 0 };
      if (!r) return { id, state: "off" as const, liveSince: null, kbps: null, error: null, restarts: 0 };
      return { id, state: r.state, liveSince: r.liveSince, kbps: r.kbps, error: r.error, restarts: r.restarts };
    });
    const reason = !o.active ? null : !ds.some((d) => d.state !== "disabled") ? "no_destinations" : (this.reasons.get(o.id) ?? null);
    const running = ds.filter((d) => d.state !== "off" && d.state !== "disabled");
    let state: OutputStatus["state"] = "off";
    if (o.active) {
      if (reason) state = reason === "encoder_failed" || reason === "no_destinations" ? "error" : "waiting";
      else if (running.length && running.every((d) => d.state === "live")) state = "live";
      else if (running.some((d) => d.state === "retrying" && d.restarts > 2)) state = "error";
      else state = running.length ? "starting" : "waiting";
    }
    return { state, reason, encoderError: enc?.error ?? null, destinations: ds };
  }

  stop() {
    for (const key of [...this.relays.keys()]) this.kill(key);
  }
}

// ---- API -------------------------------------------------------------------------

const rtmpUrl = z
  .string()
  .trim()
  .max(1000)
  .regex(/^rtmps?:\/\/[^\s"]+$/, "rtmp_url");
const destIn = z.object({
  name: z.string().trim().min(1).max(80),
  platform: z.enum(["custom", "youtube", "facebook", "twitch"]),
  url: z.union([rtmpUrl, z.literal("")]).optional(),
  /** Empty or left out on an update: keep the stored key. */
  streamKey: z
    .string()
    .trim()
    .max(500)
    .regex(/^[^\s"]*$/)
    .optional(),
  clearKey: z.boolean().optional(),
  enabled: z.boolean().default(true),
});
const outIn = z
  .object({
    name: z.string().trim().min(1).max(80),
    source: z.enum(["channel", "remote"]),
    studioId: z.number().int().nullable().optional(),
    casparChannel: z.number().int().min(1).max(16).nullable().optional(),
    liveSourceId: z.number().int().nullable().optional(),
    encoder: z.enum(["x264", "nvenc"]).default("x264"),
    videoKbps: z.number().int().min(300).max(25_000).default(4500),
    audioKbps: z.number().int().min(64).max(320).default(160),
    resolution: z.enum(["source", "720p"]).default("source"),
    deinterlace: z.boolean().default(true),
    extraArgs: z
      .string()
      .trim()
      .max(300)
      .regex(/^[\w\s:=.,+\-/]*$/, "extra_args")
      .default(""),
    destinationIds: z.array(z.number().int()).max(20).default([]),
  })
  .refine((v) => (v.source === "channel" ? !!v.studioId && !!v.casparChannel : !!v.liveSourceId), { message: "output_needs_source" });

export function registerOutputs(app: FastifyInstance, platform: Platform, outputs: StreamOutputs, hub: DeviceHub) {
  const { db } = platform.ctx;
  const id = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  const destOut = (d: DestinationRow) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    url: d.url,
    server: (d.url || (d.platform !== "custom" ? PLATFORM_SERVERS[d.platform] : "")).replace(/\/+$/, ""),
    hasKey: !!d.stream_key,
    keyHint: d.stream_key ? d.stream_key.slice(-4) : null,
    masked: maskedUrl(d),
    enabled: !!d.enabled,
    usedBy: (db.prepare("SELECT COUNT(*) AS n FROM stream_output_destinations WHERE destination_id = ?").get(d.id) as { n: number }).n,
  });
  const outOut = (o: OutputRow) => ({
    id: o.id,
    name: o.name,
    source: o.source,
    studioId: o.studio_id,
    casparChannel: o.caspar_channel,
    liveSourceId: o.live_source_id,
    encoder: o.encoder,
    videoKbps: o.video_kbps,
    audioKbps: o.audio_kbps,
    resolution: o.resolution,
    deinterlace: !!o.deinterlace,
    extraArgs: o.extra_args,
    active: !!o.active,
    destinationIds: outputs.destinationIds(o.id),
    status: outputs.status(o),
  });
  const getOutput = (oid: number) => {
    const o = outputs.output(oid);
    if (!o) throw new HttpError(404, "not_found");
    return o;
  };
  const getDest = (did: number) => {
    const d = db.prepare("SELECT * FROM stream_destinations WHERE id = ?").get(did) as DestinationRow | undefined;
    if (!d) throw new HttpError(404, "not_found");
    return d;
  };

  app.get("/api/stream-outputs", async () => ({
    outputs: outputs.outputs().map(outOut),
    destinations: outputs.destinations().map(destOut),
    presets: PLATFORM_SERVERS,
  }));

  // ---- destinations (editor-in-chief: they hold the platform accounts) ----
  app.post("/api/stream-destinations", async (req) => {
    requireRole(req, "editor");
    const b = destIn.parse(req.body);
    if (b.platform === "custom" && !b.url) throw new HttpError(400, "rtmp_url");
    const r = db.prepare("INSERT INTO stream_destinations (name, platform, url, stream_key, enabled) VALUES (?, ?, ?, ?, ?)").run(b.name, b.platform, b.url ?? "", b.streamKey ?? "", b.enabled ? 1 : 0);
    return { ok: true, id: Number(r.lastInsertRowid) };
  });
  app.put("/api/stream-destinations/:id", async (req) => {
    requireRole(req, "editor");
    const cur = getDest(id(req));
    const b = destIn.parse(req.body);
    if (b.platform === "custom" && !b.url) throw new HttpError(400, "rtmp_url");
    const key = b.clearKey ? "" : b.streamKey || cur.stream_key;
    db.prepare("UPDATE stream_destinations SET name = ?, platform = ?, url = ?, stream_key = ?, enabled = ? WHERE id = ?").run(b.name, b.platform, b.url ?? "", key, b.enabled ? 1 : 0, cur.id);
    await outputs.reconcile();
    return { ok: true };
  });
  app.delete("/api/stream-destinations/:id", async (req) => {
    requireRole(req, "editor");
    db.prepare("DELETE FROM stream_destinations WHERE id = ?").run(getDest(id(req)).id);
    await outputs.reconcile();
    return { ok: true };
  });

  // ---- streams ----
  const save = (oid: number | null, b: z.infer<typeof outIn>) => {
    if (b.source === "channel") {
      const channels = hub.playout(b.studioId)?.info().channels;
      if (channels?.length && !channels.includes(b.casparChannel!)) throw new HttpError(400, "no_such_output", channels.join(", "));
    } else {
      const live = db.prepare("SELECT kind FROM live_sources WHERE id = ?").get(b.liveSourceId!) as { kind: string } | undefined;
      if (live?.kind !== "rtmp") throw new HttpError(400, "not_remote");
    }
    const known = new Set(outputs.destinations().map((d) => d.id));
    if (b.destinationIds.some((d) => !known.has(d))) throw new HttpError(400, "not_found");
    const vals = [
      b.name,
      b.source,
      b.source === "channel" ? b.studioId! : null,
      b.source === "channel" ? b.casparChannel! : null,
      b.source === "remote" ? b.liveSourceId! : null,
      b.encoder,
      b.videoKbps,
      b.audioKbps,
      b.resolution,
      b.deinterlace ? 1 : 0,
      b.extraArgs,
    ] as const;
    let outId = oid;
    if (outId == null)
      outId = Number(
        db.prepare("INSERT INTO stream_outputs (name, source, studio_id, caspar_channel, live_source_id, encoder, video_kbps, audio_kbps, resolution, deinterlace, extra_args) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...vals).lastInsertRowid,
      );
    else db.prepare("UPDATE stream_outputs SET name = ?, source = ?, studio_id = ?, caspar_channel = ?, live_source_id = ?, encoder = ?, video_kbps = ?, audio_kbps = ?, resolution = ?, deinterlace = ?, extra_args = ? WHERE id = ?").run(...vals, outId);
    db.prepare("DELETE FROM stream_output_destinations WHERE output_id = ?").run(outId);
    const ins = db.prepare("INSERT OR IGNORE INTO stream_output_destinations (output_id, destination_id) VALUES (?, ?)");
    for (const d of b.destinationIds) ins.run(outId, d);
    return outId;
  };
  app.post("/api/stream-outputs", async (req) => {
    requireRole(req, "editor");
    return { ok: true, id: save(null, outIn.parse(req.body)) };
  });
  app.put("/api/stream-outputs/:id", async (req) => {
    requireRole(req, "editor");
    const cur = getOutput(id(req));
    const b = outIn.parse(req.body);
    save(cur.id, b);
    await outputs.reconcile();
    return { ok: true };
  });
  app.delete("/api/stream-outputs/:id", async (req) => {
    requireRole(req, "editor");
    const cur = getOutput(id(req));
    await outputs.drop(cur.id);
    db.prepare("DELETE FROM stream_outputs WHERE id = ?").run(cur.id);
    return { ok: true };
  });
  /** Start / stop streaming (operators too: going live with the stream is part of running the broadcast). */
  app.post("/api/stream-outputs/:id/active", async (req) => {
    requireRole(req, "operator");
    const cur = getOutput(id(req));
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    await outputs.setActive(cur.id, on);
    return { ok: true };
  });
}
