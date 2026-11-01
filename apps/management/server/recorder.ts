/**
 * Recordings: every remote source (RTMP/SRT) that comes in is recorded on this management node, so a live event
 * can be broadcast again later.
 *
 * - The recorder pulls the stream from the ingest server (MediaMTX) on the studio node, like the stream output
 *   relays do, with `ffmpeg -c copy` into MPEG-TS pieces (no re-encode, nothing changes on the studio node).
 *   A stream that drops and comes back within the grace time adds a piece to the same recording.
 * - When the source has a live item in the schedule, the recording stops a little after that item ends.
 * - The pieces are joined into one MP4. Editors trim the start and end in the browser; the cut is made without
 *   re-encoding. The result goes into the media library (UNAS share, folder "Recordings"), with a content category,
 *   and can be planned as a repeat straight away (or automatically, per remote source).
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dbLoader, scheduleEntries } from "./content.js";
import { parseProbe, putIntoSource, readSourceConfig, type ProbeResult, type SourceRow } from "./media.js";
import {
  clampTrim,
  concatList,
  decide,
  joinArgs,
  libraryFileName,
  libraryPath,
  liveEventAt,
  parseSourceRecording,
  recordArgs,
  recordingSettingsSchema,
  repeatTimes,
  sourceRecordingSchema,
  trimArgs,
  trimKey,
  type RecordingSettings,
} from "./recordlogic.js";
import { INGEST_API_USER, streamPath, type LiveRow, type RemoteSources } from "./remote.js";
import { compile, type TimelineEvent } from "./timeline.js";

const SETTINGS_KEY = "recordings";
const TIMELINE_CACHE_MS = 10_000;
const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 30_000;
const MIN_PART_BYTES = 4096;

export type RecordingStatus = "recording" | "processing" | "ready" | "publishing" | "published" | "failed";
export interface RecordingRow {
  id: number;
  live_source_id: number | null;
  source_name: string;
  title: string;
  status: RecordingStatus;
  stop_reason: string | null;
  started_at: string;
  ended_at: string | null;
  schedule_id: number | null;
  channel_id: number | null;
  parts: string;
  file: string | null;
  size: number | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  trim_in_ms: number;
  trim_out_ms: number | null;
  category_id: number | null;
  media_id: number | null;
  media_source_id: number | null;
  media_path: string | null;
  published_trim: string | null;
  published_at: string | null;
  block_id: number | null;
  pending_repeats: string;
  error: string | null;
  created_at: string;
}

interface Session {
  recId: number;
  liveId: number;
  input: string;
  secrets: string[];
  proc: ChildProcess | null;
  parts: string[];
  programKey: string | null;
  programEnd: number | null;
  offlineSince: number | null;
  nextTry: number;
  restarts: number;
  startedAt: number;
  partStartedAt: number;
  error: string | null;
}

export type Spawner = (cmd: string, args: string[]) => ChildProcess;
const hideSecrets = (text: string, secrets: string[]) => secrets.filter((s) => s.length >= 4).reduce((t, s) => t.split(s).join("••••"), text);

export class Recorder {
  readonly dir: string;
  private sessions = new Map<number, Session>();
  /** Remote sources that are not recorded again until their stream stops (value: the programme after which). */
  private held = new Map<number, string | null>();
  /** Why a source that is coming in is not recorded (disk full, …). */
  private blocked = new Map<number, string>();
  private timelines: { at: number; list: { channelId: number; events: TimelineEvent[] }[] } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private thumbQueue: Promise<unknown> = Promise.resolve();
  private busy = false;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private lastDiskAlert = 0;
  spawner: Spawner = (cmd, args) => spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  ffmpeg = process.env.TVSM_FFMPEG || "ffmpeg";
  ffprobe = process.env.TVSM_FFPROBE || "ffprobe";
  now = () => Date.now();

  constructor(
    private platform: Platform,
    private remote: RemoteSources,
    private onChange: () => void,
  ) {
    this.dir = join(platform.ctx.config.dataDir, "recordings");
    mkdirSync(join(this.dir, "thumbs"), { recursive: true });
    remote.afterPoll.push(() => this.tick());
  }

  private get db() {
    return this.platform.ctx.db;
  }
  private get log() {
    return this.platform.ctx.log;
  }
  settings(): RecordingSettings {
    try {
      return recordingSettingsSchema.parse(this.platform.ctx.settings.get(SETTINGS_KEY, {}));
    } catch {
      return recordingSettingsSchema.parse({});
    }
  }
  setSettings(s: RecordingSettings) {
    this.platform.ctx.settings.set(SETTINGS_KEY, s);
  }
  timezone() {
    return this.platform.ctx.settings.get("station.timezone", "Europe/Amsterdam");
  }
  row(id: number) {
    return this.db.prepare("SELECT * FROM recordings WHERE id = ?").get(id) as RecordingRow | undefined;
  }
  file(name: string) {
    return join(this.dir, name);
  }

  /** Called once at start-up: recordings that were running when the service stopped are finished from their pieces. */
  start() {
    for (const r of this.db.prepare("SELECT id, status FROM recordings WHERE status IN ('recording','processing','publishing')").all() as { id: number; status: RecordingStatus }[]) {
      if (r.status === "publishing") {
        this.db.prepare("UPDATE recordings SET status = 'ready' WHERE id = ?").run(r.id);
        this.publishLater(r.id);
      } else {
        this.db.prepare("UPDATE recordings SET status = 'processing', stop_reason = COALESCE(stop_reason, 'restart'), ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(new Date(this.now()).toISOString(), r.id);
        this.enqueue(() => this.process(r.id));
      }
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), 3600_000);
    this.cleanupTimer.unref();
    this.cleanup();
  }

  stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    // The pieces stay on disk; on the next start the recordings are finished from them.
    for (const s of this.sessions.values()) if (s.proc && s.proc.exitCode === null) s.proc.kill("SIGINT");
    this.sessions.clear();
  }

  /** Waits until the processing queue is empty (tests). */
  idle() {
    return this.queue;
  }

  private enqueue(fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((e) => this.log.warn({ err: (e as Error).message }, "recording job failed"));
  }

  // ---- what is on air --------------------------------------------------------------

  private timelineList() {
    const now = this.now();
    if (this.timelines && now - this.timelines.at < TIMELINE_CACHE_MS) return this.timelines.list;
    const loader = dbLoader(this.db);
    const from = now - 12 * 3600_000;
    const to = now + 3600_000;
    const list = (this.db.prepare("SELECT id FROM channels WHERE enabled = 1 ORDER BY id").all() as { id: number }[]).map((c) => ({ channelId: c.id, events: compile(loader, scheduleEntries(this.db, c.id, from, to), from, to).events }));
    this.timelines = { at: now, list };
    return list;
  }
  /** The schedule changed: look again on the next poll. */
  invalidate() {
    this.timelines = null;
  }

  private sources() {
    return (this.db.prepare("SELECT * FROM live_sources WHERE kind = 'rtmp'").all() as unknown as (LiveRow & { recording: string })[]).map((l) => ({ live: l, cfg: parseSourceRecording(l.recording) }));
  }

  /** Where the recorder reads the stream: the ingest server on the studio node (as the management node), or the pull URL. */
  private input(live: LiveRow): { url: string; secrets: string[] } | null {
    if (live.url) return { url: live.url, secrets: [] };
    if (!live.studio_id || !live.stream_key) return null;
    const s = this.db.prepare("SELECT host FROM studio_nodes WHERE id = ? AND enabled = 1").get(live.studio_id) as { host: string } | undefined;
    if (!s) return null;
    const token = this.remote.apiToken();
    return { url: `rtmp://${s.host}:1935/${streamPath(live.stream_key)}?user=${INGEST_API_USER}&pass=${token}`, secrets: [token, live.stream_key] };
  }

  private online(live: LiveRow, s: Session | undefined) {
    // A pulled stream has no ingest status: it is recorded while it plays on its DeckLink output.
    if (live.url) return this.remote.isRouted(live);
    const st = this.remote.status(live).state;
    // Ingest API briefly unreachable: keep recording as long as ffmpeg still gets data.
    return st === "live" || (st === "unknown" && !!s?.proc);
  }

  // ---- the loop --------------------------------------------------------------------

  /** Runs after every ingest poll (every 3 s). */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      const st = this.settings();
      const sources = this.sources();
      // Sources that were removed or no longer record.
      for (const s of [...this.sessions.values()]) {
        const src = sources.find((x) => x.live.id === s.liveId);
        if (!src || !src.cfg.enabled) this.finish(s, "manual");
      }
      const timelines = sources.length ? this.timelineList() : [];
      for (const { live, cfg } of sources) {
        if (!cfg.enabled) {
          this.blocked.delete(live.id);
          continue;
        }
        const s = this.sessions.get(live.id);
        const online = this.online(live, s);
        if (!online && !s) this.held.delete(live.id);
        const onAir = liveEventAt(timelines, live.id, now);
        const program = onAir ? { key: onAir.event.key, end: onAir.event.end } : null;
        if (s && online) s.offlineSince = null;
        if (s && !online) s.offlineSince ??= now;
        const d = decide({ online, now, session: s ?? null, program, heldAfter: this.held.has(live.id) ? this.held.get(live.id) : undefined, graceMs: st.graceSeconds * 1000, postRollMs: st.postRollSeconds * 1000 });
        if (d === "start") this.begin(live, cfg.categoryId, onAir, st);
        else if (d === "stop_programme_end") {
          this.finish(s!, "programme_end");
          if (online) this.held.set(live.id, s!.programKey);
        } else if (d === "stop_next_programme") this.finish(s!, "programme_end");
        else if (d === "stop_stream_end") this.finish(s!, "stream_end");
        else if (d === "keep" && s) {
          // The programme in the schedule started after the stream came in (contributors start early): adopt it.
          if (onAir && !s.programKey) this.adopt(s, onAir);
          else if (onAir && s.programKey === onAir.event.key) s.programEnd = onAir.event.end;
          if (online && !s.proc && now >= s.nextTry) this.startPart(s);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private freeBytes() {
    try {
      const f = statfsSync(this.dir);
      return { free: Number(f.bavail) * Number(f.bsize), total: Number(f.blocks) * Number(f.bsize) };
    } catch {
      return null;
    }
  }

  private programInfo(onAir: ReturnType<typeof liveEventAt>) {
    if (!onAir) return null;
    return { title: onAir.event.programTitle || onAir.event.title, scheduleId: onAir.event.scheduleId, channelId: onAir.channelId, key: onAir.event.key, end: onAir.event.end };
  }

  private begin(live: LiveRow, categoryId: number | null, onAir: ReturnType<typeof liveEventAt>, st: RecordingSettings) {
    const input = this.input(live);
    if (!input) return;
    const disk = this.freeBytes();
    if (disk && disk.free < st.minFreeGb * 1e9) {
      if (!this.blocked.has(live.id)) this.log.warn({ source: live.name }, "not recording: disk almost full");
      this.blocked.set(live.id, "disk_full");
      if (this.now() - this.lastDiskAlert > 3600_000) {
        this.lastDiskAlert = this.now();
        void this.platform.mail.alert("Recording not started: disk almost full", `${live.name} is coming in but is not recorded: less than ${st.minFreeGb} GB free on the management node.`);
      }
      return;
    }
    this.blocked.delete(live.id);
    this.held.delete(live.id);
    const p = this.programInfo(onAir);
    const now = this.now();
    const r = this.db
      .prepare("INSERT INTO recordings (live_source_id, source_name, title, status, started_at, schedule_id, channel_id, category_id) VALUES (?, ?, ?, 'recording', ?, ?, ?, ?)")
      .run(live.id, live.name, (p?.title || live.name).slice(0, 200), new Date(now).toISOString(), p?.scheduleId ?? null, p?.channelId ?? null, categoryId);
    const s: Session = {
      recId: Number(r.lastInsertRowid),
      liveId: live.id,
      input: input.url,
      secrets: input.secrets,
      proc: null,
      parts: [],
      programKey: p?.key ?? null,
      programEnd: p?.end ?? null,
      offlineSince: null,
      nextTry: 0,
      restarts: 0,
      startedAt: now,
      partStartedAt: 0,
      error: null,
    };
    this.sessions.set(live.id, s);
    this.log.info({ source: live.name, recording: s.recId, programme: p?.title }, "recording started");
    this.startPart(s);
  }

  private adopt(s: Session, onAir: NonNullable<ReturnType<typeof liveEventAt>>) {
    const p = this.programInfo(onAir)!;
    s.programKey = p.key;
    s.programEnd = p.end;
    this.db.prepare("UPDATE recordings SET title = ?, schedule_id = ?, channel_id = ? WHERE id = ? AND title = source_name").run(p.title.slice(0, 200), p.scheduleId, p.channelId, s.recId);
    this.db.prepare("UPDATE recordings SET schedule_id = ?, channel_id = ? WHERE id = ?").run(p.scheduleId, p.channelId, s.recId);
  }

  private startPart(s: Session) {
    const name = `rec-${s.recId}-${String(s.parts.length + 1).padStart(3, "0")}.ts`;
    s.parts.push(name);
    this.db.prepare("UPDATE recordings SET parts = ? WHERE id = ?").run(JSON.stringify(s.parts), s.recId);
    let proc: ChildProcess;
    try {
      proc = this.spawner(this.ffmpeg, recordArgs(s.input, this.file(name)));
    } catch (e) {
      s.error = (e as Error).message;
      s.nextTry = this.now() + RESTART_MAX_MS;
      return;
    }
    s.proc = proc;
    s.partStartedAt = this.now();
    let lastErr = "";
    proc.stderr?.on("data", (c: Buffer) => {
      const l = c.toString().trim().split("\n").filter(Boolean).pop();
      if (l) lastErr = hideSecrets(l, s.secrets).slice(0, 300);
    });
    proc.stdout?.on("data", () => undefined);
    const done = (code: number | null, err?: Error) => {
      if (s.proc !== proc) return;
      s.proc = null;
      const ranFor = this.now() - s.partStartedAt;
      if (ranFor > 60_000) s.restarts = 0;
      s.restarts++;
      s.nextTry = this.now() + Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.min(s.restarts - 1, 4));
      s.error = err ? hideSecrets(err.message, s.secrets) : code === 0 ? null : lastErr || `ffmpeg exited (${code ?? "signal"})`;
      if (s.error) this.log.warn({ recording: s.recId, err: s.error }, "recorder stopped; retrying while the stream is there");
    };
    proc.on("exit", (code) => done(code));
    proc.on("error", (e) => done(null, (e as NodeJS.ErrnoException).code === "ENOENT" ? new Error("ffmpeg is not installed on the management node") : e));
  }

  private stopProc(proc: ChildProcess | null) {
    return new Promise<void>((resolve) => {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 8000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill("SIGINT");
    });
  }

  /** Stops a running recording and queues the joining of its pieces. */
  private finish(s: Session, reason: "stream_end" | "programme_end" | "manual") {
    this.sessions.delete(s.liveId);
    const proc = s.proc;
    s.proc = null;
    this.db.prepare("UPDATE recordings SET status = 'processing', stop_reason = ?, ended_at = ? WHERE id = ?").run(reason, new Date(this.now()).toISOString(), s.recId);
    this.log.info({ recording: s.recId, reason }, "recording stopped");
    const stopped = this.stopProc(proc);
    this.enqueue(async () => {
      await stopped;
      await this.process(s.recId);
    });
  }

  /** Stops the recording of a source by hand; it is not recorded again until the stream stops or the next programme. */
  stopRecording(recId: number) {
    const s = [...this.sessions.values()].find((x) => x.recId === recId);
    if (!s) throw new HttpError(409, "not_recording");
    this.held.set(s.liveId, s.programKey);
    this.finish(s, "manual");
  }

  // ---- after the recording -----------------------------------------------------------

  private run(cmd: string, args: string[], timeoutMs: number) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", (e) => {
        clearTimeout(timer);
        reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${cmd} is not installed on the management node`) : e);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }
  private async ff(args: string[]) {
    const r = await this.run(this.ffmpeg, args, 6 * 3600_000);
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `ffmpeg exited (${r.code})`);
  }
  async probe(file: string): Promise<ProbeResult> {
    const r = await this.run(this.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], 120_000);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "ffprobe failed");
    return parseProbe(r.stdout);
  }

  private removeFiles(names: (string | null | undefined)[]) {
    for (const n of names) if (n) rmSync(this.file(n), { force: true });
  }

  /** Joins the pieces into one MP4, measures it and runs the automatic steps (library, repeats). */
  async process(recId: number) {
    const rec = this.row(recId);
    if (!rec || rec.status !== "processing") return;
    const parts = (JSON.parse(rec.parts) as string[]).filter((p) => existsSync(this.file(p)) && statSync(this.file(p)).size >= MIN_PART_BYTES);
    const st = this.settings();
    if (!parts.length) {
      this.removeFiles(JSON.parse(rec.parts) as string[]);
      this.db.prepare("DELETE FROM recordings WHERE id = ?").run(recId);
      this.log.info({ recording: recId }, "recording had no data; removed");
      return;
    }
    const out = `rec-${recId}.mp4`;
    const list = this.file(`rec-${recId}.txt`);
    try {
      writeFileSync(list, concatList(parts.map((p) => this.file(p))));
      try {
        await this.ff(joinArgs(list, this.file(out)));
      } catch (e) {
        // Pieces that cannot be joined (the contributor changed the resolution or codec): keep each piece as its own recording.
        if (parts.length < 2) throw e;
        this.log.warn({ recording: recId, err: (e as Error).message }, "pieces could not be joined; keeping them separately");
        await this.split(rec, parts);
        return;
      }
      const pr = await this.probe(this.file(out));
      if ((pr.durationMs ?? 0) < st.minSeconds * 1000) {
        this.removeFiles([...(JSON.parse(rec.parts) as string[]), out]);
        this.db.prepare("DELETE FROM recordings WHERE id = ?").run(recId);
        this.log.info({ recording: recId, ms: pr.durationMs }, "recording shorter than the minimum; removed");
        return;
      }
      this.ready(rec, out, pr);
      this.removeFiles(JSON.parse(rec.parts) as string[]);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      this.db.prepare("UPDATE recordings SET status = 'failed', error = ? WHERE id = ?").run(msg, recId);
      this.log.warn({ recording: recId, err: msg }, "recording could not be finished");
      void this.platform.mail.alert(`Recording failed: ${rec.title}`, `The recording of ${rec.source_name} (${rec.started_at}) could not be finished: ${msg}\nThe recorded pieces are kept in ${this.dir}.`);
    } finally {
      rmSync(list, { force: true });
    }
  }

  private async split(rec: RecordingRow, parts: string[]) {
    for (const [i, part] of parts.entries()) {
      const id = Number(
        this.db
          .prepare("INSERT INTO recordings (live_source_id, source_name, title, status, stop_reason, started_at, ended_at, schedule_id, channel_id, category_id, parts) VALUES (?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?, ?)")
          .run(rec.live_source_id, rec.source_name, `${rec.title} (${i + 1})`.slice(0, 200), rec.stop_reason, rec.started_at, rec.ended_at, rec.schedule_id, rec.channel_id, rec.category_id, JSON.stringify([part])).lastInsertRowid,
      );
      await this.process(id);
    }
    this.db.prepare("DELETE FROM recordings WHERE id = ?").run(rec.id);
  }

  private ready(rec: RecordingRow, out: string, pr: ProbeResult) {
    this.db
      .prepare("UPDATE recordings SET status = 'ready', file = ?, size = ?, duration_ms = ?, width = ?, height = ?, fps = ?, codec = ?, parts = '[]', error = NULL WHERE id = ?")
      .run(out, statSync(this.file(out)).size, pr.durationMs, pr.width, pr.height, pr.fps, pr.codec, rec.id);
    this.log.info({ recording: rec.id, title: rec.title, ms: pr.durationMs }, "recording ready");
    // Automatic steps of the remote source.
    const live = rec.live_source_id == null ? undefined : (this.db.prepare("SELECT recording FROM live_sources WHERE id = ?").get(rec.live_source_id) as { recording: string } | undefined);
    const cfg = parseSourceRecording(live?.recording);
    const repeats = repeatTimes(cfg.repeats, Date.parse(rec.started_at), this.timezone(), this.now()).map((r) => ({ channelId: r.channelId ?? rec.channel_id ?? this.firstChannel(), at: new Date(r.at).toISOString() }));
    if (repeats.length) this.db.prepare("UPDATE recordings SET pending_repeats = ? WHERE id = ?").run(JSON.stringify(repeats.filter((r) => r.channelId != null)), rec.id);
    this.onChange();
    if (cfg.toLibrary || repeats.length) this.publishLater(rec.id);
  }

  private firstChannel() {
    return (this.db.prepare("SELECT id FROM channels WHERE enabled = 1 ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
  }

  /** The library recordings go to. */
  library() {
    const id = this.settings().mediaSourceId;
    const row = (id != null ? this.db.prepare("SELECT * FROM media_sources WHERE id = ?").get(id) : this.db.prepare("SELECT * FROM media_sources WHERE enabled = 1 ORDER BY id LIMIT 1").get()) as SourceRow | undefined;
    return row;
  }

  /** A library path that no other file uses: "… 20.00.mp4", "… 20.00 (2).mp4". */
  private freePath(sourceId: number, path: string, recId: number) {
    const taken = (p: string) => {
      const m = this.db.prepare("SELECT id FROM media WHERE source_id = ? AND path = ?").get(sourceId, p) as { id: number } | undefined;
      if (!m) return false;
      const own = this.db.prepare("SELECT id FROM recordings WHERE media_id = ? AND id = ?").get(m.id, recId);
      return !own;
    };
    if (!taken(path)) return path;
    for (let i = 2; i < 100; i++) {
      const p = path.replace(/(\.[^./]+)$/, ` (${i})$1`);
      if (!taken(p)) return p;
    }
    return path.replace(/(\.[^./]+)$/, ` ${Date.now()}$1`);
  }

  /**
   * Puts the recording (trimmed) into the library. Runs in the background; a recording already in the library is
   * replaced by the new cut (same file, same media item, so planned repeats get the new length).
   */
  publish(recId: number): Promise<void> {
    const rec = this.row(recId);
    if (!rec) throw new HttpError(404, "not_found");
    if (!rec.file || !existsSync(this.file(rec.file))) throw new HttpError(409, "recording_no_file");
    if (rec.status === "recording" || rec.status === "processing" || rec.status === "publishing") throw new HttpError(409, "recording_busy");
    const src = this.library();
    if (!src) throw new HttpError(409, "recording_no_library");
    this.db.prepare("UPDATE recordings SET status = 'publishing', error = NULL WHERE id = ?").run(recId);
    const done = new Promise<void>((resolve) =>
      this.enqueue(async () => {
        try {
          await this.doPublish(recId, src);
        } finally {
          resolve();
        }
      }),
    );
    return done;
  }

  /** Publishes without waiting; problems end up in the recording's error and the log. */
  publishLater(recId: number) {
    try {
      this.publish(recId).catch(() => undefined);
    } catch (e) {
      this.db.prepare("UPDATE recordings SET error = ? WHERE id = ?").run(e instanceof HttpError ? e.code : (e as Error).message, recId);
      this.log.warn({ recording: recId, err: (e as Error).message }, "could not put the recording in the library");
    }
  }

  private async doPublish(recId: number, src: SourceRow) {
    const rec = this.row(recId)!;
    const st = this.settings();
    const trim = clampTrim(rec.trim_in_ms, rec.trim_out_ms, rec.duration_ms);
    let file = this.file(rec.file!);
    let tmp: string | null = null;
    try {
      if (trim.inMs > 0 || trim.outMs != null) {
        tmp = this.file(`export-${recId}.mp4`);
        await this.ff(trimArgs(file, tmp, trim.inMs, trim.outMs));
        file = tmp;
      }
      const pr = await this.probe(file);
      const samePlace = rec.media_path && rec.media_source_id === src.id;
      const path = samePlace ? rec.media_path! : this.freePath(src.id, libraryPath(st.folder, libraryFileName(rec.title, Date.parse(rec.started_at), this.timezone())), recId);
      const cfg = readSourceConfig(this.platform.ctx.secrets, src);
      await putIntoSource(cfg, src.type as "smb" | "local", file, path);
      const size = statSync(file).size;
      const mtime = src.type === "local" ? statSync(join((cfg as { path: string }).path, ...path.split("/"))).mtime.toISOString() : new Date(this.now()).toISOString();
      const slash = path.lastIndexOf("/");
      const name = path.slice(slash + 1).replace(/\.[^.]+$/, "");
      const folder = slash > 0 ? path.slice(0, slash) : "";
      const media = this.db
        .prepare(
          `INSERT INTO media (source_id, path, name, folder, size, mtime, duration_ms, fps, width, height, codec, category, title, probe_status, category_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'program', ?, 'ok', ?)
           ON CONFLICT (source_id, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, duration_ms = excluded.duration_ms, fps = excluded.fps,
             width = excluded.width, height = excluded.height, codec = excluded.codec, title = excluded.title, category_id = excluded.category_id,
             probe_status = 'ok', probe_error = NULL, missing = 0
           RETURNING id`,
        )
        .get(src.id, path, name, folder, size, mtime, pr.durationMs, pr.fps, pr.width, pr.height, pr.codec, rec.title, rec.category_id) as { id: number };
      this.db
        .prepare("UPDATE recordings SET status = 'published', media_id = ?, media_source_id = ?, media_path = ?, published_trim = ?, published_at = ?, error = NULL WHERE id = ?")
        .run(media.id, src.id, path, trimKey(trim.inMs, trim.outMs), new Date(this.now()).toISOString(), recId);
      this.log.info({ recording: recId, library: src.name, path }, "recording put in the library");
      const pending = JSON.parse(this.row(recId)!.pending_repeats || "[]") as { channelId: number; at: string }[];
      if (pending.length) {
        this.db.prepare("UPDATE recordings SET pending_repeats = '[]' WHERE id = ?").run(recId);
        const byChannel = new Map<number, string[]>();
        for (const p of pending) byChannel.set(p.channelId, [...(byChannel.get(p.channelId) ?? []), p.at]);
        for (const [ch, ats] of byChannel) this.planRepeats(recId, ch, ats.filter((a) => Date.parse(a) > this.now()), "recorder");
      }
      this.onChange();
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      this.db.prepare("UPDATE recordings SET status = CASE WHEN media_id IS NULL THEN 'ready' ELSE 'published' END, error = ? WHERE id = ?").run(msg, recId);
      this.log.warn({ recording: recId, err: msg }, "could not put the recording in the library");
      throw e;
    } finally {
      if (tmp) rmSync(tmp, { force: true });
    }
  }

  /** The TV block that plays the recording (made once, reused for every repeat). */
  private blockFor(rec: RecordingRow) {
    if (rec.block_id) {
      const ok = this.db.prepare("SELECT 1 FROM block_items WHERE block_id = ? AND type = 'media' AND media_id = ?").get(rec.block_id, rec.media_id);
      if (ok) return rec.block_id;
    }
    const cat = rec.category_id != null ? (this.db.prepare("SELECT color FROM categories WHERE id = ?").get(rec.category_id) as { color: string } | undefined) : undefined;
    this.db.exec("BEGIN");
    try {
      const id = Number(this.db.prepare("INSERT INTO blocks (name, kind, color, description, genre, category_id) VALUES (?, 'program', ?, ?, '', ?)").run(rec.title, cat?.color ?? "#3B6CFF", `Recording of ${rec.source_name}`, rec.category_id).lastInsertRowid);
      this.db.prepare("INSERT INTO block_items (block_id, position, type, media_id) VALUES (?, 0, 'media', ?)").run(id, rec.media_id);
      this.db.prepare("UPDATE recordings SET block_id = ? WHERE id = ?").run(id, rec.id);
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Length on air of the recording as it is in the library. */
  playLength(rec: RecordingRow) {
    if (rec.media_id) {
      const m = this.db.prepare("SELECT duration_ms FROM media WHERE id = ?").get(rec.media_id) as { duration_ms: number | null } | undefined;
      if (m?.duration_ms) return m.duration_ms;
    }
    const t = clampTrim(rec.trim_in_ms, rec.trim_out_ms, rec.duration_ms);
    return (t.outMs ?? rec.duration_ms ?? 0) - t.inMs;
  }

  /** What a repeat at these times would cut short or replace in the schedule. */
  conflicts(rec: RecordingRow, channelId: number, starts: number[]) {
    const len = this.playLength(rec);
    const loader = dbLoader(this.db);
    const out: { at: string; title: string; startAt: string; origin: string }[] = [];
    for (const start of starts) {
      const end = start + len;
      const { entries } = compile(loader, scheduleEntries(this.db, channelId, start, end), start, end);
      for (const e of entries) {
        if (e.end <= start || e.start >= end) continue;
        if (rec.block_id && e.blockId === rec.block_id && e.start === start) continue;
        const origin = (this.db.prepare("SELECT origin FROM schedule WHERE id = ?").get(e.id) as { origin: string } | undefined)?.origin ?? "manual";
        out.push({ at: new Date(start).toISOString(), title: e.programTitle || "", startAt: new Date(e.start).toISOString(), origin });
      }
    }
    return out;
  }

  /** Plans the recording as a repeat (manual schedule entries; they take precedence over the week schedule). */
  planRepeats(recId: number, channelId: number, startAts: string[], user: string) {
    const rec = this.row(recId);
    if (!rec?.media_id) throw new HttpError(409, "recording_not_in_library");
    if (!this.db.prepare("SELECT id FROM channels WHERE id = ?").get(channelId)) throw new HttpError(404, "not_found");
    const blockId = this.blockFor(rec);
    const ids: number[] = [];
    for (const at of startAts) {
      const r = this.db
        .prepare("INSERT INTO schedule (channel_id, start_at, block_id, title, description, in_epg, created_by) VALUES (?, ?, ?, ?, ?, 1, ?)")
        .run(channelId, new Date(at).toISOString(), blockId, rec.title, null, user);
      ids.push(Number(r.lastInsertRowid));
    }
    if (ids.length) this.log.info({ recording: recId, channel: channelId, repeats: startAts }, "repeats planned");
    this.onChange();
    return ids;
  }

  repeats(rec: RecordingRow) {
    if (!rec.block_id) return [];
    return (
      this.db
        .prepare("SELECT s.id, s.channel_id AS channelId, s.start_at AS startAt, c.name AS channelName FROM schedule s JOIN channels c ON c.id = s.channel_id WHERE s.block_id = ? AND s.origin = 'manual' ORDER BY s.start_at")
        .all(rec.block_id) as { id: number; channelId: number; startAt: string; channelName: string }[]
    ).map((r) => ({ ...r, past: Date.parse(r.startAt) < this.now() }));
  }

  /** Removes local files of recordings that have been in the library for longer than `keepDays`. */
  cleanup() {
    const st = this.settings();
    const cutoff = new Date(this.now() - st.keepDays * 86400_000).toISOString();
    for (const r of this.db.prepare("SELECT id, file FROM recordings WHERE status = 'published' AND file IS NOT NULL AND published_at < ?").all(cutoff) as { id: number; file: string }[]) {
      this.removeFiles([r.file]);
      this.removeThumbs(r.id);
      this.db.prepare("UPDATE recordings SET file = NULL WHERE id = ?").run(r.id);
      this.log.info({ recording: r.id }, "local copy of the recording removed (it is in the library)");
    }
  }

  removeThumbs(recId: number) {
    rmSync(join(this.dir, "thumbs", String(recId)), { recursive: true, force: true });
  }

  /** A still from the recording at `ms` (JPEG, cached). */
  async thumb(rec: RecordingRow, ms: number) {
    if (!rec.file) throw new HttpError(404, "not_found");
    const t = Math.max(0, Math.round(ms / 100) * 100);
    const dir = join(this.dir, "thumbs", String(rec.id));
    const out = join(dir, `${t}.jpg`);
    if (existsSync(out)) return out;
    mkdirSync(dir, { recursive: true });
    const job = this.thumbQueue.then(async () => {
      if (existsSync(out)) return;
      const r = await this.run(this.ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", (t / 1000).toFixed(1), "-i", this.file(rec.file!), "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", "-y", out], 30_000);
      if (r.code !== 0 || !existsSync(out)) throw new HttpError(500, "thumb_failed", r.stderr.trim().slice(0, 200));
    });
    this.thumbQueue = job.catch(() => undefined);
    await job;
    return out;
  }

  /** Running recordings, for the UI. */
  active() {
    return [...this.sessions.values()].map((s) => {
      const bytes = s.parts.reduce((n, p) => {
        try {
          return n + statSync(this.file(p)).size;
        } catch {
          return n;
        }
      }, 0);
      return { recordingId: s.recId, liveSourceId: s.liveId, since: new Date(s.startedAt).toISOString(), bytes, pieces: s.parts.length, recording: !!s.proc, programEnd: s.programEnd ? new Date(s.programEnd).toISOString() : null, error: s.error };
    });
  }
  blockedReason(liveId: number) {
    return this.blocked.get(liveId) ?? null;
  }
  isRecording(liveId: number) {
    return this.sessions.has(liveId);
  }
  disk() {
    return this.freeBytes();
  }
}

// ---- API -----------------------------------------------------------------------------

export function registerRecordings(app: FastifyInstance, platform: Platform, rec: Recorder) {
  const { db } = platform.ctx;
  const pid = (req: { params: unknown }) => Number((req.params as { id: string }).id);
  const get = (id: number) => {
    const r = rec.row(id);
    if (!r) throw new HttpError(404, "not_found");
    return r;
  };
  const out = (r: RecordingRow) => {
    const t = clampTrim(r.trim_in_ms, r.trim_out_ms, r.duration_ms);
    return {
      id: r.id,
      liveSourceId: r.live_source_id,
      sourceName: r.source_name,
      title: r.title,
      status: r.status,
      stopReason: r.stop_reason,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      channelId: r.channel_id,
      scheduleId: r.schedule_id,
      size: r.size,
      durationMs: r.duration_ms,
      width: r.width,
      height: r.height,
      fps: r.fps,
      codec: r.codec,
      trimInMs: t.inMs,
      trimOutMs: t.outMs,
      lengthMs: r.duration_ms == null ? null : (t.outMs ?? r.duration_ms) - t.inMs,
      categoryId: r.category_id,
      mediaId: r.media_id,
      mediaPath: r.media_path,
      publishedAt: r.published_at,
      /** In the library, but trimmed differently since: put it in again. */
      outdated: !!r.media_id && !!r.published_trim && r.published_trim !== trimKey(t.inMs, t.outMs),
      hasFile: !!r.file,
      pendingRepeats: (JSON.parse(r.pending_repeats || "[]") as unknown[]).length,
      repeats: rec.repeats(r),
      error: r.error,
    };
  };

  app.get("/api/recordings", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const lib = rec.library();
    return {
      recordings: (db.prepare("SELECT * FROM recordings ORDER BY started_at DESC LIMIT ?").all(q.limit) as unknown as RecordingRow[]).map(out),
      active: rec.active(),
      disk: rec.disk(),
      settings: rec.settings(),
      library: lib ? { id: lib.id, name: lib.name } : null,
    };
  });

  app.put("/api/recordings/settings", async (req) => {
    requireRole(req, "editor");
    const s = recordingSettingsSchema.parse(req.body);
    if (s.mediaSourceId != null && !db.prepare("SELECT id FROM media_sources WHERE id = ?").get(s.mediaSourceId)) throw new HttpError(404, "not_found");
    rec.setSettings(s);
    return { ok: true, settings: rec.settings() };
  });

  /** Recording settings per remote source. */
  app.get("/api/recordings/sources", async () => ({
    sources: (db.prepare("SELECT id, name, recording FROM live_sources WHERE kind = 'rtmp' ORDER BY name").all() as { id: number; name: string; recording: string }[]).map((l) => ({
      id: l.id,
      name: l.name,
      recording: parseSourceRecording(l.recording),
      active: rec.isRecording(l.id),
      blocked: rec.blockedReason(l.id),
    })),
  }));
  app.put("/api/recordings/sources/:id", async (req) => {
    requireRole(req, "editor");
    const cfg = sourceRecordingSchema.parse(req.body);
    const r = db.prepare("UPDATE live_sources SET recording = ? WHERE id = ? AND kind = 'rtmp'").run(JSON.stringify(cfg), pid(req));
    if (!r.changes) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  app.get("/api/recordings/:id", async (req) => out(get(pid(req))));

  /** Title, content category and trim points. A recording already in the library is put in again with the new cut. */
  app.put("/api/recordings/:id", async (req) => {
    requireRole(req, "editor");
    const r = get(pid(req));
    const b = z
      .object({
        title: z.string().trim().min(1).max(200),
        categoryId: z.number().int().nullable(),
        trimInMs: z.number().int().min(0),
        trimOutMs: z.number().int().min(0).nullable(),
        /** Put it in the library (again) after saving. */
        publish: z.boolean().default(false),
      })
      .parse(req.body);
    if (b.trimOutMs != null && b.trimOutMs - b.trimInMs < 1000) throw new HttpError(400, "recording_too_short");
    const t = clampTrim(b.trimInMs, b.trimOutMs, r.duration_ms);
    db.prepare("UPDATE recordings SET title = ?, category_id = ?, trim_in_ms = ?, trim_out_ms = ? WHERE id = ?").run(b.title, b.categoryId, t.inMs, t.outMs, r.id);
    if (r.media_id) db.prepare("UPDATE media SET title = ?, category_id = ? WHERE id = ?").run(b.title, b.categoryId, r.media_id);
    if (r.block_id) db.prepare("UPDATE blocks SET name = ?, category_id = ? WHERE id = ?").run(b.title, b.categoryId, r.block_id);
    db.prepare("UPDATE schedule SET title = ? WHERE block_id = ? AND origin = 'manual' AND title = ?").run(b.title, r.block_id ?? -1, r.title);
    const changed = r.media_id && r.published_trim !== trimKey(t.inMs, t.outMs);
    if (b.publish || changed) {
      if (!r.file) throw new HttpError(409, "recording_no_file");
      rec.publishLater(r.id);
    }
    return out(get(r.id));
  });

  app.post("/api/recordings/:id/publish", async (req) => {
    requireRole(req, "editor");
    const r = get(pid(req));
    rec.publish(r.id).catch(() => undefined);
    return { ok: true };
  });

  app.post("/api/recordings/:id/stop", async (req) => {
    requireRole(req, "operator");
    rec.stopRecording(get(pid(req)).id);
    return { ok: true };
  });

  /** Plans repeats. Not in the library yet: it is put in first and the repeats follow. `dryRun` only lists conflicts. */
  app.post("/api/recordings/:id/repeats", async (req) => {
    requireRole(req, "editor");
    const r = get(pid(req));
    const b = z.object({ channelId: z.number().int(), startAts: z.array(z.iso.datetime({ offset: true })).min(1).max(20), dryRun: z.boolean().default(false) }).parse(req.body);
    const starts = b.startAts.map((s) => Date.parse(s));
    if (starts.some((s) => s < rec.now() - 60_000)) throw new HttpError(400, "repeat_in_past");
    const conflicts = rec.conflicts(r, b.channelId, starts);
    if (b.dryRun) return { conflicts, lengthMs: rec.playLength(r) };
    if (r.media_id && r.status === "published") return { ids: rec.planRepeats(r.id, b.channelId, b.startAts, req.user!.username), conflicts, pending: false };
    // Not in the library (yet): plan them once it is there.
    const pending = [...(JSON.parse(r.pending_repeats || "[]") as unknown[]), ...b.startAts.map((at) => ({ channelId: b.channelId, at: new Date(at).toISOString() }))];
    db.prepare("UPDATE recordings SET pending_repeats = ? WHERE id = ?").run(JSON.stringify(pending), r.id);
    if (r.status === "ready") rec.publish(r.id).catch(() => undefined);
    else if (r.status !== "publishing" && r.status !== "processing" && r.status !== "recording") throw new HttpError(409, "recording_no_file");
    return { ids: [], conflicts, pending: true };
  });

  app.delete("/api/recordings/:id/repeats/:sid", async (req) => {
    requireRole(req, "editor");
    const r = get(pid(req));
    const sid = Number((req.params as { sid: string }).sid);
    const res = db.prepare("DELETE FROM schedule WHERE id = ? AND block_id = ? AND origin = 'manual'").run(sid, r.block_id ?? -1);
    if (!res.changes) throw new HttpError(404, "not_found");
    rec.invalidate();
    return { ok: true };
  });

  /** Deletes the recording on this machine. A copy in the library and planned repeats stay. */
  app.delete("/api/recordings/:id", async (req) => {
    requireRole(req, "editor");
    const r = get(pid(req));
    if (r.status === "recording" || r.status === "processing" || r.status === "publishing") throw new HttpError(409, "recording_busy");
    for (const f of [r.file, ...(JSON.parse(r.parts) as string[])]) if (f) rmSync(rec.file(f), { force: true });
    rec.removeThumbs(r.id);
    db.prepare("DELETE FROM recordings WHERE id = ?").run(r.id);
    return { ok: true };
  });

  /** The recording for the trim preview in the browser (with byte ranges, so the player can seek). */
  app.get("/api/recordings/:id/video", async (req, reply) => {
    const r = get(pid(req));
    if (!r.file || !existsSync(rec.file(r.file))) throw new HttpError(404, "recording_no_file");
    const path = rec.file(r.file);
    const size = statSync(path).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    reply.header("Accept-Ranges", "bytes").header("Content-Type", "video/mp4").header("Cache-Control", "private, max-age=60");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      start = Math.max(0, start);
      return reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${size}`)
        .header("Content-Length", String(end - start + 1))
        .send(createReadStream(path, { start, end }));
    }
    return reply.header("Content-Length", String(size)).send(createReadStream(path));
  });

  app.get("/api/recordings/:id/thumb", async (req, reply) => {
    const r = get(pid(req));
    const { t } = z.object({ t: z.coerce.number().min(0).default(0) }).parse(req.query);
    const file = await rec.thumb(r, Math.min(t, r.duration_ms ?? t));
    return reply.header("Content-Type", "image/jpeg").header("Cache-Control", "private, max-age=86400").send(createReadStream(file));
  });
}
