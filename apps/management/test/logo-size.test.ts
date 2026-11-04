import assert from "node:assert/strict";
import { test } from "node:test";
import { graphicsSchema, LOGO_SIZE } from "../server/content.ts";

test("logo settings saved before size/offset existed keep the old look", () => {
  const g = graphicsSchema.parse({ logo: { enabled: true, position: "top-left", file: "logo.png", opacity: 0.8 } });
  assert.deepEqual(g.logo, { enabled: true, position: "top-left", file: "logo.png", opacity: 0.8, size: LOGO_SIZE.default, offsetX: 0, offsetY: 0, fullFrame: false });
  assert.equal(graphicsSchema.parse({}).logo.size, 96);
});

test("logo size and offsets are checked", () => {
  const ok = graphicsSchema.parse({ logo: { size: 240, offsetX: -40, offsetY: 120, fullFrame: true } });
  assert.equal(ok.logo.size, 240);
  assert.equal(ok.logo.offsetX, -40);
  assert.equal(ok.logo.fullFrame, true);
  assert.throws(() => graphicsSchema.parse({ logo: { size: 5000 } }));
  assert.throws(() => graphicsSchema.parse({ logo: { size: 10 } }));
  assert.throws(() => graphicsSchema.parse({ logo: { offsetX: -500 } }));
});
