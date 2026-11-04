import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { ATEM_CONTROL_MIGRATIONS, ATEM_MIGRATIONS, registerAtem, type AtemLink } from "../server/atem.ts";
import { DIAGRAM_MIGRATIONS, registerDiagram } from "../server/diagram.ts";
import { HYPERDECK_MIGRATIONS } from "../server/legacy.ts";
import { MONITOR_MIGRATIONS } from "../server/monitoring.ts";
import { NODE_MIGRATIONS, PROVISION_MIGRATIONS, registerNodes } from "../server/nodes.ts";
import { realTeranexConnector, registerTeranex, TERANEX_MIGRATIONS, type TeranexLink } from "../server/teranex.ts";
import { applyBlock, emptySnapshot, normFormat, parseBlocks, sourceKey, teranexPreset, type TeranexSnapshot } from "../server/teranexlogic.ts";

const root = mkdtempSync(join(tmpdir(), "tvsm-teranex-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin";

/** Status dump as a Teranex AV sends it right after connecting (shape per the Teranex Ethernet Protocol). */
const DUMP = [
  "PROTOCOL PREAMBLE:\nVersion: 1.4\n\n",
  "TERANEX DEVICE:\nModel name: Teranex AV\nSoftware version: 3.1\nUnique ID: 7c2e0d0a1b2c\nLabel: Regie TX\n\n",
  "NETWORK:\nDynamic IP: false\nStatic address: 10.40.5.219\n\n",
  "VIDEO INPUT:\nVideo source: SDI\nAudio source: Embedded\nVideo mode: 1080i50\nSignal present: true\n\n",
  "VIDEO OUTPUT:\nVideo mode: 1080i50\nOutput option: Video\n\n",
  "GENLOCK:\nType: Input\nGen reference: Input\nSignal locked: true\n\n",
].join("");

test("protocol: blocks, partial chunks, ACK and the snapshot", () => {
  // Split in the middle of a block: the rest waits for the next chunk.
  const cut = DUMP.indexOf("Video mode: 1080i50");
  const a = parseBlocks(DUMP.slice(0, cut));
  assert.deepEqual(
    a.blocks.map((b) => b.header),
    ["PROTOCOL PREAMBLE", "TERANEX DEVICE", "NETWORK"],
  );
  const b = parseBlocks(a.rest + DUMP.slice(cut) + "ACK\n\n");
  assert.equal(b.rest, "");
  assert.deepEqual(
    b.blocks.map((x) => x.header),
    ["VIDEO INPUT", "VIDEO OUTPUT", "GENLOCK", "ACK"],
  );
  const s = emptySnapshot();
  for (const x of [...a.blocks, ...b.blocks]) applyBlock(s, x);
  assert.equal(s.model, "Teranex AV");
  assert.equal(s.protocolVersion, "1.4");
  assert.equal(s.softwareVersion, "3.1");
  assert.equal(s.label, "Regie TX");
  assert.deepEqual(s.input, { videoSource: "SDI", audioSource: "Embedded", videoMode: "1080i50", signalPresent: true });
  assert.deepEqual(s.output, { videoMode: "1080i50", option: "Video" });
  assert.deepEqual(s.genlock, { reference: "Input", locked: true });
  assert.equal(s.blocks.NETWORK!["Static address"], "10.40.5.219");
  assert.equal(s.blocks.ACK, undefined);
  // A later change block only updates what it carries; CRLF and odd casing are fine.
  applyBlock(s, parseBlocks("Video Input:\r\nSignal Present: false\r\n\r\n").blocks[0]!);
  assert.equal(s.input.signalPresent, false);
  assert.equal(s.input.videoMode, "1080i50");

  assert.equal(teranexPreset("Teranex AV"), "teranex-av");
  assert.equal(teranexPreset("Teranex Express"), "teranex-express");
  assert.equal(teranexPreset("Teranex 2D Processor"), "teranex-processor");
  assert.equal(teranexPreset(null), "teranex");
  assert.equal(normFormat("1080 I50"), "1080i50");
  assert.equal(sourceKey("SDI"), "sdi");
  assert.equal(sourceKey("Optical"), "optical");
  assert.equal(sourceKey("Embedded"), "embedded");
  assert.equal(sourceKey("Analog"), "analog");
});

class FakeTeranex extends EventEmitter implements TeranexLink {
  connected = false;
  state: TeranexSnapshot = (() => {
    const s = emptySnapshot();
    for (const b of parseBlocks(DUMP).blocks) applyBlock(s, b);
    return s;
  })();
  constructor(public host: string) {
    super();
  }
  up() {
    this.connected = true;
    this.emit("change");
  }
  set(fn: (s: TeranexSnapshot) => void) {
    fn(this.state);
    this.emit("change");
  }
  snapshot() {
    return this.connected ? structuredClone(this.state) : null;
  }
  async close() {
    this.connected = false;
  }
}

const fakes: FakeTeranex[] = [];
let p: Platform;
let cookie = "";
const call = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const BEFORE = [...NODE_MIGRATIONS, ...ATEM_MIGRATIONS, ...ATEM_CONTROL_MIGRATIONS, ...DIAGRAM_MIGRATIONS, ...HYPERDECK_MIGRATIONS, ...MONITOR_MIGRATIONS];

test.before(async () => {
  // A database from before: a HyperDeck on the diagram. After the upgrade it stays as an ordinary box.
  const old = await createPlatform({ app: { id: "orchestrator", name: "Orch", defaultPort: 0 }, migrations: BEFORE, register: () => {} });
  old.ctx.db.prepare("INSERT INTO hyperdecks (id, name, host) VALUES ('h1', 'Opname', '10.40.5.219')").run();
  old.ctx.db.prepare("INSERT INTO diagram_devices (id, kind, ref_id, name, device_type) VALUES ('d1', 'device', 'hyperdeck:h1', '', 'recorder')").run();
  await old.server.close();
  p = await createPlatform({
    app: { id: "orchestrator", name: "Orch", defaultPort: 0 },
    migrations: [...BEFORE, ...TERANEX_MIGRATIONS, ...PROVISION_MIGRATIONS],
    register: (s, pl) => {
      registerNodes(s, pl, { releases: async () => [] });
      const atem = registerAtem(s, pl, () => Object.assign(new EventEmitter(), { connected: false, snapshot: () => null, rename: async () => {}, switch: async () => {}, close: async () => {} }) as AtemLink);
      const tx = registerTeranex(s, pl, (host) => {
        const d = new FakeTeranex(host);
        fakes.push(d);
        return d;
      });
      registerDiagram(s, pl, atem.list, tx.list);
    },
  });
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("old HyperDeck diagram boxes become ordinary devices", () => {
  const row = p.ctx.db.prepare("SELECT kind, ref_id, name FROM diagram_devices WHERE id = 'd1'").get() as { kind: string; ref_id: string | null; name: string };
  assert.deepEqual({ ...row }, { kind: "device", ref_id: null, name: "Opname" });
});

test("register a Teranex, read its status, events on signal loss and format, diagram", async () => {
  assert.equal((await call("GET", "/api/teranex")).status, 401);
  await call("POST", "/api/auth/login", { username: "admin", password: "admin" });

  assert.equal((await call("POST", "/api/teranex", { name: "TX", host: "10.40.5.219; reboot" })).status, 400);
  assert.equal((await call("POST", "/api/teranex", { name: "TX", host: "10.40.5.219", expectedInput: "1080i50; x" })).status, 400);
  const add = await call("POST", "/api/teranex", { name: "Teranex Regie", host: "10.40.5.219", location: "Rack 1", expectedInput: "1080i50" });
  assert.equal(add.status, 200);
  const id = add.body.id;
  assert.equal(add.body.online, false);
  assert.equal(add.body.expectedInput, "1080i50");
  assert.equal((await call("POST", "/api/teranex", { name: "Dup", host: "10.40.5.219" })).status, 409);

  const dev = fakes.at(-1)!;
  assert.equal(dev.host, "10.40.5.219");
  dev.up();
  let d = await call("GET", `/api/teranex/${id}`);
  assert.equal(d.body.teranex.online, true);
  assert.equal(d.body.teranex.snapshot.model, "Teranex AV");
  assert.equal(d.body.teranex.snapshot.input.videoMode, "1080i50");
  assert.ok(d.body.events.some((e: { message: string }) => e.message.startsWith("Connected: Teranex AV")));

  // Input lost on the device (upstream switcher off): logged.
  dev.set((s) => (s.input.signalPresent = false));
  await new Promise((r) => setTimeout(r, 650));
  d = await call("GET", `/api/teranex/${id}`);
  assert.ok(d.body.events.some((e: { message: string }) => e.message.startsWith("No signal on the input")));

  // Back, with another format than expected.
  dev.set((s) => {
    s.input.signalPresent = true;
    s.input.videoMode = "1080p25";
  });
  await new Promise((r) => setTimeout(r, 650));
  d = await call("GET", `/api/teranex/${id}`);
  const msgs = d.body.events.map((e: { message: string }) => e.message);
  assert.ok(msgs.includes("Input format 1080i50 → 1080p25"));
  assert.ok(msgs.includes("Input is 1080p25, expected 1080i50"));
  assert.ok(msgs.some((m: string) => m.startsWith("Input signal back")));

  // Admins can set the expected format afterwards.
  const ed = await call("PUT", `/api/teranex/${id}`, { name: "Teranex Regie", host: "10.40.5.219", expectedInput: "1080p25" });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.expectedInput, "1080p25");

  // Diagram: placed with the connectors of its model, shown as kind teranex.
  let g = await call("GET", "/api/diagram");
  assert.deepEqual(g.body.available.teranexes.map((x: { id: string }) => x.id), [id]);
  const placed = await call("POST", "/api/diagram/devices", { kind: "teranex", refId: id });
  assert.equal(placed.status, 200);
  assert.equal((await call("POST", "/api/diagram/devices", { kind: "teranex", refId: id })).status, 409);
  g = await call("GET", "/api/diagram");
  const box = g.body.devices.find((x: { id: string }) => x.id === placed.body.id);
  assert.equal(box.kind, "teranex");
  assert.equal(box.refId, id);
  assert.equal(box.name, "Teranex Regie");
  assert.equal(box.deviceType, "converter");
  assert.equal(box.teranex.input, "1080p25");
  assert.ok(box.ports.some((x: { label: string; dir: string }) => x.label === "12G-SDI In" && x.dir === "in"));
  assert.ok(box.ports.some((x: { label: string }) => x.label === "HDMI Out"));

  // Removing the Teranex removes its diagram box.
  assert.equal((await call("DELETE", `/api/teranex/${id}`)).status, 200);
  g = await call("GET", "/api/diagram");
  assert.ok(!g.body.devices.some((x: { id: string }) => x.id === placed.body.id));
  assert.equal(dev.connected, false);
});

test("real connector against a fake Teranex: reads the dump, only ever sends PING", async () => {
  const received: string[] = [];
  const socks: Socket[] = [];
  const srv = createServer((sock) => {
    socks.push(sock);
    sock.setEncoding("utf8");
    sock.on("data", (c: string) => {
      received.push(c);
      if (c.includes("PING")) sock.write("ACK\n\n");
    });
    // The device sends its status in a few pieces.
    sock.write(DUMP.slice(0, 40));
    setTimeout(() => sock.write(DUMP.slice(40)), 20);
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as AddressInfo).port;
  const link = realTeranexConnector(`127.0.0.1:${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no snapshot")), 3000);
      link.on("change", () => {
        if (link.snapshot()?.output.videoMode) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    const s = link.snapshot()!;
    assert.equal(s.model, "Teranex AV");
    assert.equal(s.input.videoSource, "SDI");
    assert.equal(s.input.audioSource, "Embedded");
    assert.equal(s.input.videoMode, "1080i50");
    assert.equal(s.output.videoMode, "1080i50");
    // A change pushed by the device.
    socks[0]!.write("VIDEO INPUT:\nSignal present: false\n\n");
    await once(link, "change");
    assert.equal(link.snapshot()!.input.signalPresent, false);
    // Read only: nothing but keep-alives went to the device.
    assert.ok(received.join("").replace(/PING:\n\n/g, "") === "", `unexpected data sent: ${JSON.stringify(received)}`);
  } finally {
    await link.close();
    for (const s of socks) s.destroy();
    srv.close();
  }
});
