import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { ATEM_CONTROL_MIGRATIONS, ATEM_MIGRATIONS, registerAtem, type AtemLink } from "../server/atem.ts";
import { DIAGRAM_MIGRATIONS, registerDiagram } from "../server/diagram.ts";
import { HYPERDECK_MIGRATIONS } from "../server/legacy.ts";
import { MONITOR_MIGRATIONS, realProbes, registerMonitoring, type Probes } from "../server/monitoring.ts";
import { deviceIssues, nodeGroup, teranexIssues, nodeIssues, owncastBase, parseHostPort, parseOwncast, targetError, worst } from "../server/monitorlogic.ts";
import { NODE_MIGRATIONS, registerNodes } from "../server/nodes.ts";
import { registerTeranex, TERANEX_MIGRATIONS, type TeranexLink } from "../server/teranex.ts";

const root = mkdtempSync(join(tmpdir(), "tvsm-monitor-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin";

const OWNCAST = { online: true, viewerCount: 12, overallMaxViewerCount: 80, sessionMaxViewerCount: 20, lastConnectTime: "2026-11-02T06:00:00Z", lastDisconnectTime: null, versionNumber: "0.3.0" };

test("logic: health levels and node issues", () => {
  assert.equal(worst([]), "ok");
  assert.equal(worst(["ok", "unknown"]), "unknown");
  assert.equal(worst(["warn", "unknown", "down", "ok"]), "down");
  assert.deepEqual(nodeIssues({ status: "pending", role: "unassigned", online: true, lastSeenAt: null, metrics: null }).map((i) => i.code), ["pending_approval"]);
  assert.deepEqual(nodeIssues({ status: "approved", role: "studio", online: false, lastSeenAt: "2026-11-02T07:00:00Z", metrics: null })[0], { code: "agent_unresponsive", level: "down", params: { since: "2026-11-02T07:00:00Z" } });
  const busy = nodeIssues({
    status: "approved",
    role: "studio",
    online: true,
    lastSeenAt: null,
    metrics: { cpuPercent: 99, memTotal: 100, memUsed: 50, disks: [{ mount: "C:", total: 100, used: 95 }], studio: { casparcg: { connected: false }, mediaPath: "Z:", mediaReachable: false } },
  });
  assert.deepEqual(busy.map((i) => i.code), ["disk_full", "cpu_high", "casparcg_down", "media_unreachable"]);
  assert.equal(nodeGroup("playout"), "studio");
  assert.equal(nodeGroup("management"), "management");
  assert.equal(nodeGroup("other"), "other");
});

test("logic: teranex, owncast parsing, targets, device health", () => {
  const snap = { input: { signalPresent: true as boolean | null, videoMode: "1080p25" }, genlock: { locked: false, reference: "Reference" } };
  assert.deepEqual(teranexIssues({ online: true, lastSeenAt: null, expectedInput: "1080i50", snapshot: snap }).map((i) => i.code), ["input_format", "genlock_unlocked"]);
  assert.deepEqual(teranexIssues({ online: true, lastSeenAt: null, expectedInput: "1080 i50", snapshot: { ...snap, input: { signalPresent: true, videoMode: "1080i50" }, genlock: { locked: false, reference: "Internal" } } }), []);
  assert.deepEqual(teranexIssues({ online: true, lastSeenAt: null, expectedInput: "1080i50", snapshot: { ...snap, input: { signalPresent: false, videoMode: null } } }), [{ code: "no_input_signal", level: "down" }]);
  assert.equal(teranexIssues({ online: false, lastSeenAt: null, snapshot: snap })[0]!.code, "device_offline");

  const o = parseOwncast(OWNCAST, { name: "IJmond360", streamTitle: "Regionieuws" });
  assert.equal(o.viewers, 12);
  assert.equal(o.name, "IJmond360");
  assert.equal(o.streamTitle, "Regionieuws");
  assert.throws(() => parseOwncast({ hello: 1 }));

  assert.equal(owncastBase("10.40.6.127:8080"), "http://10.40.6.127:8080");
  assert.equal(owncastBase("https://live.ijmond360.nl/api/status"), "https://live.ijmond360.nl");
  assert.deepEqual(parseHostPort("10.40.0.154:445"), { host: "10.40.0.154", port: 445 });
  assert.throws(() => parseHostPort("10.40.0.154"));
  assert.equal(targetError("tcp", "nas"), "invalid_target");
  assert.equal(targetError("http", ""), "target_required");
  assert.equal(targetError("manual", ""), null);

  const okLive = { ok: true, ms: 4, owncast: o };
  assert.equal(deviceIssues({ checkType: "owncast", manualStatus: "unknown", result: okLive, fails: 0 }).health, "ok");
  assert.equal(deviceIssues({ checkType: "owncast", manualStatus: "unknown", result: { ...okLive, owncast: { ...o, online: false } }, fails: 0 }).issues[0]!.code, "not_streaming");
  assert.equal(deviceIssues({ checkType: "http", manualStatus: "unknown", result: { ok: false, ms: null }, fails: 1 }).health, "warn");
  assert.equal(deviceIssues({ checkType: "http", manualStatus: "unknown", result: { ok: false, ms: null }, fails: 2 }).health, "down");
  assert.equal(deviceIssues({ checkType: "manual", manualStatus: "ok", result: null, fails: 0, agent: { status: "approved", role: "other", online: false, lastSeenAt: null, metrics: null } }).health, "warn");
  assert.equal(deviceIssues({ checkType: "tcp", manualStatus: "unknown", result: null, fails: 0 }).health, "unknown");
});

test("real probes: Owncast status, HTTP and TCP against a local server", async () => {
  const srv: Server = createServer((req, res) => {
    if (req.url === "/api/status") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(OWNCAST));
    if (req.url === "/api/config") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: "Test" }));
    res.writeHead(req.url === "/health" ? 200 : 503).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const oc = await realProbes.owncast(`http://127.0.0.1:${port}`);
    assert.equal(oc.ok, true);
    assert.equal(oc.owncast?.viewers, 12);
    assert.equal(oc.owncast?.name, "Test");
    assert.equal((await realProbes.http(`http://127.0.0.1:${port}/health`)).ok, true);
    const bad = await realProbes.http(`http://127.0.0.1:${port}/x`);
    assert.equal(bad.ok, false);
    assert.equal(bad.httpStatus, 503);
    assert.equal((await realProbes.tcp("127.0.0.1", port)).ok, true);
  } finally {
    srv.close();
  }
  const closed = await realProbes.tcp("127.0.0.1", port);
  assert.equal(closed.ok, false);
});

// ---- API ----------------------------------------------------------------------------------

let p: Platform;
let cookie = "";
const probeResults = { owncast: { ok: true, ms: 3, owncast: parseOwncast(OWNCAST) } as Awaited<ReturnType<Probes["owncast"]>>, tcp: { ok: true, ms: 1 } as Awaited<ReturnType<Probes["tcp"]>> };
const fakeProbes: Probes = {
  owncast: async () => structuredClone(probeResults.owncast),
  http: async () => ({ ok: true, ms: 2, httpStatus: 200 }),
  tcp: async () => structuredClone(probeResults.tcp),
};
const call = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

test.before(async () => {
  p = await createPlatform({
    app: { id: "orchestrator", name: "Orch", defaultPort: 0 },
    migrations: [...NODE_MIGRATIONS, ...ATEM_MIGRATIONS, ...ATEM_CONTROL_MIGRATIONS, ...DIAGRAM_MIGRATIONS, ...HYPERDECK_MIGRATIONS, ...MONITOR_MIGRATIONS, ...TERANEX_MIGRATIONS],
    register: (s, pl) => {
      const nodes = registerNodes(s, pl);
      const atem = registerAtem(s, pl, () => Object.assign(new EventEmitter(), { connected: false, snapshot: () => null, rename: async () => {}, switch: async () => {}, close: async () => {} }) as AtemLink);
      const tx = registerTeranex(s, pl, () => Object.assign(new EventEmitter(), { connected: false, snapshot: () => null, close: async () => {} }) as TeranexLink);
      registerDiagram(s, pl, atem.list, tx.list);
      registerMonitoring(s, pl, { nodes: nodes.list, atems: atem.list, teranexes: tx.list, automationAuthorized: atem.automationAuthorized }, fakeProbes, 3_600_000);
    },
  });
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("monitoring overview: nodes, ATEM, Owncast and manual equipment", async () => {
  assert.equal((await call("GET", "/api/monitoring")).status, 401);
  await call("POST", "/api/auth/login", { username: "admin", password: "admin" });

  // A studio node that enrolled, got approved and then stopped answering.
  const en = await call("POST", "/agent-api/v1/enroll", { hostname: "VR-CASPAR-STUDIO-01", platform: "win32", os: "Windows Server 2025", arch: "x64", agentVersion: "t", ips: ["10.40.5.11"] });
  assert.equal(en.status, 200);
  await call("POST", `/api/nodes/${en.body.nodeId}/approve`, { name: "Studio 1", role: "playout" });
  await call("POST", "/api/atem", { name: "ATEM Regie", host: "10.40.5.10" });

  let m = await call("GET", "/api/monitoring");
  assert.equal(m.status, 200);
  const node = m.body.nodes[0];
  assert.equal(node.group, "studio");
  assert.equal(node.health, "down");
  assert.equal(node.issues[0].code, "never_seen");
  assert.equal(m.body.atems[0].health, "down");
  assert.equal(m.body.core.issues[0].code, "mail_not_configured");

  assert.equal((await call("POST", "/api/monitoring/devices", { name: "Owncast", block: "distribution", checkType: "owncast", target: "" })).body.error, "target_required");
  assert.equal((await call("POST", "/api/monitoring/devices", { name: "NAS", block: "infrastructure", checkType: "tcp", target: "10.40.0.154" })).body.error, "invalid_target");
  const oc = await call("POST", "/api/monitoring/devices", { name: "Owncast", block: "distribution", checkType: "owncast", target: "10.40.6.127:8080", nodeId: en.body.nodeId });
  assert.equal(oc.status, 200);
  assert.equal(oc.body.health, "warn"); // live, but the linked agent is not answering
  assert.equal(oc.body.result.owncast.viewers, 12);
  assert.equal(oc.body.agent.name, "Studio 1");

  const nas = await call("POST", "/api/monitoring/devices", { name: "UNAS Pro", block: "infrastructure", checkType: "tcp", target: "10.40.0.154:445" });
  assert.equal(nas.body.health, "ok");
  probeResults.tcp = { ok: false, ms: null, error: "ECONNREFUSED" };
  let c = await call("POST", `/api/monitoring/devices/${nas.body.id}/check`);
  assert.equal(c.body.health, "warn"); // one miss is not down yet
  c = await call("POST", `/api/monitoring/devices/${nas.body.id}/check`);
  assert.equal(c.body.health, "down");
  assert.equal(c.body.issues[0].params.error, "ECONNREFUSED");
  const ev = await call("GET", `/api/monitoring/devices/${nas.body.id}`);
  assert.equal(ev.body.events[0].type, "down");

  const tally = await call("POST", "/api/monitoring/devices", { name: "Tally-box", block: "extra", checkType: "manual", manualStatus: "ok", location: "Studio 1" });
  assert.equal(tally.body.health, "ok");
  const put = await call("PUT", `/api/monitoring/devices/${tally.body.id}`, { name: "Tally-box", block: "extra", checkType: "manual", manualStatus: "down" });
  assert.equal(put.body.health, "down");

  m = await call("GET", "/api/monitoring");
  assert.equal(m.body.devices.length, 3);
  // Studio node is linked to the Owncast device, so it is not counted twice.
  assert.equal(m.body.nodes[0].linkedDevice, oc.body.id);
  assert.deepEqual(m.body.summary, { ok: 0, warn: 2, down: 3, unknown: 0 });

  assert.equal((await call("DELETE", `/api/monitoring/devices/${tally.body.id}`)).status, 200);
  // Deleting the node keeps the device but drops the link.
  await call("DELETE", `/api/nodes/${en.body.nodeId}`);
  assert.equal((await call("GET", `/api/monitoring/devices/${oc.body.id}`)).body.device.nodeId, null);
});

test("read-only monitoring for management nodes with the automation token", async () => {
  const bare = (url: string, token?: string) => p.server.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await bare("/automation-api/v1/monitoring")).statusCode, 401);
  assert.equal((await bare("/automation-api/v1/monitoring", "wrong")).statusCode, 401);
  const { token } = (await call("GET", "/api/automation")).body;
  const res = await bare("/automation-api/v1/monitoring", token);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const viaSession = (await call("GET", "/api/monitoring")).body;
  assert.deepEqual(body.devices, viaSession.devices);
  assert.deepEqual(body.summary, viaSession.summary);
  const dev = body.devices[0];
  const ev = await bare(`/automation-api/v1/monitoring/devices/${dev.id}/events`, token);
  assert.equal(ev.statusCode, 200);
  assert.ok(Array.isArray(JSON.parse(ev.body).events));
  assert.equal((await bare(`/automation-api/v1/monitoring/devices/${dev.id}/events`)).statusCode, 401);
  // Write routes stay behind a session.
  assert.equal((await p.server.inject({ method: "POST", url: `/api/monitoring/devices/${dev.id}/check`, headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
});
