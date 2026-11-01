import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { parseClipCsv } from "../server/visualradio.ts";
import { ClipIndex, decideShot, matchKey, parseClipName, parseNowPlaying, parseRdsText, type MicState, type ShotConfig } from "../server/vrlogic.ts";

// ---- pure logic ---------------------------------------------------------------------

test("visual radio: artist/title normalising and clip file names", () => {
  assert.equal(matchKey("Beyoncé", "Halo (Radio Edit)"), matchKey("Beyonce", "Halo [Official Music Video]"));
  assert.equal(matchKey("David Guetta feat. Sia", "Titanium"), matchKey("David Guetta & Sia", "Titanium (feat. Sia)"));
  assert.equal(matchKey("The Police", "Roxanne - Remastered 2003"), "police|roxanne");
  assert.notEqual(matchKey("Queen", "Under Pressure (Live)"), matchKey("Queen", "Under Pressure"));
  assert.deepEqual(parseClipName("Clips/Golden Earring - Radar Love (Official Video).mp4"), { artist: "Golden Earring", title: "Radar Love (Official Video)" });
  assert.equal(parseClipName("Clips/intro.mp4"), null);
});

test("visual radio: now playing from JSON, XML, text, query string and RDS", () => {
  const j = parseNowPlaying({ artist: "Adele", title: "Hello", type: "song", duration: "4:55", songId: 77, startedAt: "2026-11-01T10:00:00Z" })!;
  assert.deepEqual(j, { artist: "Adele", title: "Hello", type: "music", songId: "77", durationMs: 295_000, startedAt: Date.parse("2026-11-01T10:00:00Z") });
  assert.equal(parseNowPlaying({ current: { Artist: "A", Title: "B" }, next: { artist: "C", title: "D" } })!.artist, "A");
  const x = parseNowPlaying("<?xml version='1.0'?><nowplaying><artist>Doe &amp; Co</artist><title><![CDATA[Song]]></title><type>Jingle</type><duration>12000</duration></nowplaying>")!;
  assert.equal(x.artist, "Doe & Co");
  assert.equal(x.title, "Song");
  assert.equal(x.type, "jingle");
  assert.equal(x.durationMs, 12_000);
  assert.deepEqual(parseNowPlaying("Golden Earring - Radar Love")!.type, "music");
  assert.equal(parseNowPlaying("IJmond360")!.type, "other");
  assert.equal(parseNowPlaying(undefined, { artist: "X", title: "Y", type: "commercial" })!.type, "ad");
  assert.equal(parseRdsText("RT=Nu op IJmond360: Adele - Hello"), "Adele - Hello");
  assert.equal(parseRdsText("PS=IJMOND"), null);
  assert.deepEqual(parseNowPlaying("RT=Adele - Hello\r\n"), { artist: "Adele", title: "Hello", type: "music", songId: null, durationMs: null, startedAt: null });
});

test("visual radio: clip matching by id, exact key, fuzzy and manual link", () => {
  const idx = new ClipIndex(
    [
      { id: 1, artist: "Beyoncé", title: "Halo (Official Video)", songId: null, durationMs: 1 },
      { id: 2, artist: "Golden Earring", title: "Radar Love", songId: "ZL-9", durationMs: 1 },
      { id: 3, artist: "Guns N' Roses", title: "Sweet Child O' Mine", songId: null, durationMs: 1 },
    ],
    new Map([[matchKey("Golden Earring", "Radar Love 2024 Mix"), 2]]),
  );
  assert.equal(idx.match("Beyonce", "Halo (Radio Edit)", null)!.how, "exact");
  assert.equal(idx.match("Whatever", "Whatever", "zl-9")!.clip.id, 2);
  const f = idx.match("Guns 'n Roses", "Sweet Child of Mine", null)!;
  assert.equal(f.how, "fuzzy");
  assert.equal(f.clip.id, 3);
  assert.equal(idx.match("Golden Earring", "Radar Love 2024 Mix", null)!.how, "link");
  assert.equal(idx.match("Adele", "Hello", null), null);
  assert.equal(idx.match("Beyonce", "Sweet Dreams", null), null);
});

test("visual radio: which input goes on air", () => {
  const cfg: ShotConfig = { clipInput: 2, wideInput: 6, loopInput: 3, fallback: "loop", openDelayMs: 250, closeDelayMs: 1500, minShotMs: 3000, mics: [{ key: "dj", input: 4, priority: 10 }, { key: "guest", input: 5, priority: 0 }] };
  const mics = new Map<string, MicState>();
  const base = { now: 10_000, manualInput: null, mics, playing: "music" as const, clipRunning: true, current: null };
  assert.deepEqual(decideShot(cfg, base), { input: 2, reason: "clip" });
  mics.set("dj", { open: true, since: 9_900, wasLive: false });
  assert.equal(decideShot(cfg, base).input, 2, "open delay not passed yet");
  mics.set("dj", { open: true, since: 9_000, wasLive: false });
  assert.deepEqual(decideShot(cfg, base), { input: 4, reason: "mic", mic: "dj" });
  mics.set("guest", { open: true, since: 9_000, wasLive: false });
  assert.deepEqual(decideShot(cfg, base), { input: 6, reason: "mics" });
  assert.equal(decideShot({ ...cfg, wideInput: null }, base).input, 4, "no wide shot: highest priority");
  mics.clear();
  mics.set("dj", { open: false, since: 9_500, wasLive: true });
  assert.equal(decideShot(cfg, base).input, 4, "close delay keeps the camera");
  assert.equal(decideShot(cfg, { ...base, now: 11_100 }).input, 2);
  // Minimum shot length holds the camera, a manual choice does not wait.
  const held = decideShot(cfg, { ...base, now: 11_100, current: { input: 4, since: 10_000 } });
  assert.equal(held.input, 4);
  assert.equal(held.held, true);
  assert.equal(decideShot(cfg, { ...base, manualInput: 6, current: { input: 4, since: 10_000 } }).input, 6);
  assert.deepEqual(decideShot(cfg, { ...base, now: 20_000, clipRunning: false }), { input: 3, reason: "fallback" });
  assert.deepEqual(decideShot({ ...cfg, fallback: "wide" }, { ...base, now: 20_000, clipRunning: false }), { input: 6, reason: "fallback" });
  assert.deepEqual(decideShot(cfg, { ...base, now: 20_000, playing: "jingle" }), { input: 3, reason: "idle" });
});

test("visual radio: clip database CSV", () => {
  const rows = parseClipCsv('artist;title;path;songId;offsetMs\n"Doe; John";Song;Clips\\a.mp4;12;1500\n;;;\nAdele;Hello;Clips/b.mp4;;');
  assert.deepEqual(rows, [
    { artist: "Doe; John", title: "Song", path: "Clips\\a.mp4", songId: "12", offsetMs: 1500 },
    { artist: "Adele", title: "Hello", path: "Clips/b.mp4", songId: null, offsetMs: 0 },
  ]);
  assert.equal(parseClipCsv("Adele,Hello,b.mp4")[0]!.path, "b.mp4");
});

// ---- end to end with fake devices -------------------------------------------------------

class FakeSwitcher extends EventEmitter implements SwitcherDriver {
  programIn: number | null = null;
  info(): SwitcherInfo {
    return { connected: true, model: "Fake", productName: "ATEM Fake", mixEffects: 1, inputs: [], program: [this.programIn], preview: [null] };
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
  info() {
    return { connected: true, version: "2.4.0", channels: [1], session: 1 };
  }
  async play(ch: number, layer: number, clip?: string, o: { seek?: number } = {}) {
    this.calls.push(`play ${ch}-${layer} ${clip}${o.seek ? ` seek ${o.seek}` : ""}`);
  }
  async loadbg() {}
  async stop(ch: number, layer: number) {
    this.calls.push(`stop ${ch}-${layer}`);
  }
  async clear() {}
  async playHtml() {}
  async cgAdd() {}
  async cgUpdate() {}
  async cgStop() {}
  async addConsumer() {}
  async removeConsumer() {}
  async volume(ch: number, layer: number, v: number) {
    this.calls.push(`volume ${ch}-${layer} ${v}`);
  }
  async close() {}
}

const root = mkdtempSync(join(tmpdir(), "tvsm-vr-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
const sw = new FakeSwitcher();
const po = new FakePlayout();
const drivers: DriverFactory = { switcher: () => sw, playout: () => po };
let cookie = "";
const api = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: { ...(cookie ? { cookie } : {}), ...headers } });
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

test("visual radio: song in, clip on CasparCG, microphone to camera", async () => {
  const media = join(root, "media");
  mkdirSync(join(media, "Clips"), { recursive: true });
  writeFileSync(join(media, "Clips", "Beyoncé - Halo (Official Video).mp4"), "x");
  writeFileSync(join(media, "Clips", "Golden Earring - Radar Love.mp4"), "x");
  writeFileSync(join(media, "Clips", "no artist.mp4"), "x");
  writeFileSync(join(media, "show.mp4"), "x");
  const src = await api("POST", "/api/media/sources", { name: "UNAS", type: "local", config: { path: media } });
  assert.equal(src.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const items = (await api("GET", "/api/media")).body.items as { id: number; path: string }[];
  for (const m of items) await api("PUT", `/api/media/${m.id}`, { category: "program", durationMs: 240_000 });
  const sourceId = (await api("GET", "/api/media/sources")).body.sources[0].id;

  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "VR node", host: "10.40.6.61" });
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const ch = await api("POST", "/api/channels", { name: "Radio TV", atemId, studioId, casparChannel: 1, playoutInput: 1 });

  const created = await api("POST", "/api/visualradio/stations", {
    name: "IJmond360 Radio",
    enabled: true,
    channelId: ch.body.id,
    studioId,
    casparChannel: 1,
    clipInput: 2,
    loopInput: 3,
    wideInput: 6,
    minShotMs: 0,
    clipSourceId: sourceId,
    clipFolder: "Clips",
    mics: [
      { key: "dj", name: "DJ", input: 4, priority: 10 },
      { key: "guest", name: "Guest", input: 5 },
    ],
  });
  assert.equal(created.status, 200);
  const sid = created.body.id;
  assert.equal(h.director.yieldTo(ch.body.id), true, "the director leaves the channel to Visual Radio");
  const st = (await api("GET", "/api/visualradio/stations")).body.stations[0];
  const token = st.urls.nowPlaying.split("/visualradio/")[1].split("/")[0];

  const scan = await api("POST", `/api/visualradio/stations/${sid}/clips/scan`, {});
  assert.deepEqual([scan.body.files, scan.body.added, scan.body.unnamed], [3, 2, 1]);

  const vr = h.visualRadio;
  let now = Date.parse("2026-11-01T10:00:00Z");
  vr.now = () => now;
  const step = () => vr.step(vr.station(sid)!);

  // The playout reports a song (no login, token in the URL).
  cookie = "";
  const np = await api("POST", `/visualradio/${token}/nowplaying`, { artist: "Beyonce", title: "Halo (Radio Edit)", type: "music" });
  assert.equal(np.status, 200);
  assert.equal(np.body.clip, "Beyoncé - Halo (Official Video)");
  assert.deepEqual(po.calls.slice(-2), ["play 1-10 Clips/Beyoncé - Halo (Official Video)", "volume 1-10 0"]);
  await step();
  assert.equal(sw.programIn, 2, "clip on air");

  // DJ opens the microphone: camera after the open delay, back to the clip after the close delay.
  assert.equal((await api("GET", `/visualradio/${token}/mic/dj/1`)).status, 200);
  await step();
  assert.equal(sw.programIn, 2);
  now += 300;
  await step();
  assert.equal(sw.programIn, 4);
  await api("POST", `/visualradio/${token}/mic`, "mic=dj&open=0", { "content-type": "application/x-www-form-urlencoded" });
  now += 1000;
  await step();
  assert.equal(sw.programIn, 4);
  now += 1000;
  await step();
  assert.equal(sw.programIn, 2);
  assert.equal((await api("GET", "/visualradio/wrong-token/mic/dj/1")).status, 404);

  // RDS text (Zenlex) for a song without a clip: fallback, and it shows up as missing.
  await vr.rdsLine(sid, "RT=Nu op IJmond360: Adele - Hello");
  now += 100;
  await step();
  assert.equal(sw.programIn, 3);
  assert.equal(po.calls.at(-1), "stop 1-10");
  cookie = "";
  await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" });
  const missing = await api("GET", `/api/visualradio/stations/${sid}/missing`);
  assert.equal(missing.body.songs.length, 1);
  const clips = (await api("GET", `/api/visualradio/stations/${sid}/clips`)).body.clips as { id: number; artist: string }[];
  const radar = clips.find((c) => c.artist === "Golden Earring")!;
  assert.equal((await api("POST", `/api/visualradio/songs/${missing.body.songs[0].id}/link`, { clipId: radar.id })).status, 200);
  assert.equal((await api("GET", `/api/visualradio/stations/${sid}/match?artist=Adele&title=Hello`)).body.match.how, "link");

  // CSV import with song ids from the playout, then an XML message with that id.
  const imp = await api("POST", `/api/visualradio/stations/${sid}/clips/import`, { csv: "artist;title;path;songId\nBeyoncé;Halo;Clips/Beyoncé - Halo (Official Video).mp4;ZL-42\nX;Y;Clips/nope.mp4;1" });
  assert.deepEqual([imp.body.imported, imp.body.notFound], [1, ["Clips/nope.mp4"]]);
  const xml = await api("POST", `/visualradio/${token}/nowplaying`, "<item><artist>Someone</artist><title>Else</title><songid>ZL-42</songid></item>", { "content-type": "text/xml" });
  assert.equal(xml.body.clip, "Beyoncé - Halo");

  // A jingle: no clip, station loop.
  await api("POST", `/api/visualradio/stations/${sid}/simulate`, { title: "IJmond360", type: "jingle" });
  now += 100;
  await step();
  assert.equal(sw.programIn, 3);
  // Manual camera, then back to automatic.
  await api("POST", `/api/visualradio/stations/${sid}/manual`, { input: 5 });
  await step();
  assert.equal(sw.programIn, 5);
  await api("POST", `/api/visualradio/stations/${sid}/manual`, { input: null });
  await step();
  assert.equal(sw.programIn, 3);
  const live = (await api("GET", `/api/visualradio/stations/${sid}/live`)).body;
  assert.equal(live.nowPlaying.type, "jingle");
  assert.equal(live.mics.length, 2);
  assert.ok(live.log.length > 5);

  // Disabled station: the director takes the channel back.
  await api("PUT", `/api/visualradio/stations/${sid}`, { ...st, enabled: false });
  assert.equal(h.director.yieldTo(ch.body.id), false);
});
