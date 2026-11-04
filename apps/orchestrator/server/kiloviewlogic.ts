/**
 * Kiloview encoders / decoders (E3, D260, ...). Pure: no I/O, shared by the server and the web UI.
 *
 * READ ONLY. The orchestrator only logs in and asks for status. On these devices dangerous actions (reboot, restore,
 * factory reset, EDID reset) are plain GET requests too, so every request must match the fixed allowlist below:
 * `allowedPath` is checked before anything is sent. Never widen it with "all GETs".
 */
import { CPU_WARN, type Issue } from "./monitorlogic.js";

export const KILOVIEW_KINDS = ["encoder", "decoder"] as const;
export type KiloviewKind = (typeof KILOVIEW_KINDS)[number];

export const LOGIN_PATH: Record<KiloviewKind, string> = {
  encoder: "/api/systemctrl/users/login",
  decoder: "/api/users/login",
};

/** The only status requests the orchestrator ever sends (besides the login above). */
const READ_PATHS: Record<KiloviewKind, RegExp[]> = {
  encoder: [
    /^\/api\/systemctrl\/system\/getSystemInfo\?version=true$/,
    /^\/api\/systemctrl\/system\/getNetworkSpeed$/,
    /^\/api\/codec\/vin\/active_interface$/,
    /^\/api\/codec\/(hdmi|sdi)\/vin\/detail$/,
    /^\/api\/codec\/(hdmi|sdi)\/venc\/settings$/,
    /^\/api\/codec\/(hdmi|sdi)\/audio\/input$/,
    /^\/api\/streamer\/(hdmi|sdi)\/stream\/list$/,
  ],
  decoder: [/^\/api\/report\/system_info$/, /^\/api\/report\/codec_info$/, /^\/api\/output\/list$/, /^\/api\/output\/get\?output_id=\d{1,3}$/],
};
export const allowedPath = (kind: KiloviewKind, method: "GET" | "POST", path: string) =>
  method === "POST" ? path === LOGIN_PATH[kind] : READ_PATHS[kind].some((r) => r.test(path));

// ---- snapshot -----------------------------------------------------------------------------------

export interface KvStream {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  running: boolean;
  /** Destination, with stream keys and passwords masked. */
  target: string;
}
export interface KvEncoder {
  /** HDMI / SDI. */
  activeInput: string | null;
  input: { signal: boolean | null; format: string | null; raw: string | null };
  video: { codec: string | null; mode: string | null; bitrateKbps: number | null; fps: number | null; width: number | null; height: number | null } | null;
  audio: { source: string | null; sampling: number | null; channels: number | null; mute: boolean | null } | null;
  streams: KvStream[];
  network: { txKbps: number | null; rxKbps: number | null; speedMbps: number | null } | null;
}
export interface KvOutput {
  id: string;
  /** Physical connector(s) that carry this output, e.g. "SDI" or "HDMI1". */
  connector: string | null;
  /** Output format, e.g. "1080p50". */
  format: string | null;
  source: { name: string; type: string; url: string } | null;
  /** The decoder plays the source (position status 2 / stream status "start"). */
  playing: boolean | null;
  /** Format of the incoming stream, e.g. "1080p25". */
  streamFormat: string | null;
  bitrateKbps: number | null;
  codec: string | null;
}
export interface KvDecoder {
  outputs: KvOutput[];
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  temperature: number | null;
}
export interface KiloviewSnapshot {
  kind: KiloviewKind;
  product: string | null;
  firmware: string | null;
  hardware: string | null;
  serial: string | null;
  hostname: string | null;
  encoder: KvEncoder | null;
  decoder: KvDecoder | null;
  /** Every status answer as received (secrets masked), keyed by request path. For reference. */
  raw: Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const n = (v: unknown) => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const b = (v: unknown) => (typeof v === "boolean" ? v : null);

/**
 * Short video format: "1920x1080i 50Hz" -> "1080i50", "1920x1080P50" -> "1080p50", "1920x1080 25Hz" -> "1080 25Hz".
 * No picture ("0x0 0Hz", "0x0p30") -> null.
 */
export function shortFormat(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  const m = /(\d+)\s*x\s*(\d+)\s*([ipIP])?\s*(\d+(?:\.\d+)?)?\s*(hz)?/i.exec(t);
  if (!m) return t;
  if (Number(m[1]) === 0 || Number(m[2]) === 0) return null;
  const rate = m[4] ? String(Number(m[4])) : "";
  if (m[3]) return `${m[2]}${m[3].toLowerCase()}${rate}`;
  return rate ? `${m[2]} ${rate}Hz` : m[2]!;
}
export const normFormat = (v: string) => v.replace(/\s+/g, "").toLowerCase();

/** Masks stream keys and passwords in a stream address. */
export function maskUrl(u: string): string {
  let out = u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1***@");
  // rtmp(s)://host[:port]/app/<key>: the last path part is the stream key.
  out = out.replace(/^(rtmps?:\/\/[^/\s]+\/[^/\s?]+\/)[^\s?]+/i, "$1***");
  out = out.replace(/([?&](?:passphrase|streamid|key|token|password|pwd)=)[^&\s]*/gi, "$1***");
  return out;
}
const SECRET_KEY = /pass(word|phrase)?$|^pwd$|token|secret|stream_?key|^key$|community/i;
/** Copy of a device answer with secrets masked (for the "all reported data" view and the database). */
export function maskSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskSecrets);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) && typeof x === "string" && x ? "***" : maskSecrets(x);
    return o;
  }
  return typeof v === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? maskUrl(v) : v;
}

/** Interface the E3 encodes (first one that is on). */
export function activeInterface(v: unknown): "hdmi" | "sdi" {
  const o = obj(v);
  return o.sdi === true && o.hdmi !== true ? "sdi" : "hdmi";
}

export function parseEncoder(r: { system?: unknown; active?: unknown; detail?: unknown; venc?: unknown; audio?: unknown; streams?: unknown; network?: unknown }): Omit<KiloviewSnapshot, "raw"> {
  const ver = obj(obj(r.system).version);
  const d = obj(r.detail);
  const sig = s(d.signal);
  const venc = r.venc ? obj(r.venc) : null;
  const au = r.audio ? obj(r.audio) : null;
  const eth = obj(obj(r.network).eth0);
  const iface = activeInterface(r.active);
  return {
    kind: "encoder",
    product: s(ver.product),
    firmware: s(ver.softwareVersion),
    hardware: s(ver.hardwareVersion),
    serial: s(ver.serialNumber),
    hostname: null,
    decoder: null,
    encoder: {
      activeInput: s(d.type) ?? iface.toUpperCase(),
      input: { signal: sig == null ? null : sig === "locked", format: sig === "locked" ? shortFormat(d.format) : null, raw: s(d.format) },
      video: venc
        ? {
            codec: s(venc.codec),
            mode: s(venc.mode),
            bitrateKbps: n(venc.bitrate),
            fps: n(venc.real_fps) ?? n(venc.fps),
            width: n(venc.realWidth) ?? n(venc.picWidth),
            height: n(venc.realHeight) ?? n(venc.picHeight),
          }
        : null,
      audio: au ? { source: s(au.type) ?? s(au.source), sampling: n(au.sampling), channels: n(au.channels), mute: b(au.mute) } : null,
      streams: arr(r.streams).map((x) => {
        const o = obj(x);
        const url = s(o.addressUrl) ?? s(o.address) ?? "";
        return {
          id: s(o.id) ?? s(o.name) ?? "",
          name: s(o.name) ?? s(o.type) ?? "",
          type: s(o.type) ?? "",
          enabled: o.enable === true,
          running: s(o.status) === "start",
          target: url === "offline" ? "" : maskUrl(url),
        };
      }),
      network: Object.keys(eth).length ? { txKbps: n(eth.transmit), rxKbps: n(eth.receive), speedMbps: n(eth.speed) } : null,
    },
  };
}

export function parseDecoder(r: { system?: unknown; codec?: unknown; outputs?: unknown; details?: Record<string, unknown> }): Omit<KiloviewSnapshot, "raw"> {
  const sys = obj(r.system);
  const ver = obj(sys.version);
  const codecs = arr(r.codec).map(obj);
  const outputs: KvOutput[] = arr(r.outputs)
    .map(obj)
    .filter((o) => s(o.id) && s(o.id) !== "-1")
    .map((o) => {
      const id = s(o.id)!;
      const pos = obj(arr(obj(r.details?.[id]).position)[0]);
      const info = codecs.find((c) => normFormat(s(c.type) ?? "") === `output${id}`) ?? {};
      const conns = arr(obj(obj(info.output).direct).video)
        .map(obj)
        .filter((v) => v.enable === true)
        .map((v) => s(v.type))
        .filter(Boolean);
      const stream = obj(arr(obj(info.input).stream).map(obj).find((x) => s(x.id) === s(pos.stream_id)) ?? arr(obj(info.input).stream)[0]);
      const video = obj(obj(arr(info.codec).map(obj).find((c) => s(c.stream_id) === s(pos.stream_id)) ?? arr(info.codec)[0]).video);
      const status = n(pos.status);
      const hasSource = !!s(pos.stream_id) || !!s(stream.id);
      const playing = !hasSource ? null : status != null ? status === 2 : s(stream.status) != null ? s(stream.status) === "start" : null;
      return {
        id,
        connector: conns.length ? conns.join(" + ") : null,
        format: shortFormat(o.res_name),
        source: hasSource
          ? { name: s(pos.stream_name) ?? s(stream.name) ?? "", type: s(pos.type) ?? s(stream.type) ?? "", url: maskUrl(s(pos.stream_ip) ?? s(stream.url) ?? "") }
          : null,
        playing,
        streamFormat: playing ? (shortFormat(pos.resolution) ?? shortFormat(video.format)) : null,
        bitrateKbps: playing ? (n(video.actual_bitrate) ?? (n(pos.video_bitrate) != null ? Math.round(n(pos.video_bitrate)!) : null)) : null,
        codec: s(pos.video_format) ?? s(video.codec),
      };
    });
  return {
    kind: "decoder",
    product: s(ver.product),
    firmware: s(ver.firmwareVersion),
    hardware: s(ver.hardwareVersion),
    serial: s(ver.serialnumber) ?? s(ver.serialNumber),
    hostname: s(sys.hostname),
    encoder: null,
    decoder: { outputs, cpu: n(obj(sys.cpu).percent), mem: n(obj(sys.mem).percent), disk: n(obj(sys.disk).percent), temperature: n(obj(sys.cpu).temperature) },
  };
}

/** What is "on air" right now: streams that run (encoder) or outputs that play a source (decoder). Default watch list. */
export function runningKeys(snap: KiloviewSnapshot): string[] {
  if (snap.encoder) return snap.encoder.streams.filter((x) => x.enabled && x.running).map((x) => x.id);
  return (snap.decoder?.outputs ?? []).filter((o) => o.playing).map((o) => o.id);
}

/** Temperature (°C) from which a decoder gets a warning. */
export const TEMP_WARN = 75;

export interface KiloviewIssueInput {
  online: boolean;
  lastSeenAt: string | null;
  expectedFormat?: string;
  /** Streams (encoder) / outputs (decoder) that must keep running; null = everything that ran when first seen. */
  watch: string[] | null;
  snapshot: KiloviewSnapshot | null;
}
/**
 * Health of a Kiloview box. Down: offline, no input on the encoder, a watched stream stopped, a watched decoder output
 * without picture. Warning: format other than expected (encoder input / decoder output), hot or busy decoder.
 */
export function kiloviewIssues(x: KiloviewIssueInput): Issue[] {
  if (!x.online) return [{ code: "device_offline", level: "down", params: x.lastSeenAt ? { since: x.lastSeenAt } : undefined }];
  const snap = x.snapshot;
  if (!snap) return [];
  const out: Issue[] = [];
  const watch = new Set(x.watch ?? runningKeys(snap));
  const want = (x.expectedFormat ?? "").trim();
  if (snap.encoder) {
    const e = snap.encoder;
    if (e.input.signal === false) out.push({ code: "no_input_signal", level: "down" });
    for (const st of e.streams) if (watch.has(st.id) && !st.running) out.push({ code: "stream_stopped", level: "down", params: { name: st.name } });
    if (want && e.input.signal !== false && e.input.format && normFormat(e.input.format) !== normFormat(want))
      out.push({ code: "input_format", level: "warn", params: { got: e.input.format, want } });
  }
  if (snap.decoder) {
    const d = snap.decoder;
    for (const o of d.outputs) {
      const name = o.connector ?? `Output ${o.id}`;
      if (watch.has(o.id) && o.playing !== true) out.push({ code: "decode_stopped", level: "down", params: { name, source: o.source?.name ?? "" } });
      if (want && watch.has(o.id) && o.format && normFormat(o.format) !== normFormat(want)) out.push({ code: "output_format", level: "warn", params: { name, got: o.format, want } });
    }
    if (d.temperature != null && d.temperature >= TEMP_WARN) out.push({ code: "temp_high", level: "warn", params: { deg: d.temperature } });
    if (d.cpu != null && d.cpu >= CPU_WARN) out.push({ code: "cpu_high", level: "warn", params: { pct: Math.round(d.cpu) } });
  }
  return out;
}
/** Stable key per issue, used to notice new and cleared problems between polls. */
export const issueKey = (i: Issue) => `${i.code}:${i.params?.name ?? ""}`;

export const COMMON_FORMATS = ["1080i50", "1080p50", "1080p25", "720p50", "2160p50"];
