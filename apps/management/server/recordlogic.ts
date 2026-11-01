/**
 * Pure helpers for recording remote sources: settings, file names, the ffmpeg arguments, when a recording starts
 * and stops, and the times of planned repeats. Tested in test/recordings.test.ts.
 */
import { z } from "zod";
import { addDaysIso, stationDay, stationTime } from "./hourclock.js";
import type { TimelineEvent } from "./timeline.js";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Global settings (settings key `recordings`). */
export const recordingSettingsSchema = z.object({
  /** Library the recordings go to; null = the first enabled media source. */
  mediaSourceId: z.number().int().nullable().default(null),
  /** Folder in that library, e.g. "Opnames". */
  folder: z.string().trim().max(200).regex(/^[^"\\:*?<>|]*$/).default("Recordings"),
  /** A stream that drops and comes back within this time is one recording (pieces are joined). */
  graceSeconds: z.number().int().min(5).max(1800).default(90),
  /** After the end of the programme in the schedule, keep recording this long, then stop. */
  postRollSeconds: z.number().int().min(0).max(3600).default(120),
  /** Recordings shorter than this (test streams) are thrown away. */
  minSeconds: z.number().int().min(0).max(3600).default(30),
  /** The recording on this machine is kept this many days after it went into the library (to trim again). */
  keepDays: z.number().int().min(0).max(365).default(7),
  /** Do not start a recording when less than this much disk space is free. */
  minFreeGb: z.number().min(0).max(10_000).default(5),
});
export type RecordingSettings = z.infer<typeof recordingSettingsSchema>;

export const repeatRuleSchema = z.object({
  /** 0 = same day as the programme, 1 = the day after, … */
  dayOffset: z.number().int().min(0).max(13),
  time: hhmm,
  /** null = the channel the programme was on (or the first channel). */
  channelId: z.number().int().nullable().default(null),
});
export type RepeatRule = z.infer<typeof repeatRuleSchema>;

/** Per remote source (column `live_sources.recording`). */
export const sourceRecordingSchema = z.object({
  enabled: z.boolean().default(true),
  /** Content category (sport, culture…) the recording gets in the library. */
  categoryId: z.number().int().nullable().default(null),
  /** Put the recording in the library as soon as it is finished (it can still be trimmed afterwards). */
  toLibrary: z.boolean().default(true),
  /** Plan repeats automatically when the recording is finished. */
  repeats: z.array(repeatRuleSchema).max(6).default([]),
});
export type SourceRecording = z.infer<typeof sourceRecordingSchema>;

export const parseSourceRecording = (json: string | null | undefined): SourceRecording => {
  try {
    return sourceRecordingSchema.parse(JSON.parse(json || "{}"));
  } catch {
    return sourceRecordingSchema.parse({});
  }
};

/** "Sport: FC Haarlem / VV Velsen" -> "Sport - FC Haarlem - VV Velsen" (safe on SMB, Windows and CasparCG). */
export function safeName(name: string) {
  return (
    name
      .normalize("NFC")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " - ")
      .replace(/\s+/g, " ")
      .replace(/(\s*-\s*){2,}/g, " - ")
      .replace(/^[\s.-]+|[\s.-]+$/g, "")
      .slice(0, 100)
      .trim() || "Recording"
  );
}

/** File name in the library: "<title> <yyyy-mm-dd> <hh.mm>.mp4", in station time. */
export function libraryFileName(title: string, startedAt: number, tz: string) {
  const d = stationDay(startedAt, tz);
  const hh = String(Math.floor(d.minute / 60)).padStart(2, "0");
  const mm = String(d.minute % 60).padStart(2, "0");
  return `${safeName(title)} ${d.date} ${hh}.${mm}.mp4`;
}

/** Joins a folder and a file name into a library path (forward slashes, no leading slash). */
export const libraryPath = (folder: string, file: string) => [...folder.split(/[\\/]+/).map((f) => f.trim()).filter(Boolean), file].join("/");

/** ffmpeg arguments that record one piece of a stream as MPEG-TS (survives a crash or a power cut). */
export function recordArgs(input: string, out: string) {
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-rw_timeout", "15000000", "-i", input, "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-f", "mpegts", "-progress", "pipe:1", "-nostats", "-y", out];
}

/** Concat demuxer list. */
export const concatList = (files: string[]) => files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";

/** Joins the pieces into one MP4 that browsers (trim preview) and CasparCG can play. */
export function joinArgs(listFile: string, out: string) {
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", "-y", out];
}

/**
 * Cuts [inMs, outMs) without re-encoding. The cut starts at the key frame at or before the in point (encoders
 * send one every 1–2 s), so at most a second or two more is kept at the start.
 */
export function trimArgs(input: string, out: string, inMs: number, outMs: number | null) {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  if (inMs > 0) args.push("-ss", (inMs / 1000).toFixed(3));
  args.push("-i", input);
  if (outMs != null) args.push("-t", ((outMs - inMs) / 1000).toFixed(3));
  args.push("-map", "0:v?", "-map", "0:a?", "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", "-y", out);
  return args;
}

/** Times (ms into the recording) of the pictures in the trim filmstrip. */
export function thumbTimes(durationMs: number, n: number) {
  if (durationMs <= 0 || n <= 0) return [];
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * durationMs) / n));
}

/** Valid trim points: 0 <= in < out <= duration, at least one second long. */
export function clampTrim(inMs: number, outMs: number | null, durationMs: number | null) {
  const dur = durationMs ?? Number.POSITIVE_INFINITY;
  let a = Math.max(0, Math.round(inMs));
  let b = outMs == null ? null : Math.round(outMs);
  if (b != null && b >= dur) b = null;
  if (a >= dur) a = 0;
  if (b != null && b - a < 1000) b = null;
  return { inMs: a, outMs: b };
}
export const trimKey = (inMs: number, outMs: number | null) => `${inMs}:${outMs ?? ""}`;

/** The live item of this remote source that is on air at `t` in one of the channels' timelines. */
export function liveEventAt(timelines: { channelId: number; events: TimelineEvent[] }[], liveSourceId: number, t: number) {
  for (const tl of timelines) {
    const ev = tl.events.find((e) => e.type === "live" && e.leaf?.liveSourceId === liveSourceId && e.start <= t && t < e.end);
    if (ev) return { channelId: tl.channelId, event: ev };
  }
  return null;
}

export interface SessionView {
  /** Programme (schedule key) the recording belongs to, if any. */
  programKey: string | null;
  programEnd: number | null;
  offlineSince: number | null;
}
export type RecordDecision = "start" | "keep" | "stop_programme_end" | "stop_next_programme" | "stop_stream_end" | "idle";

/**
 * What the recorder does with one remote source on a poll.
 * - A stream that comes in is recorded. A short drop (shorter than the grace time) stays one recording.
 * - When the source has a live item in the schedule, the recording stops `postRoll` after that item ends, even when
 *   the contributor keeps sending. It is then held (no new recording) until the stream stops or the next programme
 *   with this source starts. When the next programme with this source follows straight away, a new recording starts.
 */
export function decide(o: {
  online: boolean;
  now: number;
  session: SessionView | null;
  /** Live item of this source on air now. */
  program: { key: string; end: number } | null;
  /** Held after this programme (stopped while the stream kept coming in); undefined = not held. */
  heldAfter: string | null | undefined;
  graceMs: number;
  postRollMs: number;
}): RecordDecision {
  const { session: s } = o;
  if (!s) {
    if (!o.online) return "idle";
    if (o.heldAfter !== undefined && (!o.program || o.program.key === o.heldAfter)) return "idle";
    return "start";
  }
  if (s.programKey && s.programEnd != null && o.now >= s.programEnd) {
    if (o.program && o.program.key !== s.programKey) return "stop_next_programme";
    if (o.now >= s.programEnd + o.postRollMs) return "stop_programme_end";
  }
  if (!o.online) return s.offlineSince != null && o.now - s.offlineSince >= o.graceMs ? "stop_stream_end" : "keep";
  return "keep";
}

/** UTC times of the repeats for a programme that started at `startedAt` (rules are in station time). */
export function repeatTimes(rules: RepeatRule[], startedAt: number, tz: string, now: number) {
  const day = stationDay(startedAt, tz).date;
  return rules
    .map((r) => {
      const [h, m] = r.time.split(":").map(Number);
      return { at: stationTime(addDaysIso(day, r.dayOffset), h! * 60 + m!, tz), channelId: r.channelId };
    })
    .filter((r) => r.at > now)
    .sort((a, b) => a.at - b.at);
}
