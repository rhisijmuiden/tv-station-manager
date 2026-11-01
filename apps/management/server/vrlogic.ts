/**
 * Visual Radio, pure logic (no I/O, fully tested):
 * - normalising artist/title so the radio playout and the clip library agree,
 * - parsing "now playing" metadata from any radio playout (JSON, XML, plain text, query string),
 * - finding the clip for a song (song id, manual link, exact key, fuzzy),
 * - deciding which ATEM input belongs on air (microphones, clip, fallback).
 */

// ---- normalising ------------------------------------------------------------------

/** Words in brackets that say something about the recording or the video, not about the song. */
const NOISE =
  /\b(radio|single|album|clean|explicit|dirty|short|extended|original|edit|version|mix|official|music|video|videoclip|clip|audio|lyrics?|visuali[sz]er|hd|hq|4k|uhd|remaster(ed)?|\d{4}\s*remaster(ed)?|mono|stereo|intro|outro)\b/i;

export const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

const basic = (s: string) =>
  stripAccents(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Removes "(Radio Edit)", "[Official Video]", "- Remastered 2011" and "feat. X" from a title. Keeps "(Remix)"-less info like "(Part 2)". */
export function cleanTitle(title: string) {
  let t = title;
  t = t.replace(/[([{]([^)\]}]*)[)\]}]/g, (m, inner: string) => (NOISE.test(inner) || /\b(feat|ft|featuring)\b/i.test(inner) ? " " : m));
  t = t.replace(/\s+-\s+.*\b(remaster(ed)?|edit|version|mix|video)\b.*$/i, " ");
  t = t.replace(/\s+\b(feat|ft|featuring)\b\.?\s.*$/i, " ");
  return t;
}

/** The artist list split on feat./ft./&/x/and/vs/","; the first one is the main artist. */
export function splitArtists(artist: string) {
  return stripAccents(artist)
    .replace(/\b(feat|ft|featuring|vs|with|and|x)\b\.?|[&,+/]/gi, ",")
    .split(",")
    .map(basic)
    .filter(Boolean);
}

export const normTitle = (title: string) => basic(cleanTitle(title));
export const normArtist = (artist: string) => splitArtists(artist).join(" ");
/** Matching key: main artist + clean title, e.g. "beyonce|halo". */
export function matchKey(artist: string, title: string) {
  const a = splitArtists(artist)[0] ?? "";
  return `${a.replace(/^the /, "")}|${normTitle(title)}`;
}

/** "Artist - Title (Official Video).mp4" -> { artist, title }; null when the name has no " - ". */
export function parseClipName(fileName: string): { artist: string; title: string } | null {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/_/g, " ");
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base.trim());
  if (!m) return null;
  return { artist: m[1]!.trim(), title: m[2]!.trim() };
}

// ---- fuzzy similarity ---------------------------------------------------------------

export function bigrams(s: string) {
  const set = new Set<string>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
/** Sørensen–Dice coefficient on character bigrams, 0..1. */
export function dice(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return (2 * n) / (a.size + b.size);
}

// ---- now playing metadata --------------------------------------------------------------

export type ItemType = "music" | "jingle" | "ad" | "news" | "voice" | "other";
export interface NowPlaying {
  artist: string;
  title: string;
  type: ItemType;
  /** Song id from the radio playout, when it sends one. */
  songId: string | null;
  durationMs: number | null;
  /** When the item started on the radio (epoch ms); null = "now". */
  startedAt: number | null;
}

export function itemType(v: unknown, hasSong: boolean): ItemType {
  const s = String(v ?? "").toLowerCase();
  if (!s) return hasSong ? "music" : "other";
  if (/^(music|song|track|m|mus|muziek|lied|nummer)$/.test(s)) return "music";
  if (/jingle|sweeper|ident|station|promo|liner|bumper|^j$/.test(s)) return "jingle";
  if (/^(ad|ads|advert\w*|commercials?|spots?|reclame|c)$/.test(s)) return "ad";
  if (/news|nieuws|weather|weer|traffic|verkeer/.test(s)) return "news";
  if (/voice|talk|speech|presenter|mic|^v$/.test(s)) return "voice";
  return hasSong ? "music" : "other";
}

/** "3:25", "205", "205000", "PT3M25S" -> ms. Plain numbers below 1000 are seconds, larger are ms. */
export function parseDurationMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? (v < 1000 ? Math.round(v * 1000) : Math.round(v)) : null;
  const s = String(v).trim();
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/i.exec(s);
  if (iso && s.length > 2) return Math.round(((Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0)) * 60 + Number(iso[3] ?? 0)) * 1000);
  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) return Math.round(s.split(":").reduce((a, p) => a * 60 + Number(p), 0) * 1000);
  if (/^\d+(\.\d+)?$/.test(s)) return parseDurationMs(Number(s));
  return null;
}

function parseTime(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseTime(Number(s));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

const pick = (o: Record<string, unknown>, ...names: string[]) => {
  const lower = new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) {
    const v = lower.get(n.toLowerCase());
    if (v != null && v !== "") return v;
  }
  return undefined;
};

function fromObject(o: Record<string, unknown>): NowPlaying | null {
  // Wrappers used by playouts and stream servers: { current: {...} }, { nowplaying: {...} }, { song: {...} }.
  for (const [k, inner] of Object.entries(o))
    if (/^(current|nowplaying|now_playing|now|song|track|item)$/i.test(k) && inner && typeof inner === "object" && !Array.isArray(inner)) {
      const rest = Object.fromEntries(Object.entries(o).filter(([x]) => x !== k && !/^next/i.test(x)));
      const r = fromObject({ ...rest, ...(inner as Record<string, unknown>) });
      if (r) return r;
    }
  let artist = String(pick(o, "artist", "artiest", "performer", "author") ?? "").trim();
  let title = String(pick(o, "title", "titel", "song", "name", "text", "streamtitle") ?? "").trim();
  if (!artist && title) {
    const split = parseClipName(title);
    if (split) ({ artist, title } = split);
  }
  if (!artist && !title) return null;
  const hasSong = !!artist && !!title;
  return {
    artist,
    title,
    type: itemType(pick(o, "type", "itemtype", "category", "kind", "class"), hasSong),
    songId: (() => {
      const v = pick(o, "songid", "song_id", "id", "itemid", "externalid", "external_id", "isrc");
      return v == null ? null : String(v).trim() || null;
    })(),
    durationMs: parseDurationMs(pick(o, "durationms", "duration_ms", "duration", "length", "lengthms")),
    startedAt: parseTime(pick(o, "startedat", "started_at", "starttime", "start_time", "start", "started")),
  };
}

/** Flat tag/attribute reader; good enough for the small now-playing XML documents radio playouts send. */
function fromXml(xml: string): NowPlaying | null {
  const o: Record<string, unknown> = {};
  const unescape = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
  // The first item element when there is a list (current first).
  const scope = /<(current|nowplaying|now|item|song|track)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(xml)?.[0] ?? xml;
  for (const m of scope.matchAll(/<([a-z_][\w.-]*)\b[^>]*>([^<]*(?:<!\[CDATA\[[\s\S]*?\]\]>)?[^<]*)<\/\1>/gi)) if (!(m[1]!.toLowerCase() in o)) o[m[1]!.toLowerCase()] = unescape(m[2]!);
  for (const m of scope.matchAll(/\b([a-z_][\w-]*)\s*=\s*"([^"]*)"/gi)) if (!(m[1]!.toLowerCase() in o)) o[m[1]!.toLowerCase()] = unescape(m[2]!);
  return fromObject(o);
}

/**
 * Song text sent to an RDS encoder in its ASCII protocol: "RT=Artist - Title", "TEXT=…", "DPS=…", "RT+…".
 * Returns the text after the last such command, or null when the input is no RDS command.
 */
export function parseRdsText(s: string): string | null {
  let text: string | null = null;
  for (const raw of s.split(/[\r\n\0]+/)) {
    const m = /^\s*(?:RT|RT1|RT2|TEXT|DPS|DPS1|RADIOTEXT)\s*[=:]\s*(.*)$/i.exec(raw);
    if (m && m[1]!.trim()) text = m[1]!.trim();
  }
  if (!text) return null;
  // Station slogans around the song ("Nu op IJmond360: Artist - Title") are removed.
  return text.replace(/^(nu|now)\s+(op|on|playing|speelt)[^:]*:\s*/i, "").replace(/^(nu|now)\s*:\s*/i, "");
}

/** Parses whatever a playout sends: a JSON object, XML, a query string or plain "Artist - Title". */
export function parseNowPlaying(body: unknown, query: Record<string, unknown> = {}): NowPlaying | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const r = fromObject(body as Record<string, unknown>);
    if (r) return r;
  }
  if (typeof body === "string" && body.trim()) {
    const s = body.trim();
    if (s.startsWith("{")) {
      try {
        return parseNowPlaying(JSON.parse(s), query);
      } catch {
        /* not JSON after all */
      }
    }
    if (s.startsWith("<")) return fromXml(s);
    const rds = parseRdsText(s);
    if (rds) return parseNowPlaying(rds, query);
    const line = s.split(/\r?\n/)[0]!.trim();
    const split = parseClipName(line);
    return split ? { ...split, type: "music", songId: null, durationMs: null, startedAt: null } : { artist: "", title: line, type: "other", songId: null, durationMs: null, startedAt: null };
  }
  return Object.keys(query).length ? fromObject(query) : null;
}

/** "1", "true", "on", "open" -> true. */
export const truthy = (v: unknown) => v === true || v === 1 || /^(1|true|on|open|yes|aan|live)$/i.test(String(v ?? "").trim());

// ---- clip index --------------------------------------------------------------------------

export interface ClipEntry {
  id: number;
  artist: string;
  title: string;
  songId: string | null;
  durationMs: number | null;
}
export type MatchHow = "id" | "link" | "exact" | "fuzzy";
export interface ClipMatch {
  clip: ClipEntry;
  how: MatchHow;
  score: number;
}

interface Indexed {
  clip: ClipEntry;
  key: string;
  artist: Set<string>;
  title: Set<string>;
}

export class ClipIndex {
  private byId = new Map<string, ClipEntry>();
  private byKey = new Map<string, ClipEntry>();
  private all: Indexed[] = [];
  constructor(
    clips: ClipEntry[],
    /** Manual links: match key -> clip id (made from the "missing clips" list). */
    private links = new Map<string, number>(),
  ) {
    for (const c of clips) {
      const key = matchKey(c.artist, c.title);
      if (c.songId) this.byId.set(c.songId.toLowerCase(), c);
      if (!this.byKey.has(key)) this.byKey.set(key, c);
      this.all.push({ clip: c, key, artist: bigrams(normArtist(c.artist)), title: bigrams(normTitle(c.title)) });
    }
  }
  get size() {
    return this.all.length;
  }

  match(artist: string, title: string, songId: string | null, threshold = 0.82): ClipMatch | null {
    if (songId) {
      const c = this.byId.get(songId.toLowerCase());
      if (c) return { clip: c, how: "id", score: 1 };
    }
    const key = matchKey(artist, title);
    const linked = this.links.get(key);
    if (linked != null) {
      const c = this.all.find((x) => x.clip.id === linked)?.clip;
      if (c) return { clip: c, how: "link", score: 1 };
    }
    const exact = this.byKey.get(key);
    if (exact) return { clip: exact, how: "exact", score: 1 };
    const a = bigrams(normArtist(artist));
    const t = bigrams(normTitle(title));
    let best: ClipMatch | null = null;
    for (const x of this.all) {
      const ts = dice(t, x.title);
      if (ts < 0.7) continue;
      const score = 0.4 * dice(a, x.artist) + 0.6 * ts;
      if (score >= threshold && (!best || score > best.score)) best = { clip: x.clip, how: "fuzzy", score: Math.round(score * 1000) / 1000 };
    }
    return best;
  }
}

// ---- which input goes on air ------------------------------------------------------------------

export interface MicConfig {
  key: string;
  input: number;
  /** Higher wins when more microphones are open and there is no wide shot. */
  priority: number;
}
export interface ShotConfig {
  clipInput: number | null;
  wideInput: number | null;
  loopInput: number | null;
  /** What to show for music without a clip. */
  fallback: "loop" | "wide";
  openDelayMs: number;
  closeDelayMs: number;
  minShotMs: number;
  mics: MicConfig[];
}
export interface MicState {
  open: boolean;
  /** When the microphone last opened or closed. */
  since: number;
  /** It was on air (open for at least the open delay) before it closed: keep the camera for the close delay. */
  wasLive: boolean;
}
export interface ShotInput {
  now: number;
  manualInput: number | null;
  mics: Map<string, MicState>;
  /** Type of what the radio plays now; null when nothing is known (or it is stale). */
  playing: ItemType | null;
  clipRunning: boolean;
  current: { input: number; since: number } | null;
}
export type ShotReason = "manual" | "mics" | "mic" | "clip" | "fallback" | "idle";
export interface Shot {
  input: number | null;
  reason: ShotReason;
  mic?: string;
  /** The rules want another input, but the current shot has not been on air for the minimum shot length yet. */
  held?: boolean;
}

export function micLive(m: MicState | undefined, now: number, cfg: Pick<ShotConfig, "openDelayMs" | "closeDelayMs">) {
  if (!m) return false;
  return m.open ? now - m.since >= cfg.openDelayMs : m.wasLive && now - m.since < cfg.closeDelayMs;
}

/** The shot that should be on air now, by the rules: manual > microphones > clip > fallback > idle. */
export function decideShot(cfg: ShotConfig, s: ShotInput): Shot {
  const want = ((): Shot => {
    if (s.manualInput != null) return { input: s.manualInput, reason: "manual" };
    const live = cfg.mics.filter((m) => micLive(s.mics.get(m.key), s.now, cfg)).sort((a, b) => b.priority - a.priority);
    if (live.length > 1) return cfg.wideInput != null ? { input: cfg.wideInput, reason: "mics" } : { input: live[0]!.input, reason: "mic", mic: live[0]!.key };
    if (live.length === 1) return { input: live[0]!.input, reason: "mic", mic: live[0]!.key };
    if (s.playing === "music" && s.clipRunning && cfg.clipInput != null) return { input: cfg.clipInput, reason: "clip" };
    if (s.playing === "music") return { input: cfg.fallback === "wide" ? (cfg.wideInput ?? cfg.loopInput) : (cfg.loopInput ?? cfg.wideInput), reason: "fallback" };
    return { input: cfg.loopInput ?? cfg.wideInput, reason: "idle" };
  })();
  // Minimum shot length, so a camera does not flash on air (manual choices are never held back).
  if (want.reason !== "manual" && s.current && want.input !== s.current.input && s.now - s.current.since < cfg.minShotMs) return { input: s.current.input, reason: want.reason, mic: want.mic, held: true };
  return want;
}
