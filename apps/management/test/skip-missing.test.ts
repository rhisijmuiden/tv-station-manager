import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { skipEvent, type TimelineEvent } from "../server/timeline.ts";

// A clip whose file is missing is skipped after 10 s instead of freezing the picture; the rest of its programme moves up.

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
  missing = new Set<string>();
  async play(ch: number, layer: number, clip?: string, o: { loop?: boolean } = {}) {
    if (clip && this.missing.has(clip)) throw new Error("CasparCG 404 PLAY FAILED");
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

const root = mkdtempSync(join(tmpdir(), "tvsm-skip-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
const sw = new FakeSwitcher();
const node = new FakePlayout();
const drivers: DriverFactory = { switcher: () => sw, playout: () => node };
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

const MIN = 60_000;
const ev = (key: string, sid: number | null, startMin: number, endMin: number, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  key,
  scheduleId: sid,
  start: startMin * MIN,
  end: endMin * MIN,
  type: "media",
  title: key,
  programTitle: "Uur",
  offsetMs: 0,
  ...extra,
});
const view = (events: TimelineEvent[]) => events.map((e) => [e.key, e.start / MIN, e.end / MIN]);

test("skipEvent: the rest of the programme moves up, the rest-of-hour fill grows", () => {
  const events = [ev("1:0", 1, 0, 10), ev("1:1", 1, 10, 20), ev("1:2", 1, 20, 30), ev("1:fill", 1, 30, 60, { type: "beeldkrant", fill: true }), ev("2:0", 2, 60, 90)];
  const out = skipEvent(events, "1:1", 11 * MIN);
  assert.deepEqual(view(out), [["1:0", 0, 10], ["1:1", 10, 11], ["1:2", 11, 21], ["1:fill", 21, 60], ["2:0", 60, 90]]);
  // Applying it again (after a recompile of the already skipped timeline) changes nothing.
  assert.deepEqual(view(skipEvent(out, "1:1", 11 * MIN)), view(out));
  // Unknown key or a time outside the item: unchanged.
  assert.equal(skipEvent(events, "9:9", 11 * MIN), events);
  assert.equal(skipEvent(events, "1:1", 25 * MIN), events);
});

test("skipEvent: without a fill the channel filler covers the freed time, the next programme keeps its start", () => {
  const events = [ev("1:0", 1, 0, 10), ev("1:1", 1, 10, 50), ev("1:2", 1, 50, 60), ev("2:0", 2, 60, 90)];
  const out = skipEvent(events, "1:1", 10.5 * MIN);
  assert.deepEqual(view(out), [["1:0", 0, 10], ["1:1", 10, 10.5], ["1:2", 10.5, 20.5], [`filler:${20.5 * MIN}`, 20.5, 60], ["2:0", 60, 90]]);
  assert.equal(out[3]!.type, "filler");
  assert.equal(out[3]!.scheduleId, null);
});

test("director: a missing file is skipped after 10 s and the next clip plays", async () => {
  const media = join(root, "media");
  mkdirSync(media, { recursive: true });
  for (const n of ["een", "weg", "twee"]) writeFileSync(join(media, `${n}.mp4`), "x");
  await api("POST", "/api/media/sources", { name: "Test", type: "local", config: { path: media } });
  await new Promise((r) => setTimeout(r, 300));
  const items = (await api("GET", "/api/media")).body.items as { id: number; name: string }[];
  const id = (n: string) => items.find((m) => m.name === n)!.id;
  for (const n of ["een", "weg", "twee"]) await api("PUT", `/api/media/${id(n)}`, { category: "program", durationMs: 10 * MIN });

  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "CASPARCG02", host: "10.40.5.12", role: "playout" });
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId, casparChannel: 1, playoutInput: 1 })).body;
  const block = (await api("POST", "/api/blocks", { name: "Uur", items: ["een", "weg", "twee"].map((n) => ({ type: "media", mediaId: id(n) })) })).body;
  const t0 = Date.parse("2026-11-03T13:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: block.id, title: "Uur 14" });
  await api("POST", `/api/control/${ch.id}/automation`, { on: true });
  // Someone moved the file on the share after the library scan.
  node.missing.add("weg");

  const d = h.director;
  const at = async (t: number) => {
    d.now = () => t;
    await d.tick();
  };
  const status = () => d.status(p.ctx.db.prepare("SELECT * FROM channels WHERE id = ?").get(ch.id) as never);
  await at(t0 + MIN);
  assert.equal(status().current?.title, "een");
  node.calls.length = 0;
  // 14:10: "weg" fails; retried, still within the 10 s.
  for (const s of [0, 1, 6]) await at(t0 + 10 * MIN + s * 1000);
  assert.equal(status().current?.title, "weg");
  assert.ok(!node.calls.some((c) => c.includes("twee")), node.calls.join("\n"));
  // After 10 s it is skipped: "twee" starts at once (not at 14:20).
  await at(t0 + 10 * MIN + 11_000);
  assert.ok(node.calls.includes("play 1-10 twee"), node.calls.join("\n"));
  assert.equal(status().current?.title, "twee");
  // A recompile a minute later keeps the skip: "twee" plays on, the freed time comes after it.
  node.calls.length = 0;
  await at(t0 + 12 * MIN);
  assert.equal(status().current?.title, "twee");
  assert.ok(!node.calls.some((c) => c.startsWith("play 1-10")), node.calls.join("\n"));
  const asrun = p.ctx.db.prepare("SELECT detail FROM asrun WHERE channel_id = ? AND detail LIKE 'Skipped%'").all(ch.id) as { detail: string }[];
  assert.equal(asrun.length, 1);
});
