import assert from "node:assert/strict";
import { test } from "node:test";
import { groupInputs, portParts, portSummary, type PortInput } from "../server/atemports.ts";

const ext = (id: number, port: string | null, longName = `Camera ${id}`, namesDefault?: boolean): PortInput => ({ id, longName, shortName: `Cam${id}`, external: true, port, namesDefault });
// Television Studio HD: 1-4 HDMI, 5-8 SDI.
const tvsHd: PortInput[] = [
  ...[1, 2, 3, 4].map((n) => ext(n, "HDMI")),
  ext(5, "SDI", "CASPARCG02"),
  ext(6, "SDI"),
  ext(7, "SDI"),
  ext(8, "SDI", "CASPARCG01"),
  { id: 0, longName: "Black", shortName: "BLK", external: false },
  { id: 1000, longName: "Color Bars", shortName: "BARS", external: false },
];

test("an external input is its connector, with the name only when it is not the factory name", () => {
  assert.deepEqual(portParts(tvsHd, 8), { kind: "physical", number: 8, port: "SDI", name: "CASPARCG01" });
  assert.deepEqual(portParts(tvsHd, 2), { kind: "physical", number: 2, port: "HDMI", name: null });
  assert.deepEqual(portParts([ext(3, "SDI", "SDI 3")], 3), { kind: "physical", number: 3, port: "SDI", name: null });
  assert.deepEqual(portParts([ext(3, "SDI", "Studio cam", true)], 3).kind, "physical");
  assert.equal((portParts([ext(3, "SDI", "Studio cam", true)], 3) as { name: string | null }).name, null);
  assert.deepEqual(portParts([ext(4, "Unknown", "Desk")], 4), { kind: "physical", number: 4, port: null, name: "Desk" });
});

test("internal sources keep the ATEM name; unknown inputs only the number", () => {
  assert.deepEqual(portParts(tvsHd, 1000), { kind: "internal", number: 1000, name: "Color Bars" });
  assert.deepEqual(portParts(tvsHd, 42), { kind: "unknown", number: 42 });
  assert.deepEqual(portParts(undefined, 5), { kind: "unknown", number: 5 });
});

test("pickers list the connectors first, then the ATEM's own sources", () => {
  const g = groupInputs([...tvsHd].reverse());
  assert.deepEqual(
    g.physical.map((i) => i.id),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.deepEqual(
    g.internal.map((i) => i.id),
    [0, 1000],
  );
});

test("the connector layout in one line", () => {
  assert.equal(portSummary(tvsHd), "HDMI 1-4 · SDI 5-8");
  assert.equal(portSummary([ext(1, "HDMI"), ext(2, "SDI"), ext(3, "SDI"), ext(5, "SDI")]), "HDMI 1 · SDI 2-3 · SDI 5");
});
