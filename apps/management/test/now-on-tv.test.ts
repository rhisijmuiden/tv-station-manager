import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { owncastGuess, previewKind } from "../server/preview.ts";
import { programAt, type TimelineEvent } from "../server/timeline.ts";

// Dashboard "Now on TV": the hour block on air with its items, and the stream preview per channel.

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

const root = mkdtempSync(join(tmpdir(), "tvsm-now-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
const sw = new FakeSwitcher();
const drivers: DriverFactory = { switcher: () => sw, playout: () => new FakePlayout() };

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
const ev = (scheduleId: number | null, startMin: number, endMin: number, title: string, programTitle = "", type: TimelineEvent["type"] = "media"): TimelineEvent => ({
  key: scheduleId == null ? `filler:${startMin}` : `${scheduleId}:${startMin}`,
  scheduleId,
  start: startMin * MIN,
  end: endMin * MIN,
  type: scheduleId == null ? "filler" : type,
  title,
  programTitle,
  offsetMs: 0,
});

test("programAt: all parts of an hour block (same occurrence), with the gaps inside it", () => {
  // 07:00 news (fixed part), 07:05-07:40 programme window, a gap, 07:55 ads (fixed part), 08:00 the next hour block.
  const events = [
    ev(null, 0, 60, ""),
    ev(1, 60, 65, "Nieuws", "Nieuws"),
    ev(2, 65, 85, "Reportage A", "Sport"),
    ev(2, 85, 100, "Reportage B", "Sport"),
    ev(null, 100, 115, ""),
    ev(3, 115, 120, "Reclame", "Reclame"),
    ev(4, 120, 125, "Nieuws", "Nieuws"),
  ];
  const info = (id: number) => (id <= 3 ? { group: "slot1:2026-11-02", inEpg: id === 2 } : { group: "slot1:2026-11-02b", inEpg: false });
  const p = programAt(events, 90 * MIN, info)!;
  assert.equal(p.title, "Sport"); // the programme title, not the fixed news part
  assert.deepEqual(p.items.map((e) => e.title), ["Nieuws", "Reportage A", "Reportage B", "", "Reclame"]);
  assert.equal(p.index, 2);
  assert.equal(p.start, 60 * MIN);
  assert.equal(p.end, 120 * MIN);
  // Without an occurrence (manual entry) only the entry itself is the block; filler outside a block is no block.
  const manual = programAt(events, 90 * MIN, () => ({ group: null, inEpg: true }))!;
  assert.deepEqual(manual.items.map((e) => e.title), ["Reportage A", "Reportage B"]);
  assert.equal(programAt(events, 30 * MIN, info), null);
  // Long blocks are capped around the current item.
  const many = Array.from({ length: 100 }, (_, i) => ev(9, i, i + 1, `#${i}`, "Lang"));
  const capped = programAt(many, 50.5 * MIN, () => ({ group: null, inEpg: true }), 10)!;
  assert.equal(capped.items.length, 10);
  assert.equal(capped.items[capped.index]!.title, "#50");
  assert.equal(capped.index, 3);
});

test("preview: Owncast guess from an RTMP server, player kind", () => {
  assert.equal(owncastGuess("rtmp://10.40.6.30:1935/live"), "http://10.40.6.30:8080/embed/video");
  assert.equal(owncastGuess("rtmps://user:pw@stream.ijmond360.nl/live"), "http://stream.ijmond360.nl:8080/embed/video");
  assert.equal(owncastGuess("srt://x"), null);
  assert.equal(previewKind("https://cdn.example.org/hls/stream.m3u8?x=1"), "video");
  assert.equal(previewKind("http://10.40.6.30:8080/embed/video"), "page");
});

test("now on TV: /api/control shows the block, its items and the next programme; preview URL per channel", async () => {
  const media = join(root, "media");
  mkdirSync(media, { recursive: true });
  for (const n of ["intro", "item1", "item2", "next"]) writeFileSync(join(media, `${n}.mp4`), "x");
  await api("POST", "/api/media/sources", { name: "Test", type: "local", config: { path: media } });
  await new Promise((r) => setTimeout(r, 300));
  const items = (await api("GET", "/api/media")).body.items as { id: number; name: string }[];
  const id = (n: string) => items.find((m) => m.name === n)!.id;
  for (const m of items) await api("PUT", `/api/media/${m.id}`, { category: "program", durationMs: 10 * MIN });
  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "Studio", host: "10.40.5.11" });
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId, casparChannel: 1, playoutInput: 1 })).body;
  const mk = async (name: string, ms: string[]) => (await api("POST", "/api/blocks", { name, items: ms.map((n) => ({ type: "media", mediaId: id(n) })) })).body.id as number;
  const show = await mk("Avondshow", ["intro", "item1", "item2"]);
  const nxt = await mk("Late", ["next"]);
  const t0 = Date.parse("2026-11-02T19:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: show, title: "Avondshow" });
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0 + 30 * MIN).toISOString(), blockId: nxt, title: "Laat" });
  h.director.now = () => t0 + 14 * MIN;
  h.director.invalidate();
  await h.director.tick();
  const c = (await api("GET", "/api/control")).body.channels[0];
  assert.equal(c.current.title, "item1");
  assert.equal(c.program.title, "Avondshow");
  assert.equal(c.program.index, 1);
  assert.deepEqual(c.program.items.map((e: { title: string }) => e.title), ["intro", "item1", "item2"]);
  assert.equal(c.program.endAt, new Date(t0 + 30 * MIN).toISOString());
  assert.deepEqual(c.program.next, { title: "Laat", startAt: new Date(t0 + 30 * MIN).toISOString() });

  // Preview: suggested from the channel's stream output to an own RTMP server, then set by an editor.
  const dest = (await api("POST", "/api/stream-destinations", { name: "Owncast", platform: "custom", url: "rtmp://10.40.6.30:1935/live", streamKey: "abcd1234" })).body;
  assert.equal((await api("POST", "/api/stream-outputs", { name: "Website", source: "channel", studioId, casparChannel: 1, destinationIds: [dest.id] })).status, 200);
  let pv = (await api("GET", "/api/dashboard/previews")).body.previews[0];
  assert.deepEqual(pv, { channelId: ch.id, url: null, kind: null, suggestion: "http://10.40.6.30:8080/embed/video" });
  assert.equal((await api("PUT", `/api/dashboard/previews/${ch.id}`, { url: "javascript:alert(1)" })).status, 400);
  assert.equal((await api("PUT", `/api/dashboard/previews/${ch.id}`, { url: "http://10.40.6.30:8080/embed/video" })).status, 200);
  pv = (await api("GET", "/api/dashboard/previews")).body.previews[0];
  assert.equal(pv.url, "http://10.40.6.30:8080/embed/video");
  assert.equal(pv.kind, "page");
  assert.equal(pv.suggestion, null);
  assert.equal((await api("PUT", `/api/dashboard/previews/${ch.id}`, { url: "" })).status, 200);
  assert.equal((await api("GET", "/api/dashboard/previews")).body.previews[0].url, null);
});
