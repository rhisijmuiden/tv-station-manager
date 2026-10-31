/**
 * Remote sources: RTMP/SRT streams that a remote contributor (OBS, vMix, a phone app, an encoder) pushes to the
 * ingest server (MediaMTX) on a studio node. CasparCG on that node plays the stream to a DeckLink output, and the
 * ATEM input that output is cabled to can then be switched on air.
 *
 * - Every remote source has its own stream key. MediaMTX asks this management node whether a key is valid
 *   (authMethod: http, `POST /ingest/auth`), so keys are created and revoked here and nothing is stored on the node.
 * - This node polls the MediaMTX API on each studio node to show whether a stream is coming in.
 * - A source that is routed to a DeckLink output is (re)started on CasparCG whenever its stream (re)connects.
 */
import type { Platform } from "@tvsm/platform";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DeviceHub } from "./devices.js";

export const INGEST_API_USER = "tvsm-management";
export const REMOTE_LAYER = 10;
const POLL_MS = 3000;

export interface LiveRow {
  id: number;
  name: string;
  kind: "atem" | "rtmp";
  atem_input: number;
  studio_id: number | null;
  caspar_channel: number | null;
  url: string | null;
  stream_key: string | null;
}
interface StudioRow {
  id: number;
  name: string;
  host: string;
  public_host: string | null;
  ingest_api_port: number;
}

export interface IngestPath {
  name: string;
  online: boolean;
  onlineSince: string | null;
  tracks: string[];
  inboundBytes: number;
  kbps: number | null;
  readers: number;
}
export interface IngestState {
  reachable: boolean;
  error: string | null;
  checkedAt: string | null;
  paths: Map<string, IngestPath>;
}
export type RemoteState = "pull" | "unknown" | "waiting" | "live";

/** MediaMTX /v3/paths/list item; `ready`/`readyTime`/`tracks`/`bytesReceived` are the pre-1.15 names. */
interface MtxPath {
  name: string;
  ready?: boolean;
  online?: boolean;
  readyTime?: string | null;
  onlineTime?: string | null;
  tracks?: (string | { codec?: string })[];
  tracks2?: { codec?: string }[];
  readers?: unknown[];
  inboundBytes?: number;
  bytesReceived?: number;
}

export function parsePaths(items: MtxPath[], previous: Map<string, IngestPath> | undefined, seconds: number) {
  const out = new Map<string, IngestPath>();
  for (const p of items) {
    const online = p.online ?? p.ready ?? false;
    const bytes = p.inboundBytes ?? p.bytesReceived ?? 0;
    const prev = previous?.get(p.name);
    const kbps = online && prev && seconds > 0 && bytes >= prev.inboundBytes ? Math.round(((bytes - prev.inboundBytes) * 8) / 1000 / seconds) : null;
    out.set(p.name, {
      name: p.name,
      online,
      onlineSince: online ? (p.onlineTime ?? p.readyTime ?? null) : null,
      tracks: (p.tracks2 ?? p.tracks ?? []).map((t) => (typeof t === "string" ? t : (t.codec ?? "?"))),
      inboundBytes: bytes,
      kbps,
      readers: p.readers?.length ?? 0,
    });
  }
  return out;
}

/** "Studio Haarlem!" -> "studio-haarlem-3f9c0a..." */
export function newStreamKey(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return `${slug || "remote"}-${randomBytes(12).toString("hex")}`;
}

export const streamPath = (key: string) => `live/${key}`;

const isLoopback = (ip: string | undefined) => !!ip && (ip === "::1" || ip.startsWith("127.") || ip === "::ffff:127.0.0.1");
const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** MediaMTX HTTP auth request body. */
export interface IngestAuthRequest {
  ip?: string;
  user?: string;
  password?: string;
  action?: string;
  path?: string;
  protocol?: string;
  query?: string;
}

export class RemoteSources {
  private studios = new Map<number, IngestState>();
  /** "studioId:casparChannel" -> the remote source routed to that DeckLink output. */
  private routes = new Map<string, { liveId: number; playing: boolean; onlineSince: string | null }>();
  private timer: NodeJS.Timeout | null = null;
  private lastPoll = 0;
  private polling = false;
  fetcher: typeof fetch = (...a) => fetch(...a);

  constructor(
    private platform: Platform,
    private hub: DeviceHub,
  ) {}

  start() {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
    void this.poll();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Password the management node uses for the MediaMTX API on the studio nodes; checked by `auth()`. */
  apiToken() {
    const s = this.platform.ctx.settings;
    let t = s.get<string>("ingest.apiToken", "");
    if (!t) {
      t = randomBytes(24).toString("hex");
      s.set("ingest.apiToken", t);
    }
    return t;
  }

  /** Answers MediaMTX: may this client publish, read or use the API? */
  auth(r: IngestAuthRequest): boolean {
    switch (r.action) {
      case "publish": {
        const key = /^live\/([A-Za-z0-9_-]{8,80})$/.exec(r.path ?? "")?.[1];
        if (!key) return false;
        return !!this.platform.ctx.db.prepare("SELECT id FROM live_sources WHERE kind = 'rtmp' AND stream_key = ?").get(key);
      }
      case "read":
        // CasparCG and the agent on the studio node itself. Nobody else may pull streams from the node.
        return isLoopback(r.ip);
      case "api":
        return isLoopback(r.ip) || (r.user === INGEST_API_USER && !!r.password && sameSecret(r.password, this.apiToken()));
      default:
        return false;
    }
  }

  private studioRows() {
    return this.platform.ctx.db.prepare("SELECT id, name, host, public_host, ingest_api_port FROM studio_nodes WHERE enabled = 1").all() as unknown as StudioRow[];
  }
  live(id: number) {
    return this.platform.ctx.db.prepare("SELECT * FROM live_sources WHERE id = ?").get(id) as LiveRow | undefined;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();
      const seconds = this.lastPoll ? (now - this.lastPoll) / 1000 : 0;
      this.lastPoll = now;
      const rows = this.studioRows();
      for (const id of this.studios.keys()) if (!rows.some((r) => r.id === id)) this.studios.delete(id);
      const auth = `Basic ${Buffer.from(`${INGEST_API_USER}:${this.apiToken()}`).toString("base64")}`;
      await Promise.all(
        rows.map(async (s) => {
          const prev = this.studios.get(s.id);
          try {
            const res = await this.fetcher(`http://${s.host}:${s.ingest_api_port}/v3/paths/list?itemsPerPage=500`, { headers: { authorization: auth }, signal: AbortSignal.timeout(2500) });
            if (!res.ok) throw new Error(res.status === 401 ? "unauthorized" : `HTTP ${res.status}`);
            const j = (await res.json()) as { items?: MtxPath[] };
            this.studios.set(s.id, { reachable: true, error: null, checkedAt: new Date(now).toISOString(), paths: parsePaths(j.items ?? [], prev?.paths, seconds) });
          } catch (e) {
            const err = e as Error;
            this.studios.set(s.id, { reachable: false, error: err.name === "TimeoutError" ? "timeout" : err.message, checkedAt: new Date(now).toISOString(), paths: new Map() });
          }
        }),
      );
      await this.reconcile();
    } finally {
      this.polling = false;
    }
  }

  /** (Re)starts routed streams on CasparCG when they come online or reconnect. */
  private async reconcile() {
    for (const [key, r] of this.routes) {
      const live = this.live(r.liveId);
      if (!live || live.kind !== "rtmp" || !live.studio_id || !live.caspar_channel) {
        this.routes.delete(key);
        continue;
      }
      if (live.url) continue; // pulled by CasparCG itself
      const st = this.status(live);
      if (st.state !== "live") {
        r.playing = false;
        r.onlineSince = null;
        continue;
      }
      if (r.playing && r.onlineSince === st.onlineSince) continue;
      try {
        await this.hub.playout(live.studio_id)?.play(live.caspar_channel, REMOTE_LAYER, this.playUrl(live));
        r.playing = true;
        r.onlineSince = st.onlineSince;
        this.platform.ctx.log.info({ source: live.name }, "remote source started on CasparCG");
      } catch (e) {
        this.platform.ctx.log.warn({ source: live.name, err: (e as Error).message }, "could not start remote source");
      }
    }
  }

  ingest(studioId: number | null | undefined) {
    const s = studioId == null ? undefined : this.studios.get(studioId);
    return s ? { reachable: s.reachable, error: s.error, checkedAt: s.checkedAt } : { reachable: false, error: null, checkedAt: null };
  }

  /** What CasparCG plays: the pull URL, or the stream on the local ingest server. */
  playUrl(live: LiveRow) {
    return live.url || `rtmp://127.0.0.1/${streamPath(live.stream_key ?? "")}`;
  }

  status(live: LiveRow): { state: RemoteState; onlineSince: string | null; tracks: string[]; kbps: number | null } {
    const none = { onlineSince: null, tracks: [], kbps: null };
    if (live.url) return { state: "pull", ...none };
    const s = live.studio_id == null ? undefined : this.studios.get(live.studio_id);
    if (!s?.reachable || !live.stream_key) return { state: "unknown", ...none };
    const p = s.paths.get(streamPath(live.stream_key));
    if (!p?.online) return { state: "waiting", ...none };
    return { state: "live", onlineSince: p.onlineSince, tracks: p.tracks, kbps: p.kbps };
  }

  /** Connection details for the remote contributor. */
  pushInfo(live: LiveRow) {
    if (live.url || !live.stream_key || !live.studio_id) return null;
    const s = this.platform.ctx.db.prepare("SELECT host, public_host FROM studio_nodes WHERE id = ?").get(live.studio_id) as { host: string; public_host: string | null } | undefined;
    if (!s) return null;
    const host = s.public_host || s.host;
    const path = streamPath(live.stream_key);
    return {
      host,
      rtmpServer: `rtmp://${host}/live`,
      streamKey: live.stream_key,
      rtmpUrl: `rtmp://${host}/${path}`,
      srtUrl: `srt://${host}:8890?streamid=publish:${path}`,
    };
  }

  /** The remote source routed to this DeckLink output, if any. */
  routedTo(studioId: number, casparChannel: number) {
    return this.routes.get(`${studioId}:${casparChannel}`)?.liveId ?? null;
  }
  isRouted(live: LiveRow) {
    return !!live.studio_id && !!live.caspar_channel && this.routedTo(live.studio_id, live.caspar_channel) === live.id;
  }

  /**
   * Puts a remote source on its DeckLink output (CasparCG channel). A stream that is not coming in yet is started
   * as soon as it arrives.
   */
  async route(live: LiveRow) {
    if (live.kind !== "rtmp" || !live.studio_id || !live.caspar_channel) throw new Error("not a remote source");
    const p = this.hub.playout(live.studio_id);
    if (!p) throw new Error("studio node for this stream is not configured");
    const key = `${live.studio_id}:${live.caspar_channel}`;
    const cur = this.routes.get(key);
    if (cur?.liveId === live.id && cur.playing) return;
    const st = this.status(live);
    const r = { liveId: live.id, playing: false, onlineSince: null as string | null };
    this.routes.set(key, r);
    if (st.state === "live" || st.state === "pull" || st.state === "unknown") {
      await p.play(live.caspar_channel, REMOTE_LAYER, this.playUrl(live));
      r.playing = true;
      r.onlineSince = st.onlineSince;
    } else await p.stop(live.caspar_channel, REMOTE_LAYER).catch(() => undefined);
  }

  /** Stops whatever remote source plays on this DeckLink output. */
  async unroute(studioId: number, casparChannel: number) {
    const key = `${studioId}:${casparChannel}`;
    if (!this.routes.has(key)) return;
    this.routes.delete(key);
    await this.hub.playout(studioId)?.stop(casparChannel, REMOTE_LAYER).catch(() => undefined);
  }

  /** The playout took this output over (e.g. it plays a clip on it): forget the route without stopping. */
  forget(studioId: number | null | undefined, casparChannel: number) {
    if (studioId != null) this.routes.delete(`${studioId}:${casparChannel}`);
  }
}
