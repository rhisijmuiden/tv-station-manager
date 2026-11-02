import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { repeatRules } from "../server/switching.ts";

// Switch buttons for editors: named buttons that take a live source on air by hand, with the record/repeat question.

test("repeat choice: chosen time, the source's own repeat times, or a time is needed", () => {
  const rules = [{ dayOffset: 1, time: "10:00", channelId: null }];
  assert.deepEqual(repeatRules({ record: false, repeat: true }, rules, 4), [], "nothing recorded: no repeat");
  assert.deepEqual(repeatRules({ record: true, repeat: false }, rules, 4), []);
  assert.deepEqual(repeatRules({ record: true, repeat: true }, rules, 4), [{ dayOffset: 1, time: "10:00", channelId: 4 }]);
  assert.deepEqual(repeatRules({ record: true, repeat: true, repeatAt: { dayOffset: 0, time: "22:30" } }, rules, 4), [{ dayOffset: 0, time: "22:30", channelId: 4 }]);
  assert.equal(repeatRules({ record: true, repeat: true }, [], 4), "needs_time");
});

class FakeSwitcher extends EventEmitter implements SwitcherDriver {
  programIn: number | null = 1;
  info(): SwitcherInfo {
    return { connected: true, model: "Fake", productName: "ATEM Fake", mixEffects: 1, inputs: [1, 2, 3, 4].map((id) => ({ id, longName: `In ${id}`, shortName: `${id}`, external: true })), program: [this.programIn], preview: [null] };
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
  played: string[] = [];
  info() {
    return { connected: true, version: "2.4.3", channels: [1, 2], session: 1 };
  }
  async play(ch: number, _layer: number, clip?: string) {
    if (clip) this.played.push(`${ch} ${clip}`);
  }
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
class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill() {
    if (this.exitCode !== null) return true;
    this.exitCode = 0;
    setImmediate(() => this.emit("exit", 0));
    return true;
  }
}

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("switch buttons: take a camera or a stream live, record it, repeat it, back to the schedule", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "tvsm-switch-"));
  process.env.TVSM_DATA_DIR = join(root, "data");
  process.env.TVSM_CONF_DIR = join(root, "conf");
  process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
  const clip = join(root, "clip.ts");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-c:a", "aac", "-f", "mpegts", clip]);

  const sw = new FakeSwitcher();
  const studio = new FakePlayout();
  const drivers: DriverFactory = { switcher: () => sw, playout: () => studio };
  let h!: ManagementHandles;
  const p: Platform = await createPlatform(managementOptions({ drivers, autostart: false, onReady: (x) => (h = x) }));
  let cookie = "";
  const api = async (method: string, url: string, payload?: unknown, as?: string) => {
    const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: (as ?? cookie) ? { cookie: as ?? cookie } : {} });
    const set = res.headers["set-cookie"];
    if (set && as === undefined) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
    return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body };
  };
  try {
    assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
    const lib = join(root, "unas");
    mkdirSync(lib);
    await api("POST", "/api/media/sources", { name: "UNAS", type: "local", config: { path: lib } });
    await api("POST", "/api/atems", { name: "Regie", host: "10.40.6.50" });
    await api("POST", "/api/studios", { name: "VR-CASPAR-STUDIO-01", host: "10.40.5.11" });
    const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
    const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
    const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId, casparChannel: 1, playoutInput: 1 })).body;
    await api("POST", `/api/control/${ch.id}/automation`, { on: true });
    const cam = (await api("POST", "/api/live-sources", { name: "Studiocamera", kind: "atem", atemInput: 3 })).body;
    const stream = (await api("POST", "/api/live-sources", { name: "Persconferentie", kind: "rtmp", atemInput: 2, studioId, casparChannel: 2 })).body;
    const key = (await api("GET", "/api/live-sources")).body.sources.find((s: { id: number }) => s.id === stream.id).push.streamKey as string;
    await api("PUT", "/api/recordings/settings", { folder: "Opnames", graceSeconds: 60, postRollSeconds: 60, minSeconds: 5, keepDays: 7, minFreeGb: 0, mediaSourceId: null });

    // Admin makes the buttons; an operator can press them but not make them.
    const b1 = (await api("POST", "/api/switch/buttons", { channelId: ch.id, name: "Studio", color: "#1DB97A", liveSourceId: cam.id })).body;
    const b2 = (await api("POST", "/api/switch/buttons", { channelId: ch.id, name: "IJmond360 Nieuws live", color: "#FF3D57", liveSourceId: stream.id })).body;
    assert.equal((await api("POST", "/api/switch/buttons", { channelId: ch.id, name: "x", liveSourceId: 999 })).status, 404);
    await api("POST", "/api/users", { username: "redactie", password: "redactie-password", role: "operator" });
    const login = await p.server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "redactie", password: "redactie-password" } });
    const op = String(login.headers["set-cookie"]).split(";")[0]!;
    assert.equal((await api("POST", "/api/switch/buttons", { channelId: ch.id, name: "x", liveSourceId: cam.id }, op)).status, 403);
    assert.equal((await api("POST", "/api/switch/buttons/order", { ids: [b2.id, b1.id] })).status, 200);
    let view = (await api("GET", "/api/switch", undefined, op)).body.channels[0];
    assert.deepEqual(
      view.buttons.map((b: { name: string }) => b.name),
      ["IJmond360 Nieuws live", "Studio"],
    );
    assert.equal(view.buttons[0].source.kind, "rtmp");
    assert.equal(view.buttons[0].source.recordDefault, true);

    // Camera: one press, the ATEM switches and the schedule waits.
    assert.equal((await api("POST", `/api/switch/buttons/${b1.id}/press`, {}, op)).status, 200);
    assert.equal(sw.programIn, 3);
    view = (await api("GET", "/api/switch", undefined, op)).body.channels[0];
    assert.equal(view.override.name, "Studiocamera");
    assert.equal(view.buttons.find((b: { id: number }) => b.id === b1.id).onAir, true);
    assert.equal(view.recording, null, "a camera is not recorded");

    // Stream: repeat without a time and without repeat times on the source is refused.
    assert.equal((await api("POST", `/api/switch/buttons/${b2.id}/press`, { record: true, repeat: true }, op)).body.error, "repeat_needs_time");

    // The stream is coming in.
    let online = true;
    h.remote.fetcher = (async () => new Response(JSON.stringify({ items: online ? [{ name: `live/${key}`, online: true, onlineTime: new Date().toISOString(), tracks2: [{ codec: "H264" }], readers: [], inboundBytes: 1 }] : [] }), { headers: { "content-type": "application/json" } })) as never;
    const spawned: string[][] = [];
    h.recorder.spawner = ((_cmd: string, args: string[]) => {
      spawned.push(args);
      copyFileSync(clip, args[args.length - 1]!);
      return new FakeProc();
    }) as never;
    await h.remote.poll();
    assert.equal(spawned.length, 1, "the source records itself as soon as it comes in (its own setting)");

    // Live with "record: yes, repeat tomorrow at 10:00": the running recording is kept and gets the choices.
    const press = await api("POST", `/api/switch/buttons/${b2.id}/press`, { record: true, repeat: true, repeatAt: { dayOffset: 1, time: "10:00" } }, op);
    assert.equal(press.status, 200, JSON.stringify(press.body));
    assert.equal(sw.programIn, 2);
    assert.ok(studio.played.some((x) => x.startsWith("2 rtmp://127.0.0.1/live/")), "stream on its DeckLink output");
    view = (await api("GET", "/api/switch", undefined, op)).body.channels[0];
    assert.equal(view.override.name, "Persconferentie");
    assert.equal(view.recording.active, true);
    assert.equal(view.recording.repeat, true);
    let recs = (await api("GET", "/api/recordings")).body.recordings;
    assert.equal(recs[0].title, "IJmond360 Nieuws live", "named after the button");
    assert.equal(recs[0].channelId, ch.id);

    // Back to the schedule: the live recording is finished, goes to the library and is planned as a repeat.
    assert.equal((await api("POST", `/api/switch/${ch.id}/back`, {}, op)).status, 200);
    assert.equal((await api("GET", "/api/switch", undefined, op)).body.channels[0].override, null);
    await h.recorder.idle();
    await h.recorder.idle();
    recs = (await api("GET", "/api/recordings")).body.recordings;
    assert.equal(recs[0].stopReason, "live_end");
    assert.equal(recs[0].status, "published", recs[0].error ?? "");
    assert.equal(recs[0].repeats.length, 1);
    assert.equal(recs[0].repeats[0].channelId, ch.id);
    assert.ok(Date.parse(recs[0].repeats[0].startAt) > Date.now() + 3600_000);
    // The contributor keeps sending: not recorded again until the stream stops.
    await h.remote.poll();
    assert.equal(spawned.length, 1);

    // Live again, "record: no": nothing is recorded.
    online = false;
    await h.remote.poll();
    online = true;
    assert.equal((await api("POST", `/api/switch/buttons/${b2.id}/press`, { record: false }, op)).status, 200);
    await h.remote.poll();
    await h.remote.poll();
    assert.equal(spawned.length, 1, "editor said no");
    view = (await api("GET", "/api/switch", undefined, op)).body.channels[0];
    assert.equal(view.recording.active, false);
    assert.equal(view.recording.record, false);
    // Switching straight to the camera ends the stream's live session.
    assert.equal((await api("POST", `/api/switch/buttons/${b1.id}/press`, {}, op)).status, 200);
    assert.equal(sw.programIn, 3);
    assert.equal(h.recorder.intent(stream.id), null);

    // A stream that came in by itself is thrown away when the editor says "no" on going live.
    online = false;
    await h.remote.poll();
    online = true;
    await h.remote.poll();
    assert.equal(spawned.length, 2);
    const before = (await api("GET", "/api/recordings")).body.recordings.length;
    assert.equal((await api("POST", `/api/switch/buttons/${b2.id}/press`, { record: false }, op)).status, 200);
    await h.recorder.idle();
    assert.equal((await api("GET", "/api/recordings")).body.recordings.length, before - 1);
    await api("POST", `/api/switch/${ch.id}/back`, {}, op);

    // Locked in the orchestrator: the buttons do nothing.
    h.hub.lockFor = () => ({ name: "Regie", by: "reinder", at: null, reason: "Live talk" }) as never;
    assert.equal((await api("POST", `/api/switch/buttons/${b1.id}/press`, {}, op)).status, 409);
    assert.equal((await api("GET", "/api/switch", undefined, op)).body.channels[0].atemLock.by, "reinder");
    h.hub.lockFor = () => null;

    // Removing a live source removes its buttons.
    await api("DELETE", `/api/live-sources/${cam.id}`);
    assert.equal((await api("GET", "/api/switch/buttons")).body.buttons.length, 1);
  } finally {
    await p.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
