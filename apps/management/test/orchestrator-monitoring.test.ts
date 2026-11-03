import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions } from "../server/app.ts";

// The orchestrator's monitoring picture, read on this node with the automation token (no orchestrator login).

const root = mkdtempSync(join(tmpdir(), "tvsm-orchmon-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;

const OVERVIEW = {
  checkedAt: "2026-11-03T23:00:00Z",
  core: { name: "Orch", hostname: "tv-orchestrator", version: "0.1.0", channel: "test", uptimeSeconds: 60, mailConfigured: true, lastBackup: null, health: "ok", issues: [] },
  nodes: [],
  atems: [],
  teranexes: [],
  devices: [{ id: "dev-1", name: "Owncast", block: "distribution", health: "ok", issues: [] }],
  summary: { ok: 2, warn: 0, down: 0, unknown: 0 },
};
let reachable = true;
let outdated = false;
const seen: string[] = [];
const fakeFetch = (async (url: string, init?: RequestInit) => {
  seen.push(url);
  if (!reachable) throw new Error("connect ECONNREFUSED");
  if (new Headers(init?.headers).get("authorization") !== "Bearer tok-123") return new Response("{}", { status: 401 });
  const path = new URL(url).pathname;
  const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
  if (path === "/automation-api/v1/atem-control") return json({ serverTime: new Date().toISOString(), switchers: [] });
  if (path === "/automation-api/v1/monitoring" && !outdated) return json(OVERVIEW);
  if (path === "/automation-api/v1/monitoring/devices/dev-1/events") return json({ events: [{ type: "ok", message: "Back up", at: "2026-11-03T22:00:00Z" }] });
  return new Response('{"error":"not_found"}', { status: 404 });
}) as typeof fetch;

let cookie = "";
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const fresh = () => new Promise((r) => setTimeout(r, 2100)); // past the short shared cache

test.before(async () => {
  p = await createPlatform(managementOptions({ autostart: false, fetch: fakeFetch }));
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("orchestrator monitoring: proxied read-only with the automation token", async () => {
  assert.equal((await api("GET", "/api/orchestrator-monitoring")).status, 401); // signed in here, though
  await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" });
  assert.equal((await api("GET", "/api/orchestrator-monitoring")).body.error, "orchestrator_not_linked");

  // Address + token are enough; the ATEM lock switch may stay off.
  await api("PUT", "/api/orchestrator-link", { enabled: false, url: "http://10.40.6.201:8080/", token: "wrong" });
  assert.equal((await api("GET", "/api/orchestrator-monitoring")).body.error, "orchestrator_token_rejected");
  await api("PUT", "/api/orchestrator-link", { enabled: false, url: "http://10.40.6.201:8080/", token: "tok-123" });
  const m = await api("GET", "/api/orchestrator-monitoring");
  assert.equal(m.status, 200);
  assert.equal(m.body.devices[0].name, "Owncast");
  assert.deepEqual(m.body.summary, OVERVIEW.summary);
  assert.equal(m.body.source, "http://10.40.6.201:8080");
  assert.equal(seen.at(-1), "http://10.40.6.201:8080/automation-api/v1/monitoring");

  // Many browsers in a row ask the orchestrator once.
  const before = seen.length;
  await api("GET", "/api/orchestrator-monitoring");
  await api("GET", "/api/orchestrator-monitoring");
  assert.equal(seen.length, before);

  const ev = await api("GET", "/api/orchestrator-monitoring/devices/dev-1/events");
  assert.equal(ev.body.events[0].message, "Back up");
  assert.equal((await api("GET", "/api/orchestrator-monitoring/devices/..%2Fx/events")).status, 404);

  await fresh();
  reachable = false;
  const down = await api("GET", "/api/orchestrator-monitoring");
  assert.equal(down.status, 502);
  assert.equal(down.body.error, "orchestrator_unreachable");

  await fresh();
  reachable = true;
  outdated = true;
  assert.equal((await api("GET", "/api/orchestrator-monitoring")).body.error, "orchestrator_outdated");
});
