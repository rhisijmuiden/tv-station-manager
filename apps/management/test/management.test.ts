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
import { destinationUrl, encoderArgs, maskedUrl } from "../server/outputs.ts";

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
  channels: number[] | null = null;
  session = 1;
  info() {
    return { connected: true, version: "2.4.0", channels: this.channels, session: this.session };
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
  async clear(ch: number, layer?: number) {
    this.calls.push(`clear ${ch}-${layer}`);
  }
  async playHtml(ch: number, layer: number, url: string) {
    this.calls.push(`html ${ch}-${layer} ${url}`);
  }
  async cgAdd(ch: number, layer: number, template: string) {
    this.calls.push(`cgadd ${ch}-${layer} ${template}`);
  }
  async cgUpdate(ch: number, layer: number) {
    this.calls.push(`cgupdate ${ch}-${layer}`);
  }
  async cgStop() {}
  async addConsumer(ch: number, index: number, consumer: string, params: string) {
    this.calls.push(`add ${ch}-${index} ${consumer} ${params}`);
  }
  async removeConsumer(ch: number, index: number) {
    this.calls.push(`remove ${ch}-${index}`);
  }
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

test("remote sources: own stream key, ingest auth, DeckLink output follows the stream", async () => {
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const add = await api("POST", "/api/live-sources", { name: "Reporter Zandvoort", kind: "rtmp", atemInput: 2, studioId, casparChannel: 2 });
  assert.equal(add.status, 200);
  let src = (await api("GET", "/api/live-sources")).body.sources.find((x: { id: number }) => x.id === add.body.id);
  assert.equal(src.mode, "push");
  assert.match(src.push.streamKey, /^reporter-zandvoort-[0-9a-f]{24}$/);
  assert.equal(src.push.rtmpServer, "rtmp://10.40.6.60/live");
  assert.equal(src.push.srtUrl, `srt://10.40.6.60:8890?streamid=publish:live/${src.push.streamKey}`);
  assert.equal(src.status.state, "unknown");

  // MediaMTX asks this node: only the right key may publish, only the node itself may read.
  const auth = (b: object) => api("POST", "/ingest/auth", b).then((r) => r.status);
  const saved = cookie;
  cookie = "";
  assert.equal(await auth({ action: "publish", path: `live/${src.push.streamKey}`, ip: "203.0.113.9", protocol: "rtmp" }), 200);
  assert.equal(await auth({ action: "publish", path: "live/reporter-zandvoort-000000000000000000000000", ip: "203.0.113.9" }), 401);
  assert.equal(await auth({ action: "read", path: `live/${src.push.streamKey}`, ip: "127.0.0.1" }), 200);
  assert.equal(await auth({ action: "read", path: `live/${src.push.streamKey}`, ip: "10.40.6.99" }), 401);
  assert.equal(await auth({ action: "api", ip: "10.40.6.202", user: "tvsm-management", password: "nope" }), 401);
  assert.equal(await auth({ action: "api", ip: "10.40.6.202", user: "tvsm-management", password: h.remote.apiToken() }), 200);
  cookie = saved;

  // Fake MediaMTX API on the studio node.
  let online = false;
  let onlineTime = "2026-11-01T20:00:00Z";
  let bytes = 0;
  const seen: string[] = [];
  h.remote.fetcher = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push(`${url} ${init.headers.authorization}`);
    const items = online ? [{ name: `live/${src.push.streamKey}`, online: true, onlineTime, tracks2: [{ codec: "H264" }, { codec: "MPEG-4 Audio" }], readers: [], inboundBytes: bytes }] : [];
    return new Response(JSON.stringify({ items }), { headers: { "content-type": "application/json" } });
  }) as never;
  await h.remote.poll();
  assert.ok(seen[0]!.startsWith("http://10.40.6.60:9997/v3/paths/list"));
  assert.equal(seen[0]!.split(" ").slice(1).join(" "), `Basic ${Buffer.from(`tvsm-management:${h.remote.apiToken()}`).toString("base64")}`);
  src = (await api("GET", "/api/live-sources")).body.sources.find((x: { id: number }) => x.id === add.body.id);
  assert.equal(src.status.state, "waiting");

  // Routed before the stream arrives: CasparCG starts it as soon as it comes in, and again after a reconnect.
  po.calls.length = 0;
  assert.equal((await api("POST", `/api/live-sources/${src.id}/output`, { on: true })).status, 200);
  assert.deepEqual(po.calls, ["stop 2-10"]);
  online = true;
  await h.remote.poll();
  const url = `play 2-10 rtmp://127.0.0.1/live/${src.push.streamKey}`;
  assert.deepEqual(po.calls.slice(1), [url]);
  bytes = 3_000_000;
  await h.remote.poll();
  assert.equal(po.calls.filter((c) => c === url).length, 1);
  src = (await api("GET", "/api/live-sources")).body.sources.find((x: { id: number }) => x.id === add.body.id);
  assert.equal(src.status.state, "live");
  assert.deepEqual(src.status.tracks, ["H264", "MPEG-4 Audio"]);
  assert.equal(src.onOutput, true);
  onlineTime = "2026-11-01T20:05:00Z"; // the contributor reconnected
  await h.remote.poll();
  assert.equal(po.calls.filter((c) => c === url).length, 2);
  po.session++; // CasparCG restarted and lost its layers
  await h.remote.poll();
  assert.equal(po.calls.filter((c) => c === url).length, 3);
  await h.remote.poll();
  assert.equal(po.calls.filter((c) => c === url).length, 3);

  // Taking it live in the control room switches the ATEM to the input of that DeckLink output.
  const chId = (await api("GET", "/api/channels")).body.channels[0].id;
  assert.equal((await api("POST", `/api/control/${chId}/live`, { liveSourceId: src.id })).status, 200);
  assert.equal(sw.programIn, 2);
  await api("POST", `/api/control/${chId}/resume`);
  assert.ok(po.calls.includes("stop 2-10"));
  assert.equal((await api("GET", "/api/live-sources")).body.sources.find((x: { id: number }) => x.id === add.body.id).onOutput, false);

  // A studio node with one DeckLink output: output 2 cannot be chosen or started.
  po.channels = [1];
  const bad = await api("POST", "/api/live-sources", { name: "Wrong output", kind: "rtmp", atemInput: 2, studioId, casparChannel: 2 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "no_such_output");
  const out = await api("POST", `/api/live-sources/${src.id}/output`, { on: true });
  assert.equal(out.status, 502);
  assert.match(out.body.message, /DeckLink output 2 does not exist/);
  // Identify outputs: a numbered test card on every output, removed again on stop.
  po.channels = [1, 2];
  po.calls.length = 0;
  const idf = await api("POST", `/api/studios/${studioId}/identify`, { on: true });
  assert.equal(idf.status, 200);
  assert.deepEqual(idf.body.channels, [1, 2]);
  assert.ok(po.calls.some((c) => c.startsWith("html 2-90 ") && c.includes("/graphics/identify?n=2&of=2")), po.calls.join("\n"));
  assert.ok((await api("GET", "/api/studios")).body.studios[0].identifyUntil);
  const card = await api("GET", "/graphics/identify?n=2&of=2&node=Studio%20%3Cb%3E");
  assert.match(card.body, /UITGANG 2/);
  assert.ok(!card.body.includes("<b>"));
  await api("POST", `/api/studios/${studioId}/identify`, { on: false });
  assert.ok(po.calls.includes("clear 1-90") && po.calls.includes("clear 2-90"));
  po.channels = null;

  // A new key revokes the old one.
  const oldKey = src.push.streamKey;
  await api("POST", `/api/live-sources/${src.id}/new-key`);
  cookie = "";
  assert.equal(await auth({ action: "publish", path: `live/${oldKey}`, ip: "203.0.113.9" }), 401);
  cookie = saved;
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

// ---- stream output ------------------------------------------------------------------

test("stream output: encoder args and destination urls", () => {
  const a = encoderArgs({ encoder: "x264", video_kbps: 4500, audio_kbps: 160, resolution: "720p", deinterlace: 1, extra_args: "" });
  assert.equal(a, "-format flv -filter:v yadif=0:-1:0,scale=1280:720,format=yuv420p -codec:v libx264 -preset:v veryfast -tune:v zerolatency -b:v 4500k -maxrate:v 4500k -bufsize:v 9000k -g:v 50 -codec:a aac -b:a 160k");
  assert.match(encoderArgs({ encoder: "nvenc", video_kbps: 6000, audio_kbps: 128, resolution: "source", deinterlace: 0, extra_args: "-profile:v high" }), /^-format flv -filter:v format=yuv420p -codec:v h264_nvenc .* -profile:v high$/);
  assert.equal(destinationUrl({ platform: "youtube", url: "", stream_key: "abcd-1234" }), "rtmp://a.rtmp.youtube.com/live2/abcd-1234");
  assert.equal(destinationUrl({ platform: "custom", url: "rtmp://stream.example.org/live/", stream_key: "" }), "rtmp://stream.example.org/live");
  assert.equal(maskedUrl({ platform: "facebook", url: "", stream_key: "FB-1234567890" }), "rtmps://live-api-s.facebook.com:443/rtmp/••••7890");
});

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  constructor(public args: string[]) {
    super();
  }
  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0);
    return true;
  }
}

test("stream output: channel encoder on CasparCG, one relay per destination, remote sources forwarded as is", async () => {
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const procs: FakeProc[] = [];
  h.outputs.spawner = ((_cmd: string, args: string[]) => {
    const pr = new FakeProc(args);
    procs.push(pr);
    return pr;
  }) as never;
  let paths: object[] = [];
  h.remote.fetcher = (async () => new Response(JSON.stringify({ items: paths }), { headers: { "content-type": "application/json" } })) as never;

  // Destinations: the key is never sent back to the browser.
  const yt = await api("POST", "/api/stream-destinations", { name: "YouTube", platform: "youtube", streamKey: "yt-secret-key-9876" });
  assert.equal(yt.status, 200);
  const own = await api("POST", "/api/stream-destinations", { name: "Website", platform: "custom", url: "rtmp://stream.example.org/live/tv" });
  assert.equal((await api("POST", "/api/stream-destinations", { name: "Bad", platform: "custom" })).status, 400);
  let list = (await api("GET", "/api/stream-outputs")).body;
  assert.ok(!JSON.stringify(list).includes("yt-secret-key-9876"));
  assert.equal(list.destinations.find((d: { id: number }) => d.id === yt.body.id).masked, "rtmp://a.rtmp.youtube.com/live2/••••9876");
  // Updating without a key keeps it.
  assert.equal((await api("PUT", `/api/stream-destinations/${yt.body.id}`, { name: "YouTube kanaal", platform: "youtube" })).status, 200);

  const add = await api("POST", "/api/stream-outputs", { name: "Website stream", source: "channel", studioId, casparChannel: 1, destinationIds: [yt.body.id, own.body.id], extraArgs: "" });
  assert.equal(add.status, 200);
  assert.equal((await api("POST", "/api/stream-outputs", { name: "x", source: "channel", studioId, casparChannel: 1, extraArgs: "-x \"; rm" })).status, 400);
  const oid = add.body.id as number;
  const path = `program/out-${oid}`;

  // Only CasparCG on the studio node itself may publish the programme stream.
  const auth = (b: object) => api("POST", "/ingest/auth", b).then((r) => r.status);
  assert.equal(await auth({ action: "publish", path, ip: "127.0.0.1" }), 200);
  assert.equal(await auth({ action: "publish", path, ip: "203.0.113.9" }), 401);
  assert.equal(await auth({ action: "publish", path: "program/out-9999", ip: "127.0.0.1" }), 401);
  assert.equal(await auth({ action: "read", path, ip: "10.40.6.202", user: "tvsm-management", password: h.remote.apiToken() }), 200);
  assert.equal(await auth({ action: "read", path, ip: "10.40.6.202", user: "tvsm-management", password: "wrong" }), 401);

  // Start: CasparCG gets the encoder; the relays wait until the stream shows up on the ingest server.
  po.calls.length = 0;
  assert.equal((await api("POST", `/api/stream-outputs/${oid}/active`, { on: true })).status, 200);
  await h.remote.poll();
  const idx = 700 + oid;
  assert.equal(po.calls[0], `remove 1-${idx}`);
  assert.equal(po.calls[1], `add 1-${idx} STREAM rtmp://127.0.0.1:1935/${path} ${encoderArgs({ encoder: "x264", video_kbps: 4500, audio_kbps: 160, resolution: "source", deinterlace: 1, extra_args: "" })}`);
  let o = (await api("GET", "/api/stream-outputs")).body.outputs.find((x: { id: number }) => x.id === oid);
  assert.equal(o.status.state, "waiting");
  assert.equal(o.status.reason, "encoder_starting");
  assert.equal(procs.length, 0);

  paths = [{ name: path, online: true, onlineTime: "2026-11-01T21:00:00Z", tracks2: [{ codec: "H264" }], readers: [], inboundBytes: 1 }];
  await h.remote.poll();
  assert.equal(procs.length, 2);
  const src = `rtmp://10.40.6.60:1935/${path}?user=tvsm-management&pass=${h.remote.apiToken()}`;
  assert.ok(procs.every((x) => x.args[x.args.indexOf("-i") + 1] === src));
  assert.deepEqual(procs.map((x) => x.args.at(-1)).sort(), ["rtmp://a.rtmp.youtube.com/live2/yt-secret-key-9876", "rtmp://stream.example.org/live/tv"]);
  assert.ok(procs[0]!.args.includes("copy"));
  await h.remote.poll();
  assert.equal(procs.length, 2, "no second relay while one runs");
  assert.equal(po.calls.filter((c) => c.startsWith("add ")).length, 1);

  procs[0]!.stdout.emit("data", Buffer.from("bitrate=4512.3kbits/s\ntotal_size=10240\nprogress=continue\n"));
  procs[1]!.stdout.emit("data", Buffer.from("total_size=2048\n"));
  o = (await api("GET", "/api/stream-outputs")).body.outputs.find((x: { id: number }) => x.id === oid);
  assert.equal(o.status.state, "live");
  assert.ok(o.status.destinations.some((d: { kbps: number | null }) => d.kbps === 4512));

  // A failing destination retries with the error shown, without the stream key; the other keeps running.
  const ytProc = procs.find((x) => x.args.at(-1)!.includes("youtube"))!;
  ytProc.stderr.emit("data", Buffer.from("rtmp://a.rtmp.youtube.com/live2/yt-secret-key-9876: Input/output error\n"));
  ytProc.exitCode = 1;
  ytProc.emit("exit", 1);
  o = (await api("GET", "/api/stream-outputs")).body.outputs.find((x: { id: number }) => x.id === oid);
  const ytState = o.status.destinations.find((d: { id: number }) => d.id === yt.body.id);
  assert.equal(ytState.state, "retrying");
  assert.match(ytState.error, /Input\/output error/);
  assert.ok(!ytState.error.includes("yt-secret-key-9876"));
  await h.remote.poll();
  assert.equal(procs.length, 2, "waits before retrying");

  // CasparCG restarted: the encoder is added again.
  po.session++;
  po.calls.length = 0;
  await h.remote.poll();
  assert.deepEqual(po.calls.map((c) => c.split(" ")[0]), ["add"]);

  // Stop: relays end and the encoder is removed from CasparCG.
  po.calls.length = 0;
  await api("POST", `/api/stream-outputs/${oid}/active`, { on: false });
  assert.ok(procs.every((x) => x.exitCode !== null));
  assert.deepEqual(po.calls, [`remove 1-${idx}`]);
  assert.equal((await api("GET", "/api/stream-outputs")).body.outputs.find((x: { id: number }) => x.id === oid).status.state, "off");

  // A live event (remote source) is forwarded as it comes in, as soon as the contributor starts.
  const live = await api("POST", "/api/live-sources", { name: "Event", kind: "rtmp", atemInput: 3, studioId, casparChannel: 1 });
  const key = (await api("GET", "/api/live-sources")).body.sources.find((x: { id: number }) => x.id === live.body.id).push.streamKey;
  const ev = await api("POST", "/api/stream-outputs", { name: "Event to YouTube", source: "remote", liveSourceId: live.body.id, destinationIds: [yt.body.id] });
  assert.equal(ev.status, 200);
  paths = [];
  await h.remote.poll();
  await api("POST", `/api/stream-outputs/${ev.body.id}/active`, { on: true });
  o = (await api("GET", "/api/stream-outputs")).body.outputs.find((x: { id: number }) => x.id === ev.body.id);
  assert.equal(o.status.reason, "waiting_for_stream");
  const before = procs.length;
  po.calls.length = 0;
  paths = [{ name: `live/${key}`, online: true, onlineTime: "2026-11-01T21:30:00Z", tracks2: [], readers: [], inboundBytes: 5 }];
  await h.remote.poll();
  assert.equal(procs.length, before + 1);
  assert.equal(procs.at(-1)!.args[procs.at(-1)!.args.indexOf("-i") + 1], `rtmp://10.40.6.60:1935/live/${key}?user=tvsm-management&pass=${h.remote.apiToken()}`);
  assert.ok(!po.calls.some((c) => c.startsWith("add ")), "no encoder for a remote source");
  assert.equal((await api("DELETE", `/api/stream-outputs/${ev.body.id}`)).status, 200);
  assert.ok(procs.at(-1)!.exitCode !== null);
});
