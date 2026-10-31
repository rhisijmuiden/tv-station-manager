import type { Platform } from "@tvsm/platform";
import { HttpError, randomToken } from "@tvsm/platform";
import {
  AGENT_API,
  fingerprintOf,
  type AgentCommand,
  type CommandType,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type NodeRole,
} from "@tvsm/platform/agent-protocol";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

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

const HEARTBEAT_SECONDS = 10;
const OFFLINE_AFTER_SECONDS = 45;
const MAX_PENDING = 50;
const ROLES = ["unassigned", "management", "studio", "other"] as const;
const COMMANDS = ["restart-agent", "reboot", "update-agent"] as const;

const hashSecret = (s: string) => createHash("sha256").update(s).digest("hex");

const factsSchema = z.object({
  hostname: z.string().trim().min(1).max(255),
  platform: z.string().max(32),
  os: z.string().max(200),
  arch: z.string().max(32),
  agentVersion: z.string().max(64),
  ips: z.array(z.string().max(64)).max(32),
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
});
const heartbeatSchema = factsSchema.extend({
  metrics: metricsSchema,
  results: z.array(z.object({ id: z.number().int(), status: z.enum(["done", "failed"]), result: z.string().max(4000).optional() })).max(100).optional(),
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
});

export function registerNodes(app: FastifyInstance, platform: Platform) {
  const { db, log } = platform.ctx;
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
         online = 1, last_seen_at = ? WHERE id = ?`,
    ).run(hb.hostname, hb.platform, hb.os, hb.arch, hb.agentVersion, JSON.stringify(hb.ips), req.ip, JSON.stringify(hb.metrics), new Date().toISOString(), node.id);
    if (node.agent_version && node.agent_version !== hb.agentVersion) event(node.id, "agent-updated", `Agent ${node.agent_version} → ${hb.agentVersion}`);
    if (!wasOnline && node.status === "approved") {
      event(node.id, "online", "Node is online");
      if (node.last_seen_at) void platform.mail.alert(`Node back online: ${node.name}`, `${node.name} (${hb.hostname}) is online again.`);
    }
    for (const r of hb.results ?? []) {
      db.prepare("UPDATE node_commands SET status = ?, result = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND node_id = ?").run(r.status, r.result ?? null, r.id, node.id);
      event(node.id, r.status === "done" ? "command" : "command-failed", `Command #${r.id}: ${r.result ?? r.status}`);
    }

    if (node.status === "pending") return { status: "pending", fingerprint: node.fingerprint, intervalSeconds: HEARTBEAT_SECONDS };
    if (node.status === "rejected") return { status: "rejected" };

    const queued = db.prepare("SELECT id, type, payload FROM node_commands WHERE node_id = ? AND status = 'queued' ORDER BY id").all(node.id) as {
      id: number;
      type: CommandType;
      payload: string | null;
    }[];
    for (const c of queued) db.prepare("UPDATE node_commands SET status = 'sent', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(c.id);
    const commands: AgentCommand[] = queued.map((c) => ({ id: c.id, type: c.type, payload: c.payload ? JSON.parse(c.payload) : undefined }));
    const upd = platform.updates.getSettings();
    return { status: "approved", name: node.name, role: node.role, intervalSeconds: HEARTBEAT_SECONDS, commands, update: { channel: upd.channel, repository: upd.repository } };
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
      commands: db.prepare("SELECT id, type, status, result, created_at AS createdAt, updated_at AS updatedAt FROM node_commands WHERE node_id = ? ORDER BY id DESC LIMIT 20").all(n.id),
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

  return { counts };
}
