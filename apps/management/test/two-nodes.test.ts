import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import { LIVE_PREROLL_MS, LIVE_SETTLE_MS } from "../server/director.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";

// Two studio nodes on one channel: a playout node runs the schedule, a live node takes the stream of an event.
// The director switches the ATEM between them following the schedule.

class FakeSwitcher extends EventEmitter implements SwitcherDriver {
  programIn: number | null = null;
  info(): SwitcherInfo {
    return { connected: true, model: "Fake", productName: "ATEM Fake", mixEffects: 1, inputs: [1, 2, 3].map((id) => ({ id, longName: `In ${id}`, shortName: `${id}`, external: true })), program: [this.programIn], preview: [null] };
  }
  async program(input: number) {
    this.programIn = input;
  }
  async preview() {}
  async cut() {}
  async auto() {}
  async close() {}
}
class FakePlayout extends EventEmitter implements PlayoutDriver {
  calls: string[] = [];
  session = 1;
  info() {
    return { connected: true, version: "2.4.3", channels: [1], session: this.session };
  }
  async play(ch: number, layer: number, clip?: string, o: { loop?: boolean } = {}) {
    this.calls.push(`play ${ch}-${layer}${clip ? ` ${clip}` : ""}${o.loop ? " loop" : ""}`);
  }
  async loadbg(ch: number, layer: number, clip: string) {
    this.calls.push(`loadbg ${ch}-${layer} ${clip}`);
  }
  async stop(ch: number, layer: number) {
    this.calls.push(`stop ${ch}-${layer}`);
  }
  async clear(ch: number, layer?: number) {
    this.calls.push(`clear ${ch}-${layer}`);
  }
  async playHtml() {}
  async cgAdd(ch: number, layer: number, template: string) {
    this.calls.push(`cgadd ${ch}-${layer} ${template}`);
  }
  async cgUpdate(ch: number, layer: number) {
    this.calls.push(`cgupdate ${ch}-${layer}`);
  }
  async cgStop() {}
  async addConsumer() {}
  async removeConsumer() {}
  async close() {}
}

const root = mkdtempSync(join(tmpdir(), "tvsm-two-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
const sw = new FakeSwitcher();
const nodes = new Map<string, FakePlayout>([
  ["10.40.5.11", new FakePlayout()],
  ["10.40.5.12", new FakePlayout()],
]);
const playoutNode = nodes.get("10.40.5.11")!;
const liveNode = nodes.get("10.40.5.12")!;
const drivers: DriverFactory = { switcher: () => sw, playout: (host) => nodes.get(host)! };
let cookie = "";
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body };
};

test.before(async () => {
  p = await createPlatform(managementOptions({ drivers, autostart: false, onReady: (x) => (h = x) }));
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("two studio nodes: the schedule switches the ATEM between the playout node and the live node", async () => {
  const media = join(root, "media");
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, "show.mp4"), "x");
  writeFileSync(join(media, "ident.mp4"), "x");
  await api("POST", "/api/media/sources", { name: "Test", type: "local", config: { path: media } });
  await new Promise((r) => setTimeout(r, 300));
  const items = (await api("GET", "/api/media")).body.items as { id: number; name: string }[];
  const show = items.find((m) => m.name === "show")!;
  const ident = items.find((m) => m.name === "ident")!;
  await api("PUT", `/api/media/${show.id}`, { category: "program", durationMs: 60_000 });
  await api("PUT", `/api/media/${ident.id}`, { category: "filler", durationMs: 10_000 });

  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  assert.equal((await api("POST", "/api/studios", { name: "VR-CASPAR-STUDIO-01", host: "10.40.5.11", role: "playout" })).status, 200);
  assert.equal((await api("POST", "/api/studios", { name: "VR-CASPAR-TV-01", host: "10.40.5.12", role: "live" })).status, 200);
  assert.equal((await api("POST", "/api/studios", { name: "Bad", host: "10.40.5.13", role: "director" })).status, 400);
  const studios = (await api("GET", "/api/studios")).body.studios as { id: number; name: string; role: string }[];
  const playoutId = studios.find((s) => s.role === "playout")!.id;
  const liveId = studios.find((s) => s.role === "live")!.id;
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId: playoutId, casparChannel: 1, playoutInput: 1, fallbackInput: 3, fillerMediaId: ident.id })).body;

  // Event stream pushed to the live node, its DeckLink output 1 is cabled to ATEM input 2.
  const src = (await api("POST", "/api/live-sources", { name: "Raadsvergadering", kind: "rtmp", atemInput: 2, studioId: liveId, casparChannel: 1 })).body;
  const key = (await api("GET", "/api/live-sources")).body.sources[0].push.streamKey as string;
  let online = false;
  h.remote.fetcher = (async (url: string) => {
    const mine = url.startsWith("http://10.40.5.12:");
    const items = mine && online ? [{ name: `live/${key}`, online: true, onlineTime: "2026-11-02T19:00:00Z", tracks2: [{ codec: "H264" }], readers: [], inboundBytes: 1 }] : [];
    return new Response(JSON.stringify({ items }), { headers: { "content-type": "application/json" } });
  }) as never;

  const showBlock = (await api("POST", "/api/blocks", { name: "Show", items: [{ type: "media", mediaId: show.id }] })).body;
  const liveBlock = (await api("POST", "/api/blocks", { name: "Raad live", items: [{ type: "live", liveSourceId: src.id, durationMs: 120_000 }] })).body;
  const t0 = Date.parse("2026-11-02T19:00:00Z");
  const tLive = t0 + 60_000;
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: showBlock.id, title: "Avondshow" });
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(tLive).toISOString(), blockId: liveBlock.id, title: "Gemeenteraad live" });
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(tLive + 120_000).toISOString(), blockId: showBlock.id, title: "Herhaling" });
  await api("POST", `/api/control/${ch.id}/automation`, { on: true });

  const d = h.director;
  let clock = t0;
  h.remote.now = () => clock;
  const run = async (t: number) => {
    clock = t;
    d.now = () => t;
    await h.remote.poll();
    await d.tick();
  };
  const status = () => d.status(p.ctx.db.prepare("SELECT * FROM channels WHERE id = ?").get(ch.id) as never);
  const url = `rtmp://127.0.0.1/live/${key}`;

  await run(t0 + 100);
  assert.equal(sw.programIn, 1);
  assert.equal(status().onAir?.node, "playout");
  assert.equal(status().onAir?.studio, "VR-CASPAR-STUDIO-01");

  // Preroll: well before the live item, the live node waits for the stream; the ATEM stays on the playout node.
  await run(tLive - LIVE_PREROLL_MS + 1000);
  assert.ok(liveNode.calls.includes("stop 1-10"), liveNode.calls.join("\n"));
  assert.equal(sw.programIn, 1);
  online = true;
  await run(tLive - 20_000);
  assert.ok(liveNode.calls.includes(`play 1-10 ${url}`), liveNode.calls.join("\n"));
  // The logo goes on the live node's output too.
  assert.ok(liveNode.calls.includes("cgadd 1-20 tvsm/overlay"), liveNode.calls.join("\n"));
  assert.equal(sw.programIn, 1);

  // Live item: ATEM to the live node, the playout node loops the filler as standby.
  playoutNode.calls.length = 0;
  await run(tLive + 100);
  assert.equal(sw.programIn, 2);
  assert.ok(playoutNode.calls.includes("play 1-10 ident loop"), playoutNode.calls.join("\n"));
  assert.equal(status().onAir?.node, "live");
  assert.equal(status().onAir?.studio, "VR-CASPAR-TV-01");
  assert.equal(status().standby, null);

  // The stream drops: back to the playout node, and to the live node once it is back and has settled.
  online = false;
  await run(tLive + 10_000);
  assert.equal(sw.programIn, 1);
  assert.equal(status().standby?.name, "Raadsvergadering");
  online = true;
  await run(tLive + 15_000);
  assert.equal(sw.programIn, 1, "not before the stream has settled on CasparCG");
  await run(tLive + 15_000 + LIVE_SETTLE_MS);
  assert.equal(sw.programIn, 2);
  assert.equal(status().standby, null);

  // After the live item: back to the playout node, stream and overlay off the live node.
  liveNode.calls.length = 0;
  await run(tLive + 120_000 + 100);
  assert.equal(sw.programIn, 1);
  assert.ok(liveNode.calls.includes("stop 1-10"), liveNode.calls.join("\n"));
  assert.ok(liveNode.calls.includes("clear 1-20"), liveNode.calls.join("\n"));
  assert.equal(status().onAir?.node, "playout");

  const asrun = (await api("GET", `/api/asrun?channel=${ch.id}&from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z`)).body.items as { detail: string | null }[];
  assert.ok(asrun.some((i) => i.detail?.includes("dropped")));
  assert.ok(asrun.some((i) => i.detail?.includes("Stream is in")));
});

test("two studio nodes: no stream at the start of the live item keeps the playout node on air", async () => {
  const ch = (await api("GET", "/api/channels")).body.channels[0];
  const src = (await api("GET", "/api/live-sources")).body.sources[0];
  const liveBlock = (await api("POST", "/api/blocks", { name: "Wedstrijd", items: [{ type: "live", liveSourceId: src.id, durationMs: 60_000 }] })).body;
  const t1 = Date.parse("2026-11-03T12:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t1).toISOString(), blockId: liveBlock.id, title: "Voetbal" });
  h.remote.fetcher = (async () => new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } })) as never;
  const d = h.director;
  d.invalidate();
  const run = async (t: number) => {
    h.remote.now = () => t;
    d.now = () => t;
    await h.remote.poll();
    await d.tick();
  };
  await run(t1 + 100);
  assert.equal(sw.programIn, 1);
  const st = d.status(p.ctx.db.prepare("SELECT * FROM channels WHERE id = ?").get(ch.id) as never);
  assert.equal(st.standby?.name, src.name);
  assert.equal(st.onAir?.node, "playout");
});
