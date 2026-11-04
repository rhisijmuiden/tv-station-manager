import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { displayTitle, lineupHtml, lineupRows, lineupSchema } from "../server/lineuplogic.ts";
import type { Leaf, TimelineEvent } from "../server/timeline.ts";

const MIN = 60_000;

// ---- pure logic ---------------------------------------------------------------

const ev = (start: number, type: TimelineEvent["type"], title: string, leaf: Partial<Leaf> = {}): TimelineEvent => ({
  key: `${start}`,
  scheduleId: 1,
  start,
  end: start + MIN,
  type,
  title,
  programTitle: "Uur",
  offsetMs: 0,
  leaf: type === "filler" ? undefined : ({ type, durationMs: MIN, title, blockKind: "program", blockName: "b", category: "program", ...leaf } as Leaf),
});

test("lineup: only programmes and live items of the coming hour, parts merged", () => {
  const t0 = Date.parse("2026-11-02T12:00:00Z");
  const events = [
    ev(t0, "lineup", ""),
    ev(t0 + 15_000, "media", "Journaal_IJmond"),
    ev(t0 + 5 * MIN, "media", "Reclame Bakker", { blockKind: "commercial" }),
    ev(t0 + 6 * MIN, "media", "Jingle", { category: "jingle" }),
    ev(t0 + 7 * MIN, "beeldkrant", "Nieuws"),
    ev(t0 + 10 * MIN, "media", "Sport Weekoverzicht"),
    ev(t0 + 20 * MIN, "media", "Sport Weekoverzicht"),
    ev(t0 + 25 * MIN, "filler", ""),
    ev(t0 + 30 * MIN, "live", "Raadsvergadering"),
    ev(t0 + 61 * MIN, "media", "Te laat"),
  ];
  const rows = lineupRows(events, t0, { minutesAhead: 60, maxRows: 7 });
  assert.deepEqual(
    rows.map((r) => [(r.start - t0) / 1000, r.title, r.live]),
    [
      [15, "Journaal IJmond", false],
      [600, "Sport Weekoverzicht", false],
      [1800, "Raadsvergadering", true],
    ],
  );
  assert.equal(lineupRows(events, t0, { minutesAhead: 60, maxRows: 2 }).length, 2);
  assert.equal(displayTitle("  Cultuur__Agenda  "), "Cultuur Agenda");
});

test("lineup: page in the station time zone, Dutch and English, escaped", () => {
  const at = Date.parse("2026-11-02T12:00:00Z");
  const rows = [{ start: at + 5 * MIN, title: "Kunst <& Cultuur>", live: false }, { start: at + 30 * MIN, title: "Raad", live: true }];
  const nl = lineupHtml({ channel: "IJmond360", settings: lineupSchema.parse({}), rows, at, timeZone: "Europe/Amsterdam", logoUrl: null });
  assert.match(nl, /Straks op IJmond360/);
  assert.match(nl, /13:05/);
  assert.match(nl, /13:30/);
  assert.match(nl, /Kunst &lt;&amp; Cultuur&gt;/);
  assert.match(nl, /maandag 2 november/i);
  assert.ok(!/<script/.test(nl), "a slide on air has no scripts");
  const en = lineupHtml({ channel: "IJmond360", settings: lineupSchema.parse({ language: "en", heading: "Tonight" }), rows: [], at, timeZone: "Europe/Amsterdam", logoUrl: null });
  assert.match(en, /<h1>Tonight<\/h1>/);
  assert.match(en, /Nothing else is scheduled/);
});

// ---- API, schedule and director ---------------------------------------------------

class FakeSwitcher extends EventEmitter implements SwitcherDriver {
  programIn: number | null = null;
  info(): SwitcherInfo {
    return { connected: true, model: "Fake", productName: "ATEM Fake", mixEffects: 1, inputs: [1, 2].map((id) => ({ id, longName: `In ${id}`, shortName: `${id}`, external: true })), program: [this.programIn], preview: [null] };
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
  graphics: unknown[] = [];
  info() {
    return { connected: true, version: "2.4.3", channels: [1], session: 1 };
  }
  async play(ch: number, layer: number, clip?: string) {
    this.calls.push(`play ${ch}-${layer}${clip ? ` ${clip}` : ""}`);
  }
  async loadbg() {}
  async stop() {}
  async clear() {}
  async playHtml(ch: number, layer: number, url: string) {
    this.calls.push(`html ${ch}-${layer} ${url}`);
  }
  async cgAdd(_c: number, _l: number, _t: string, data: unknown) {
    this.graphics.push(data);
  }
  async cgUpdate(_c: number, _l: number, data: unknown) {
    this.graphics.push(data);
  }
  async cgStop() {}
  async addConsumer() {}
  async removeConsumer() {}
  async close() {}
}

const root = mkdtempSync(join(tmpdir(), "tvsm-lineup-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
const sw = new FakeSwitcher();
const playout = new FakePlayout();
const drivers: DriverFactory = { switcher: () => sw, playout: () => playout };
let cookie = "";
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, headers: res.headers, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body };
};

test.before(async () => {
  p = await createPlatform(managementOptions({ drivers, autostart: false, onReady: (x) => (h = x) }));
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("lineup: slide in an hour block lists the programme files after it and plays on CasparCG", async () => {
  const dir = join(root, "media");
  mkdirSync(join(dir, "Programmas"), { recursive: true });
  mkdirSync(join(dir, "Reclame"), { recursive: true });
  for (const f of ["Programmas/Journaal_IJmond.mp4", "Programmas/Cultuur Agenda.mp4", "Reclame/Bakker.mp4"]) writeFileSync(join(dir, f), "x");
  await api("POST", "/api/media/sources", { name: "Test", type: "local", config: { path: dir } });
  await new Promise((r) => setTimeout(r, 300));
  const media = (await api("GET", "/api/media")).body.items as { id: number; name: string; category: string }[];
  const id = (n: string) => media.find((m) => m.name === n)!.id;
  for (const m of media) assert.equal((await api("PUT", `/api/media/${m.id}`, { category: m.category, durationMs: 10 * MIN })).status, 200);
  assert.equal(media.find((m) => m.name === "Bakker")!.category, "commercial");

  const ads = (await api("POST", "/api/blocks", { name: "Reclame", kind: "commercial", items: [{ type: "media", mediaId: id("Bakker") }] })).body;
  const hour = await api("POST", "/api/blocks", {
    name: "Middaguur",
    items: [{ type: "lineup" }, { type: "media", mediaId: id("Journaal_IJmond") }, { type: "block", childBlockId: ads.id }, { type: "media", mediaId: id("Cultuur Agenda") }, { type: "lineup", durationMs: 20_000 }],
  });
  assert.equal(hour.status, 200, JSON.stringify(hour.body));
  const detail = (await api("GET", `/api/blocks/${hour.body.id}`)).body;
  assert.equal(detail.items[0].type, "lineup");
  assert.equal(detail.items[0].effectiveDurationMs, 15_000);
  assert.equal(detail.items[4].effectiveDurationMs, 20_000);
  assert.equal(detail.block.durationMs, 30 * MIN + 35_000);

  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "Studio", host: "10.40.5.11" });
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId, casparChannel: 1, playoutInput: 1 })).body;
  const t0 = Date.parse("2026-11-02T12:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: hour.body.id, title: "Middaguur" });

  // The page: only the programme files, with the file name as title, in station time.
  const page = String((await api("GET", `/lineup/page.html?channel=${ch.id}&at=${t0}`)).body);
  assert.match(page, /Straks op IJmond360/);
  assert.match(page, /13:00<\/span><span class="n">Journaal IJmond/);
  assert.match(page, /13:20<\/span><span class="n">Cultuur Agenda/);
  assert.ok(!page.includes("Bakker"), "commercials are left out");
  // Settings per channel (Graphics page), and an unsaved preview.
  const g = (await api("GET", "/api/channels")).body.channels[0].graphics;
  assert.equal(g.lineup.minutesAhead, 60);
  assert.equal((await api("PUT", `/api/channels/${ch.id}/graphics`, { ...g, lineup: { ...g.lineup, language: "en", minutesAhead: 10 } })).status, 200);
  const en = String((await api("GET", `/lineup/page.html?channel=${ch.id}&at=${t0}`)).body);
  assert.match(en, /Coming up on IJmond360/);
  assert.ok(en.includes("Journaal IJmond") && !en.includes("Cultuur Agenda"));
  const preRes = await api("GET", `/lineup/page.html?channel=${ch.id}&at=${t0}&preview=1&settings=${encodeURIComponent(JSON.stringify({ heading: "Vanmiddag" }))}`);
  assert.equal(preRes.headers["x-frame-options"], "SAMEORIGIN", "the editor shows it in an iframe");
  const pre = String(preRes.body);
  assert.match(pre, /<h1>Vanmiddag<\/h1>/);
  assert.match(pre, /class="preview"/);
  assert.equal((await api("GET", "/lineup/page.html?channel=999")).status, 404);

  // On air: the slide is a web page on the playout layer, the channel overlay steps aside.
  await api("POST", `/api/control/${ch.id}/automation`, { on: true });
  h.director.now = () => t0 + 2000;
  h.director.invalidate();
  await h.director.tick();
  assert.ok(playout.calls.some((c) => new RegExp(`^html 1-10 http://.+/lineup/page\\.html\\?channel=${ch.id}&at=${t0}$`).test(c)), playout.calls.join("\n"));
  assert.equal(sw.programIn, 1);
  assert.equal((playout.graphics.at(-1) as { hidden: boolean }).hidden, true);
  assert.equal((await api("GET", "/api/control")).body.channels[0].current.type, "lineup");
  h.director.now = () => t0 + 20_000;
  await h.director.tick();
  assert.ok(playout.calls.some((c) => c.startsWith("play 1-10 Programmas/Journaal_IJmond")), playout.calls.join("\n"));
});
