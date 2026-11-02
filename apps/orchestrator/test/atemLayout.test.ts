import assert from "node:assert/strict";
import { test } from "node:test";
import { buttonSources, familyOf, panelFor, type PanelInput } from "../web/atemLayout.ts";

const ext = (n: number): PanelInput[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, longName: `Camera ${i + 1}`, shortName: `CAM${i + 1}`, kind: "external", port: "SDI" }));
const internal: PanelInput[] = [
  { id: 0, longName: "Black", shortName: "BLK", kind: "black", port: null },
  { id: 3010, longName: "Media Player 1", shortName: "MP1", kind: "mediaplayer", port: null },
  { id: 3020, longName: "Media Player 2", shortName: "MP2", kind: "mediaplayer", port: null },
  { id: 1000, longName: "Color Bars", shortName: "BARS", kind: "bars", port: null },
];

test("model families", () => {
  assert.equal(familyOf("Mini"), "mini");
  assert.equal(familyOf("MiniExtremeISOG2"), "extreme");
  assert.equal(familyOf("TelevisionStudioHD8"), "studio");
  assert.equal(familyOf("Constellation4K2ME"), "rack");
  assert.equal(familyOf("SomethingNew"), "generic");
});

test("ATEM Mini Pro: four input buttons, audio and streaming keys", () => {
  const spec = panelFor("MiniPro", { inputs: [...ext(4), ...internal], mixEffects: 1 });
  assert.equal(spec.sourceButtons, 4);
  assert.ok(spec.audio && spec.streaming && spec.outputSelect);
  assert.deepEqual(buttonSources(spec, [...ext(4), ...internal]).map((s) => s?.id), [1, 2, 3, 4]);
  assert.equal(panelFor("Mini", { inputs: ext(4), mixEffects: 1 }).streaming, false);
});

test("Television Studio HD8: program/preview rows with inputs, black and media players", () => {
  const inputs = [...ext(8), ...internal];
  const spec = panelFor("TelevisionStudioHD8", { inputs, mixEffects: 1 });
  assert.deepEqual(spec.rows, ["program", "preview"]);
  assert.ok(spec.tbar);
  assert.deepEqual(buttonSources(spec, inputs).map((s) => s?.shortName), ["CAM1", "CAM2", "CAM3", "CAM4", "CAM5", "CAM6", "CAM7", "CAM8", "BLK", "MP1", "MP2"]);
});

test("rack models are sized by M/E and fill unused buttons with null", () => {
  const spec = panelFor("Constellation4K2ME", { inputs: ext(6), mixEffects: 2 });
  assert.equal(spec.rackUnits, 2);
  const b = buttonSources(spec, ext(6));
  assert.equal(b.length, 8);
  assert.equal(b[6], null);
});
