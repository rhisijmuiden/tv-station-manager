import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver } from "../server/drivers.ts";
import { clampTrim, decide, libraryFileName, libraryPath, repeatTimes, safeName, trimArgs } from "../server/recordlogic.ts";

// ---- pure logic -------------------------------------------------------------------

test("recording decisions: start, short drops, end of stream, end of programme and hold", () => {
  const base = { now: 1_000_000, graceMs: 90_000, postRollMs: 120_000, heldAfter: undefined, program: null };
  assert.equal(decide({ ...base, online: false, session: null }), "idle");
  assert.equal(decide({ ...base, online: true, session: null }), "start");
  const s = { programKey: null, programEnd: null, offlineSince: null };
  assert.equal(decide({ ...base, online: true, session: s }), "keep");
  // Short drop: still the same recording.
  assert.equal(decide({ ...base, online: false, session: { ...s, offlineSince: base.now - 30_000 } }), "keep");
  assert.equal(decide({ ...base, online: false, session: { ...s, offlineSince: base.now - 90_000 } }), "stop_stream_end");
  // Programme in the schedule: stop after the post-roll, even when the stream keeps coming in.
  const ps = { programKey: "7:0", programEnd: base.now - 60_000, offlineSince: null };
  assert.equal(decide({ ...base, online: true, session: ps }), "keep");
  assert.equal(decide({ ...base, online: true, session: { ...ps, programEnd: base.now - 120_000 } }), "stop_programme_end");
  // The next programme with this source follows straight away: a new recording.
  assert.equal(decide({ ...base, online: true, session: ps, program: { key: "8:0", end: base.now + 1 } }), "stop_next_programme");
  // Held after the programme until the stream stops or another programme starts.
  assert.equal(decide({ ...base, online: true, session: null, heldAfter: "7:0" }), "idle");
  assert.equal(decide({ ...base, online: true, session: null, heldAfter: "7:0", program: { key: "7:0", end: 0 } }), "idle");
  assert.equal(decide({ ...base, online: true, session: null, heldAfter: "7:0", program: { key: "9:0", end: base.now + 1 } }), "start");
  assert.equal(decide({ ...base, online: true, session: null, heldAfter: null }), "idle");
});

test("recording names, trim points and repeat times", () => {
  assert.equal(safeName('Sport: FC "Haarlem" / VV Velsen?'), "Sport - FC - Haarlem - VV Velsen");
  assert.equal(safeName("..."), "Recording");
  // 19:30 UTC on 1 Nov 2026 = 20:30 in Amsterdam (winter time).
  assert.equal(libraryFileName("Gemeenteraad live", Date.parse("2026-11-01T19:30:00Z"), "Europe/Amsterdam"), "Gemeenteraad live 2026-11-01 20.30.mp4");
  assert.equal(libraryPath(" Opnames / Raad ", "a.mp4"), "Opnames/Raad/a.mp4");
  assert.equal(libraryPath("", "a.mp4"), "a.mp4");
  assert.deepEqual(clampTrim(5000, 3_000_000, 60_000), { inMs: 5000, outMs: null });
  assert.deepEqual(clampTrim(-3, 20_000, 60_000), { inMs: 0, outMs: 20_000 });
  assert.deepEqual(clampTrim(10_000, 10_500, 60_000), { inMs: 10_000, outMs: null });
  assert.deepEqual(trimArgs("in.mp4", "out.mp4", 12_500, 42_500).slice(4, 10), ["-ss", "12.500", "-i", "in.mp4", "-t", "30.000"]);
  // Repeats in station time: next day 10:00 and the same evening 23:00; past ones are dropped.
  const started = Date.parse("2026-10-24T18:00:00Z"); // Saturday 20:00 summer time
  const now = Date.parse("2026-10-24T20:00:00Z");
  const r = repeatTimes(
    [
      { dayOffset: 1, time: "10:00", channelId: null },
      { dayOffset: 0, time: "23:00", channelId: 2 },
      { dayOffset: 0, time: "12:00", channelId: null },
    ],
    started,
    "Europe/Amsterdam",
    now,
  );
  // 25 Oct 2026 is the switch to winter time: 10:00 CET = 09:00 UTC.
  assert.deepEqual(
    r.map((x) => [new Date(x.at).toISOString(), x.channelId]),
    [
      ["2026-10-24T21:00:00.000Z", 2],
      ["2026-10-25T09:00:00.000Z", null],
    ],
  );
});

// ---- recorder on a real platform, with real ffmpeg for joining and cutting -------------

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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

test("live stream is recorded, joined, trimmed, put in the library and planned as a repeat", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "tvsm-rec-"));
  process.env.TVSM_DATA_DIR = join(root, "data");
  process.env.TVSM_CONF_DIR = join(root, "conf");
  process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
  // Two pieces of "stream": 20 s and 15 s (the contributor's connection dropped in between).
  const clips = join(root, "clips");
  mkdirSync(clips);
  const make = (name: string, secs: number) =>
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=320x180:rate=25`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", String(secs), "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-c:a", "aac", "-f", "mpegts", join(clips, name)]);
  make("a.ts", 20);
  make("b.ts", 15);
  const pieces = [join(clips, "a.ts"), join(clips, "b.ts")];

  let h!: ManagementHandles;
  const drivers: DriverFactory = { switcher: () => { throw new Error("no atem"); }, playout: () => new FakePlayout() };
  const p: Platform = await createPlatform(managementOptions({ drivers, autostart: false, onReady: (x) => (h = x) }));
  let cookie = "";
  const api = async (method: string, url: string, payload?: unknown) => {
    const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
    const set = res.headers["set-cookie"];
    if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
    return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body, headers: res.headers, raw: res.rawPayload };
  };
  try {
    assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
    const lib = join(root, "unas");
    mkdirSync(lib);
    await api("POST", "/api/media/sources", { name: "UNAS", type: "local", config: { path: lib } });
    assert.equal((await api("POST", "/api/studios", { name: "VR-CASPAR-TV-01", host: "10.40.5.12", role: "live" })).status, 200);
    const studio = (await api("GET", "/api/studios")).body.studios[0] as { id: number };
    const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId: null, studioId: studio.id, casparChannel: 1, playoutInput: 1 })).body;
    const cat = (await api("POST", "/api/categories", { name: "Politiek", color: "#7A3CFF" })).body;
    const src = (await api("POST", "/api/live-sources", { name: "Raadszaal", kind: "rtmp", atemInput: 2, studioId: studio.id, casparChannel: 1 })).body;
    const key = (await api("GET", "/api/live-sources")).body.sources[0].push.streamKey as string;
    // Per source: category Politiek, into the library, repeat the next day at 10:00.
    assert.equal((await api("PUT", `/api/recordings/sources/${src.id}`, { enabled: true, categoryId: cat.id, toLibrary: true, repeats: [{ dayOffset: 1, time: "10:00", channelId: null }] })).status, 200);
    assert.equal((await api("PUT", "/api/recordings/settings", { folder: "Opnames", graceSeconds: 60, postRollSeconds: 60, minSeconds: 5, keepDays: 7, minFreeGb: 0, mediaSourceId: null })).status, 200);

    // A programme with the live item: 20:00-21:00 station time.
    const t0 = Date.now() - 60_000;
    const block = (await api("POST", "/api/blocks", { name: "Raad live", items: [{ type: "live", liveSourceId: src.id, durationMs: 3600_000 }] })).body;
    await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: block.id, title: "Gemeenteraad live" });

    let online = false;
    h.remote.fetcher = (async () => new Response(JSON.stringify({ items: online ? [{ name: `live/${key}`, online: true, onlineTime: new Date(t0).toISOString(), tracks2: [{ codec: "H264" }], readers: [], inboundBytes: 1 }] : [] }), { headers: { "content-type": "application/json" } })) as never;
    const rec = h.recorder;
    const spawned: string[][] = [];
    rec.spawner = ((_cmd: string, args: string[]) => {
      spawned.push(args);
      const out = args[args.length - 1]!;
      copyFileSync(pieces[spawned.length - 1] ?? pieces[1]!, out);
      return new FakeProc();
    }) as never;
    let clock = Date.now();
    rec.now = () => clock;
    const poll = async (t: number) => {
      clock = t;
      await h.remote.poll();
    };

    await poll(clock);
    assert.equal(spawned.length, 0, "nothing comes in: no recording");
    online = true;
    await poll(clock + 3000);
    assert.equal(spawned.length, 1);
    // Reads as the management node from the ingest server on the studio node; no re-encode.
    assert.match(spawned[0]!.join(" "), new RegExp(`-i rtmp://10\\.40\\.5\\.12:1935/live/${key}\\?user=tvsm-management&pass=\\w+ .*-c copy -f mpegts`));
    let list = (await api("GET", "/api/recordings")).body;
    assert.equal(list.active.length, 1);
    assert.equal(list.recordings[0].status, "recording");
    assert.equal(list.recordings[0].title, "Gemeenteraad live", "named after the programme in the schedule");
    assert.equal(list.recordings[0].channelId, ch.id);
    assert.equal((await api("GET", "/api/recordings/sources")).body.sources[0].active, true);

    // The connection drops (ffmpeg ends) and comes back within the grace time: a second piece, same recording.
    online = false;
    await poll(clock + 3000);
    online = true;
    await poll(clock + 20_000);
    assert.equal(spawned.length, 1, "first piece's ffmpeg is still running in the fake");
    // Let the fake ffmpeg end, as it does when the stream stops.
    const procEnd = list.active[0];
    assert.ok(procEnd);
    (rec as unknown as { sessions: Map<number, { proc: FakeProc }> }).sessions.get(src.id)!.proc.kill();
    await new Promise((r) => setImmediate(r));
    await poll(clock + 5000);
    assert.equal(spawned.length, 2, "reconnected: a new piece");

    // Stream stops for good: after the grace time the recording is finished.
    online = false;
    (rec as unknown as { sessions: Map<number, { proc: FakeProc }> }).sessions.get(src.id)!.proc.kill();
    await poll(clock + 3000);
    assert.equal((await api("GET", "/api/recordings")).body.recordings[0].status, "recording");
    await poll(clock + 61_000);
    await rec.idle();
    await rec.idle();
    list = (await api("GET", "/api/recordings")).body;
    assert.equal(list.active.length, 0);
    let r = list.recordings[0];
    assert.equal(r.stopReason, "stream_end");
    assert.equal(r.status, "published", r.error ?? "");
    assert.ok(Math.abs(r.durationMs - 35_000) < 1500, `joined length ${r.durationMs}`);
    assert.equal(r.categoryId, cat.id);
    assert.ok(r.mediaPath.startsWith("Opnames/Gemeenteraad live "), r.mediaPath);
    assert.ok(existsSync(join(lib, ...r.mediaPath.split("/"))), "file is on the share");
    assert.equal(readdirSync(join(root, "data", "recordings")).filter((f) => f.endsWith(".ts")).length, 0, "pieces removed");

    // The media item is in the library with its category, schedulable.
    const media = (await api("GET", `/api/media?categoryId=${cat.id}`)).body.items as { id: number; durationMs: number; title: string; probeStatus: string }[];
    assert.equal(media.length, 1);
    assert.equal(media[0]!.id, r.mediaId);
    assert.equal(media[0]!.probeStatus, "ok");

    // The automatic repeat (next day 10:00) is planned.
    assert.equal(r.repeats.length, 1);
    assert.equal(r.repeats[0].channelId, ch.id);

    // Preview: the browser can seek in the video.
    const v = await api("GET", `/api/recordings/${r.id}/video`, undefined);
    assert.equal(v.status, 200);
    const part = await p.server.inject({ method: "GET", url: `/api/recordings/${r.id}/video`, headers: { cookie, range: "bytes=0-99" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.rawPayload.length, 100);
    const thumb = await p.server.inject({ method: "GET", url: `/api/recordings/${r.id}/thumb?t=5000`, headers: { cookie } });
    assert.equal(thumb.statusCode, 200);
    assert.equal(thumb.headers["content-type"], "image/jpeg");

    // Trim the start (contributor started early) and the end: the library file is replaced by the cut.
    const put = await api("PUT", `/api/recordings/${r.id}`, { title: "Gemeenteraad 1 november", categoryId: cat.id, trimInMs: 5000, trimOutMs: 30_000 });
    assert.equal(put.status, 200);
    await new Promise((res) => setTimeout(res, 20));
    await rec.idle();
    r = (await api("GET", `/api/recordings/${r.id}`)).body;
    assert.equal(r.status, "published", r.error ?? "");
    assert.equal(r.outdated, false);
    assert.equal(r.trimInMs, 5000);
    const m2 = (await api("GET", `/api/media?categoryId=${cat.id}`)).body.items[0];
    assert.equal(m2.id, r.mediaId, "same media item, so planned repeats follow the new cut");
    assert.ok(Math.abs(m2.durationMs - 25_000) < 2100, `trimmed length ${m2.durationMs}`);
    assert.equal(m2.title, "Gemeenteraad 1 november");

    // Plan another repeat by hand; a dry run lists what it would overlap.
    const at = new Date(Date.parse(r.repeats[0].startAt) + 10_000).toISOString();
    const dry = (await api("POST", `/api/recordings/${r.id}/repeats`, { channelId: ch.id, startAts: [at], dryRun: true })).body;
    assert.equal(dry.conflicts.length, 1, "overlaps the automatic repeat");
    const plan = (await api("POST", `/api/recordings/${r.id}/repeats`, { channelId: ch.id, startAts: [new Date(Date.now() + 3 * 86400_000).toISOString()] })).body;
    assert.equal(plan.ids.length, 1);
    r = (await api("GET", `/api/recordings/${r.id}`)).body;
    assert.equal(r.repeats.length, 2);
    assert.equal((await api("DELETE", `/api/recordings/${r.id}/repeats/${plan.ids[0]}`)).status, 200);
    assert.equal((await api("GET", `/api/recordings/${r.id}`)).body.repeats.length, 1);
    assert.equal((await api("POST", `/api/recordings/${r.id}/repeats`, { channelId: ch.id, startAts: ["2020-01-01T10:00:00Z"] })).status, 400);

    // A manual stop holds the source while the stream keeps coming in.
    spawned.length = 0;
    online = true;
    await poll(clock + 3000);
    assert.equal(spawned.length, 1);
    const running = (await api("GET", "/api/recordings")).body.active[0];
    assert.equal((await api("POST", `/api/recordings/${running.recordingId}/stop`)).status, 200);
    await poll(clock + 3000);
    assert.equal(spawned.length, 1, "held: no new recording while the same stream continues");
    await rec.idle();
    online = false;
    await poll(clock + 3000);
    online = true;
    await poll(clock + 3000);
    assert.equal(spawned.length, 2, "stream came back after stopping: recorded again");
  } finally {
    await p.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
