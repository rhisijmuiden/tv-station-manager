import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { NODE_MIGRATIONS, registerNodes } from "../server/nodes.ts";

const root = mkdtempSync(join(tmpdir(), "tvsm-orch-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin";

let p: Platform;
let cookie = "";
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const facts = { hostname: "studio-01", platform: "win32", os: "Windows Server 2025", arch: "x64", agentVersion: "0.1.0", ips: ["10.40.6.50"] };
const metrics = { cpuCount: 8, cpuPercent: 12.5, memTotal: 16e9, memUsed: 4e9, disks: [{ mount: "C:\\", total: 5e11, used: 1e11 }], uptimeSeconds: 100, agentUptimeSeconds: 50 };

test.before(async () => {
  p = await createPlatform({ app: { id: "orchestrator", name: "Orch", defaultPort: 0 }, migrations: NODE_MIGRATIONS, register: (s, pl) => void registerNodes(s, pl) });
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("node enrollment, approval, heartbeat and commands", async () => {
  // Enroll (no session needed).
  const en = await call("POST", "/agent-api/v1/enroll", facts);
  assert.equal(en.status, 200);
  const { nodeId, secret, fingerprint } = en.body;
  assert.match(fingerprint, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  const auth = { authorization: `Bearer ${nodeId}:${secret}` };

  // Wrong secret is refused; pending node gets pending.
  assert.equal((await call("POST", "/agent-api/v1/heartbeat", { ...facts, metrics }, { authorization: `Bearer ${nodeId}:nope` })).status, 401);
  const pending = await call("POST", "/agent-api/v1/heartbeat", { ...facts, metrics }, auth);
  assert.equal(pending.body.status, "pending");

  // Admin API needs a session.
  assert.equal((await call("GET", "/api/nodes")).status, 401);
  await call("POST", "/api/auth/login", { username: "admin", password: "admin" });
  const list = await call("GET", "/api/nodes");
  assert.equal(list.body.counts.pending, 1);
  assert.equal(list.body.nodes[0].fingerprint, fingerprint);
  assert.equal(list.body.nodes[0].online, true);

  // Commands are refused before approval.
  assert.equal((await call("POST", `/api/nodes/${nodeId}/commands`, { type: "restart-agent" })).status, 400);

  const approved = await call("POST", `/api/nodes/${nodeId}/approve`, { name: "Studio 1", role: "studio" });
  assert.equal(approved.body.status, "approved");

  const q = await call("POST", `/api/nodes/${nodeId}/commands`, { type: "restart-agent" });
  assert.equal(q.body.status, "queued");
  const hb = await call("POST", "/agent-api/v1/heartbeat", { ...facts, metrics }, auth);
  assert.equal(hb.body.status, "approved");
  assert.equal(hb.body.role, "studio");
  assert.equal(hb.body.name, "Studio 1");
  assert.deepEqual(hb.body.commands.map((c: { type: string }) => c.type), ["restart-agent"]);
  // Command is delivered once.
  const hb2 = await call("POST", "/agent-api/v1/heartbeat", { ...facts, metrics, results: [{ id: q.body.id, status: "done", result: "Restarting agent" }] }, auth);
  assert.equal(hb2.body.commands.length, 0);
  const detail = await call("GET", `/api/nodes/${nodeId}`);
  assert.equal(detail.body.commands[0].status, "done");
  assert.ok(detail.body.events.some((e: { type: string }) => e.type === "approved"));
  assert.equal(detail.body.node.metrics.cpuPercent, 12.5);

  // Removing the node revokes it.
  await call("DELETE", `/api/nodes/${nodeId}`);
  assert.equal((await call("POST", "/agent-api/v1/heartbeat", { ...facts, metrics }, auth)).status, 401);
});

test("rejected node is told so", async () => {
  const en = await call("POST", "/agent-api/v1/enroll", { ...facts, hostname: "rogue" });
  await call("POST", `/api/nodes/${en.body.nodeId}/reject`);
  const hb = await call("POST", "/agent-api/v1/heartbeat", { ...facts, metrics }, { authorization: `Bearer ${en.body.nodeId}:${en.body.secret}` });
  assert.equal(hb.body.status, "rejected");
});
