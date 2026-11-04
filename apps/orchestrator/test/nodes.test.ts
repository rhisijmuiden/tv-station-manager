import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { NODE_MIGRATIONS, PROVISION_MIGRATIONS, latestAgentVersion, registerNodes } from "../server/nodes.ts";

const root = mkdtempSync(join(tmpdir(), "tvsm-orch-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin";

let p: Platform;
let onAirNode: string | null = null;
const releases = [
  { tag_name: "v0.3.0-test.9", draft: false, prerelease: true, assets: [{ name: "tvsm-agent_0.3.0.test.9_windows-x64.zip" }, { name: "tvsm-agent_0.3.0.test.9_amd64.deb" }] },
  { tag_name: "v0.2.0", draft: false, prerelease: false, assets: [{ name: "tvsm-agent_0.2.0_windows-x64.zip" }] },
  { tag_name: "v0.4.0", draft: true, prerelease: false, assets: [{ name: "tvsm-agent_0.4.0_windows-x64.zip" }] },
];
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
  p = await createPlatform({
    app: { id: "orchestrator", name: "Orch", defaultPort: 0 },
    migrations: [...NODE_MIGRATIONS, ...PROVISION_MIGRATIONS],
    register: (s, pl) =>
      void registerNodes(s, pl, {
        releases: async () => releases,
        atems: () => [
          {
            name: "ATEM 4K",
            snapshot: { program: [8], preview: [2], inputs: [{ id: 8, longName: "Playout" }] },
            inputs: [{ inputId: 8, nodeId: onAirNode }],
          },
        ],
      }),
  });
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

  // Studio nodes report CasparCG / ingest; a malformed studio block is dropped, not the heartbeat.
  const studio = {
    casparcg: { service: "running", connected: true, version: "2.4.0 Stable", channels: [{ id: 1, format: "1080i5000", status: "PLAYING" }] },
    ingest: { service: "running", rtmpUrl: "rtmp://10.40.5.11/live", streams: [{ name: "live/remote1", ready: true, readers: 1, tracks: ["H264", "MPEG-4 Audio"] }] },
    outputs: [{ device: 1, channel: 1, format: "1080i5000" }],
    mediaPath: "\\\\unas\\TV",
    mediaReachable: true,
  };
  assert.equal((await call("POST", "/agent-api/v1/heartbeat", { ...facts, metrics: { ...metrics, studio } }, auth)).status, 200);
  assert.equal((await call("GET", `/api/nodes/${nodeId}`)).body.node.metrics.studio.ingest.streams[0].name, "live/remote1");
  assert.equal((await call("POST", "/agent-api/v1/heartbeat", { ...facts, metrics: { ...metrics, studio: { casparcg: "bad" } } }, auth)).status, 200);
  assert.equal((await call("GET", `/api/nodes/${nodeId}`)).body.node.metrics.studio, undefined);
  assert.equal((await call("POST", `/api/nodes/${nodeId}/commands`, { type: "restart-casparcg" })).body.status, "queued");

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

test("latest agent per channel and platform", () => {
  assert.equal(latestAgentVersion(releases, "production", "win32"), "0.2.0");
  assert.equal(latestAgentVersion(releases, "test", "win32"), "0.3.0-test.9");
  assert.equal(latestAgentVersion(releases, "production", "linux"), null);
  assert.equal(latestAgentVersion(releases, "test", "linux"), "0.3.0-test.9");
});

test("provisioning: plan, on-air confirmation, capability gating, password sent once, role after success", async () => {
  await call("POST", "/api/auth/login", { username: "admin", password: "admin" });
  const en = await call("POST", "/agent-api/v1/enroll", { ...facts, hostname: "CASPARCG02" });
  const { nodeId, secret } = en.body;
  const auth = { authorization: `Bearer ${nodeId}:${secret}` };
  await call("POST", `/api/nodes/${nodeId}/approve`, { name: "CASPARCG02", role: "playout" });
  const studio = {
    casparcg: { service: "running", connected: true, version: "2.4.3", channels: [{ id: 1, format: "1080i5000", status: "PLAYING" }] },
    ingest: { service: "running", rtmpUrl: null, streams: [] },
    outputs: [{ device: 1, channel: 1, format: "1080i5000" }],
    mediaPath: "\\\\unas\\TV",
    mediaReachable: true,
    role: "playout",
  };
  // Old agent: no capabilities.
  const first = await call("POST", "/agent-api/v1/heartbeat", { ...facts, hostname: "CASPARCG02", metrics: { ...metrics, studio } }, auth);
  assert.equal(first.body.update.auto.enabled, true);
  assert.equal(first.body.update.auto.windowStart, "03:00");

  // On air (ATEM input 8 on program is fed by this node): typing the name is required.
  onAirNode = nodeId;
  const body = { role: "live", outputs: 1, components: ["ffmpeg"], managementHosts: ["10.40.6.202"], smbUser: "reinder", smbPassword: "geheim" };
  const plan = await call("POST", `/api/nodes/${nodeId}/provision/plan`, body);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.requireTypedName, true);
  assert.ok(plan.body.warnings.some((w: { key: string; params: { input: number } }) => w.key === "onAirProgram" && w.params.input === 8));
  assert.ok(plan.body.steps.some((s: { key: string }) => s.key === "updateAgent"));
  assert.equal((await call("POST", `/api/nodes/${nodeId}/provision`, body)).body.error, "confirm_name");
  const q = await call("POST", `/api/nodes/${nodeId}/provision`, { ...body, confirmName: " casparcg02 " });
  assert.equal(q.status, 200);
  // A second job is refused while one is queued.
  assert.equal((await call("POST", `/api/nodes/${nodeId}/provision`, { ...body, confirmName: "CASPARCG02" })).status, 409);

  // The old agent only gets the update; the provision job waits for the capability.
  const hbOld = await call("POST", "/agent-api/v1/heartbeat", { ...facts, hostname: "CASPARCG02", metrics: { ...metrics, studio } }, auth);
  assert.deepEqual(hbOld.body.commands.map((c: { type: string }) => c.type), ["update-agent"]);
  const caps = ["provision", "inventory", "auto-update"];
  const hbNew = await call("POST", "/agent-api/v1/heartbeat", { ...facts, hostname: "CASPARCG02", agentVersion: "0.3.0-test.9", capabilities: caps, metrics: { ...metrics, studio } }, auth);
  const job = hbNew.body.commands.find((c: { type: string }) => c.type === "provision");
  assert.equal(job.payload.role, "ingest");
  assert.equal(job.payload.smbPassword, "geheim");
  assert.equal(job.payload.managementUrl, "http://10.40.6.202:8080");
  assert.deepEqual(job.payload.components.sort(), ["ffmpeg", "vcredist"]);
  assert.equal(job.payload.nodeRole, undefined);
  // The password is gone from the database once delivered.
  const row = p.ctx.db.prepare("SELECT payload FROM node_commands WHERE id = ?").get(job.id) as { payload: string };
  assert.ok(!row.payload.includes("geheim"));
  assert.ok(!row.payload.includes("enc:v1"));

  // Progress, then the result: the role follows.
  await call("POST", "/agent-api/v1/heartbeat", { ...facts, hostname: "CASPARCG02", capabilities: caps, metrics, results: [{ id: job.id, status: "running", result: "ffmpeg" }] }, auth);
  let d = await call("GET", `/api/nodes/${nodeId}`);
  const c = d.body.commands.find((x: { id: number }) => x.id === job.id);
  assert.equal(c.status, "sent");
  assert.equal(c.progress, "ffmpeg");
  await call("POST", "/agent-api/v1/heartbeat", { ...facts, hostname: "CASPARCG02", capabilities: caps, metrics, results: [{ id: job.id, status: "done", result: "Node set up as ingest" }] }, auth);
  d = await call("GET", `/api/nodes/${nodeId}`);
  assert.equal(d.body.node.role, "live");
  assert.equal(d.body.commands.find((x: { id: number }) => x.id === job.id).status, "done");
  assert.equal(d.body.latestAgent, "0.2.0"); // update channel = production

  // Per-node auto update off; agent settings validated.
  await call("PUT", `/api/nodes/${nodeId}/auto-update`, { enabled: false });
  const hbOff = await call("POST", "/agent-api/v1/heartbeat", { ...facts, hostname: "CASPARCG02", capabilities: caps, metrics }, auth);
  assert.equal(hbOff.body.update.auto.enabled, false);
  assert.equal((await call("PUT", "/api/nodes-settings", { autoUpdate: true, windowStart: "", windowEnd: "", deckLinkSource: "ftp://x" })).status, 400);
  assert.equal((await call("PUT", "/api/nodes-settings", { autoUpdate: true, windowStart: "", windowEnd: "", deckLinkSource: "\\\\unas\\Software\\dv.zip" })).status, 200);

  // Linux nodes cannot be provisioned.
  const lin = await call("POST", "/agent-api/v1/enroll", { ...facts, hostname: "tv-manager", platform: "linux" });
  await call("POST", `/api/nodes/${lin.body.nodeId}/approve`, { name: "tv-manager", role: "management" });
  const lp = await call("POST", `/api/nodes/${lin.body.nodeId}/provision/plan`, { role: "playout" });
  assert.equal(lp.body.blocked, true);
  onAirNode = null;
});
