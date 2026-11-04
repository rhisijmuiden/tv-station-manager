import type { Platform } from "@tvsm/platform";
import { HttpError, randomToken, requireRole } from "@tvsm/platform";
import {
  AGENT_API,
  agentAssetName,
  fingerprintOf,
  type AgentCommand,
  type AutoUpdatePolicy,
  type ProvisionPayload,
  type CommandType,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type NodeRole,
} from "@tvsm/platform/agent-protocol";
import { compareVersions } from "@tvsm/platform/semver";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { confirmMatches, installerRole, nodeRoleAfter, planProvision, provisionRequestSchema, type OnAir, type PlanNode } from "./provisionlogic.js";

export const NODE_MIGRATIONS = [
  `CREATE TABLE nodes (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
     role TEXT NOT NULL DEFAULT 'unassigned',
     secret_hash TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     hostname TEXT NOT NULL,
     platform TEXT, os TEXT, arch TEXT, agent_version TEXT,
     ips TEXT NOT NULL DEFAULT '[]',
     remote_ip TEXT,
     notes TEXT NOT NULL DEFAULT '',
     metrics TEXT,
     online INTEGER NOT NULL DEFAULT 0,
     last_seen_at TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     approved_at TEXT
   );
   CREATE TABLE node_commands (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     payload TEXT,
     status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','done','failed')),
     result TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE TABLE node_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     message TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE INDEX node_events_node ON node_events(node_id, at);`,
];

/** Appended at the end of the orchestrator's migration list (after TERANEX_MIGRATIONS). */
export const PROVISION_MIGRATIONS = [
  `ALTER TABLE nodes ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE nodes ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE node_commands ADD COLUMN progress TEXT;`,
];

const HEARTBEAT_SECONDS = 10;
const OFFLINE_AFTER_SECONDS = 45;
const MAX_PENDING = 50;
const ROLES = ["unassigned", "management", "studio", "playout", "live", "other"] as const;
const COMMANDS = ["restart-agent", "reboot", "update-agent", "restart-casparcg", "restart-ingest"] as const;
/** Commands an agent only gets once it reports the capability (older agents update themselves first). */
const NEEDS_CAPABILITY: Partial<Record<CommandType, string>> = { provision: "provision" };

export const agentSettingsSchema = z.object({
  /** Agents install new releases of the update channel by themselves. */
  autoUpdate: z.boolean().default(true),
  /** HH:MM in the node's local time; both empty = any time. */
  windowStart: z.string().regex(/^(\d{1,2}:\d{2})?$/).default("03:00"),
  windowEnd: z.string().regex(/^(\d{1,2}:\d{2})?$/).default("05:00"),
  /** https URL or UNC path of the Blackmagic Desktop Video installer (.zip or .msi), used by "install DeckLink driver". */
  deckLinkSource: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v === "" || /^https:\/\//i.test(v) || /^\\\\[^\\]+\\/.test(v), "https_or_unc")
    .default(""),
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string }[];
}
export interface NodesOptions {
  /** ATEM switchers (program/preview + which node feeds which input), for the "on air" warning. */
  atems?: () => { name: string; snapshot: { program: (number | null)[]; preview: (number | null)[]; inputs: { id: number; longName: string }[] } | null; inputs: { inputId: number; nodeId: string | null }[] }[];
  /** GitHub releases of the repository (newest agent per channel). Tests pass a fake. */
  releases?: (repository: string, token: string) => Promise<GhRelease[]>;
}

const fetchReleases = async (repository: string, token: string): Promise<GhRelease[]> => {
  const res = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=50`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "tvsm-orchestrator", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  return (await res.json()) as GhRelease[];
};

/** Newest agent release on a channel that has a package for the platform. */
export function latestAgentVersion(releases: GhRelease[], channel: "production" | "test", platform: string, arch = "x64") {
  const usable = releases
    .filter((r) => !r.draft && (channel === "test" || !r.prerelease))
    .filter((r) => r.assets.some((a) => a.name === agentAssetName(r.tag_name, platform, arch)))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  return usable[0]?.tag_name.replace(/^v/, "") ?? null;
}

const hashSecret = (s: string) => createHash("sha256").update(s).digest("hex");

const factsSchema = z.object({
  hostname: z.string().trim().min(1).max(255),
  platform: z.string().max(32),
  os: z.string().max(200),
  arch: z.string().max(32),
  agentVersion: z.string().max(64),
  ips: z.array(z.string().max(64)).max(32),
  capabilities: z.array(z.string().max(40)).max(32).optional(),
});
const inventorySchema = z.object({
  collectedAt: z.string().max(40),
  os: z.string().max(200).nullable(),
  powershell: z.string().max(40).nullable(),
  desktopVideo: z.string().max(40).nullable(),
  decklinks: z.array(z.string().max(120)).max(16),
  gpu: z.object({ name: z.string().max(200), driver: z.string().max(60).nullable() }).nullable(),
  ffmpeg: z.string().max(80).nullable(),
  vcredist: z.string().max(40).nullable(),
  casparcg: z.string().max(40).nullable(),
  mediamtx: z.string().max(40).nullable(),
  shareCredentials: z.boolean(),
  rebootPending: z.boolean(),
  studioParked: z.boolean(),
});
const metricsSchema = z.object({
  cpuCount: z.number(),
  cpuPercent: z.number(),
  load1: z.number().optional(),
  memTotal: z.number(),
  memUsed: z.number(),
  disks: z.array(z.object({ mount: z.string().max(255), total: z.number(), used: z.number() })).max(64),
  uptimeSeconds: z.number(),
  agentUptimeSeconds: z.number(),
  studio: z
    .object({
      casparcg: z.object({
        service: z.string().max(40),
        connected: z.boolean(),
        version: z.string().max(200).nullable(),
        channels: z.array(z.object({ id: z.number().int(), format: z.string().max(40), status: z.string().max(80) })).max(32),
      }),
      ingest: z.object({
        service: z.string().max(40),
        rtmpUrl: z.string().max(500).nullable(),
        streams: z.array(z.object({ name: z.string().max(200), ready: z.boolean(), readers: z.number().int(), tracks: z.array(z.string().max(40)).max(16) })).max(100),
      }),
      outputs: z.array(z.object({ device: z.number().int(), channel: z.number().int(), format: z.string().max(40) })).max(16),
      mediaPath: z.string().max(1000).nullable(),
      mediaReachable: z.boolean().nullable(),
      role: z.enum(["playout", "live", "studio"]).nullable().optional().catch(null),
    })
    .optional()
    // A malformed studio block must never cost the node its heartbeat.
    .catch(undefined),
  inventory: inventorySchema.optional().catch(undefined),
  provisioning: z.object({ commandId: z.number().int(), step: z.string().max(200), startedAt: z.string().max(40) }).nullable().optional().catch(undefined),
});
const heartbeatSchema = factsSchema.extend({
  metrics: metricsSchema,
  results: z.array(z.object({ id: z.number().int(), status: z.enum(["done", "failed", "running"]), result: z.string().max(4000).optional() })).max(100).optional(),
});

interface NodeRow {
  id: string;
  name: string;
  status: "pending" | "approved" | "rejected";
  role: NodeRole;
  secret_hash: string;
  fingerprint: string;
  hostname: string;
  platform: string | null;
  os: string | null;
  arch: string | null;
  agent_version: string | null;
  ips: string;
  remote_ip: string | null;
  notes: string;
  metrics: string | null;
  online: number;
  last_seen_at: string | null;
  created_at: string;
  approved_at: string | null;
  capabilities: string;
  auto_update: number;
}

const toPublic = (n: NodeRow) => ({
  id: n.id,
  name: n.name,
  status: n.status,
  role: n.role,
  fingerprint: n.fingerprint,
  hostname: n.hostname,
  platform: n.platform,
  os: n.os,
  arch: n.arch,
  agentVersion: n.agent_version,
  ips: JSON.parse(n.ips) as string[],
  remoteIp: n.remote_ip,
  notes: n.notes,
  metrics: n.metrics ? JSON.parse(n.metrics) : null,
  online: Boolean(n.online),
  lastSeenAt: n.last_seen_at,
  createdAt: n.created_at,
  approvedAt: n.approved_at,
  capabilities: JSON.parse(n.capabilities || "[]") as string[],
  autoUpdate: Boolean(n.auto_update),
});

export function registerNodes(app: FastifyInstance, platform: Platform, opts: NodesOptions = {}) {
  const { db, log, settings } = platform.ctx;
  const agentSettings = (): AgentSettings => agentSettingsSchema.parse(settings.get("agents", {}));

  // Newest agent release per channel + platform, refreshed in the background (never blocks a heartbeat).
  const releaseCache = { at: 0, key: "", releases: [] as GhRelease[], loading: false };
  const latestFor = (channel: "production" | "test", repository: string, nodePlatform: string | null, arch: string | null) => {
    const key = repository;
    if (!releaseCache.loading && (releaseCache.key !== key || Date.now() - releaseCache.at > 30 * 60_000)) {
      releaseCache.loading = true;
      (opts.releases ?? fetchReleases)(repository, platform.updates.getSettings().githubToken)
        .then((r) => Object.assign(releaseCache, { releases: r, key, at: Date.now() }))
        .catch((err) => {
          releaseCache.at = Date.now() - 25 * 60_000; // retry in 5 minutes
          log.warn({ err: (err as Error).message }, "agent release check failed");
        })
        .finally(() => (releaseCache.loading = false));
    }
    if (releaseCache.key !== key || !nodePlatform) return null;
    return latestAgentVersion(releaseCache.releases, channel, nodePlatform, arch ?? "x64");
  };
  const get = (id: string) => db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  const event = (nodeId: string, type: string, message: string) =>
    db.prepare("INSERT INTO node_events (node_id, type, message) VALUES (?, ?, ?)").run(nodeId, type, message);

  // ---- agent API (authenticated by node secret, not by session) ----------

  const enrollHits = new Map<string, number[]>();
  app.post(`${AGENT_API}/enroll`, async (req) => {
    const now = Date.now();
    const hits = (enrollHits.get(req.ip) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= 10) throw new HttpError(429, "too_many_requests");
    enrollHits.set(req.ip, [...hits, now]);
    const pending = (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE status = 'pending'").get() as { n: number }).n;
    if (pending >= MAX_PENDING) throw new HttpError(429, "too_many_pending_nodes");

    const facts = factsSchema.parse(req.body);
    const id = randomUUID();
    const secret = randomToken(32);
    const fingerprint = await fingerprintOf(secret);
    db.prepare(
      `INSERT INTO nodes (id, name, secret_hash, fingerprint, hostname, platform, os, arch, agent_version, ips, remote_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, facts.hostname, hashSecret(secret), fingerprint, facts.hostname, facts.platform, facts.os, facts.arch, facts.agentVersion, JSON.stringify(facts.ips), req.ip);
    event(id, "enrolled", `Enrollment request from ${facts.hostname} (${req.ip})`);
    log.info({ id, hostname: facts.hostname, ip: req.ip }, "node enrollment request");
    return { nodeId: id, secret, fingerprint };
  });

  const authNode = (req: FastifyRequest): NodeRow => {
    const m = /^Bearer ([0-9a-f-]{36}):(.+)$/.exec(req.headers.authorization ?? "");
    const node = m ? get(m[1]!) : undefined;
    if (!node) throw new HttpError(401, "unknown_node");
    const a = Buffer.from(node.secret_hash, "hex");
    const b = Buffer.from(hashSecret(m![2]!), "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "unknown_node");
    return node;
  };

  app.post(`${AGENT_API}/heartbeat`, async (req): Promise<HeartbeatResponse> => {
    const node = authNode(req);
    const hb = heartbeatSchema.parse(req.body) as HeartbeatRequest;
    const wasOnline = Boolean(node.online);
    db.prepare(
      `UPDATE nodes SET hostname = ?, platform = ?, os = ?, arch = ?, agent_version = ?, ips = ?, remote_ip = ?, metrics = ?,
         online = 1, last_seen_at = ?, capabilities = ? WHERE id = ?`,
    ).run(
      hb.hostname,
      hb.platform,
      hb.os,
      hb.arch,
      hb.agentVersion,
      JSON.stringify(hb.ips),
      req.ip,
      JSON.stringify(hb.metrics),
      new Date().toISOString(),
      JSON.stringify(hb.capabilities ?? []),
      node.id,
    );
    if (node.agent_version && node.agent_version !== hb.agentVersion) event(node.id, "agent-updated", `Agent ${node.agent_version} → ${hb.agentVersion}`);
    if (!wasOnline && node.status === "approved") {
      event(node.id, "online", "Node is online");
      if (node.last_seen_at) void platform.mail.alert(`Node back online: ${node.name}`, `${node.name} (${hb.hostname}) is online again.`);
    }
    for (const r of hb.results ?? []) {
      const cmd = db.prepare("SELECT type, payload, status, progress FROM node_commands WHERE id = ? AND node_id = ?").get(r.id, node.id) as
        | { type: CommandType; payload: string | null; status: string; progress: string | null }
        | undefined;
      if (!cmd || cmd.status === "done" || cmd.status === "failed") continue;
      if (r.status === "running") {
        // Progress of a long job; the command stays "sent" until the final result.
        if (r.result && r.result !== cmd.progress) {
          db.prepare("UPDATE node_commands SET progress = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(r.result, r.id);
          event(node.id, "provision", `#${r.id}: ${r.result}`);
        }
        continue;
      }
      db.prepare("UPDATE node_commands SET status = ?, result = ?, progress = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND node_id = ?").run(r.status, r.result ?? null, r.id, node.id);
      event(node.id, r.status === "done" ? "command" : "command-failed", `Command #${r.id}: ${r.result ?? r.status}`);
      if (cmd.type === "provision") {
        const role = (JSON.parse(cmd.payload ?? "{}") as { nodeRole?: NodeRole }).nodeRole;
        if (r.status === "done" && role && role !== node.role) {
          db.prepare("UPDATE nodes SET role = ? WHERE id = ?").run(role, node.id);
          event(node.id, "role", `Role changed ${node.role} → ${role} (provisioning #${r.id})`);
        }
        void platform.mail.alert(
          r.status === "done" ? `Node set up: ${node.name}` : `Node setup FAILED: ${node.name}`,
          `${node.name} (${hb.hostname}): provisioning #${r.id} ${r.status}.\n\n${r.result ?? ""}`,
        );
      }
    }

    if (node.status === "pending") return { status: "pending", fingerprint: node.fingerprint, intervalSeconds: HEARTBEAT_SECONDS };
    if (node.status === "rejected") return { status: "rejected" };

    const caps: string[] = hb.capabilities ?? [];
    const queued = (
      db.prepare("SELECT id, type, payload FROM node_commands WHERE node_id = ? AND status = 'queued' ORDER BY id").all(node.id) as {
        id: number;
        type: CommandType;
        payload: string | null;
      }[]
    ).filter((c) => !NEEDS_CAPABILITY[c.type] || caps.includes(NEEDS_CAPABILITY[c.type]!));
    const commands: AgentCommand[] = [];
    for (const c of queued) {
      const payload = c.payload ? (JSON.parse(c.payload) as Record<string, unknown>) : undefined;
      if (payload && typeof payload.smbPassword === "string") {
        // The share password travels once: decrypt for the agent, then drop it from the database.
        payload.smbPassword = platform.ctx.secrets.decrypt(payload.smbPassword);
        const { smbPassword: _drop, ...rest } = payload;
        db.prepare("UPDATE node_commands SET payload = ? WHERE id = ?").run(JSON.stringify({ ...rest, smbPassword: "[sent]" }), c.id);
      }
      if (payload && payload.smbPassword === "[sent]") delete payload.smbPassword;
      db.prepare("UPDATE node_commands SET status = 'sent', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(c.id);
      const { nodeRole: _role, ...agentPayload } = payload ?? {};
      commands.push({ id: c.id, type: c.type, payload: payload ? agentPayload : undefined });
    }
    const upd = platform.updates.getSettings();
    const ag = agentSettings();
    const auto: AutoUpdatePolicy = { enabled: ag.autoUpdate && Boolean(node.auto_update), windowStart: ag.windowStart, windowEnd: ag.windowEnd };
    return {
      status: "approved",
      name: node.name,
      role: node.role,
      intervalSeconds: HEARTBEAT_SECONDS,
      commands,
      update: { channel: upd.channel, repository: upd.repository, latest: latestFor(upd.channel, upd.repository, hb.platform, hb.arch), auto },
    };
  });

  // ---- offline detection ---------------------------------------------------

  const sweep = () => {
    const cutoff = new Date(Date.now() - OFFLINE_AFTER_SECONDS * 1000).toISOString();
    const gone = db.prepare("SELECT * FROM nodes WHERE online = 1 AND last_seen_at < ?").all(cutoff) as unknown as NodeRow[];
    for (const n of gone) {
      db.prepare("UPDATE nodes SET online = 0 WHERE id = ?").run(n.id);
      if (n.status !== "approved") continue;
      event(n.id, "offline", "Node stopped sending heartbeats");
      log.warn({ node: n.name }, "node offline");
      void platform.mail.alert(`Node OFFLINE: ${n.name}`, `${n.name} (${n.hostname}, role ${n.role}) has not reported for ${OFFLINE_AFTER_SECONDS} seconds.\nLast seen: ${n.last_seen_at}`);
    }
  };
  const timer = setInterval(sweep, 5000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  // ---- admin API (session auth via platform) -------------------------------

  const counts = () =>
    db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE status = 'approved') AS total,
                COUNT(*) FILTER (WHERE status = 'approved' AND online = 1) AS online,
                COUNT(*) FILTER (WHERE status = 'pending') AS pending
           FROM nodes`,
      )
      .get() as { total: number; online: number; pending: number };

  app.get("/api/nodes", async () => ({
    counts: counts(),
    install: (({ channel, repository }) => ({ channel, repository }))(platform.updates.getSettings()),
    nodes: (db.prepare("SELECT * FROM nodes ORDER BY status = 'pending' DESC, name COLLATE NOCASE").all() as unknown as NodeRow[]).map(toPublic),
  }));

  app.get("/api/nodes/:id", async (req) => {
    const n = get((req.params as { id: string }).id);
    if (!n) throw new HttpError(404, "not_found");
    return {
      node: toPublic(n),
      events: db.prepare("SELECT type, message, at FROM node_events WHERE node_id = ? ORDER BY id DESC LIMIT 50").all(n.id),
      commands: db
        .prepare("SELECT id, type, status, result, progress, created_at AS createdAt, updated_at AS updatedAt FROM node_commands WHERE node_id = ? ORDER BY id DESC LIMIT 20")
        .all(n.id),
      latestAgent: latestFor(platform.updates.getSettings().channel, platform.updates.getSettings().repository, n.platform, n.arch),
    };
  });

  const editSchema = z.object({ name: z.string().trim().min(1).max(80), role: z.enum(ROLES), notes: z.string().max(2000).optional() });

  app.post("/api/nodes/:id/approve", async (req) => {
    const n = get((req.params as { id: string }).id);
    if (!n) throw new HttpError(404, "not_found");
    const body = editSchema.parse(req.body);
    db.prepare("UPDATE nodes SET status = 'approved', name = ?, role = ?, notes = COALESCE(?, notes), approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
      body.name,
      body.role,
      body.notes ?? null,
      n.id,
    );
    event(n.id, "approved", `Approved by ${req.user!.username} as ${body.role}`);
    return toPublic(get(n.id)!);
  });

  app.post("/api/nodes/:id/reject", async (req) => {
    const n = get((req.params as { id: string }).id);
    if (!n) throw new HttpError(404, "not_found");
    db.prepare("UPDATE nodes SET status = 'rejected' WHERE id = ?").run(n.id);
    event(n.id, "rejected", `Rejected by ${req.user!.username}`);
    return toPublic(get(n.id)!);
  });

  app.put("/api/nodes/:id", async (req) => {
    const n = get((req.params as { id: string }).id);
    if (!n) throw new HttpError(404, "not_found");
    const body = editSchema.parse(req.body);
    db.prepare("UPDATE nodes SET name = ?, role = ?, notes = COALESCE(?, notes) WHERE id = ?").run(body.name, body.role, body.notes ?? null, n.id);
    if (body.role !== n.role) event(n.id, "role", `Role changed ${n.role} → ${body.role} by ${req.user!.username}`);
    return toPublic(get(n.id)!);
  });

  app.delete("/api/nodes/:id", async (req) => {
    db.prepare("DELETE FROM nodes WHERE id = ?").run((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/api/nodes/:id/commands", async (req) => {
    const n = get((req.params as { id: string }).id);
    if (!n) throw new HttpError(404, "not_found");
    if (n.status !== "approved") throw new HttpError(400, "node_not_approved");
    const { type } = z.object({ type: z.enum(COMMANDS) }).parse(req.body);
    const r = db.prepare("INSERT INTO node_commands (node_id, type) VALUES (?, ?)").run(n.id, type);
    event(n.id, "command-queued", `${type} queued by ${req.user!.username}`);
    return { id: Number(r.lastInsertRowid), type, status: "queued" };
  });

  // ---- agent settings (self-update policy, DeckLink installer source) -------------------------------

  app.get("/api/nodes-settings", async () => agentSettings());
  app.put("/api/nodes-settings", async (req) => {
    requireRole(req, "admin");
    const next = agentSettingsSchema.parse(req.body);
    settings.set("agents", next);
    return next;
  });

  app.put("/api/nodes/:id/auto-update", async (req) => {
    requireRole(req, "admin");
    const n = get((req.params as { id: string }).id);
    if (!n) throw new HttpError(404, "not_found");
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    db.prepare("UPDATE nodes SET auto_update = ? WHERE id = ?").run(enabled ? 1 : 0, n.id);
    event(n.id, "auto-update", `Automatic agent updates ${enabled ? "on" : "off"} (${req.user!.username})`);
    return toPublic(get(n.id)!);
  });

  // ---- provisioning (role change / software installation) ---------------------------------------------

  const onAirOf = (nodeId: string): OnAir[] => {
    const out: OnAir[] = [];
    for (const sw of opts.atems?.() ?? []) {
      const fed = new Set(sw.inputs.filter((i) => i.nodeId === nodeId).map((i) => i.inputId));
      if (!sw.snapshot || fed.size === 0) continue;
      const name = (id: number) => sw.snapshot!.inputs.find((i) => i.id === id)?.longName ?? "";
      for (const id of new Set(sw.snapshot.program.filter((x): x is number => x != null && fed.has(x)))) out.push({ atem: sw.name, input: id, inputName: name(id), bus: "program" });
      for (const id of new Set(sw.snapshot.preview.filter((x): x is number => x != null && fed.has(x))))
        if (!out.some((o) => o.atem === sw.name && o.input === id)) out.push({ atem: sw.name, input: id, inputName: name(id), bus: "preview" });
    }
    return out;
  };
  const planNode = (n: NodeRow): PlanNode => {
    const m = n.metrics ? (JSON.parse(n.metrics) as { studio?: PlanNode["studio"]; inventory?: PlanNode["inventory"] }) : {};
    const busy = !!db.prepare("SELECT 1 FROM node_commands WHERE node_id = ? AND type = 'provision' AND status IN ('queued','sent')").get(n.id);
    return {
      name: n.name,
      platform: n.platform,
      online: Boolean(n.online),
      role: n.role,
      agentCapabilities: JSON.parse(n.capabilities || "[]") as string[],
      studio: m.studio ?? null,
      inventory: m.inventory ?? null,
      busy,
    };
  };
  /** Suggestion for the wizard: the IPs of the management node(s), so AMCP/ingest API only accept them. */
  const managementHosts = () =>
    (db.prepare("SELECT ips, remote_ip FROM nodes WHERE status = 'approved' AND role = 'management'").all() as { ips: string; remote_ip: string | null }[]).flatMap((r) => {
      const ips = JSON.parse(r.ips) as string[];
      return ips.length ? ips.slice(0, 1) : r.remote_ip ? [r.remote_ip] : [];
    });

  const approvedNode = (req: FastifyRequest) => {
    const n = get((req.params as { id: string }).id);
    if (!n) throw new HttpError(404, "not_found");
    if (n.status !== "approved") throw new HttpError(400, "node_not_approved");
    return n;
  };

  app.get("/api/nodes/:id/provision", async (req) => {
    const n = approvedNode(req);
    return { managementHosts: managementHosts(), deckLinkSource: agentSettings().deckLinkSource !== "", onAir: onAirOf(n.id) };
  });

  app.post("/api/nodes/:id/provision/plan", async (req) => {
    requireRole(req, "admin");
    const n = approvedNode(req);
    const body = provisionRequestSchema.parse(req.body);
    return planProvision(planNode(n), body, { onAir: onAirOf(n.id), deckLinkSource: agentSettings().deckLinkSource });
  });

  app.post("/api/nodes/:id/provision", async (req) => {
    requireRole(req, "admin");
    const n = approvedNode(req);
    const body = provisionRequestSchema.parse(req.body);
    const ag = agentSettings();
    const plan = planProvision(planNode(n), body, { onAir: onAirOf(n.id), deckLinkSource: ag.deckLinkSource });
    if (plan.blocked) throw new HttpError(409, "provision_blocked", plan.warnings.filter((w) => w.level === "block").map((w) => w.key).join(","));
    if (plan.requireTypedName && !confirmMatches(body.confirmName, n.name)) throw new HttpError(400, "confirm_name");
    const upd = platform.updates.getSettings();
    const components = [...new Set([...body.components, ...plan.steps.filter((s) => s.key === "vcredist").map(() => "vcredist" as const)])];
    const payload: ProvisionPayload & { nodeRole: NodeRole } = {
      role: installerRole(body.role),
      ...(body.outputs ? { outputs: body.outputs } : {}),
      ...(body.videoMode ? { videoMode: body.videoMode } : {}),
      ...(body.keyer ? { keyer: body.keyer } : {}),
      ...(body.htmlGpu ? { htmlGpu: body.htmlGpu } : {}),
      ...(body.mediaPath ? { mediaPath: body.mediaPath } : {}),
      ...(body.smbUser ? { smbUser: body.smbUser, smbPassword: platform.ctx.secrets.encrypt(body.smbPassword ?? "") } : {}),
      ...(body.managementHosts?.length ? { managementHosts: body.managementHosts, managementUrl: `http://${body.managementHosts[0]}:8080` } : {}),
      components,
      ...(components.includes("decklink") ? { deckLinkSource: ag.deckLinkSource } : {}),
      rebootWhenDone: body.rebootWhenDone,
      channel: upd.channel,
      repository: upd.repository,
      nodeRole: nodeRoleAfter(body.role) as NodeRole,
    };
    // An agent without the provision capability updates itself first; the job waits in the queue until then.
    if (!planNode(n).agentCapabilities.includes("provision")) db.prepare("INSERT INTO node_commands (node_id, type) VALUES (?, 'update-agent')").run(n.id);
    const r = db.prepare("INSERT INTO node_commands (node_id, type, payload) VALUES (?, 'provision', ?)").run(n.id, JSON.stringify(payload));
    const what = `${body.role}${body.components.length ? ` + ${body.components.join(", ")}` : ""}`;
    event(n.id, "command-queued", `Provisioning (${what}) queued by ${req.user!.username}${plan.requireTypedName ? " (confirmed by typing the node name)" : ""}`);
    return { id: Number(r.lastInsertRowid), status: "queued", plan };
  });

  app.post("/api/nodes/:id/provision/:cmd/cancel", async (req) => {
    requireRole(req, "admin");
    const n = approvedNode(req);
    const cmd = Number((req.params as { cmd: string }).cmd);
    const r = db.prepare("UPDATE node_commands SET status = 'failed', result = 'Cancelled before the node picked it up' WHERE id = ? AND node_id = ? AND type = 'provision' AND status = 'queued'").run(cmd, n.id);
    if (!r.changes) throw new HttpError(409, "already_started");
    event(n.id, "command", `Provisioning #${cmd} cancelled by ${req.user!.username}`);
    return { ok: true };
  });

  const list = () => (db.prepare("SELECT * FROM nodes WHERE status != 'rejected' ORDER BY name COLLATE NOCASE").all() as unknown as NodeRow[]).map(toPublic);
  return { counts, list };
}
