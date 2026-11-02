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
import { HYPERDECK_MIGRATIONS, realHyperdeckConnector, registerHyperdecks, type HyperdeckLink, type TransportAction } from "../server/hyperdeck.ts";
import { cleanClipName, formatDuration, hyperdeckPreset, recordTimeLeft, type HyperdeckSnapshot } from "../server/hyperdecklogic.ts";
import { NODE_MIGRATIONS, registerNodes } from "../server/nodes.ts";

const root = mkdtempSync(join(tmpdir(), "tvsm-hyperdeck-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin";

const snap = (): HyperdeckSnapshot => ({
  model: "HyperDeck Studio 4K Pro",
  protocolVersion: 1.11,
  transport: { status: "stopped", speed: 0, slotId: 1, clipId: null, timecode: "00:00:00:00", displayTimecode: "00:00:00:00", videoFormat: "1080i50", inputVideoFormat: "1080i50", loop: false },
  slots: [
    { id: 1, status: "mounted", volumeName: "SSD1", recordingTime: 7200, videoFormat: "1080i50" },
    { id: 2, status: "empty", volumeName: "", recordingTime: 0, videoFormat: null },
  ],
  videoInput: "SDI",
  fileFormat: "QuickTimeProRes",
  remoteEnabled: true,
});

class FakeDeck extends EventEmitter implements HyperdeckLink {
  connected = false;
  state = snap();
  calls: [TransportAction, string | undefined][] = [];
  fail = false;
  constructor(public host: string) {
    super();
  }
  up() {
    this.connected = true;
    this.emit("change");
  }
  snapshot() {
    return this.connected ? structuredClone(this.state) : null;
  }
  async transport(action: TransportAction, clipName?: string) {
    if (this.fail) throw new Error("111 remote control disabled");
    this.calls.push([action, clipName]);
    this.state.transport.status = action === "record" ? "record" : action === "play" ? "play" : "stopped";
  }
  async close() {
    this.connected = false;
  }
}

const decks: FakeDeck[] = [];
let p: Platform;
let cookie = "";
const call = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

test.before(async () => {
  p = await createPlatform({
    app: { id: "orchestrator", name: "Orch", defaultPort: 0 },
    migrations: [...NODE_MIGRATIONS, ...ATEM_MIGRATIONS, ...ATEM_CONTROL_MIGRATIONS, ...DIAGRAM_MIGRATIONS, ...HYPERDECK_MIGRATIONS],
    register: (s, pl) => {
      registerNodes(s, pl);
      const atem = registerAtem(s, pl, () => Object.assign(new EventEmitter(), { connected: false, snapshot: () => null, rename: async () => {}, switch: async () => {}, close: async () => {} }) as AtemLink);
      const hd = registerHyperdecks(s, pl, (host) => {
        const d = new FakeDeck(host);
        decks.push(d);
        return d;
      });
      registerDiagram(s, pl, atem.list, hd.list);
    },
  });
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("helpers: preset per model, time left, clip names", () => {
  assert.equal(hyperdeckPreset("HyperDeck Studio 4K Pro"), "hyperdeck-studio-pro");
  assert.equal(hyperdeckPreset("HyperDeck Studio HD Plus"), "hyperdeck-studio-pro");
  assert.equal(hyperdeckPreset("HyperDeck Studio HD Mini"), "hyperdeck-studio-hd-mini");
  assert.equal(hyperdeckPreset("HyperDeck Extreme 8K HDR"), "hyperdeck-extreme");
  assert.equal(hyperdeckPreset(null), "hyperdeck");
  const s = snap();
  assert.equal(recordTimeLeft(s), 7200);
  s.slots[0]!.status = "empty";
  assert.equal(recordTimeLeft(s), null);
  assert.equal(formatDuration(7260), "2h 01m");
  assert.equal(formatDuration(75), "1m 15s");
  assert.equal(cleanClipName("  Raad: 3/11 \r\nvergadering é "), "Raad 311 vergadering e");
});

test("register a HyperDeck, read its state, record / stop, place it on the diagram", async () => {
  assert.equal((await call("GET", "/api/hyperdecks")).status, 401);
  await call("POST", "/api/auth/login", { username: "admin", password: "admin" });

  assert.equal((await call("POST", "/api/hyperdecks", { name: "Rec", host: "10.40.5.219; reboot" })).status, 400);
  const add = await call("POST", "/api/hyperdecks", { name: "Opname 1", host: "10.40.5.219", location: "Rack 2" });
  assert.equal(add.status, 200);
  const id = add.body.id;
  assert.equal(add.body.online, false);
  assert.equal((await call("POST", "/api/hyperdecks", { name: "Dup", host: "10.40.5.219" })).status, 409);
  assert.equal((await call("POST", `/api/hyperdecks/${id}/transport`, { action: "record" })).status, 409);

  const deck = decks.at(-1)!;
  assert.equal(deck.host, "10.40.5.219");
  deck.up();
  let d = await call("GET", `/api/hyperdecks/${id}`);
  assert.equal(d.body.deck.online, true);
  assert.equal(d.body.deck.snapshot.model, "HyperDeck Studio 4K Pro");
  assert.equal(d.body.events[0].type, "online");

  const rec = await call("POST", `/api/hyperdecks/${id}/transport`, { action: "record", clipName: "Raad / 3 nov" });
  assert.equal(rec.status, 200);
  assert.deepEqual(deck.calls.at(-1), ["record", "Raad 3 nov"]);
  assert.equal(rec.body.snapshot.transport.status, "record");

  await call("POST", `/api/hyperdecks/${id}/transport`, { action: "stop" });
  assert.deepEqual(deck.calls.at(-1), ["stop", undefined]);
  d = await call("GET", `/api/hyperdecks/${id}`);
  assert.match(d.body.events[0].message, /Stop by admin/);
  assert.match(d.body.events[1].message, /Record "Raad 3 nov" by admin/);

  // Remote switched off on the deck: a clear error.
  deck.fail = true;
  deck.state.remoteEnabled = false;
  assert.equal((await call("POST", `/api/hyperdecks/${id}/transport`, { action: "play" })).body.error, "remote_disabled");
  deck.fail = false;
  // No media mounted: recording is refused before the deck is asked.
  deck.state.slots[0]!.status = "empty";
  assert.equal((await call("POST", `/api/hyperdecks/${id}/transport`, { action: "record" })).body.error, "no_media");
  deck.state.slots[0]!.status = "mounted";

  // Diagram: available, placed with the ports of its model, shown with live status.
  let g = await call("GET", "/api/diagram");
  assert.deepEqual(g.body.available.hyperdecks.map((h: { id: string }) => h.id), [id]);
  const placed = await call("POST", "/api/diagram/devices", { kind: "hyperdeck", refId: id, x: 0, y: 0 });
  assert.equal(placed.status, 200);
  assert.equal((await call("POST", "/api/diagram/devices", { kind: "hyperdeck", refId: id })).status, 409);
  assert.equal((await call("POST", "/api/diagram/devices", { kind: "hyperdeck", refId: "nope" })).status, 400);
  g = await call("GET", "/api/diagram");
  const box = g.body.devices.find((x: { id: string }) => x.id === placed.body.id);
  assert.equal(box.kind, "hyperdeck");
  assert.equal(box.refId, id);
  assert.equal(box.name, "Opname 1");
  assert.equal(box.online, true);
  assert.equal(box.hyperdeck.model, "HyperDeck Studio 4K Pro");
  assert.deepEqual(
    box.ports.map((x: { label: string; dir: string }) => `${x.dir}:${x.label}`),
    ["in:SDI In", "in:HDMI In", "out:SDI Out A", "out:SDI Out B", "out:SDI Monitor Out", "out:HDMI Out"],
  );
  assert.equal(g.body.available.hyperdecks.length, 0);

  // Removing the deck from the inventory removes its diagram box.
  assert.equal((await call("DELETE", `/api/hyperdecks/${id}`)).status, 200);
  g = await call("GET", "/api/diagram");
  assert.equal(g.body.devices.some((x: { id: string }) => x.id === placed.body.id), false);
});

/** A minimal HyperDeck speaking the Ethernet protocol, to check the real connector end to end. */
function fakeHyperdeckServer() {
  const seen: string[] = [];
  let status = "stopped";
  let client: Socket | null = null;
  const block = (code: string, lines: Record<string, string | number | boolean>) => `${code}:\r\n${Object.entries(lines).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  const server = createServer((sock) => {
    client = sock;
    sock.write(block("500 connection info", { "protocol version": "1.11", model: "HyperDeck Studio 4K Pro" }));
    let buf = "";
    let pending: string[] = [];
    sock.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        // Commands with parameters come as "name:" + "key: value" lines + a blank line.
        if (pending.length) {
          if (raw) {
            pending.push(raw);
            continue;
          }
        } else if (!raw) continue;
        else if (raw.endsWith(":")) {
          pending = [raw];
          continue;
        }
        const line = pending.length ? pending.join(" ") : raw;
        pending = [];
        seen.push(line);
        if (line === "device info") sock.write(block("204 device info", { "protocol version": "1.11", model: "HyperDeck Studio 4K Pro", "slot count": 2 }));
        else if (line === "transport info") sock.write(block("208 transport info", { status, speed: 0, "slot id": 1, "clip id": 1, "single clip": false, "display timecode": "10:00:00:00", timecode: "10:00:00:00", "video format": "1080i50", loop: false }));
        else if (line.startsWith("slot info")) {
          const id = Number(/slot id: (\d)/.exec(line)?.[1] ?? 1);
          sock.write(block("202 slot info", id === 1 ? { "slot id": 1, status: "mounted", "volume name": "SSD1", "recording time": 5400, "video format": "1080i50" } : { "slot id": 2, status: "empty", "volume name": "", "recording time": 0, "video format": "1080i50" }));
        } else if (line === "configuration") sock.write(block("211 configuration", { "video input": "SDI", "audio input": "embedded", "file format": "QuickTimeProRes" }));
        else if (line === "remote") sock.write(block("210 remote info", { enabled: true, override: false }));
        else if (line.startsWith("record")) {
          status = "record";
          sock.write("200 ok\r\n");
          sock.write(block("508 transport info", { status: "record" }));
        } else if (line === "stop") {
          status = "stopped";
          sock.write("200 ok\r\n");
          sock.write(block("508 transport info", { status: "stopped" }));
        } else sock.write("200 ok\r\n");
      }
    });
  });
  return { server, seen, close: () => (client?.destroy(), server.close()) };
}

test("real connector talks the HyperDeck Ethernet protocol", async () => {
  const fake = fakeHyperdeckServer();
  fake.server.listen(0, "127.0.0.1");
  await once(fake.server, "listening");
  const port = (fake.server.address() as AddressInfo).port;
  const link = realHyperdeckConnector(`127.0.0.1:${port}`);
  try {
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 30));
      assert.ok(ok());
    };
    await until(() => link.connected);
    const s = link.snapshot()!;
    assert.equal(s.model, "HyperDeck Studio 4K Pro");
    assert.equal(s.transport.status, "stopped");
    assert.equal(s.transport.displayTimecode, "10:00:00:00");
    assert.deepEqual(s.slots.map((x) => [x.id, x.status, x.recordingTime]), [[1, "mounted", 5400], [2, "empty", 0]]);
    assert.equal(s.videoInput, "SDI");
    assert.equal(s.remoteEnabled, true);
    assert.ok(fake.seen.some((l) => l.startsWith("notify")));

    await link.transport("record", "Raad 3 nov");
    assert.ok(fake.seen.some((l) => l.startsWith("record") && l.includes("Raad 3 nov")));
    await until(() => link.snapshot()?.transport.status === "record");
    await link.transport("stop");
    await until(() => link.snapshot()?.transport.status === "stopped");
  } finally {
    await link.close();
    fake.close();
  }
});
