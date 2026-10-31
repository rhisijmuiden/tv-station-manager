import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { guessCategory, parseProbe, parseSmbListing } from "../server/media.ts";
import { compile, expandBlock, BlockCycleError, casparClip, type Loader } from "../server/timeline.ts";
import { toXmltv } from "../server/epg.ts";

// ---- pure logic ---------------------------------------------------------------

const loader = (): Loader => {
  const media = new Map([
    [1, { id: 1, name: "News", title: null, path: "Programmas/News.mp4", durationMs: 10 * 60_000, fps: 25, category: "program", missing: false }],
    [2, { id: 2, name: "Ad A", title: null, path: "Reclame/A.mov", durationMs: 30_000, fps: 25, category: "commercial", missing: false }],
    [3, { id: 3, name: "Ad B", title: null, path: "Reclame/B.mov", durationMs: 30_000, fps: 25, category: "commercial", missing: false }],
  ]);
  const blocks = new Map([
    [10, { id: 10, name: "Ad break", kind: "commercial" as const, items: [2, 3].map((m) => ({ type: "media" as const, mediaId: m, childBlockId: null, liveSourceId: null, durationMs: null, title: null })) }],
    [
      11,
      {
        id: 11,
        name: "Evening",
        kind: "program" as const,
        items: [
          { type: "media" as const, mediaId: 1, childBlockId: null, liveSourceId: null, durationMs: null, title: null },
          { type: "block" as const, mediaId: null, childBlockId: 10, liveSourceId: null, durationMs: null, title: null },
          { type: "live" as const, mediaId: null, childBlockId: null, liveSourceId: 5, durationMs: 5 * 60_000, title: "Studio" },
        ],
      },
    ],
    [12, { id: 12, name: "Loop", kind: "program" as const, items: [{ type: "block" as const, mediaId: null, childBlockId: 12, liveSourceId: null, durationMs: null, title: null }] }],
  ]);
  return { block: (id) => blocks.get(id), media: (id) => media.get(id), live: (id) => (id === 5 ? { id: 5, name: "Cam", kind: "atem" } : undefined) };
};

test("timeline: nested blocks expand, cycles are detected", () => {
  const l = loader();
  const leaves = expandBlock(l, 11);
  assert.deepEqual(leaves.map((x) => x.title), ["News", "Ad A", "Ad B", "Studio"]);
  assert.equal(leaves[1]!.blockKind, "commercial");
  assert.equal(leaves.reduce((s, x) => s + x.durationMs, 0), 16 * 60_000);
  assert.throws(() => expandBlock(l, 12), BlockCycleError);
});

test("timeline: hard starts cut overruns, gaps become filler", () => {
  const l = loader();
  const t0 = Date.parse("2026-11-01T18:00:00Z");
  const { events, entries } = compile(
    l,
    [
      { id: 1, channelId: 1, start: t0, blockId: 11, title: null, description: null, inEpg: true },
      { id: 2, channelId: 1, start: t0 + 12 * 60_000, blockId: 10, title: null, description: null, inEpg: true }, // cuts the live item
      { id: 3, channelId: 1, start: t0 + 20 * 60_000, blockId: 10, title: null, description: null, inEpg: true },
    ],
    t0 - 60_000,
    t0 + 30 * 60_000,
  );
  assert.deepEqual(events.map((e) => e.type), ["filler", "media", "media", "media", "live", "media", "media", "filler", "media", "media", "filler"]);
  const live = events.find((e) => e.type === "live")!;
  assert.equal(live.end, t0 + 12 * 60_000);
  assert.equal(entries[0]!.overrunMs, 4 * 60_000);
  assert.equal(entries[1]!.gapAfterMs, 7 * 60_000);
  // A window starting in the middle of an item keeps the offset (used to seek).
  const mid = compile(l, [{ id: 1, channelId: 1, start: t0, blockId: 11, title: null, description: null, inEpg: true }], t0 + 60_000, t0 + 120_000).events[0]!;
  assert.equal(mid.offsetMs, 60_000);
  assert.equal(casparClip("Programmas\\News.mp4"), "Programmas/News");
});

test("media: smbclient listing, ffprobe output, categories", () => {
  const out = [
    "  .                                   D        0  Sat Oct 31 12:00:00 2026",
    "  Programmas                          D        0  Sat Oct 31 12:00:00 2026",
    "  intro.mp4                           A  1048576  Sat Oct 31 12:00:00 2026",
    "",
    "\\TV\\Programmas",
    "  Het Journaal 1.mov                  A 734003200  Fri Oct 30 09:15:42 2026",
    "  notes.txt                           A      120  Fri Oct 30 09:15:42 2026",
    "",
    "\t\t30536690 blocks of size 1024. 26543213 blocks available",
  ].join("\n");
  const files = parseSmbListing(out, "TV");
  assert.deepEqual(files.map((f) => f.path), ["intro.mp4", "Programmas/Het Journaal 1.mov"]);
  assert.equal(files[1]!.size, 734003200);
  const p = parseProbe(JSON.stringify({ format: { duration: "1800.040000" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "25/1" }] }));
  assert.deepEqual(p, { durationMs: 1800040, fps: 25, width: 1920, height: 1080, codec: "h264" });
  assert.equal(guessCategory("Reclame/2026/spot.mp4"), "commercial");
  assert.equal(guessCategory("Jingles/x.mov"), "jingle");
  assert.equal(guessCategory("Series/Ad Astra.mp4"), "program");
});

test("epg: xmltv escapes and formats times", () => {
  const x = toXmltv([{ id: 1, name: "TV <1>" }], [{ channelId: 1, start: Date.parse("2026-11-01T18:00:00Z"), end: Date.parse("2026-11-01T18:30:00Z"), title: "News & Weather", description: null, genre: "News" }]);
  assert.match(x, /<programme start="20261101180000 \+0000" stop="20261101183000 \+0000" channel="tvsm.1">/);
  assert.match(x, /News &amp; Weather/);
  assert.match(x, /TV &lt;1&gt;/);
});

// ---- director end to end with fake devices ---------------------------------------

class FakeSwitcher extends EventEmitter implements SwitcherDriver {
  programIn: number | null = null;
  calls: string[] = [];
  info(): SwitcherInfo {
    return { connected: true, model: "Fake", productName: "ATEM Fake", mixEffects: 1, inputs: [1, 2, 3].map((id) => ({ id, longName: `In ${id}`, shortName: `${id}`, external: true })), program: [this.programIn], preview: [null] };
  }
  async program(input: number, me: number, t: string) {
    this.programIn = input;
    this.calls.push(`program ${input} me${me} ${t}`);
  }
  async preview() {}
  async cut() {}
  async auto() {}
  async close() {}
}
class FakePlayout extends EventEmitter implements PlayoutDriver {
  calls: string[] = [];
  info() {
    return { connected: true, version: "2.4.0" };
  }
  async play(ch: number, layer: number, clip?: string, o: { loop?: boolean; seek?: number } = {}) {
    this.calls.push(`play ${ch}-${layer}${clip ? ` ${clip}` : ""}${o.loop ? " loop" : ""}${o.seek ? ` seek ${o.seek}` : ""}`);
  }
  async loadbg(ch: number, layer: number, clip: string) {
    this.calls.push(`loadbg ${ch}-${layer} ${clip}`);
  }
  async stop(ch: number, layer: number) {
    this.calls.push(`stop ${ch}-${layer}`);
  }
  async clear() {}
  async cgAdd(ch: number, layer: number, template: string) {
    this.calls.push(`cgadd ${ch}-${layer} ${template}`);
  }
  async cgUpdate(ch: number, layer: number) {
    this.calls.push(`cgupdate ${ch}-${layer}`);
  }
  async cgStop() {}
  async close() {}
}

const root = mkdtempSync(join(tmpdir(), "tvsm-mgmt-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
const sw = new FakeSwitcher();
const po = new FakePlayout();
const drivers: DriverFactory = { switcher: () => sw, playout: () => po };
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

test("roles: operators cannot edit content or system settings", async () => {
  assert.equal((await api("POST", "/api/users", { username: "ops", password: "operator-pass-1", role: "operator" })).status, 200);
  assert.equal((await api("POST", "/api/users", { username: "chief", password: "editor-pass-12", role: "editor" })).status, 200);
  const admin = cookie;
  cookie = "";
  await api("POST", "/api/auth/login", { username: "ops", password: "operator-pass-1" });
  assert.equal((await api("POST", "/api/blocks", { name: "x" })).status, 403);
  assert.equal((await api("GET", "/api/settings/mail")).status, 403);
  assert.equal((await api("GET", "/api/blocks")).status, 200);
  cookie = "";
  await api("POST", "/api/auth/login", { username: "chief", password: "editor-pass-12" });
  assert.equal((await api("POST", "/api/blocks", { name: "ok" })).status, 200);
  assert.equal((await api("POST", "/api/atems", { name: "a", host: "10.0.0.1" })).status, 403);
  cookie = admin;
});

test("director: plays the schedule on CasparCG and switches the ATEM", async () => {
  const media = join(root, "media");
  mkdirSync(join(media, "Reclame"), { recursive: true });
  writeFileSync(join(media, "show.mp4"), "x");
  writeFileSync(join(media, "show.srt"), "1\n00:00:00,500 --> 00:00:02,000\nWelkom\n");
  writeFileSync(join(media, "Reclame", "spot.mp4"), "x");
  // Local source; durations are set by hand because the files are not real video.
  const src = await api("POST", "/api/media/sources", { name: "Test", type: "local", config: { path: media } });
  assert.equal(src.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const list = await api("GET", "/api/media");
  assert.equal(list.body.total, 2);
  const show = list.body.items.find((m: { name: string }) => m.name === "show");
  const spot = list.body.items.find((m: { name: string }) => m.name === "spot");
  assert.equal(spot.category, "commercial");
  await api("PUT", `/api/media/${show.id}`, { category: "program", durationMs: 60_000 });
  await api("PUT", `/api/media/${spot.id}`, { category: "commercial", durationMs: 20_000 });

  assert.equal((await api("POST", "/api/atems", { name: "Main ATEM", host: "10.40.6.50" })).status, 200);
  assert.equal((await api("POST", "/api/studios", { name: "Studio 1", host: "10.40.6.60" })).status, 200);
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const ch = await api("POST", "/api/channels", { name: "TV 1", atemId, studioId, casparChannel: 1, playoutInput: 1, fallbackInput: 3 });
  assert.equal(ch.status, 200);

  const ads = await api("POST", "/api/blocks", { name: "Ads", kind: "commercial", items: [{ type: "media", mediaId: spot.id }] });
  const blk = await api("POST", "/api/blocks", { name: "Evening show", items: [{ type: "media", mediaId: show.id }, { type: "block", childBlockId: ads.body.id }] });
  assert.equal((await api("PUT", `/api/blocks/${ads.body.id}`, { name: "Ads", kind: "commercial", items: [{ type: "block", childBlockId: blk.body.id }] })).body.error, "block_cycle");

  const t0 = Date.parse("2026-11-01T20:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.body.id, startAt: new Date(t0).toISOString(), blockId: blk.body.id, title: "Avondshow" });
  const sched = await api("GET", `/api/schedule?channel=${ch.body.id}&from=${new Date(t0 - 3600_000).toISOString()}&to=${new Date(t0 + 3600_000).toISOString()}`);
  assert.equal(sched.body.entries[0].programTitle, "Avondshow");
  assert.equal(Date.parse(sched.body.entries[0].endAt) - t0, 80_000);

  await api("POST", `/api/control/${ch.body.id}/automation`, { on: true });
  const d = h.director;
  const run = async (t: number) => {
    d.now = () => t;
    await d.tick();
  };
  await run(t0 - 10_000); // gap before the show: fallback input
  assert.equal(sw.programIn, 3);
  await run(t0 - 2000); // preload
  assert.ok(po.calls.includes("loadbg 1-10 show"));
  await run(t0 + 100);
  assert.ok(po.calls.includes("play 1-10"), po.calls.join("\n"));
  assert.equal(sw.programIn, 1);
  // Subtitles: sidecar show.srt found by the scan, timed from the clip's first frame.
  assert.equal(show.subtitlePath, "show.srt");
  const subs = d.status(p.ctx.db.prepare("SELECT * FROM channels").get() as never).graphics.subtitles;
  assert.equal(subs.enabled, true);
  assert.equal(subs.clipStart, t0);
  const cues = await api("GET", new URL(subs.url).pathname);
  assert.deepEqual(cues.body.cues, [{ s: 500, e: 2000, t: "Welkom" }]);
  await run(t0 + 61_000); // in the ad break: logo hidden
  assert.equal(d.status((p.ctx.db.prepare("SELECT * FROM channels").get() as never)).graphics.hidden, true);
  po.calls.length = 0;
  await run(t0 + 30_000); // jump back: seek into the clip
  assert.ok(po.calls.some((c) => c === "play 1-10 show seek 750"), po.calls.join("\n"));

  const asrun = await api("GET", `/api/asrun?channel=${ch.body.id}&from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z`);
  assert.ok(asrun.body.items.some((i: { title: string }) => i.title === "spot"));

  const settings = await api("GET", "/api/management/settings");
  const epg = await api("GET", `/epg/xmltv.xml?token=${settings.body.epgToken}`);
  assert.equal(epg.status, 200);
  assert.equal((await api("GET", "/epg/xmltv.xml?token=wrong")).status, 403);
});

test("subtitles: parse srt/vtt, match sidecar files, decode windows-1252", async () => {
  const { parseSubtitles, matchSubtitles } = await import("../server/subtitles.ts");
  const { decodeText } = await import("../server/media.ts");
  const srt = "\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Hallo</i> daar\r\nTweede regel\r\n\r\n2\r\n00:01:02,25 --> 00:01:04,000\r\nKlaar\r\n\r\n3\r\nbroken\r\n";
  assert.deepEqual(parseSubtitles(srt), [
    { s: 1000, e: 3500, t: "Hallo daar\nTweede regel" },
    { s: 62250, e: 64000, t: "Klaar" },
  ]);
  const vtt = "WEBVTT\n\nNOTE x\n\nintro\n00:05.000 --> 00:06.000 align:center\nVTT cue\n\n01:00:00.000 --> 01:00:01.000\nLate";
  assert.deepEqual(parseSubtitles(vtt), [
    { s: 5000, e: 6000, t: "VTT cue" },
    { s: 3600_000, e: 3601_000, t: "Late" },
  ]);
  const m = matchSubtitles(["Programmas/Journaal.mp4", "Programmas/Film.mov", "Reclame/A.mov"], ["programmas/JOURNAAL.en.srt", "Programmas/Journaal.nl.srt", "Programmas/Film.vtt", "Programmas/Film.srt", "Other.srt"]);
  assert.equal(m.get("Programmas/Journaal.mp4"), "Programmas/Journaal.nl.srt");
  assert.equal(m.get("Programmas/Film.mov"), "Programmas/Film.srt");
  assert.equal(m.has("Reclame/A.mov"), false);
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])), "café");
  assert.equal(decodeText(Buffer.from("café", "utf8")), "café");
  const listing = parseSmbListing("\\TV\r\n  Show.mp4    A 10  Fri Oct 30 09:15:42 2026\r\n  Show.srt    A 2  Fri Oct 30 09:15:42 2026\r\n", "TV");
  assert.deepEqual(listing.map((f) => f.path), ["Show.mp4", "Show.srt"]);
});
