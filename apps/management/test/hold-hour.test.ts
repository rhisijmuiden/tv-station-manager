import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { nextStationHour } from "../server/hourclock.ts";
import { holdUntil, type TimelineEvent } from "../server/timeline.ts";

// Changes to the hour block on air wait for the next whole hour, so the playout does not restart mid-programme.

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

const root = mkdtempSync(join(tmpdir(), "tvsm-hold-"));
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
const ev = (key: string, startMin: number, endMin: number, path: string, offsetMin = 0): TimelineEvent => ({
  key,
  scheduleId: 1,
  start: startMin * MIN,
  end: endMin * MIN,
  type: "media",
  title: path,
  programTitle: "Uur",
  offsetMs: offsetMin * MIN,
  leaf: { type: "media", durationMs: (endMin - startMin + offsetMin) * MIN, title: path, path, blockKind: "program", blockName: "Uur" },
});

test("holdUntil: the hour on air keeps its old items, the new ones start at the hour", () => {
  const held = [ev("1:0", 0, 30, "a"), ev("1:1", 30, 60, "b"), ev("2:0", 60, 120, "c")];
  const fresh = [ev("1:0", 0, 20, "a"), ev("1:1", 20, 40, "x"), ev("1:2", 40, 60, "b"), ev("2:0", 60, 120, "c2")];
  const r = holdUntil(held, fresh, 10 * MIN, 60 * MIN);
  assert.equal(r.differs, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.events.map((e) => e.title), ["a", "b", "c2"]);

  // Nothing changed in this hour: the fresh timeline at once (later hours update directly).
  const same = holdUntil(held, [held[0]!, held[1]!, ev("2:0", 60, 120, "c2")], 10 * MIN, 60 * MIN);
  assert.equal(same.differs, false);
  assert.equal(same.events[2]!.title, "c2");

  // Only the keys changed (the week schedule was published again with new rows): held, but nothing to show editors.
  const renamed = holdUntil(held, [ev("7:0", 0, 30, "a"), ev("7:1", 30, 60, "b"), ev("8:0", 60, 120, "c")], 10 * MIN, 60 * MIN);
  assert.equal(renamed.differs, true);
  assert.equal(renamed.changed, false);
  assert.equal(renamed.events[0]!.key, "1:0");

  // An item running across the hour: cut at the hour and started there at the right offset; the same item plays on.
  const long = holdUntil([ev("1:0", 0, 50, "a"), ev("1:1", 50, 70, "b")], [ev("1:0", 0, 40, "z"), ev("1:1", 50, 70, "b")], 5 * MIN, 60 * MIN);
  assert.deepEqual(long.events.map((e) => [e.key, e.start / MIN, e.end / MIN, e.offsetMs / MIN]), [["1:0", 0, 50, 0], ["1:1", 50, 60, 0], ["1:1", 60, 70, 10]]);
  const other = holdUntil([ev("1:0", 0, 70, "a")], [ev("1:0", 0, 70, "z")], 5 * MIN, 60 * MIN);
  assert.deepEqual(other.events.map((e) => [e.key, e.title, e.start / MIN, e.offsetMs / MIN]), [["1:0", "a", 0, 0], [`1:0@${60 * MIN}`, "z", 60, 60]]);
  // After the hour, the cut item compared with the uncut fresh one is the same picture.
  const later = holdUntil(other.events, [ev("1:0", 0, 70, "z")], 61 * MIN, 120 * MIN);
  assert.equal(later.changed, false);
});

test("nextStationHour: whole hours in station time", () => {
  const t = Date.parse("2026-11-03T14:31:20Z");
  assert.equal(new Date(nextStationHour(t, "Europe/Amsterdam")).toISOString(), "2026-11-03T15:00:00.000Z");
  assert.equal(new Date(nextStationHour(Date.parse("2026-11-03T15:00:00Z"), "Europe/Amsterdam")).toISOString(), "2026-11-03T16:00:00.000Z");
  assert.equal(new Date(nextStationHour(t, "Asia/Kolkata")).toISOString(), "2026-11-03T15:30:00.000Z");
});

test("director: editing the block on air goes on air at the next hour; apply now takes it at once", async () => {
  const media = join(root, "media");
  mkdirSync(media, { recursive: true });
  for (const n of ["een", "twee", "nieuw"]) writeFileSync(join(media, `${n}.mp4`), "x");
  await api("POST", "/api/media/sources", { name: "Test", type: "local", config: { path: media } });
  await new Promise((r) => setTimeout(r, 300));
  const items = (await api("GET", "/api/media")).body.items as { id: number; name: string }[];
  const id = (n: string) => items.find((m) => m.name === n)!.id;
  for (const n of ["een", "twee", "nieuw"]) await api("PUT", `/api/media/${id(n)}`, { category: "program", durationMs: 30 * MIN });

  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "CASPARCG02", host: "10.40.5.12", role: "playout" });
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId, casparChannel: 1, playoutInput: 1 })).body;
  const block = (await api("POST", "/api/blocks", { name: "Uur", items: [{ type: "media", mediaId: id("een") }, { type: "media", mediaId: id("twee") }] })).body;
  const t0 = Date.parse("2026-11-03T13:00:00Z"); // 14:00 Amsterdam
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: block.id, title: "Uur 14" });
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0 + 60 * MIN).toISOString(), blockId: block.id, title: "Uur 15" });
  await api("POST", `/api/control/${ch.id}/automation`, { on: true });

  const d = h.director;
  let clock = t0;
  // The director compiles at least every minute; walk there in minute steps like the real loop.
  const run = async (t: number) => {
    for (let c = Math.min(clock + MIN, t); ; c = Math.min(c + MIN, t)) {
      d.now = () => c;
      await d.tick();
      if (c >= t) break;
    }
    clock = t;
  };
  const status = () => d.status(p.ctx.db.prepare("SELECT * FROM channels WHERE id = ?").get(ch.id) as never);
  await run(t0 + 10 * MIN);
  assert.equal(status().current?.title, "een");

  // 14:20: the editor swaps the second clip. The clip on air plays on, 14:30 still brings the old second clip.
  node.calls.length = 0;
  assert.equal((await api("PUT", `/api/blocks/${block.id}`, { name: "Uur", items: [{ type: "media", mediaId: id("een") }, { type: "media", mediaId: id("nieuw") }] })).status, 200);
  await run(t0 + 20 * MIN);
  assert.ok(!node.calls.some((c) => c.startsWith("play")), node.calls.join("\n"));
  assert.equal(status().pending?.from, new Date(t0 + 60 * MIN).toISOString());
  assert.equal(status().upcoming[0]?.title, "twee");
  await run(t0 + 30 * MIN + 100);
  assert.equal(status().current?.title, "twee");
  // A periodic recompile does not let it through either.
  await run(t0 + 45 * MIN);
  assert.equal(status().current?.title, "twee");
  // 15:00: the new hour plays the changed block.
  await run(t0 + 90 * MIN + 100);
  assert.equal(status().current?.title, "nieuw");
  assert.equal(status().pending, null);

  // Apply now: the change is taken at once.
  assert.equal((await api("PUT", `/api/blocks/${block.id}`, { name: "Uur", items: [{ type: "media", mediaId: id("twee") }, { type: "media", mediaId: id("een") }] })).status, 200);
  await run(t0 + 91 * MIN);
  assert.equal(status().current?.title, "nieuw");
  assert.ok(status().pending);
  assert.equal((await api("POST", `/api/control/${ch.id}/apply-now`)).status, 200);
  await run(t0 + 92 * MIN);
  assert.equal(status().current?.title, "een");
  assert.equal(status().pending, null);
});
