import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { detectKind, kindFromContentType, normaliseUrl, parseFfmpegInfo, playPlan, relayArgs, scanPage, webcamSettingsSchema } from "../server/webcamlogic.ts";

// ---- pure logic ---------------------------------------------------------------

test("webcams: kind of a link", () => {
  assert.equal(normaliseUrl("www.webcam.nl/noord-holland/ijmuiden/"), "https://www.webcam.nl/noord-holland/ijmuiden/");
  assert.throws(() => normaliseUrl("ftp://cam/x"));
  assert.equal(detectKind("rtsp://admin:pw@10.40.7.20:554/stream1"), "rtsp");
  assert.equal(detectKind("rtmp://live.example/app/key"), "rtmp");
  assert.equal(detectKind("srt://10.0.0.5:9000?streamid=x"), "srt");
  assert.equal(detectKind("https://cdn.example/live/strand/playlist.m3u8?token=1"), "hls");
  assert.equal(detectKind("http://10.40.7.21/mjpg/video.mjpg"), "mjpeg");
  assert.equal(detectKind("http://10.40.7.22/axis-cgi/jpg/image.cgi"), "image");
  assert.equal(detectKind("https://example.org/cams/pier.jpg"), "image");
  assert.equal(detectKind("https://example.org/loop.mp4"), "video");
  assert.equal(detectKind("https://www.webcam.nl/ijmuiden/"), "page");
  assert.equal(kindFromContentType("application/vnd.apple.mpegurl"), "hls");
  assert.equal(kindFromContentType("multipart/x-mixed-replace; boundary=x"), "mjpeg");
  assert.equal(kindFromContentType("text/html; charset=utf-8"), "page");
});

test("webcams: streams found in a webcam page", () => {
  const html = `<html><head><meta property="og:video" content="https://cdn.example/og.m3u8"></head><body>
    <video id="v" poster="/snapshots/pier.jpg"><source src="//cdn.example/live/pier/index.m3u8" type="application/x-mpegURL"></video>
    <script>var player = jwplayer("x").setup({ file: "https:\\/\\/cdn2.example\\/cam\\/strand.m3u8" }); var r = 'rtsp://10.1.1.1/live';</script>
    <img src="/mjpg/video.mjpg"><img src="/img/logo.png">
    <iframe src="https://player.example/embed/42"></iframe><iframe src="https://www.youtube.com/embed/abc"></iframe>
    <iframe src="https://googleads.g.doubleclick.net/x"></iframe></body></html>`;
  const c = scanPage(html, "https://www.webcam.example/ijmuiden/");
  const urls = c.map((x) => `${x.kind} ${x.url}`);
  assert.equal(c[0]!.kind, "hls");
  assert.ok(urls.includes("hls https://cdn.example/live/pier/index.m3u8"), urls.join("\n"));
  assert.ok(urls.includes("hls https://cdn2.example/cam/strand.m3u8"));
  assert.ok(urls.includes("hls https://cdn.example/og.m3u8"));
  assert.ok(urls.includes("rtsp rtsp://10.1.1.1/live"));
  assert.ok(urls.includes("mjpeg https://www.webcam.example/mjpg/video.mjpg"));
  assert.ok(urls.includes("image https://www.webcam.example/snapshots/pier.jpg"));
  assert.ok(urls.includes("page https://player.example/embed/42"));
  assert.ok(!urls.some((u) => u.includes("youtube") || u.includes("doubleclick") || u.includes("logo.png")));
});

test("webcams: ffmpeg details, relay arguments and play plan", () => {
  const info = parseFfmpegInfo("  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 25 fps, 25 tbr\n  Stream #0:1: Audio: aac (LC), 48000 Hz");
  assert.deepEqual(info, { videoCodec: "h264", width: 1920, height: 1080, fps: 25, audioCodec: "aac" });
  const rtsp = relayArgs("rtsp", "rtsp://cam/1", false);
  assert.deepEqual(rtsp.slice(rtsp.indexOf("-rtsp_transport"), rtsp.indexOf("-rtsp_transport") + 2), ["-rtsp_transport", "tcp"]);
  assert.ok(rtsp.includes("-an") && rtsp.includes("copy") && rtsp.at(-1) === "pipe:1");
  assert.ok(relayArgs("hls", "https://x/a.m3u8", true).includes("0:a:0?"));
  const settings = webcamSettingsSchema.parse({});
  assert.equal(settings.durationSec, 60);
  assert.equal(settings.audio, false);
  assert.equal(settings.caption.enabled, true);
  const base = "http://10.40.6.202:8080";
  assert.deepEqual(playPlan({ id: 3, kind: "hls", url: "https://x/a.m3u8", settings }, base), { mode: "video", url: `${base}/webcam/3/live.ts`, captionUrl: `${base}/webcam/page.html?id=3&caption=1` });
  assert.equal(playPlan({ id: 3, kind: "hls", url: "https://x/a.m3u8", settings: { ...settings, via: "direct" } }, base).url, "https://x/a.m3u8");
  assert.deepEqual(playPlan({ id: 4, kind: "image", url: "https://x/a.jpg", settings }, base), { mode: "html", url: `${base}/webcam/page.html?id=4`, captionUrl: null });
  assert.equal(playPlan({ id: 5, kind: "page", url: "https://www.webcam.nl/x", settings: { ...settings, caption: { ...settings.caption, enabled: false } } }, base).captionUrl, null);
});

// ---- server -------------------------------------------------------------------------

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
  failPlay = false;
  info() {
    return { connected: true, version: "2.4.3", channels: [1], session: 1 };
  }
  async play(ch: number, layer: number, clip?: string) {
    this.calls.push(`play ${ch}-${layer}${clip ? ` ${clip}` : ""}`);
    if (this.failPlay) throw new Error("CasparCG 404 PLAY FAILED");
  }
  async loadbg() {}
  async stop() {}
  async clear(ch: number, layer?: number) {
    this.calls.push(`clear ${ch}-${layer}`);
  }
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

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const root = mkdtempSync(join(tmpdir(), "tvsm-cam-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
let site: Server;
let base = "";
let clip: Buffer | null = null;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(200).fill(0), 0xff, 0xd9]);
const sw = new FakeSwitcher();
const playout = new FakePlayout();
const drivers: DriverFactory = { switcher: () => sw, playout: () => playout };
let cookie = "";
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, headers: res.headers, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body, raw: res.rawPayload };
};

test.before(async () => {
  if (hasFfmpeg) {
    const f = join(root, "clip.ts");
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-t", "2", "-c:v", "mpeg2video", "-f", "mpegts", "-y", f]);
    clip = readFileSync(f);
  }
  // A webcam site: a page with an embedded player, the player with the stream, a snapshot camera.
  site = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/ijmuiden/") return res.writeHead(200, { "content-type": "text/html" }).end(`<html><title>Webcam IJmuiden pier</title><body><iframe src="/embed/7"></iframe></body></html>`);
    if (u.pathname === "/embed/7") return res.writeHead(200, { "content-type": "text/html" }).end(`<video><source src="${base}/live/pier.ts"></video><script>var s = "/live/pier.m3u8";</script>`);
    if (u.pathname === "/nothing/") return res.writeHead(200, { "content-type": "text/html" }).end(`<html><title>Geen camera</title><p>hallo</p></html>`);
    if (u.pathname === "/cam.jpg") return res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG);
    if (u.pathname === "/live/pier.ts" && clip) return res.writeHead(200, { "content-type": "video/mp2t" }).end(clip);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  p = await createPlatform(managementOptions({ drivers, autostart: false, onReady: (x) => (h = x) }));
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
});
test.after(async () => {
  await p.server.close();
  site.close();
  rmSync(root, { recursive: true, force: true });
});

test("webcams: inspect a webcam page, test, save, plan and play on CasparCG", async () => {
  // A webcam page: the stream is found in the embedded player.
  const ins = await api("POST", "/api/webcams/inspect", { url: `${base}/ijmuiden/` });
  assert.equal(ins.status, 200, JSON.stringify(ins.body));
  assert.equal(ins.body.title, "Webcam IJmuiden pier");
  assert.equal(ins.body.kind, "hls");
  assert.equal(ins.body.url, `${base}/live/pier.m3u8`);
  assert.equal(ins.body.pageUrl, `${base}/ijmuiden/`);
  assert.ok(ins.body.candidates.some((c: { url: string; kind: string }) => c.kind === "video" && c.url === `${base}/live/pier.ts`));
  // A page without a stream is shown as a web page.
  const none = (await api("POST", "/api/webcams/inspect", { url: `${base}/nothing/` })).body;
  assert.equal(none.kind, "page");
  assert.equal(none.candidates.length, 0);
  assert.equal((await api("POST", "/api/webcams/inspect", { url: "https://www.youtube.com/watch?v=abc" })).body.youtube, true);

  // Test a picture camera and (with ffmpeg) a video stream.
  const pic = (await api("POST", "/api/webcams/test", { kind: "image", url: `${base}/cam.jpg` })).body;
  assert.equal(pic.ok, true);
  assert.match(pic.thumbnail, /^data:image\/jpeg;base64,/);
  const bad = (await api("POST", "/api/webcams/test", { kind: "image", url: `${base}/gone.jpg` })).body;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /404/);
  if (hasFfmpeg) {
    const vid = (await api("POST", "/api/webcams/test", { kind: "video", url: `${base}/live/pier.ts` })).body;
    assert.equal(vid.ok, true, vid.error);
    assert.equal(vid.info.width, 640);
    assert.match(vid.thumbnail, /^data:image\/jpeg/);
  }

  // Save: every webcam gets its own block; credentials stay out of the API.
  const cam = await api("POST", "/api/webcams", { name: "Pier IJmuiden", kind: hasFfmpeg ? "video" : "hls", url: hasFfmpeg ? `${base}/live/pier.ts` : `${base}/live/pier.m3u8`, pageUrl: `${base}/ijmuiden/`, settings: { durationSec: 90 } });
  assert.equal(cam.status, 200, JSON.stringify(cam.body));
  assert.equal(cam.body.durationMs, 90_000);
  assert.equal(cam.body.settings.caption.enabled, true);
  assert.ok(cam.body.block);
  const secret = (await api("POST", "/api/webcams", { name: "IP camera", kind: "rtsp", url: "rtsp://admin:geheim@10.40.7.20/stream1" })).body;
  assert.equal(secret.url, "rtsp://***@10.40.7.20/stream1");
  assert.equal(secret.hasCredentials, true);
  const kept = (await api("PUT", `/api/webcams/${secret.id}`, { name: "IP camera haven", kind: "rtsp", url: secret.url })).body;
  assert.equal(kept.name, "IP camera haven");
  assert.equal(h.webcams && (p.ctx.db.prepare("SELECT url FROM webcams WHERE id = ?").get(secret.id) as { url: string }).url, "rtsp://admin:geheim@10.40.7.20/stream1");
  assert.equal((await api("GET", `/api/blocks/${kept.block.id}`)).body.block.name, "IP camera haven");
  const snap = (await api("POST", "/api/webcams", { name: "Strand", kind: "image", url: `${base}/cam.jpg`, settings: { refreshSec: 10, caption: { text: "Strand Wijk aan Zee" } } })).body;
  await h.webcams.check(snap.id);
  const snapOut = (await api("GET", `/api/webcams/${snap.id}`)).body;
  assert.equal(snapOut.status, "online");
  assert.ok(snapOut.thumbnailUrl);
  assert.equal((await api("GET", snapOut.thumbnailUrl)).headers["content-type"], "image/jpeg");
  assert.equal((await api("POST", "/api/webcams", { name: "x", kind: "rtsp", url: "ftp://nope" })).status, 400);

  // Public: data for the page and the picture through the management node.
  const data = (await api("GET", `/webcam/${snap.id}/data.json`)).body;
  assert.equal(data.caption, "Strand Wijk aan Zee");
  assert.equal(data.mode, "picture");
  const img = await api("GET", `/webcam/${snap.id}/snapshot`);
  assert.equal(img.status, 200);
  assert.equal(img.raw.length, JPEG.length);
  assert.match(String((await api("GET", "/webcam/page.html?id=1")).body), /data\.json/);

  // In a block next to other items: default length from the webcam, or set on the item.
  const blk = (await api("POST", "/api/blocks", { name: "Weer en webcams", items: [{ type: "webcam", webcamId: cam.body.id }, { type: "webcam", webcamId: snap.id, durationMs: 30_000 }] })).body;
  const detail = (await api("GET", `/api/blocks/${blk.id}`)).body;
  assert.equal(detail.block.durationMs, 120_000);
  assert.equal(detail.items[0].webcamName, "Pier IJmuiden");
  assert.equal((await api("POST", "/api/blocks", { name: "x", items: [{ type: "webcam" }] })).status, 400);
  assert.equal((await api("DELETE", `/api/webcams/${cam.body.id}`)).status, 409);

  // On air: video stream through the relay with the caption above it, then the picture page.
  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "Studio", host: "10.40.5.11" });
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId, casparChannel: 1, playoutInput: 1 })).body;
  const t0 = Date.parse("2026-11-02T12:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: blk.id, title: "Webcams" });
  await api("POST", `/api/control/${ch.id}/automation`, { on: true });
  h.director.now = () => t0 + 5000;
  h.director.invalidate();
  await h.director.tick();
  assert.ok(playout.calls.some((c) => new RegExp(`^play 1-10 http://.+/webcam/${cam.body.id}/live\\.ts$`).test(c)), playout.calls.join("\n"));
  assert.ok(playout.calls.some((c) => new RegExp(`^html 1-11 .+/webcam/page\\.html\\?id=${cam.body.id}&caption=1$`).test(c)));
  assert.equal(sw.programIn, 1);
  assert.equal((playout.graphics.at(-1) as { hidden: boolean }).hidden, false);
  assert.equal((await api("GET", "/api/control")).body.channels[0].current.type, "webcam");

  playout.calls = [];
  h.director.now = () => t0 + 95_000;
  await h.director.tick();
  assert.ok(playout.calls.some((c) => new RegExp(`^html 1-10 .+/webcam/page\\.html\\?id=${snap.id}$`).test(c)), playout.calls.join("\n"));
  assert.ok(playout.calls.includes("clear 1-11"));

  // A stream that does not come in: "not available" card, and the director tries again.
  const blk2 = (await api("POST", "/api/blocks", { name: "Haven", items: [{ type: "webcam", webcamId: secret.id }] })).body;
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0 + 120_000).toISOString(), blockId: blk2.id, title: "Haven" });
  playout.failPlay = true;
  playout.calls = [];
  // Added to the hour on air: it would wait for the next hour, "apply now" takes it at once.
  h.director.applyNow(ch.id);
  h.director.now = () => t0 + 121_000;
  await h.director.tick();
  assert.ok(playout.calls.some((c) => c.endsWith(`/webcam/page.html?id=${secret.id}&offline=1`)), playout.calls.join("\n"));
  assert.match((await api("GET", "/api/control")).body.channels[0].lastError, /IP camera haven/);
  playout.failPlay = false;
  h.director.now = () => t0 + 128_000;
  await h.director.tick();
  assert.equal((await api("GET", "/api/control")).body.channels[0].lastError, null);

  // The relay itself (fake ffmpeg): MPEG-TS out, no sound, killed when CasparCG hangs up.
  const spawned: string[][] = [];
  h.webcams.spawner = (_cmd, args) => {
    spawned.push(args);
    const proc = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
    const stdout = new PassThrough();
    Object.assign(proc, { stdout, stderr: new PassThrough(), exitCode: null, kill: () => true });
    setTimeout(() => stdout.end(Buffer.from("TS")), 10);
    return proc;
  };
  const live = await api("GET", `/webcam/${secret.id}/live.ts`);
  assert.equal(live.headers["content-type"], "video/mp2t");
  assert.equal(String(live.raw), "TS");
  assert.ok(spawned[0]!.includes("rtsp://admin:geheim@10.40.7.20/stream1") && spawned[0]!.includes("-an"));

  // Delete: its own block goes too.
  assert.equal((await api("DELETE", `/api/webcams/${cam.body.id}?force=true`)).status, 200);
  assert.equal((await api("GET", `/api/blocks/${cam.body.block.id}`)).status, 404);
});
