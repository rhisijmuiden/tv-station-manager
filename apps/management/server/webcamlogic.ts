/**
 * Pure logic for webcams and external streams ("live pictures" an editor clicks into a programme, like a beeldkrant):
 * - what kind of link it is (`detectKind`),
 * - which streams a webcam web page (e.g. webcam.nl) hides (`scanPage`),
 * - how the studio node plays it (`playPlan`) and the ffmpeg arguments of the management node's relay (`relayArgs`).
 *
 * Kinds:
 * - hls    HTTP Live Streaming (.m3u8), most webcam sites use it.
 * - rtsp   IP cameras (rtsp://, rtsps://).
 * - rtmp / srt  streams from an encoder or a streaming server.
 * - video  any other video URL ffmpeg can read (MPEG-TS, MP4, FLV over http(s)).
 * - mjpeg  Motion-JPEG over http (many older IP cameras: /mjpg/video.mjpg, /video.cgi).
 * - image  a still picture that the camera refreshes (snapshot.jpg); shown again every few seconds.
 * - page   a web page that is shown as it is (when no stream could be found in it).
 */
import { z } from "zod";

export const WEBCAM_KINDS = ["hls", "rtsp", "rtmp", "srt", "video", "mjpeg", "image", "page"] as const;
export type WebcamKind = (typeof WEBCAM_KINDS)[number];
/** Kinds the studio node plays as video (CasparCG FFmpeg producer). The rest is a web page (CasparCG HTML producer). */
export const VIDEO_KINDS: readonly WebcamKind[] = ["hls", "rtsp", "rtmp", "srt", "video"];
export const isVideoKind = (k: WebcamKind) => VIDEO_KINDS.includes(k);

export const webcamSettingsSchema = z.object({
  /** Default length of the item in a programme (seconds); a duration on the block item wins. */
  durationSec: z.number().int().min(5).max(24 * 3600).default(60),
  /** Sound of the stream; off by default (most webcams have none, or only wind). */
  audio: z.boolean().default(false),
  /** Caption at the bottom ("LIVE · Strand Wijk aan Zee"). Empty text = the name of the webcam. */
  caption: z
    .object({
      enabled: z.boolean().default(true),
      text: z.string().max(120).default(""),
      live: z.boolean().default(true),
      position: z.enum(["bottom-left", "bottom-right", "top-left", "top-right"]).default("bottom-left"),
    })
    .prefault({}),
  /** The channel overlay (logo, clock, ticker) stays on top. */
  showOverlay: z.boolean().default(true),
  /** Pictures: fill the screen (crop) or show them whole. */
  fit: z.enum(["cover", "contain"]).default("cover"),
  /** Still pictures: load a new one every n seconds. */
  refreshSec: z.number().int().min(1).max(600).default(5),
  /**
   * Video streams: "relay" = the management node fetches the stream and hands it to the studio node (the studio
   * needs no internet access, RTSP goes over TCP); "direct" = CasparCG opens the URL itself.
   */
  via: z.enum(["relay", "direct"]).default("relay"),
});
export type WebcamSettings = z.infer<typeof webcamSettingsSchema>;

const VIDEO_EXT = /\.(mp4|m4v|mov|ts|mts|flv|mkv|webm)(\?|#|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)(\?|#|$)/i;
const MJPEG_HINT = /(\.mjpe?g(\?|#|$)|\/mjpg\/|\/video\.cgi|faststream|mjpegstream|action=stream|videostream\.cgi|nphMotionJpeg|\/axis-cgi\/mjpg)/i;
const SNAPSHOT_HINT = /(snapshot|snap\.cgi|image\.cgi|still\.jpg|current\.jpg|latest\.jpg|webcam\.jpg|\/jpg\/image|cam\.jpg|axis-cgi\/jpg)/i;
const YOUTUBE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

/** Adds https:// to "www.webcam.nl/…" and checks the scheme. */
export function normaliseUrl(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error("empty URL");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  const u = new URL(s);
  if (!["http:", "https:", "rtsp:", "rtsps:", "rtmp:", "rtmps:", "srt:"].includes(u.protocol)) throw new Error(`unsupported scheme ${u.protocol}`);
  return u.toString();
}

/** Guesses the kind from the URL alone. */
export function detectKind(url: string): WebcamKind {
  const u = new URL(url);
  const p = u.protocol;
  if (p === "rtsp:" || p === "rtsps:") return "rtsp";
  if (p === "rtmp:" || p === "rtmps:") return "rtmp";
  if (p === "srt:") return "srt";
  const path = u.pathname + u.search;
  if (/\.m3u8(\?|#|$)/i.test(path) || /\/(playlist|index|chunklist)[^/]*\.m3u8/i.test(path)) return "hls";
  if (MJPEG_HINT.test(path)) return "mjpeg";
  if (IMAGE_EXT.test(u.pathname) || SNAPSHOT_HINT.test(path)) return "image";
  if (VIDEO_EXT.test(u.pathname)) return "video";
  return "page";
}

/** Kind from the Content-Type of an http(s) answer, when the URL does not tell. */
export function kindFromContentType(type: string | null | undefined): WebcamKind | null {
  const t = (type ?? "").toLowerCase();
  if (!t) return null;
  if (t.includes("mpegurl")) return "hls";
  if (t.includes("multipart/x-mixed-replace")) return "mjpeg";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/") || t.includes("mp2t")) return "video";
  if (t.includes("html")) return "page";
  return null;
}

export const isYouTube = (url: string) => {
  try {
    return YOUTUBE.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

export interface Candidate {
  url: string;
  kind: WebcamKind;
  /** Where it was found: a <video>/<source> tag, a player setting in a script, an embedded frame, a picture, … */
  found: "video" | "script" | "iframe" | "image" | "meta";
}

const RANK: Record<WebcamKind, number> = { hls: 0, rtsp: 1, rtmp: 2, srt: 3, video: 4, mjpeg: 5, image: 6, page: 7 };

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

/** JavaScript strings: "https:\/\/cam.example\/live.m3u8", /, … */
const unescapeJs = (s: string) => s.replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/").replace(/\\u0026/g, "&");

const resolve = (raw: string, base: string): string | null => {
  const s = decodeEntities(unescapeJs(raw.trim()));
  if (!s || s.startsWith("data:") || s.startsWith("blob:") || s.startsWith("javascript:")) return null;
  try {
    const u = new URL(s.startsWith("//") ? `${new URL(base).protocol}${s}` : s, base);
    return ["http:", "https:", "rtsp:", "rtsps:", "rtmp:", "rtmps:", "srt:"].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
};

/**
 * Finds the streams in a webcam web page: <video>/<source> tags, player settings in scripts (hls.js, video.js,
 * JW Player, Clappr: any quoted .m3u8 / rtsp:// / .mjpg URL), og:video, camera pictures and embedded players (<iframe>).
 * Best first: HLS, RTSP, …, then pictures, then embedded pages (to look into one level deeper).
 */
export function scanPage(html: string, baseUrl: string): Candidate[] {
  const out = new Map<string, Candidate>();
  const add = (raw: string | undefined, found: Candidate["found"], force?: WebcamKind) => {
    if (!raw) return;
    const url = resolve(raw, baseUrl);
    if (!url || url === baseUrl) return;
    let kind = force ?? detectKind(url);
    if (found === "iframe" && kind === "page") kind = "page";
    else if (kind === "page") return; // a plain link is not a stream
    if (isYouTube(url)) return; // CasparCG cannot play YouTube pages; see docs
    const prev = out.get(url);
    if (!prev || RANK[kind] < RANK[prev.kind]) out.set(url, { url, kind, found });
  };
  const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(2).find((x) => x != null);

  for (const m of html.matchAll(/<(video|source)\b[^>]*>/gi)) {
    const src = attr(m[0], "src") ?? attr(m[0], "data-src");
    const type = attr(m[0], "type");
    add(src, "video", type && /mpegurl/i.test(type) ? "hls" : undefined);
    const poster = attr(m[0], "poster");
    if (poster && (SNAPSHOT_HINT.test(poster) || /cam/i.test(poster))) add(poster, "image", "image");
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const prop = attr(m[0], "property") ?? attr(m[0], "name") ?? "";
    if (/^(og:video(:url|:secure_url)?|twitter:player:stream)$/i.test(prop)) add(attr(m[0], "content"), "meta");
  }
  // Quoted URLs anywhere (scripts, data attributes, JSON): streams and camera pictures.
  for (const m of html.matchAll(/["'`]((?:https?:|rtsps?:|rtmps?:|srt:)?(?:\\?\/\\?\/)?[^"'`\s<>]*?(?:\.m3u8|\.mjpe?g|\/mjpg\/[^"'`\s<>]*|\/video\.cgi)[^"'`\s<>]*)["'`]/gi)) add(m[1], "script");
  for (const m of html.matchAll(/["'`]((?:rtsps?|rtmps?|srt):\\?\/\\?\/[^"'`\s<>]+)["'`]/gi)) add(m[1], "script");
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(m[0], "src") ?? attr(m[0], "data-src");
    if (!src) continue;
    const u = resolve(src, baseUrl);
    if (!u) continue;
    if (MJPEG_HINT.test(u)) add(u, "image", "mjpeg");
    else if (SNAPSHOT_HINT.test(u) || /webcam|\/cam(era)?s?\//i.test(new URL(u).pathname)) add(u, "image", "image");
  }
  for (const m of html.matchAll(/<iframe\b[^>]*>/gi)) {
    const src = attr(m[0], "src") ?? attr(m[0], "data-src");
    if (src && !/(doubleclick|googlesyndication|facebook\.com\/plugins|google\.com\/maps|recaptcha|cookie)/i.test(src)) add(src, "iframe", "page");
  }
  return [...out.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

/** What ffmpeg says about the input ("Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 25 fps"). */
export interface StreamInfo {
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  audioCodec: string | null;
}
export function parseFfmpegInfo(stderr: string): StreamInfo {
  const v = /Stream #\d+:\d+[^:]*: Video: ([a-z0-9_]+)[^\n]*?(\d{2,5})x(\d{2,5})(?:[^\n]*?([\d.]+) (?:fps|tbr))?/i.exec(stderr);
  const a = /Stream #\d+:\d+[^:]*: Audio: ([a-z0-9_]+)/i.exec(stderr);
  return {
    videoCodec: v?.[1] ?? null,
    width: v ? Number(v[2]) : null,
    height: v ? Number(v[3]) : null,
    fps: v?.[4] ? Math.round(Number(v[4]) * 100) / 100 : null,
    audioCodec: a?.[1] ?? null,
  };
}

/** ffmpeg input options per kind: time-outs, RTSP over TCP, start at the live edge. */
export function inputArgs(kind: WebcamKind, url: string): string[] {
  const a = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  if (kind === "rtsp") a.push("-rtsp_transport", "tcp", "-timeout", "10000000");
  else if (kind === "srt") a.push("-timeout", "10000000");
  else if (kind === "rtmp") a.push("-rw_timeout", "10000000");
  else if (kind === "mjpeg") a.push("-f", "mpjpeg", "-rw_timeout", "10000000");
  else a.push("-rw_timeout", "10000000", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
  if (kind === "hls") a.push("-live_start_index", "-2");
  // A file (not a live stream) is read at its own speed, so it does not race ahead of the playout.
  if (kind === "video") a.push("-re");
  a.push("-fflags", "+genpts+discardcorrupt", "-i", url);
  return a;
}

/** Relay on the management node: the stream as MPEG-TS on stdout, without re-encoding; no sound unless asked. */
export function relayArgs(kind: WebcamKind, url: string, audio: boolean): string[] {
  return [...inputArgs(kind, url), "-map", "0:v:0", ...(audio ? ["-map", "0:a:0?"] : ["-an"]), "-c", "copy", "-sn", "-dn", "-f", "mpegts", "-muxdelay", "0", "pipe:1"];
}

/** One frame as a small JPEG (preview card), plus the stream details on stderr. */
export function snapshotArgs(kind: WebcamKind, url: string): string[] {
  return [...inputArgs(kind, url).filter((x) => x !== "-re"), "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1"];
}

export interface WebcamPlay {
  /** "video": PLAY <url> (FFmpeg producer). "html": PLAY [HTML] <url>. */
  mode: "video" | "html";
  url: string;
  /** Caption page played on the layer above, for video. */
  captionUrl: string | null;
}

/** How the studio node plays a webcam. `base` is the management node's public URL. */
export function playPlan(cam: { id: number; kind: WebcamKind; url: string; settings: WebcamSettings }, base: string): WebcamPlay {
  const page = `${base}/webcam/page.html?id=${cam.id}`;
  const caption = cam.settings.caption.enabled ? `${page}&caption=1` : null;
  if (isVideoKind(cam.kind)) return { mode: "video", url: cam.settings.via === "relay" ? `${base}/webcam/${cam.id}/live.ts` : cam.url, captionUrl: caption };
  // A foreign web page plays as it is (it may not allow being framed); the caption goes on the layer above.
  if (cam.kind === "page") return { mode: "html", url: cam.url, captionUrl: caption };
  // Pictures and MJPEG: our own page shows them (through the management node) with the caption.
  return { mode: "html", url: page, captionUrl: null };
}

export const captionText = (name: string, s: WebcamSettings) => (s.caption.text.trim() || name).slice(0, 120);
