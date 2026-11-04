import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { KILOVIEW_MIGRATIONS, RealKiloviewClient, registerKiloview } from "../server/kiloview.ts";
import { allowedPath, kiloviewIssues, maskSecrets, maskUrl, parseDecoder, parseEncoder, runningKeys, shortFormat } from "../server/kiloviewlogic.ts";
import { HYPERDECK_MIGRATIONS } from "../server/legacy.ts";
import { MONITOR_MIGRATIONS, registerMonitoring } from "../server/monitoring.ts";
import { NODE_MIGRATIONS, PROVISION_MIGRATIONS } from "../server/nodes.ts";
import { ATEM_CONTROL_MIGRATIONS, ATEM_MIGRATIONS } from "../server/atem.ts";
import { DIAGRAM_MIGRATIONS } from "../server/diagram.ts";
import { TERANEX_MIGRATIONS } from "../server/teranex.ts";
import { D260, E3 } from "./kiloviewFixtures.ts";

const root = mkdtempSync(join(tmpdir(), "tvsm-kiloview-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin";

test("formats, masking and the allowlist", () => {
  assert.equal(shortFormat("1920x1080i 50Hz"), "1080i50");
  assert.equal(shortFormat("1920x1080P50"), "1080p50");
  assert.equal(shortFormat("1920x1080p25"), "1080p25");
  assert.equal(shortFormat("1920x1080 25Hz"), "1080 25Hz");
  assert.equal(shortFormat("0x0 0Hz"), null);
  assert.equal(shortFormat("0x0p30"), null);

  assert.equal(maskUrl("rtmp://10.40.2.43:1935/live/SECRETKEY"), "rtmp://10.40.2.43:1935/live/***");
  assert.equal(maskUrl("rtmp://user:pw@host/live/key?x=1"), "rtmp://***@host/live/***?x=1");
  assert.equal(maskUrl("srt://10.31.50.244:1025?passphrase=abc&latency=125"), "srt://10.31.50.244:1025?passphrase=***&latency=125");
  assert.equal(maskUrl("srt://10.31.50.244:1025"), "srt://10.31.50.244:1025");
  const m = maskSecrets({ password: "x", passphrase: "", token: "t", list: [{ addressUrl: "rtmp://h/live/k" }], latency: 125 }) as Record<string, unknown>;
  assert.deepEqual(m, { password: "***", passphrase: "", token: "***", list: [{ addressUrl: "rtmp://h/live/***" }], latency: 125 });

  // Reboot / restore / factory reset are plain GETs on these boxes: never allowed.
  for (const p of ["/api/systemctrl/system/reboot", "/api/systemctrl/system/restore", "/api/systemctrl/system/reFactory", "/api/codec/vin/edid/reset", "/api/streamer/hdmi/stream/enable"])
    assert.equal(allowedPath("encoder", "GET", p), false, p);
  for (const p of ["/api/sys/reboot", "/api/sys/restore", "/api/source/refresh", "/api/output/get?output_id=1&x=reboot"]) assert.equal(allowedPath("decoder", "GET", p), false, p);
  assert.equal(allowedPath("encoder", "GET", "/api/codec/hdmi/vin/detail"), true);
  assert.equal(allowedPath("decoder", "GET", "/api/output/get?output_id=2"), true);
  assert.equal(allowedPath("encoder", "POST", "/api/systemctrl/users/login"), true);
  assert.equal(allowedPath("encoder", "POST", "/api/streamer/hdmi/stream/enable"), false);
  assert.equal(allowedPath("decoder", "POST", "/api/users/login"), true);
});

test("E3 status: input, encoder and streams", () => {
  const s = { ...parseEncoder({ system: E3.system.data, active: E3.active, detail: E3.hdmi, venc: E3.venc, audio: E3.audio, streams: E3.streams, network: E3.network.data }), raw: {} };
  assert.equal(s.product, "E3");
  assert.equal(s.firmware, "1.26.0013.0102");
  const e = s.encoder!;
  assert.equal(e.activeInput, "HDMI");
  assert.deepEqual(e.input, { signal: true, format: "1080i50", raw: "1920x1080i 50Hz" });
  assert.equal(e.video!.bitrateKbps, 10000);
  assert.equal(e.video!.codec, "H264");
  assert.equal(e.audio!.channels, 8);
  assert.deepEqual(
    e.streams.map((x) => [x.name, x.type, x.enabled, x.running, x.target]),
    [
      ["NDI-HX", "ndi_hx", false, false, ""],
      ["Velsen-GH", "srt", true, true, "srt://10.31.50.244:1025"],
      ["Webstream", "rtmp", true, true, "rtmp://10.40.2.43:1935/live/***"],
    ],
  );
  assert.equal(e.network!.txKbps, 20202.89);
  assert.deepEqual(runningKeys(s), ["575a343176a62416", "5ee592a4f22cddfa"]);
  const base = { online: true, lastSeenAt: null, watch: runningKeys(s), snapshot: s };
  assert.deepEqual(kiloviewIssues(base), []);
  assert.deepEqual(kiloviewIssues({ ...base, expectedFormat: "1080i50" }), []);
  assert.deepEqual(kiloviewIssues({ ...base, expectedFormat: "1080p50" }), [{ code: "input_format", level: "warn", params: { got: "1080i50", want: "1080p50" } }]);

  // HDMI cable out: no signal; the SRT link to Velsen drops: stream stopped.
  const lost = structuredClone(s);
  lost.encoder!.input = { signal: false, format: null, raw: "0x0 0Hz" };
  lost.encoder!.streams[1]!.running = false;
  assert.deepEqual(kiloviewIssues({ ...base, snapshot: lost }), [
    { code: "no_input_signal", level: "down" },
    { code: "stream_stopped", level: "down", params: { name: "Velsen-GH" } },
  ]);
  assert.equal(kiloviewIssues({ ...base, online: false })[0]!.code, "device_offline");
});

test("D260 status: outputs, sources, health", () => {
  const s = { ...parseDecoder({ system: D260.system.data, outputs: D260.outputs.data, details: { "1": D260.out1.data, "2": D260.out2.data }, codec: D260.codec.data }), raw: {} };
  assert.equal(s.product, "D260");
  assert.equal(s.firmware, "2.20.0732.0901");
  assert.equal(s.hostname, "D260-2011140024275");
  const d = s.decoder!;
  assert.deepEqual([d.cpu, d.mem, d.temperature], [3.88, 25, 44]);
  const [o1, o2] = d.outputs;
  assert.deepEqual({ ...o2, source: o2!.source }, { id: "2", connector: "SDI", format: "1080p50", source: { name: "Stella Studio (SRT)", type: "srt", url: "srt:" }, playing: true, streamFormat: "1080p25", bitrateKbps: 9849, codec: "H.264" });
  assert.equal(o1!.connector, "HDMI1");
  assert.equal(o1!.playing, false);
  assert.equal(o1!.streamFormat, null);
  assert.equal(o1!.bitrateKbps, null);
  assert.equal(o1!.source!.url, "rtmp://10.31.50.244:1935/live/***");
  // Only the SDI output (TV) is on air; the drone input on HDMI1 is usually empty.
  assert.deepEqual(runningKeys(s), ["2"]);
  const base = { online: true, lastSeenAt: null, watch: ["2"], snapshot: s };
  assert.deepEqual(kiloviewIssues(base), []);
  assert.deepEqual(kiloviewIssues({ ...base, expectedFormat: "1080i50" }), [{ code: "output_format", level: "warn", params: { name: "SDI", got: "1080p50", want: "1080i50" } }]);
  assert.deepEqual(kiloviewIssues({ ...base, watch: ["1", "2"] }), [{ code: "decode_stopped", level: "down", params: { name: "HDMI1", source: "drone" } }]);
  const hot = structuredClone(s);
  hot.decoder!.temperature = 80;
  assert.deepEqual(kiloviewIssues({ ...base, snapshot: hot }), [{ code: "temp_high", level: "warn", params: { deg: 80 } }]);
});

// ---- a fake box on localhost that answers like the real ones and records every request ---------------------

interface Fake {
  server: Server;
  host: string;
  requests: string[];
  token: string;
  /** Changes the answers (e.g. signal lost). */
  state: { e3: typeof E3; d260: typeof D260 };
  down: boolean;
}
async function fakeBox(kind: "encoder" | "decoder"): Promise<Fake> {
  const f: Fake = { server: null!, host: "", requests: [], token: "tok-1", state: { e3: structuredClone(E3), d260: structuredClone(D260) }, down: false };
  const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = (req: IncomingMessage) => new Promise<string>((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
  f.server = createServer(async (req, res) => {
    const url = req.url ?? "";
    f.requests.push(`${req.method} ${url}`);
    if (f.down) return req.socket.destroy();
    if (kind === "encoder") {
      if (url === "/api/systemctrl/users/login") {
        const b = JSON.parse(await body(req));
        return b.username === "admin" && b.password === "pw" ? json(res, 200, { result: "ok", data: { token: f.token, alias: "admin" } }) : json(res, 200, { result: "error", msg: "Unauthorized" });
      }
      if (req.headers.authorization !== f.token) return json(res, 200, { result: "error", msg: "Unauthorized" });
      const e = f.state.e3;
      const map: Record<string, unknown> = {
        "/api/systemctrl/system/getSystemInfo?version=true": e.system,
        "/api/codec/vin/active_interface": e.active,
        "/api/codec/hdmi/vin/detail": e.hdmi,
        "/api/codec/hdmi/venc/settings": e.venc,
        "/api/codec/hdmi/audio/input": e.audio,
        "/api/streamer/hdmi/stream/list": e.streams,
        "/api/systemctrl/system/getNetworkSpeed": e.network,
      };
      return url in map ? json(res, 200, map[url]) : json(res, 404, { result: "error", msg: "not found" });
    }
    if (url === "/api/users/login") {
      const b = JSON.parse(await body(req));
      return b.username === "admin" && b.password === "pw" ? json(res, 200, { result: "ok", data: { token: f.token, user: "admin", alias: "超级管理员" } }) : json(res, 200, { result: "error", msg: "3" });
    }
    let app: Record<string, unknown> = {};
    try {
      app = JSON.parse(String(req.headers.app ?? "{}"));
    } catch {}
    if (app.token !== f.token) return json(res, 200, { result: "error", msg: "2" });
    const d = f.state.d260;
    const map: Record<string, unknown> = {
      "/api/report/system_info": d.system,
      "/api/output/list": d.outputs,
      "/api/output/get?output_id=1": d.out1,
      "/api/output/get?output_id=2": d.out2,
      "/api/report/codec_info": d.codec,
    };
    return url in map ? json(res, 200, map[url]) : json(res, 200, { result: "error", msg: "404" });
  });
  await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
  f.host = `127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  return f;
}

test("real client: logs in, reads only allowlisted pages, logs in again when the session runs out", async () => {
  const e3 = await fakeBox("encoder");
  const d260 = await fakeBox("decoder");
  try {
    const c = new RealKiloviewClient({ kind: "encoder", host: e3.host, username: "admin", password: "pw" });
    let s = await c.poll();
    assert.equal(s.encoder!.input.format, "1080i50");
    assert.equal(s.encoder!.streams.length, 3);
    assert.ok(JSON.stringify(s.raw).includes("live/***"));
    assert.ok(!JSON.stringify(s).includes("SECRETKEY"));
    // The box forgot the session: one new login, then the same reads.
    e3.token = "tok-2";
    s = await c.poll();
    assert.equal(s.product, "E3");
    assert.equal(e3.requests.filter((r) => r.includes("login")).length, 2);
    for (const r of e3.requests) {
      const [m, p] = r.split(" ") as ["GET" | "POST", string];
      assert.ok(allowedPath("encoder", m, p), r);
    }

    const d = new RealKiloviewClient({ kind: "decoder", host: d260.host, username: "admin", password: "pw" });
    const ds = await d.poll();
    assert.equal(ds.decoder!.outputs[1]!.playing, true);
    assert.equal(ds.decoder!.outputs[1]!.connector, "SDI");
    for (const r of d260.requests) {
      const [m, p] = r.split(" ") as ["GET" | "POST", string];
      assert.ok(allowedPath("decoder", m, p), r);
    }

    await assert.rejects(new RealKiloviewClient({ kind: "encoder", host: e3.host, username: "admin", password: "wrong" }).poll(), /login_failed/);
  } finally {
    e3.server.close();
    d260.server.close();
  }
});

let p: Platform;
let cookie = "";
const call = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

test("API: register, watch list, events on problems, monitoring layer, password never shown", async () => {
  const e3 = await fakeBox("encoder");
  const d260 = await fakeBox("decoder");
  let kv!: ReturnType<typeof registerKiloview>;
  p = await createPlatform({
    app: { id: "orchestrator", name: "Orch", defaultPort: 0 },
    migrations: [...NODE_MIGRATIONS, ...ATEM_MIGRATIONS, ...ATEM_CONTROL_MIGRATIONS, ...DIAGRAM_MIGRATIONS, ...HYPERDECK_MIGRATIONS, ...MONITOR_MIGRATIONS, ...TERANEX_MIGRATIONS, ...PROVISION_MIGRATIONS, ...KILOVIEW_MIGRATIONS],
    register: (s, pl) => {
      kv = registerKiloview(s, pl, undefined, 3_600_000);
      registerMonitoring(s, pl, { nodes: () => [], atems: () => [], kiloviews: kv.list }, undefined, 3_600_000);
    },
  });
  try {
    assert.equal((await call("GET", "/api/kiloview")).status, 401);
    await call("POST", "/api/auth/login", { username: "admin", password: "admin" });

    const bad = await call("POST", "/api/kiloview/test", { name: "E3", kind: "encoder", host: e3.host, username: "admin", password: "nope" });
    assert.deepEqual(bad.body, { ok: false, error: "login_failed" });
    const ok = await call("POST", "/api/kiloview/test", { name: "E3", kind: "encoder", host: e3.host, username: "admin", password: "pw" });
    assert.deepEqual(ok.body, { ok: true, product: "E3", firmware: "1.26.0013.0102" });

    assert.equal((await call("POST", "/api/kiloview", { name: "E3", kind: "encoder", host: "10.40.5.52; reboot", username: "admin", password: "pw" })).status, 400);
    const a = await call("POST", "/api/kiloview", { name: "E3 Beverwijk", kind: "encoder", host: e3.host, username: "admin", password: "pw", location: "Beverwijk", expectedFormat: "1080i50" });
    assert.equal(a.status, 200);
    assert.equal(a.body.hasPassword, true);
    assert.ok(!JSON.stringify(a.body).includes('"pw"'));
    const stored = p.ctx.db.prepare("SELECT password FROM kiloviews WHERE id = ?").get(a.body.id) as { password: string };
    assert.match(stored.password, /^enc:v1:/);
    const b = await call("POST", "/api/kiloview", { name: "D260 Velsen", kind: "decoder", host: d260.host, username: "admin", password: "pw", expectedFormat: "1080p50" });
    assert.equal((await call("POST", "/api/kiloview", { name: "Dup", kind: "decoder", host: d260.host, username: "admin", password: "pw" })).status, 409);

    await kv.pollAll();
    let e = (await call("GET", `/api/kiloview/${a.body.id}`)).body;
    assert.equal(e.kiloview.online, true);
    // What ran at first contact is watched: the SRT link and the web stream.
    assert.deepEqual(e.kiloview.watch, ["575a343176a62416", "5ee592a4f22cddfa"]);
    assert.deepEqual(e.kiloview.issues, []);
    assert.ok(e.events.some((x: { message: string }) => x.message.startsWith("Connected: E3")));
    let d = (await call("GET", `/api/kiloview/${b.body.id}`)).body;
    assert.deepEqual(d.kiloview.watch, ["2"]);

    // The SRT link drops and the decoder loses its picture.
    e3.state.e3.streams[1]!.status = "stop";
    d260.state.d260.out2.data.position[0]!.status = 3;
    await kv.pollAll();
    await kv.pollAll();
    e = (await call("GET", `/api/kiloview/${a.body.id}`)).body;
    assert.deepEqual(e.kiloview.issues, [{ code: "stream_stopped", level: "down", params: { name: "Velsen-GH" } }]);
    assert.equal(e.events.filter((x: { message: string }) => x.message === 'Stream "Velsen-GH" stopped').length, 1);
    d = (await call("GET", `/api/kiloview/${b.body.id}`)).body;
    assert.equal(d.kiloview.issues[0].code, "decode_stopped");

    const mon = (await call("GET", "/api/monitoring")).body;
    assert.equal(mon.kiloviews.length, 2);
    const md = mon.kiloviews.find((x: { kind: string }) => x.kind === "decoder");
    assert.equal(md.health, "down");
    assert.deepEqual(md.outputs.map((o: { connector: string }) => o.connector), ["SDI"]);
    const me = mon.kiloviews.find((x: { kind: string }) => x.kind === "encoder");
    assert.deepEqual(me.input, { source: "HDMI", format: "1080i50", signal: true });
    assert.equal(mon.summary.down, 2);

    // Back again.
    e3.state.e3.streams[1]!.status = "start";
    d260.state.d260.out2.data.position[0]!.status = 2;
    await kv.pollAll();
    e = (await call("GET", `/api/kiloview/${a.body.id}`)).body;
    assert.deepEqual(e.kiloview.issues, []);
    assert.ok(e.events.some((x: { message: string }) => x.message === 'Resolved: Stream "Velsen-GH" stopped'));

    // The web stream is not important: unwatch it; stopping it is then no problem.
    const w = await call("PUT", `/api/kiloview/${a.body.id}/watch`, { watch: ["575a343176a62416"] });
    assert.deepEqual(w.body.watch, ["575a343176a62416"]);
    e3.state.e3.streams[2]!.status = "stop";
    await kv.pollAll();
    assert.deepEqual((await call("GET", `/api/kiloview/${a.body.id}`)).body.kiloview.issues, []);

    // Edit without a password keeps the stored one.
    const ed = await call("PUT", `/api/kiloview/${a.body.id}`, { name: "E3 Studio", kind: "encoder", host: e3.host, username: "admin", password: "" });
    assert.equal(ed.status, 200);
    await kv.pollAll();
    assert.equal((await call("GET", `/api/kiloview/${a.body.id}`)).body.kiloview.online, true);

    // Offline after two failed polls.
    e3.down = true;
    await kv.pollAll();
    await kv.pollAll();
    e = (await call("GET", `/api/kiloview/${a.body.id}`)).body;
    assert.equal(e.kiloview.online, false);
    assert.equal(e.kiloview.issues[0].code, "device_offline");

    // Nothing but login and allowlisted reads ever reached the boxes.
    for (const [kind, f] of [["encoder", e3], ["decoder", d260]] as const)
      for (const r of f.requests) {
        const [m, path] = r.split(" ") as ["GET" | "POST", string];
        assert.ok(allowedPath(kind, m, path), r);
      }

    assert.equal((await call("DELETE", `/api/kiloview/${b.body.id}`)).status, 200);
    assert.equal((await call("GET", "/api/kiloview")).body.kiloviews.length, 1);
  } finally {
    e3.server.close();
    d260.server.close();
    await p.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
