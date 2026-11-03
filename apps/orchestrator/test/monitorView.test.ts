import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CELL,
  LAYERS,
  attention,
  columnsFor,
  fitZoom,
  project,
  matches,
  pushHistory,
  roomLayout,
  slot,
  sparkPoints,
  summarize,
  toItems,
  type LayerId,
  type Overview,
} from "../web/monitorView.ts";

const node = (
  id: string,
  name: string,
  role: string,
  group: "studio" | "management" | "other",
  extra: Partial<Overview["nodes"][number]> = {},
): Overview["nodes"][number] => ({
  id,
  name,
  role,
  group,
  status: "approved",
  hostname: name.toLowerCase(),
  platform: "linux",
  ip: `10.0.0.${id}`,
  agentVersion: "0.1.1",
  online: true,
  lastSeenAt: null,
  metrics: { cpu: 10, mem: 20, disk: 30, uptimeSeconds: 60 },
  casparcg: null,
  linkedDevice: null,
  health: "ok",
  issues: [],
  ...extra,
});

const overview = (): Overview => ({
  checkedAt: "2026-11-03T14:00:00Z",
  core: {
    name: "Orchestrator",
    hostname: "orch",
    version: "0.1.1",
    channel: "test",
    uptimeSeconds: 10,
    mailConfigured: false,
    lastBackup: null,
    health: "warn",
    issues: [{ code: "mail_not_configured", level: "warn" }],
  },
  nodes: [
    node("12", "CASPARCG02", "playout", "studio"),
    node("11", "CASPARCG01", "live", "studio", {
      health: "warn",
      issues: [{ code: "cpu_high", level: "warn" }],
    }),
    node("2", "tv-manager", "management", "management"),
    node("9", "owncast-host", "other", "other", { linkedDevice: "d1" }),
    node("7", "new-box", "studio", "studio", {
      status: "pending",
      health: "warn",
    }),
  ],
  atems: [
    {
      id: "a1",
      name: "ATEM Regie",
      host: "10.40.5.100",
      location: "",
      online: false,
      model: null,
      control: "automation",
      health: "down",
      issues: [{ code: "device_offline", level: "down" }],
    },
  ],
  hyperdecks: [
    {
      id: "h1",
      name: "HyperDeck",
      host: "10.40.5.219",
      location: "Rack",
      online: true,
      model: "HyperDeck Studio 4K Pro",
      transport: "stopped",
      health: "ok",
      issues: [],
    },
  ],
  devices: [
    {
      id: "d1",
      name: "Owncast",
      block: "distribution",
      checkType: "owncast",
      target: "http://10.40.6.127:8080",
      nodeId: "9",
      manualStatus: "unknown",
      location: "",
      notes: "",
      health: "ok",
      issues: [],
      result: null,
      lastCheckAt: null,
      lastOkAt: null,
      changedAt: null,
      agent: {
        id: "9",
        name: "owncast-host",
        online: true,
        lastSeenAt: null,
        metrics: { cpu: 40, mem: 50, disk: 60, uptimeSeconds: 1 },
      },
    },
    {
      id: "d2",
      name: "UPS",
      block: "extra",
      checkType: "manual",
      target: "",
      nodeId: null,
      manualStatus: "unknown",
      location: "Server room",
      notes: "",
      health: "unknown",
      issues: [],
      result: null,
      lastCheckAt: null,
      lastOkAt: null,
      changedAt: null,
      agent: null,
    },
  ],
  summary: { ok: 4, warn: 3, down: 1, unknown: 1 },
});

test("items land in the layer of the signal path, sorted by name", () => {
  const items = toItems(overview());
  const at = (l: LayerId) =>
    items.filter((i) => i.layer === l).map((i) => i.name);
  assert.deepEqual(at("core"), ["Orchestrator"]);
  assert.deepEqual(at("management"), ["tv-manager"]);
  assert.deepEqual(at("nodes"), ["CASPARCG01", "CASPARCG02"]);
  assert.deepEqual(at("switchers"), ["ATEM Regie"]);
  assert.deepEqual(at("recorders"), ["HyperDeck"]);
  assert.deepEqual(at("distribution"), ["Owncast"]);
  // pending nodes and extra equipment are infrastructure; a node linked to a device is shown with the device
  assert.deepEqual(at("infrastructure"), ["new-box", "UPS"]);
  assert.equal(items.find((i) => i.name === "Owncast")?.metrics?.cpu, 40);
  // layer order is kept
  assert.deepEqual(
    [...new Set(items.map((i) => i.layer))],
    LAYERS.filter((l) => items.some((i) => i.layer === l)),
  );
});

test("filters on layer, health and text", () => {
  const items = toItems(overview());
  const names = (f: Parameters<typeof matches>[1]) =>
    items.filter((i) => matches(i, f)).map((i) => i.name);
  assert.deepEqual(names({ layer: "nodes", health: "all", query: "" }), [
    "CASPARCG01",
    "CASPARCG02",
  ]);
  assert.deepEqual(names({ layer: "all", health: "down", query: "" }), [
    "ATEM Regie",
  ]);
  assert.deepEqual(
    names({ layer: "all", health: "all", query: "10.40.5.219" }),
    ["HyperDeck"],
  );
  assert.deepEqual(
    names({ layer: "all", health: "all", query: "server room" }),
    ["UPS"],
  );
  assert.deepEqual(names({ layer: "all", health: "all", query: "playout" }), [
    "CASPARCG02",
  ]);
});

test("layer summary and attention list, worst first", () => {
  const items = toItems(overview());
  const s = summarize(items);
  assert.equal(s.nodes.total, 2);
  assert.equal(s.nodes.health, "warn");
  assert.equal(s.switchers.health, "down");
  assert.equal(s.infrastructure.health, "warn");
  assert.equal(s.recorders.counts.ok, 1);
  assert.deepEqual(
    attention(items).map((i) => i.name),
    ["ATEM Regie", "CASPARCG01", "new-box", "Orchestrator", "UPS"],
  );
});

test("CPU history keeps the last values per item and drops items that are gone", () => {
  const items = toItems(overview());
  let h: Record<string, number[]> = { "node:gone": [1, 2] };
  for (let n = 0; n < 5; n++) h = pushHistory(h, items, 3);
  assert.deepEqual(h["node:12"], [10, 10, 10]);
  assert.equal(h["node:gone"], undefined);
  assert.equal(h["atem:a1"], undefined);
  assert.equal(sparkPoints([0, 100], 300, 60), "0,60 300,0");
  assert.equal(sparkPoints([5], 300, 60), "");
});

test("3D room: platforms grow with the number of items and never overlap", () => {
  const counts = Object.fromEntries(LAYERS.map((l) => [l, 1])) as Record<
    LayerId,
    number
  >;
  const small = roomLayout(counts);
  const big = roomLayout({ ...counts, nodes: 40 });
  assert.ok(big.width > small.width);
  assert.equal(columnsFor(1), 1);
  assert.equal(columnsFor(3), 3);
  assert.equal(columnsFor(40), 8);
  const n = big.platforms.nodes;
  assert.equal(n.w, 8 * CELL + 40);
  // every slot is inside its platform
  for (let i = 0; i < 40; i++) {
    const c = slot(n, i);
    assert.ok(
      c.x > n.x && c.x < n.x + n.w && c.y > n.y && c.y < n.y + n.h,
      `slot ${i}`,
    );
  }
  // platforms do not overlap
  const ps = Object.values(big.platforms);
  for (const a of ps)
    for (const b of ps) {
      if (a === b) continue;
      const apart =
        a.x + a.w <= b.x ||
        b.x + b.w <= a.x ||
        a.y + a.h <= b.y ||
        b.y + b.h <= a.y;
      assert.ok(apart, `${a.layer} / ${b.layer}`);
    }
  // a bigger room zooms out
  assert.ok(
    fitZoom(big, 900, 600, -38, 56) < fitZoom(small, 900, 600, -38, 56),
  );
});

test("3D projection follows the CSS transform of the floor", () => {
  const room = { width: 1000, height: 600 };
  const stage = { w: 800, h: 500, d: 2400, oy: 0.3 };
  const flat = { angle: 0, tilt: 0, zoom: 1 };
  assert.deepEqual(project(room, flat, stage, 500, 300, 0), { x: 400, y: 250 });
  assert.deepEqual(project(room, flat, stage, 600, 300, 0), { x: 500, y: 250 });
  // a quarter turn moves a point right of the centre to below it
  const turned = project(
    room,
    { angle: 90, tilt: 0, zoom: 2 },
    stage,
    600,
    300,
    0,
  );
  assert.ok(Math.abs(turned.x - 400) < 1e-9 && Math.abs(turned.y - 450) < 1e-9);
  // tilted: the far edge goes up and shrinks, things on the floor rise when they get taller
  const tilt = { angle: 0, tilt: 56, zoom: 1 };
  assert.ok(project(room, tilt, stage, 500, 0, 0).y > 250 - 300);
  assert.ok(
    project(room, tilt, stage, 500, 300, 80).y <
      project(room, tilt, stage, 500, 300, 0).y,
  );
});
