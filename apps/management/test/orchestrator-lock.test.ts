import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";

// An ATEM locked in the orchestrator: the director holds its switches until it is released.

class FakeSwitcher extends EventEmitter implements SwitcherDriver {
  programIn: number | null = 3;
  calls: string[] = [];
  info(): SwitcherInfo {
    return { connected: true, model: "Fake", productName: "ATEM Fake", mixEffects: 1, inputs: [1, 2, 3].map((id) => ({ id, longName: `In ${id}`, shortName: `${id}`, external: true })), program: [this.programIn], preview: [null] };
  }
  async program(input: number) {
    this.calls.push(`program ${input}`);
    this.programIn = input;
  }
  async preview(input: number) {
    this.calls.push(`preview ${input}`);
  }
  async cut() {
    this.calls.push("cut");
  }
  async auto() {}
  async close() {}
}
class FakePlayout extends EventEmitter implements PlayoutDriver {
  info() {
    return { connected: true, version: "2.4.3", channels: [1], session: 1 };
  }
  async play() {}
  async loadbg() {}
  async stop() {}
  async clear() {}
  async playHtml() {}
  async cgAdd() {}
  async cgUpdate() {}
  async cgStop() {}
  async addConsumer() {}
  async removeConsumer() {}
  async close() {}
}

const root = mkdtempSync(join(tmpdir(), "tvsm-lock-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
const sw = new FakeSwitcher();
const drivers: DriverFactory = { switcher: () => sw, playout: () => new FakePlayout() };

// The orchestrator, as far as this node sees it.
let mode: "automation" | "locked" = "locked";
let reachable = true;
const seen: { url: string; auth: string | null }[] = [];
const fakeFetch = (async (url: string, init?: RequestInit) => {
  seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
  if (!reachable) throw new Error("connect ECONNREFUSED");
  if (new Headers(init?.headers).get("authorization") !== "Bearer tok-123") return new Response("{}", { status: 401 });
  return new Response(JSON.stringify({ serverTime: new Date().toISOString(), switchers: [{ id: "x", name: "Regie", host: "10.40.6.50", mode, by: "reinder", at: "2026-11-01T20:00:00Z", reason: "Live talk" }] }), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

let cookie = "";
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body };
};

test.before(async () => {
  p = await createPlatform(managementOptions({ drivers, autostart: false, fetch: fakeFetch, onReady: (x) => (h = x) }));
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("orchestrator lock: automation holds its switches, manual switching refused, release takes the held switch", async () => {
  const media = join(root, "media");
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, "show.mp4"), "x");
  await api("POST", "/api/media/sources", { name: "Test", type: "local", config: { path: media } });
  await new Promise((r) => setTimeout(r, 300));
  const show = ((await api("GET", "/api/media")).body.items as { id: number; name: string }[]).find((m) => m.name === "show")!;
  await api("PUT", `/api/media/${show.id}`, { category: "program", durationMs: 60_000 });
  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "Studio", host: "10.40.5.11" });
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId, casparChannel: 1, playoutInput: 1, fallbackInput: 2 })).body;
  const block = (await api("POST", "/api/blocks", { name: "Show", items: [{ type: "media", mediaId: show.id }] })).body;
  const t0 = Date.parse("2026-11-02T19:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: block.id, title: "Avondshow" });
  await api("POST", `/api/control/${ch.id}/automation`, { on: true });

  // Link to the orchestrator.
  assert.equal((await api("PUT", "/api/orchestrator-link", { enabled: true, url: "not a url" })).status, 400);
  assert.equal((await api("PUT", "/api/orchestrator-link", { enabled: true, url: "http://10.40.6.201:8080/", token: "wrong" })).body.lastError, "token rejected by the orchestrator");
  const linked = await api("PUT", "/api/orchestrator-link", { enabled: true, url: "http://10.40.6.201:8080/", token: "tok-123" });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.lastError, null);
  assert.equal(linked.body.hasToken, true);
  assert.equal(linked.body.token, undefined);
  assert.equal(seen.at(-1)!.url, "http://10.40.6.201:8080/automation-api/v1/atem-control");
  assert.deepEqual(
    linked.body.locks.map((l: { host: string; by: string }) => [l.host, l.by]),
    [["10.40.6.50", "reinder"]],
  );
  // The token is stored encrypted.
  assert.ok(!JSON.stringify(p.ctx.settings.get("orchestrator.link", {})).includes("tok-123"));

  // Locked: the director plays the schedule but does not switch; the operator's camera (3) stays on air.
  h.director.now = () => t0 + 1000;
  await h.director.tick();
  assert.equal(sw.programIn, 3);
  assert.deepEqual(sw.calls, []);
  const ctl = (await api("GET", "/api/control")).body.channels[0];
  assert.equal(ctl.atemLock.by, "reinder");
  assert.equal((await api("POST", `/api/control/${ch.id}/atem`, { action: "program", input: 2 })).status, 409);
  assert.equal((await api("GET", "/api/atems")).body.atems[0].lock.reason, "Live talk");

  // Orchestrator down: the lock stays.
  reachable = false;
  await h.orchestrator.poll();
  assert.match(h.orchestrator.status().lastError!, /ECONNREFUSED/);
  assert.equal(h.hub.lock(atemId)?.by, "reinder");

  // Released: the held switch is taken straight away.
  reachable = true;
  mode = "automation";
  await h.orchestrator.poll();
  await new Promise((r) => setImmediate(r));
  assert.equal(sw.programIn, 1);
  assert.equal(h.hub.lock(atemId), null);
  assert.equal((await api("POST", `/api/control/${ch.id}/atem`, { action: "preview", input: 2 })).status, 200);

  // Switching the link off releases everything.
  mode = "locked";
  await h.orchestrator.poll();
  assert.ok(h.hub.lock(atemId));
  await api("PUT", "/api/orchestrator-link", { enabled: false, url: "http://10.40.6.201:8080" });
  assert.equal(h.hub.lock(atemId), null);
  assert.equal((await api("GET", "/api/orchestrator-link")).body.hasToken, true);
});
