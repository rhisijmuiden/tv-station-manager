import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { ATEM_CONTROL_MIGRATIONS, ATEM_MIGRATIONS, registerAtem, type AtemLink, type AtemSnapshot, type SwitchAction } from "../server/atem.ts";
import { DIAGRAM_MIGRATIONS, registerDiagram } from "../server/diagram.ts";
import { NODE_MIGRATIONS, registerNodes } from "../server/nodes.ts";

const root = mkdtempSync(join(tmpdir(), "tvsm-atem-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin";

const snap = (): AtemSnapshot => ({
  model: 16,
  modelKey: "MiniExtreme",
  productName: "ATEM Mini Extreme",
  protocol: "2.30",
  videoMode: "1080i50",
  mixEffects: 1,
  keyers: [4],
  downstreamKeyers: 2,
  auxes: 1,
  mediaPlayers: 2,
  superSources: 1,
  multiviewers: 1,
  inputs: [
    { id: 1, longName: "Camera 1", shortName: "CAM1", kind: "external", port: "HDMI", namesDefault: true },
    { id: 2, longName: "Camera 2", shortName: "CAM2", kind: "external", port: "HDMI", namesDefault: true },
    { id: 0, longName: "Black", shortName: "BLK", kind: "black", port: null, namesDefault: true },
  ],
  program: [1],
  preview: [2],
});

/** Fake switcher: in-memory state, records renames and switches. */
class FakeLink extends EventEmitter implements AtemLink {
  connected = false;
  state = snap();
  renames: [number, string, string][] = [];
  switches: [SwitchAction, number, number | undefined][] = [];
  constructor(public host: string) {
    super();
  }
  up() {
    this.connected = true;
    this.emit("change");
  }
  down() {
    this.connected = false;
    this.emit("change");
  }
  snapshot() {
    return this.connected ? structuredClone(this.state) : null;
  }
  async rename(input: number, longName: string, shortName: string) {
    this.renames.push([input, longName, shortName]);
    const i = this.state.inputs.find((x) => x.id === input)!;
    Object.assign(i, { longName, shortName, namesDefault: false });
  }
  async switch(action: SwitchAction, me: number, input?: number) {
    this.switches.push([action, me, input]);
    if (action === "program") this.state.program[me] = input!;
    if (action === "preview") this.state.preview[me] = input!;
    if (action === "cut") [this.state.program[me], this.state.preview[me]] = [this.state.preview[me]!, this.state.program[me]!];
    if (action === "aux") (this.state.auxSources ??= [])[me] = input!;
  }
  async close() {
    this.connected = false;
  }
}

const links: FakeLink[] = [];
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
    migrations: [...NODE_MIGRATIONS, ...ATEM_MIGRATIONS, ...ATEM_CONTROL_MIGRATIONS, ...DIAGRAM_MIGRATIONS],
    register: (s, pl) => {
      registerNodes(s, pl);
      const atem = registerAtem(s, pl, (host) => {
        const l = new FakeLink(host);
        links.push(l);
        return l;
      });
      registerDiagram(s, pl, atem.list);
    },
  });
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("register an ATEM, read its state, rename inputs and link nodes", async () => {
  assert.equal((await call("GET", "/api/atem")).status, 401);
  await call("POST", "/api/auth/login", { username: "admin", password: "admin" });

  assert.equal((await call("POST", "/api/atem", { name: "Mixer", host: "10.40.6.240; rm -rf" })).status, 400);
  const add = await call("POST", "/api/atem", { name: "Regie", host: "10.40.6.240", location: "Rack 1" });
  assert.equal(add.status, 200);
  const id = add.body.id;
  assert.equal(add.body.online, false);
  assert.equal(add.body.snapshot, null);
  assert.equal((await call("POST", "/api/atem", { name: "Dup", host: "10.40.6.240" })).status, 409);

  // Not reached yet: renaming is refused, the link stays usable for notes.
  assert.equal((await call("PUT", `/api/atem/${id}/inputs/1`, { longName: "Playout" })).status, 404);

  const link = links.at(-1)!;
  assert.equal(link.host, "10.40.6.240");
  link.up();
  const d = await call("GET", `/api/atem/${id}`);
  assert.equal(d.body.switcher.online, true);
  assert.equal(d.body.switcher.snapshot.productName, "ATEM Mini Extreme");
  assert.equal(d.body.switcher.snapshot.program[0], 1);
  assert.equal(d.body.events[0].type, "online");

  // Names are validated against what the ATEM can hold.
  assert.equal((await call("PUT", `/api/atem/${id}/inputs/1`, { shortName: "TOOLONG" })).status, 400);
  assert.equal((await call("PUT", `/api/atem/${id}/inputs/1`, { longName: "Ünicode" })).status, 400);
  assert.equal((await call("PUT", `/api/atem/${id}/inputs/99`, { longName: "X" })).status, 404);

  const r = await call("PUT", `/api/atem/${id}/inputs/1`, { longName: "Playout node", shortName: "PLAY" });
  assert.equal(r.status, 200);
  assert.deepEqual(link.renames, [[1, "Playout node", "PLAY"]]);
  assert.equal(r.body.snapshot.inputs.find((i: { id: number }) => i.id === 1).shortName, "PLAY");

  // Unchanged names are not written again; the note is stored in the orchestrator only.
  const n = await call("PUT", `/api/atem/${id}/inputs/1`, { longName: "Playout node", shortName: "PLAY", note: "DeckLink SDI 1" });
  assert.equal(link.renames.length, 1);
  assert.deepEqual(n.body.inputs, [{ inputId: 1, nodeId: null, note: "DeckLink SDI 1" }]);
  assert.equal((await call("PUT", `/api/atem/${id}/inputs/1`, { nodeId: "nope" })).status, 400);

  // Offline: last known state is kept, renaming needs a connection.
  link.down();
  assert.equal((await call("PUT", `/api/atem/${id}/inputs/2`, { longName: "Live" })).status, 409);
  const off = await call("GET", "/api/atem");
  assert.equal(off.body.switchers[0].online, false);
  assert.equal(off.body.switchers[0].snapshot.inputs[0].longName, "Playout node");
  assert.equal((await call("PUT", `/api/atem/${id}/inputs/2`, { note: "Live node" })).status, 200);

  // Changing the address reconnects with a new link.
  const moved = await call("PUT", `/api/atem/${id}`, { name: "Regie", host: "10.40.6.241" });
  assert.equal(moved.status, 200);
  assert.equal(links.at(-1)!.host, "10.40.6.241");

  assert.equal((await call("DELETE", `/api/atem/${id}`)).status, 200);
  assert.equal((await call("GET", "/api/atem")).body.switchers.length, 0);
});

test("switch from the orchestrator, lock and release for the automation", async () => {
  await call("POST", "/api/auth/login", { username: "admin", password: "admin" });
  const id = (await call("POST", "/api/atem", { name: "Master", host: "10.40.6.250" })).body.id;
  const link = links.at(-1)!;
  assert.equal((await call("POST", `/api/atem/${id}/switch`, { action: "program", input: 2 })).status, 409);
  link.up();
  assert.equal((await call("POST", `/api/atem/${id}/switch`, { action: "program" })).status, 400);
  assert.equal((await call("POST", `/api/atem/${id}/switch`, { action: "program", input: 77 })).status, 400);
  assert.equal((await call("POST", `/api/atem/${id}/switch`, { action: "cut", me: 3 })).status, 400);

  const sw = await call("POST", `/api/atem/${id}/switch`, { action: "program", input: 2 });
  assert.equal(sw.status, 200);
  assert.equal(sw.body.snapshot.program[0], 2);
  assert.equal(sw.body.control.mode, "automation");
  assert.equal((await call("POST", `/api/atem/${id}/switch`, { action: "aux", me: 0, input: 10010 })).status, 200);
  assert.deepEqual(link.switches, [["program", 0, 2], ["aux", 0, 10010]]);

  // Switching with lock: the automation keeps its hands off from now on.
  const locked = await call("POST", `/api/atem/${id}/switch`, { action: "cut", lock: true });
  assert.equal(locked.body.control.mode, "locked");
  assert.equal(locked.body.control.by, "admin");
  const ev = (await call("GET", `/api/atem/${id}`)).body.events.map((e: { type: string }) => e.type);
  assert.ok(ev.includes("control") && ev.includes("switch"));

  // Management nodes read the modes with the automation token.
  const tok = await call("GET", "/api/automation");
  assert.equal(tok.status, 200);
  const api = (auth?: string) => p.server.inject({ method: "GET", url: tok.body.path, headers: auth ? { authorization: auth } : {} });
  assert.equal((await api()).statusCode, 401);
  assert.equal((await api("Bearer wrong")).statusCode, 401);
  const res = JSON.parse((await api(`Bearer ${tok.body.token}`)).body);
  assert.deepEqual(
    res.switchers.map((s: { host: string; mode: string }) => [s.host, s.mode]),
    [["10.40.6.250", "locked"]],
  );
  assert.equal((await call("GET", "/api/automation")).body.lastPollAt.ip, "127.0.0.1");

  const rel = await call("PUT", `/api/atem/${id}/control`, { mode: "automation" });
  assert.equal(rel.body.control.mode, "automation");
  assert.equal(JSON.parse((await api(`Bearer ${tok.body.token}`)).body).switchers[0].mode, "automation");

  const fresh = await call("POST", "/api/automation/token");
  assert.notEqual(fresh.body.token, tok.body.token);
  assert.equal((await api(`Bearer ${tok.body.token}`)).statusCode, 401);
  await call("DELETE", `/api/atem/${id}`);
});

test("connection diagram: devices, cards, cables, fed-by sync", async () => {
  await call("POST", "/api/auth/login", { username: "admin", password: "admin" });
  const a = (await call("POST", "/api/atem", { name: "Studio", host: "10.40.6.240" })).body.id;
  const b = (await call("POST", "/api/atem", { name: "Master", host: "10.40.6.241" })).body.id;
  links.at(-2)!.up();
  links.at(-1)!.up();

  let d = await call("GET", "/api/diagram");
  assert.equal(d.body.available.atems.length, 2);
  const placeA = await call("POST", "/api/diagram/devices", { kind: "atem", refId: a, x: 400, y: 0 });
  const placeB = await call("POST", "/api/diagram/devices", { kind: "atem", refId: b, x: 800, y: 0 });
  assert.equal((await call("POST", "/api/diagram/devices", { kind: "atem", refId: a })).status, 409);
  assert.equal((await call("POST", "/api/diagram/devices", { kind: "device" })).status, 400);
  const srv = await call("POST", "/api/diagram/devices", {
    kind: "device",
    name: "Playout PC",
    deviceType: "server",
    cards: [{ id: "c1", model: "decklink-duo-2", name: "DeckLink Duo 2", ports: [{ id: "p1", label: "SDI 1", dir: "out", type: "SDI" }, { id: "p2", label: "SDI 2", dir: "out" }] }],
  });
  assert.equal(srv.status, 200);
  d = await call("GET", "/api/diagram");
  const atemA = d.body.devices.find((x: { id: string }) => x.id === placeA.body.id);
  assert.deepEqual(
    atemA.ports.map((p: { key: string }) => p.key),
    ["in:1", "in:2", "pgm", "aux:1", "mv:1"],
  );
  assert.equal(atemA.name, "Studio");
  assert.equal(d.body.available.atems.length, 0);

  const cable = (from: [string, string], to: [string, string]) => call("POST", "/api/diagram/links", { from: { device: from[0], port: from[1] }, to: { device: to[0], port: to[1] } });
  assert.equal((await cable([srv.body.id, "c1:p1"], [placeA.body.id, "pgm"])).status, 400); // out → out
  assert.equal((await cable([placeA.body.id, "in:1"], [srv.body.id, "c1:p1"])).status, 400);
  assert.equal((await cable([srv.body.id, "c1:p1"], [placeA.body.id, "in:9"])).status, 400);
  assert.equal((await cable([srv.body.id, "c1:p1"], [placeA.body.id, "in:1"])).status, 200);
  assert.equal((await cable([srv.body.id, "c1:p2"], [placeA.body.id, "in:1"])).status, 409); // input taken
  assert.equal((await cable([placeA.body.id, "pgm"], [placeB.body.id, "in:2"])).status, 200);

  // Removing a port from the card removes its cable.
  await call("PUT", `/api/diagram/devices/${srv.body.id}`, { cards: [{ id: "c1", model: "custom", name: "Card", ports: [{ id: "p2", label: "SDI 2", dir: "out" }] }] });
  d = await call("GET", "/api/diagram");
  assert.equal(d.body.links.length, 1);
  assert.equal((await call("PUT", "/api/diagram/layout", { positions: [{ id: srv.body.id, x: 12.4, y: 99.6 }] })).status, 200);
  assert.deepEqual(
    (await call("GET", "/api/diagram")).body.devices.filter((x: { id: string }) => x.id === srv.body.id).map((x: { x: number; y: number }) => [x.x, x.y]),
    [[12, 100]],
  );

  // Removing an ATEM from the inventory removes it (and its cables) from the diagram.
  await call("DELETE", `/api/atem/${b}`);
  d = await call("GET", "/api/diagram");
  assert.equal(d.body.devices.length, 2);
  assert.equal(d.body.links.length, 0);
  await call("DELETE", `/api/atem/${a}`);
});
