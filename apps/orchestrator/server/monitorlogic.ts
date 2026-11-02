/**
 * Monitoring helpers shared by the orchestrator server and its web UI (pure: no I/O).
 *
 * Every monitored thing (node, ATEM, HyperDeck, Owncast, extra device) gets a health level plus a list of issues.
 * Issues are codes with parameters so the UI can translate them (EN/NL).
 */

export type Health = "ok" | "warn" | "down" | "unknown";
export interface Issue {
  code: string;
  level: Exclude<Health, "ok" | "unknown">;
  params?: Record<string, string | number>;
}

export const BLOCKS = ["infrastructure", "distribution", "extra"] as const;
export type Block = (typeof BLOCKS)[number];
export const CHECK_TYPES = ["owncast", "http", "tcp", "manual"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];
export const MANUAL_STATUSES = ["ok", "warn", "down", "unknown"] as const;

/** Thresholds for node metrics (percent). */
export const DISK_WARN = 90;
export const MEM_WARN = 95;
export const CPU_WARN = 95;
/** A check must fail this many times in a row before a device counts as down (no flapping on one lost packet). */
export const FAILS_BEFORE_DOWN = 2;

const RANK: Record<Health, number> = { ok: 0, unknown: 1, warn: 2, down: 3 };
/** The worst of several levels; "unknown" only wins over "ok". An empty list is "ok". */
export function worst(levels: Health[]): Health {
  return levels.reduce<Health>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");
}
export const healthOf = (issues: Issue[], base: Health = "ok"): Health => worst([base, ...issues.map((i) => i.level)]);

// ---- nodes --------------------------------------------------------------------------

export interface NodeMetrics {
  cpuPercent?: number;
  memTotal?: number;
  memUsed?: number;
  disks?: { mount: string; total: number; used: number }[];
  uptimeSeconds?: number;
  studio?: {
    casparcg?: { connected: boolean; channels?: { id: number; status: string }[] };
    ingest?: { streams?: { name: string; ready: boolean }[] };
    mediaPath?: string | null;
    mediaReachable?: boolean | null;
  };
}
export interface NodeInput {
  status: "pending" | "approved" | "rejected";
  role: string;
  online: boolean;
  lastSeenAt: string | null;
  metrics: NodeMetrics | null;
}

export const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);

export function nodeIssues(n: NodeInput): Issue[] {
  if (n.status === "pending") return [{ code: "pending_approval", level: "warn" }];
  if (!n.online) return [{ code: n.lastSeenAt ? "agent_unresponsive" : "never_seen", level: "down", params: n.lastSeenAt ? { since: n.lastSeenAt } : undefined }];
  const out: Issue[] = [];
  const m = n.metrics;
  if (!m) return out;
  for (const d of m.disks ?? []) {
    const p = pct(d.used, d.total);
    if (p >= DISK_WARN) out.push({ code: "disk_full", level: "warn", params: { mount: d.mount, pct: p } });
  }
  if (m.memTotal && m.memUsed != null && pct(m.memUsed, m.memTotal) >= MEM_WARN) out.push({ code: "memory_high", level: "warn", params: { pct: pct(m.memUsed, m.memTotal) } });
  if (m.cpuPercent != null && m.cpuPercent >= CPU_WARN) out.push({ code: "cpu_high", level: "warn", params: { pct: Math.round(m.cpuPercent) } });
  const s = m.studio;
  if (s?.casparcg && !s.casparcg.connected) out.push({ code: "casparcg_down", level: "down" });
  if (s?.mediaPath && s.mediaReachable === false) out.push({ code: "media_unreachable", level: "warn", params: { path: s.mediaPath } });
  return out;
}

/** Infrastructure group a node is shown in. */
export function nodeGroup(role: string): "studio" | "management" | "other" {
  if (role === "studio" || role === "playout" || role === "live") return "studio";
  if (role === "management") return "management";
  return "other";
}

// ---- ATEM / HyperDeck -----------------------------------------------------------------

export function atemIssues(a: { online: boolean; lastSeenAt: string | null; control?: { mode: string } | null }): Issue[] {
  if (!a.online) return [{ code: "device_offline", level: "down", params: a.lastSeenAt ? { since: a.lastSeenAt } : undefined }];
  return [];
}

export function hyperdeckIssues(h: {
  online: boolean;
  lastSeenAt: string | null;
  snapshot: { remoteEnabled: boolean | null; transport: { status: string; slotId: number | null }; slots: { id: number; status: string; recordingTime: number }[] } | null;
}, lowRecordSeconds: number): Issue[] {
  if (!h.online) return [{ code: "device_offline", level: "down", params: h.lastSeenAt ? { since: h.lastSeenAt } : undefined }];
  const s = h.snapshot;
  if (!s) return [];
  const out: Issue[] = [];
  if (s.remoteEnabled === false) out.push({ code: "remote_disabled", level: "warn" });
  const mounted = s.slots.filter((x) => x.status === "mounted");
  if (!mounted.length) out.push({ code: "no_media", level: "warn" });
  const active = mounted.find((x) => x.id === s.transport.slotId) ?? mounted[0];
  if (s.transport.status === "record" && active && active.recordingTime < lowRecordSeconds) out.push({ code: "record_time_low", level: "warn", params: { minutes: Math.floor(active.recordingTime / 60) } });
  return out;
}

// ---- Owncast ------------------------------------------------------------------------

export interface OwncastStatus {
  online: boolean;
  viewers: number;
  sessionMaxViewers: number;
  overallMaxViewers: number;
  lastConnectTime: string | null;
  lastDisconnectTime: string | null;
  version: string | null;
  name: string | null;
  streamTitle: string | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Owncast `GET /api/status` (+ optional `GET /api/config` for the name). Both are public, read-only endpoints. */
export function parseOwncast(status: unknown, config?: unknown): OwncastStatus {
  if (!status || typeof status !== "object") throw new Error("not an Owncast status response");
  const s = status as Record<string, unknown>;
  if (typeof s.online !== "boolean") throw new Error("not an Owncast status response");
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  return {
    online: s.online,
    viewers: num(s.viewerCount),
    sessionMaxViewers: num(s.sessionMaxViewerCount),
    overallMaxViewers: num(s.overallMaxViewerCount),
    lastConnectTime: str(s.lastConnectTime),
    lastDisconnectTime: str(s.lastDisconnectTime),
    version: str(s.versionNumber),
    name: str(c.name),
    streamTitle: str(s.streamTitle) ?? str(c.streamTitle),
  };
}

/** Owncast base URL: "10.40.6.127:8080" becomes "http://10.40.6.127:8080", trailing slashes and "/api/..." are dropped. */
export function owncastBase(target: string): string {
  let t = target.trim();
  if (!/^https?:\/\//i.test(t)) t = `http://${t}`;
  const u = new URL(t);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/api(\/.*)?$/, "").replace(/\/+$/, "")}`;
}

/** "host:port" for TCP checks. */
export function parseHostPort(target: string): { host: string; port: number } {
  const m = /^\[?([A-Za-z0-9.:-]+?)\]?:(\d{1,5})$/.exec(target.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error("expected host:port");
  return { host: m[1]!, port: Number(m[2]) };
}

/** Validates a device target for its check type; returns an error code or null. */
export function targetError(type: CheckType, target: string): string | null {
  const t = target.trim();
  if (type === "manual") return null;
  if (!t) return "target_required";
  try {
    if (type === "tcp") parseHostPort(t);
    else if (type === "owncast") owncastBase(t);
    else {
      const u = new URL(/^https?:\/\//i.test(t) ? t : `http://${t}`);
      if (!/^https?:$/.test(u.protocol)) return "invalid_target";
    }
  } catch {
    return "invalid_target";
  }
  return null;
}

/** Result of one probe (owncast/http/tcp). */
export interface ProbeResult {
  ok: boolean;
  /** Round trip in ms. */
  ms: number | null;
  error?: string;
  httpStatus?: number;
  owncast?: OwncastStatus;
}

/** Health of a probed or manual device; `fails` = consecutive failed probes. */
export function deviceIssues(d: { checkType: CheckType; manualStatus: Health; result: ProbeResult | null; fails: number; agent?: NodeInput | null }): { health: Health; issues: Issue[] } {
  // Problems of a linked agent (not answering, disk full, ...) are warnings on the device: the service itself may still be fine.
  const issues: Issue[] = d.agent ? nodeIssues(d.agent).map((i) => ({ ...i, level: "warn" as const })) : [];
  if (d.checkType === "manual") return { health: healthOf(issues, d.manualStatus), issues };
  const r = d.result;
  if (!r) return { health: healthOf(issues, "unknown"), issues };
  if (!r.ok) {
    issues.unshift({ code: "unreachable", level: d.fails >= FAILS_BEFORE_DOWN ? "down" : "warn", params: r.error ? { error: r.error } : undefined });
    return { health: healthOf(issues), issues };
  }
  if (d.checkType === "owncast" && r.owncast && !r.owncast.online) issues.push({ code: "not_streaming", level: "warn" });
  return { health: healthOf(issues), issues };
}

// ---- summary --------------------------------------------------------------------------

export function countHealth(levels: Health[]): Record<Health, number> {
  const out: Record<Health, number> = { ok: 0, warn: 0, down: 0, unknown: 0 };
  for (const l of levels) out[l]++;
  return out;
}
