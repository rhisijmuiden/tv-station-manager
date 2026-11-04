/**
 * Monitoring: one status overview of the whole platform.
 *
 * Reads what the orchestrator already knows (nodes via their agent heartbeat, ATEM switchers, Teranex converters) and adds
 * "monitor devices": Owncast servers (read-only `GET /api/status`), plain HTTP or TCP checks and manual entries for
 * equipment that cannot be checked over the network. A device can be linked to an enrolled node whose agent runs on
 * the same machine (e.g. the Linux box running Owncast), so its CPU/disk and heartbeat show up on the device too.
 * Docs: docs/monitoring.md.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import { randomUUID } from "node:crypto";
import { connect as tcpConnect } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AUTOMATION_API, type PublicSwitcher } from "./atem.js";
import type { PublicKiloview } from "./kiloview.js";
import type { PublicTeranex } from "./teranex.js";
import {
  atemIssues,
  BLOCKS,
  CHECK_TYPES,
  countHealth,
  deviceIssues,
  FAILS_BEFORE_DOWN,
  healthOf,
  teranexIssues,
  MANUAL_STATUSES,
  nodeGroup,
  nodeIssues,
  owncastBase,
  parseHostPort,
  parseOwncast,
  pct,
  targetError,
  type CheckType,
  type Health,
  type Issue,
  type NodeMetrics,
  type ProbeResult,
} from "./monitorlogic.js";

/** Appended after HYPERDECK_MIGRATIONS. */
export const MONITOR_MIGRATIONS = [
  `CREATE TABLE monitor_devices (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     block TEXT NOT NULL DEFAULT 'extra' CHECK (block IN ('infrastructure','distribution','extra')),
     check_type TEXT NOT NULL DEFAULT 'manual' CHECK (check_type IN ('owncast','http','tcp','manual')),
     target TEXT NOT NULL DEFAULT '',
     node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
     manual_status TEXT NOT NULL DEFAULT 'unknown' CHECK (manual_status IN ('ok','warn','down','unknown')),
     location TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',
     health TEXT NOT NULL DEFAULT 'unknown',
     result TEXT,
     fails INTEGER NOT NULL DEFAULT 0,
     last_check_at TEXT,
     last_ok_at TEXT,
     changed_at TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE TABLE monitor_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     device_id TEXT NOT NULL REFERENCES monitor_devices(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     message TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE INDEX monitor_events_device ON monitor_events(device_id, at);`,
];

const TIMEOUT_MS = 5000;
const POLL_MS = 15_000;

/** Network probes; tests replace them. */
export interface Probes {
  owncast(base: string): Promise<ProbeResult>;
  http(url: string): Promise<ProbeResult>;
  tcp(host: string, port: number): Promise<ProbeResult>;
}

const errText = (e: unknown) => {
  const c = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
  return c ?? ((e as Error).name === "TimeoutError" ? "timeout" : String((e as Error).message ?? e).slice(0, 200));
};

export const realProbes: Probes = {
  async owncast(base) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!res.ok) return { ok: false, ms: Date.now() - t0, httpStatus: res.status, error: `HTTP ${res.status}` };
      const status = await res.json();
      const ms = Date.now() - t0;
      const config = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      return { ok: true, ms, httpStatus: res.status, owncast: parseOwncast(status, config) };
    } catch (e) {
      return { ok: false, ms: null, error: errText(e) };
    }
  },
  async http(url) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
      await res.body?.cancel().catch(() => undefined);
      return { ok: res.status < 400, ms: Date.now() - t0, httpStatus: res.status, error: res.status < 400 ? undefined : `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, ms: null, error: errText(e) };
    }
  },
  tcp(host, port) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const s = tcpConnect({ host, port });
      const done = (r: ProbeResult) => {
        s.destroy();
        resolve(r);
      };
      s.setTimeout(TIMEOUT_MS, () => done({ ok: false, ms: null, error: "timeout" }));
      s.once("connect", () => done({ ok: true, ms: Date.now() - t0 }));
      s.once("error", (e) => done({ ok: false, ms: null, error: errText(e) }));
    });
  },
};

interface DeviceRow {
  id: string;
  name: string;
  block: (typeof BLOCKS)[number];
  check_type: CheckType;
  target: string;
  node_id: string | null;
  manual_status: Health;
  location: string;
  notes: string;
  health: Health;
  result: string | null;
  fails: number;
  last_check_at: string | null;
  last_ok_at: string | null;
  changed_at: string | null;
  created_at: string;
}

const deviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  block: z.enum(BLOCKS),
  checkType: z.enum(CHECK_TYPES),
  target: z.string().trim().max(500).default(""),
  nodeId: z.string().max(64).nullable().optional(),
  manualStatus: z.enum(MANUAL_STATUSES).optional(),
  location: z.string().trim().max(120).optional(),
  notes: z.string().max(2000).optional(),
});

interface NodeLike {
  id: string;
  name: string;
  status: "pending" | "approved" | "rejected";
  role: string;
  hostname: string;
  platform: string | null;
  agentVersion: string | null;
  ips: string[];
  online: boolean;
  lastSeenAt: string | null;
  metrics: NodeMetrics | null;
}

const metricSummary = (m: NodeMetrics | null) =>
  m
    ? {
        cpu: m.cpuPercent != null ? Math.round(m.cpuPercent) : null,
        mem: m.memTotal ? pct(m.memUsed ?? 0, m.memTotal) : null,
        disk: m.disks?.length ? Math.max(...m.disks.map((d) => pct(d.used, d.total))) : null,
        uptimeSeconds: m.uptimeSeconds ?? null,
      }
    : null;

export function registerMonitoring(
  app: FastifyInstance,
  platform: Platform,
  sources: {
    nodes: () => NodeLike[];
    atems: () => PublicSwitcher[];
    teranexes?: () => PublicTeranex[];
    kiloviews?: () => PublicKiloview[];
    /** Checks the automation token; enables the read-only monitoring routes for management nodes. */
    automationAuthorized?: (req: FastifyRequest) => boolean;
  },
  probes: Probes = realProbes,
  pollMs = POLL_MS,
) {
  const { db, log } = platform.ctx;
  const get = (id: string) => db.prepare("SELECT * FROM monitor_devices WHERE id = ?").get(id) as DeviceRow | undefined;
  const event = (id: string, type: string, message: string) => db.prepare("INSERT INTO monitor_events (device_id, type, message) VALUES (?, ?, ?)").run(id, type, message);
  const nodeById = (id: string | null) => (id ? sources.nodes().find((n) => n.id === id) : undefined);

  const evaluate = (r: DeviceRow) => {
    const node = nodeById(r.node_id);
    return deviceIssues({
      checkType: r.check_type,
      manualStatus: r.manual_status,
      result: r.result ? (JSON.parse(r.result) as ProbeResult) : null,
      fails: r.fails,
      agent: node ?? null,
    });
  };

  const probe = (r: DeviceRow): Promise<ProbeResult> => {
    try {
      if (r.check_type === "owncast") return probes.owncast(owncastBase(r.target));
      if (r.check_type === "tcp") {
        const { host, port } = parseHostPort(r.target);
        return probes.tcp(host, port);
      }
      return probes.http(/^https?:\/\//i.test(r.target) ? r.target : `http://${r.target}`);
    } catch (e) {
      return Promise.resolve({ ok: false, ms: null, error: (e as Error).message });
    }
  };

  /** Probes one device and stores the result; status changes are logged and mailed. */
  const check = async (id: string) => {
    const before = get(id);
    if (!before || before.check_type === "manual") return;
    const result = await probe(before);
    const r = get(id);
    if (!r || r.target !== before.target || r.check_type !== before.check_type) return; // edited meanwhile
    const now = new Date().toISOString();
    const fails = result.ok ? 0 : r.fails + 1;
    const next = { ...r, result: JSON.stringify(result), fails };
    const { health } = evaluate(next);
    const changed = health !== r.health;
    db.prepare("UPDATE monitor_devices SET result = ?, fails = ?, health = ?, last_check_at = ?, last_ok_at = COALESCE(?, last_ok_at), changed_at = CASE WHEN ? THEN ? ELSE changed_at END WHERE id = ?").run(
      next.result,
      fails,
      health,
      now,
      result.ok ? now : null,
      changed ? 1 : 0,
      now,
      id,
    );
    if (!changed) return;
    event(id, health, health === "ok" ? "Check OK" : health === "down" ? `Not reachable: ${result.error ?? "no answer"}` : health === "warn" ? (result.ok ? "Reachable, with a warning" : `Check failed: ${result.error ?? ""}`) : "Unknown");
    if (health === "down" && fails >= FAILS_BEFORE_DOWN) {
      log.warn({ device: r.name }, "monitored device down");
      void platform.mail.alert(`DOWN: ${r.name}`, `${r.name} (${r.target}) does not answer.\nError: ${result.error ?? "-"}\nLast OK: ${r.last_ok_at ?? "never"}`);
    } else if (health === "ok" && r.health === "down") void platform.mail.alert(`Back up: ${r.name}`, `${r.name} (${r.target}) answers again.`);
  };

  let running = false;
  const pollAll = async () => {
    if (running) return;
    running = true;
    try {
      const rows = db.prepare("SELECT id FROM monitor_devices WHERE check_type != 'manual'").all() as { id: string }[];
      await Promise.all(rows.map((r) => check(r.id).catch((e) => log.debug({ e }, "monitor check failed"))));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void pollAll(), pollMs);
  timer.unref();
  const first = setTimeout(() => void pollAll(), 1000);
  first.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    clearTimeout(first);
  });

  const toPublic = (r: DeviceRow) => {
    const node = nodeById(r.node_id);
    const { health, issues } = evaluate(r);
    const result = r.result ? (JSON.parse(r.result) as ProbeResult) : null;
    return {
      id: r.id,
      name: r.name,
      block: r.block,
      checkType: r.check_type,
      target: r.target,
      nodeId: r.node_id,
      manualStatus: r.manual_status,
      location: r.location,
      notes: r.notes,
      health,
      issues,
      result: r.check_type === "manual" ? null : result,
      lastCheckAt: r.last_check_at,
      lastOkAt: r.last_ok_at,
      changedAt: r.changed_at,
      agent: node ? { id: node.id, name: node.name, online: node.online, lastSeenAt: node.lastSeenAt, metrics: metricSummary(node.metrics) } : null,
    };
  };
  const listDevices = () => (db.prepare("SELECT * FROM monitor_devices ORDER BY name COLLATE NOCASE").all() as unknown as DeviceRow[]).map(toPublic);

  const core = () => {
    const sys = platform.updates.systemInfo();
    const mail = platform.mail.getConfig().enabled;
    const targets = platform.backup.listTargets().length;
    const last = platform.backup.listRuns(20) as { status: string; startedAt: string; finishedAt: string | null }[];
    const lastOk = last.find((r) => r.status === "success") ?? null;
    const issues: Issue[] = [];
    if (!mail) issues.push({ code: "mail_not_configured", level: "warn" });
    if (!targets) issues.push({ code: "no_backup_target", level: "warn" });
    else if (last[0]?.status === "failed") issues.push({ code: "backup_failed", level: "warn" });
    else if (!lastOk || Date.now() - Date.parse(lastOk.startedAt) > 8 * 86400_000) issues.push({ code: "backup_old", level: "warn" });
    return {
      name: platform.ctx.config.app.name,
      hostname: sys.hostname,
      version: sys.version,
      channel: sys.channel,
      uptimeSeconds: sys.uptimeSeconds,
      mailConfigured: mail,
      lastBackup: last[0] ? { status: last[0].status, at: last[0].startedAt } : null,
      health: healthOf(issues),
      issues,
    };
  };

  /** The whole monitoring picture; served to signed-in users and, read-only, to management nodes. */
  const overview = () => {
    const devices = listDevices();
    const nodes = sources.nodes().map((n) => {
      const issues = nodeIssues(n);
      return {
        id: n.id,
        name: n.name,
        role: n.role,
        group: nodeGroup(n.role),
        status: n.status,
        hostname: n.hostname,
        platform: n.platform,
        ip: n.ips[0] ?? null,
        agentVersion: n.agentVersion,
        online: n.online,
        lastSeenAt: n.lastSeenAt,
        metrics: metricSummary(n.metrics),
        casparcg: n.metrics?.studio?.casparcg ? { connected: n.metrics.studio.casparcg.connected, channels: n.metrics.studio.casparcg.channels?.length ?? 0 } : null,
        // Devices linked to this node's agent are shown there; the node itself still counts under its role.
        linkedDevice: devices.find((d) => d.nodeId === n.id)?.id ?? null,
        health: healthOf(issues),
        issues,
      };
    });
    const atems = sources.atems().map((a) => {
      const issues = atemIssues(a);
      return {
        id: a.id,
        name: a.name,
        host: a.host,
        location: a.location,
        online: a.online,
        lastSeenAt: a.lastSeenAt,
        model: a.snapshot?.productName ?? a.snapshot?.modelKey ?? null,
        control: a.control.mode,
        health: healthOf(issues),
        issues,
      };
    });
    const teranexes = (sources.teranexes?.() ?? []).map((x) => {
      const issues = teranexIssues(x);
      return {
        id: x.id,
        name: x.name,
        host: x.host,
        location: x.location,
        online: x.online,
        lastSeenAt: x.lastSeenAt,
        model: x.snapshot?.model ?? null,
        input: x.online && x.snapshot ? { source: x.snapshot.input.videoSource, format: x.snapshot.input.videoMode, signal: x.snapshot.input.signalPresent, audio: x.snapshot.input.audioSource } : null,
        output: x.online ? (x.snapshot?.output.videoMode ?? null) : null,
        health: healthOf(issues),
        issues,
      };
    });
    const kiloviews = (sources.kiloviews?.() ?? []).map((k) => {
      const s = k.online ? k.snapshot : null;
      const enc = s?.encoder;
      const dec = s?.decoder;
      const watch = new Set(k.watch ?? []);
      // Decoder: the outputs that are watched (or all with a source when nothing is chosen yet).
      const outs = (dec?.outputs ?? []).filter((o) => (k.watch ? watch.has(o.id) : o.source));
      return {
        id: k.id,
        name: k.name,
        kind: k.kind,
        host: k.host,
        location: k.location,
        online: k.online,
        lastSeenAt: k.lastSeenAt,
        model: s?.product ?? (k.snapshot?.product ?? null),
        input: enc ? { source: enc.activeInput, format: enc.input.format, signal: enc.input.signal } : null,
        bitrateKbps: enc ? (enc.video?.bitrateKbps ?? null) : (outs.find((o) => o.playing)?.bitrateKbps ?? null),
        streams: enc ? enc.streams.filter((x) => x.enabled).map((x) => ({ name: x.name, type: x.type, running: x.running })) : [],
        outputs: outs.map((o) => ({ connector: o.connector ?? `Output ${o.id}`, format: o.format, source: o.source?.name ?? null, playing: o.playing, streamFormat: o.streamFormat })),
        temperature: dec?.temperature ?? null,
        cpu: dec?.cpu ?? null,
        health: healthOf(k.issues),
        issues: k.issues,
      };
    });
    const c = core();
    const all = [
      c.health,
      ...nodes.filter((n) => !n.linkedDevice).map((n) => n.health),
      ...atems.map((a) => a.health),
      ...teranexes.map((x) => x.health),
      ...kiloviews.map((k) => k.health),
      ...devices.map((d) => d.health),
    ];
    return { checkedAt: new Date().toISOString(), core: c, nodes, atems, teranexes, kiloviews, devices, summary: countHealth(all) };
  };
  app.get("/api/monitoring", async () => overview());

  const find = (id: string) => {
    const r = get(id);
    if (!r) throw new HttpError(404, "not_found");
    return r;
  };
  const validate = (b: z.infer<typeof deviceSchema>) => {
    const e = targetError(b.checkType, b.target);
    if (e) throw new HttpError(400, e);
    if (b.nodeId && !sources.nodes().some((n) => n.id === b.nodeId)) throw new HttpError(400, "unknown_node");
  };

  const deviceDetail = (id: string) => {
    const r = find(id);
    return { device: toPublic(r), events: db.prepare("SELECT type, message, at FROM monitor_events WHERE device_id = ? ORDER BY id DESC LIMIT 50").all(r.id) };
  };
  app.get("/api/monitoring/devices/:id", async (req) => deviceDetail((req.params as { id: string }).id));

  app.post("/api/monitoring/devices", async (req) => {
    requireRole(req, "admin");
    const b = deviceSchema.parse(req.body);
    validate(b);
    const id = randomUUID();
    db.prepare("INSERT INTO monitor_devices (id, name, block, check_type, target, node_id, manual_status, location, notes, health) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      b.name,
      b.block,
      b.checkType,
      b.checkType === "manual" ? b.target : b.target.trim(),
      b.nodeId ?? null,
      b.manualStatus ?? "unknown",
      b.location ?? "",
      b.notes ?? "",
      b.checkType === "manual" ? (b.manualStatus ?? "unknown") : "unknown",
    );
    event(id, "added", `Added by ${req.user!.username}`);
    await check(id);
    return toPublic(get(id)!);
  });

  app.put("/api/monitoring/devices/:id", async (req) => {
    requireRole(req, "admin");
    const r = find((req.params as { id: string }).id);
    const b = deviceSchema.parse(req.body);
    validate(b);
    const reprobe = b.target !== r.target || b.checkType !== r.check_type;
    db.prepare(
      `UPDATE monitor_devices SET name = ?, block = ?, check_type = ?, target = ?, node_id = ?, manual_status = ?, location = ?, notes = ?
         ${reprobe ? ", result = NULL, fails = 0, health = 'unknown'" : ""} WHERE id = ?`,
    ).run(b.name, b.block, b.checkType, b.target, b.nodeId ?? null, b.manualStatus ?? r.manual_status, b.location ?? r.location, b.notes ?? r.notes, r.id);
    if (b.checkType === "manual" && (b.manualStatus ?? r.manual_status) !== r.manual_status) {
      event(r.id, b.manualStatus!, `Status set to ${b.manualStatus} by ${req.user!.username}`);
      db.prepare("UPDATE monitor_devices SET health = ?, changed_at = ? WHERE id = ?").run(b.manualStatus!, new Date().toISOString(), r.id);
    }
    if (reprobe) await check(r.id);
    return toPublic(get(r.id)!);
  });

  app.delete("/api/monitoring/devices/:id", async (req) => {
    requireRole(req, "admin");
    db.prepare("DELETE FROM monitor_devices WHERE id = ?").run((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/api/monitoring/devices/:id/check", async (req) => {
    requireRole(req, "operator");
    const r = find((req.params as { id: string }).id);
    await check(r.id);
    return toPublic(get(r.id)!);
  });

  // Read-only copy for management nodes (same automation token as the ATEM lock link), so the tv-manager
  // can show this picture natively without anyone signing in on the orchestrator.
  const authorized = sources.automationAuthorized;
  if (authorized) {
    app.get(`${AUTOMATION_API}/monitoring`, async (req, reply) => {
      if (!authorized(req)) return reply.status(401).send({ error: "unauthorized" });
      return overview();
    });
    app.get(`${AUTOMATION_API}/monitoring/devices/:id/events`, async (req, reply) => {
      if (!authorized(req)) return reply.status(401).send({ error: "unauthorized" });
      return { events: deviceDetail((req.params as { id: string }).id).events };
    });
  }

  return { list: listDevices, pollAll, overview, deviceDetail };
}
