import assert from "node:assert/strict";
import { test } from "node:test";
import { atemPorts, autoLayout, cardFromPreset, COLUMN_WIDTH, linkError, trace, type Link, type ResolvedPort } from "../server/diagramlogic.ts";

const L = (id: string, fd: string, fp: string, td: string, tp: string): Link => ({ id, from: { device: fd, port: fp }, to: { device: td, port: tp }, cable: "sdi", label: "" });

test("card presets and custom cards", () => {
  const c = cardFromPreset("decklink-4k-extreme-12g", "c1");
  assert.equal(c.name, "DeckLink 4K Extreme 12G");
  assert.deepEqual(
    c.ports.filter((p) => p.dir === "out").map((p) => p.label),
    ["SDI Out A (fill)", "SDI Out B (key)", "HDMI Out"],
  );
  const x = cardFromPreset("custom", "c2", { name: "Router", outs: 2, ins: 1 });
  assert.deepEqual(
    x.ports.map((p) => [p.id, p.dir]),
    [["o1", "out"], ["o2", "out"], ["i1", "in"]],
  );
});

test("ATEM ports come from the switcher", () => {
  const ports = atemPorts({
    mixEffects: 1,
    auxes: 2,
    multiviewers: 1,
    inputs: [
      { id: 1, longName: "Playout", shortName: "PLAY", kind: "external", port: "SDI" },
      { id: 1000, longName: "Bars", shortName: "BARS", kind: "bars", port: null },
    ],
  });
  assert.deepEqual(
    ports.map((p) => [p.key, p.dir, p.label]),
    [["in:1", "in", "Playout"], ["pgm", "out", "Program"], ["aux:1", "out", "Aux 1"], ["aux:2", "out", "Aux 2"], ["mv:1", "out", "Multiview"]],
  );
  assert.deepEqual(atemPorts(null), []);
});

test("cable rules", () => {
  const ports: Record<string, ResolvedPort[]> = {
    s: [{ key: "c:o1", id: "o1", label: "SDI", dir: "out", group: "c" }],
    a: [
      { key: "in:1", id: "in:1", label: "1", dir: "in", group: "inputs" },
      { key: "pgm", id: "pgm", label: "PGM", dir: "out", group: "outputs" },
    ],
  };
  const get = (d: string) => ports[d];
  const e = (fd: string, fp: string, td: string, tp: string, links: Link[] = []) => linkError({ device: fd, port: fp }, { device: td, port: tp }, get, links);
  assert.equal(e("s", "c:o1", "a", "in:1"), null);
  assert.equal(e("x", "c:o1", "a", "in:1"), "unknown_device");
  assert.equal(e("a", "pgm", "a", "in:1"), "same_device");
  assert.equal(e("s", "c:o1", "a", "pgm"), "direction");
  assert.equal(e("s", "c:o9", "a", "in:1"), "unknown_port");
  assert.equal(e("s", "c:o1", "a", "in:1", [L("l1", "s", "c:o1", "a", "in:1")]), "input_taken");
});

test("auto layout puts the signal flow left to right", () => {
  const pos = autoLayout(
    [
      { id: "master", ports: 4 },
      { id: "studio", ports: 4 },
      { id: "play", ports: 1 },
      { id: "live", ports: 1 },
      { id: "cam", ports: 1 },
    ],
    [L("1", "play", "o", "studio", "in:1"), L("2", "live", "o", "studio", "in:2"), L("3", "studio", "pgm", "master", "in:1"), L("4", "cam", "o", "master", "in:2")],
  );
  assert.equal(pos.play!.x, 0);
  assert.equal(pos.cam!.x, 0);
  assert.equal(pos.studio!.x, COLUMN_WIDTH);
  assert.equal(pos.master!.x, 2 * COLUMN_WIDTH);
  // Sources line up with the input they feed: input 1 above input 2.
  const ordered = autoLayout(
    [
      { id: "atem", ports: 3, portOrder: ["in:1", "in:2", "pgm"] },
      { id: "z-first", ports: 1 },
      { id: "a-second", ports: 1 },
    ],
    [L("1", "a-second", "o", "atem", "in:2"), L("2", "z-first", "o", "atem", "in:1")],
  );
  assert.ok(ordered["z-first"]!.y < ordered["a-second"]!.y);
  // A loop does not hang.
  const loop = autoLayout([{ id: "a", ports: 1 }, { id: "b", ports: 1 }], [L("1", "a", "pgm", "b", "in:1"), L("2", "b", "pgm", "a", "in:1")]);
  assert.ok(Number.isFinite(loop.a!.x) && Number.isFinite(loop.b!.x));
});

test("tally: program, preview and the on-air chain through ATEMs", () => {
  const links = [
    L("play", "srv", "c:o1", "studio", "in:1"),
    L("live", "srv2", "c:o1", "studio", "in:2"),
    L("studio-pgm", "studio", "pgm", "master", "in:3"),
    L("studio-aux", "studio", "aux:1", "master", "in:4"),
    L("cam", "cam", "c:o1", "master", "in:5"),
  ];
  const t1 = trace(links, {
    studio: { program: [2], preview: [1], auxSources: [1] },
    master: { program: [3], preview: [5], auxSources: [] },
  });
  assert.equal(t1["studio-pgm"], "air");
  assert.equal(t1.live, "air");
  assert.equal(t1.play, "preview");
  assert.equal(t1.cam, "preview");
  assert.equal(t1["studio-aux"], undefined);

  // Master takes the studio's aux, which shows input 1: the chain follows the aux.
  const t2 = trace(links, {
    studio: { program: [2], preview: [1], auxSources: [1] },
    master: { program: [4], preview: [3], auxSources: [] },
  });
  assert.equal(t2["studio-aux"], "air");
  assert.equal(t2.play, "air");
  assert.equal(t2.live, "program");
  assert.equal(t2["studio-pgm"], "preview");

  // Aux showing M/E 1 program follows the program.
  const t3 = trace(links, { studio: { program: [2], preview: [1], auxSources: [10010] }, master: { program: [4], preview: [], auxSources: [] } });
  assert.equal(t3.live, "air");
});
