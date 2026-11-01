import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { ATEM_MIGRATIONS, registerAtem, type AtemLink, type AtemSnapshot } from "../server/atem.ts";
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

/** Fake switcher: in-memory state, records renames, never switches. */
class FakeLink extends EventEmitter implements AtemLink {
  connected = false;
  state = snap();
  renames: [number, string, string][] = [];
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
    migrations: [...NODE_MIGRATIONS, ...ATEM_MIGRATIONS],
    register: (s, pl) => {
      registerNodes(s, pl);
      registerAtem(s, pl, (host) => {
        const l = new FakeLink(host);
        links.push(l);
        return l;
      });
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
