import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { bodySize, infoPageHtml, infoPageSchema, textBlocks } from "../server/infopagelogic.ts";
import { baseLayer, layersSchema } from "../server/layers.ts";

const COLORS = { background: "#2A1430", panel: "#713C80", accent: "#E92E7F", text: "#FFFFFF" };
// A 1x1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---- pure logic ---------------------------------------------------------------

test("info page: paragraphs, lists and bold text from the editor's text", () => {
  assert.deepEqual(textBlocks("Bel ons\nof mail\n\n- Telefoon: 0255\n• Mail\n\nTot ziens"), [
    { kind: "p", lines: ["Bel ons", "of mail"] },
    { kind: "ul", items: ["Telefoon: 0255", "Mail"] },
    { kind: "p", lines: ["Tot ziens"] },
  ]);
  const html = infoPageHtml({ settings: infoPageSchema.parse({ title: "Contact <redactie>", body: "- **0255** 123\nmail & meer", footer: "www.ijmond360.nl" }), colors: COLORS, imageUrl: null, logoUrl: null, language: "nl" });
  assert.match(html, /<h1>Contact &lt;redactie&gt;<\/h1>/);
  assert.match(html, /<li><b>0255<\/b> 123<\/li><\/ul><p>mail &amp; meer<\/p>/);
  assert.match(html, /<footer>.*www\.ijmond360\.nl<\/footer>/);
  assert.ok(!/<script/.test(html), "a page on air has no scripts");
  // Less text gets bigger letters.
  assert.ok(bodySize("Kort", false) > bodySize("lang ".repeat(200), false));
});

test("info page: a layout with a picture falls back to text while there is no picture", () => {
  const s = infoPageSchema.parse({ layout: "imageRight", title: "Over ons", body: "Tekst" });
  assert.doesNotMatch(infoPageHtml({ settings: s, colors: COLORS, imageUrl: null, logoUrl: null, language: "nl" }), /class="pic"/);
  assert.match(infoPageHtml({ settings: s, colors: COLORS, imageUrl: "/infopage/img/1", logoUrl: "/logo", language: "nl" }), /class="split "><div class="text">.*<div class="pic"><img src="\/infopage\/img\/1"/s);
  const only = infoPageHtml({ settings: { ...s, layout: "imageOnly" }, colors: COLORS, imageUrl: "/x.jpg", logoUrl: "/logo", language: "nl" });
  assert.match(only, /class="only"/);
  assert.doesNotMatch(only, /<h1>/);
  assert.equal(infoPageSchema.parse({}).durationSec, 20);
});

test("info page: overlay hidden by default, kept when the page asks for it", () => {
  const layers = layersSchema.parse({});
  assert.equal(baseLayer(layers, { type: "info", leaf: { blockKind: "program" } }).logo, false);
  assert.equal(baseLayer(layers, { type: "info", leaf: { blockKind: "program", showOverlay: true } }).clock, true);
});

// ---- API, blocks and director ---------------------------------------------------

class FakeSwitcher extends EventEmitter implements SwitcherDriver {
  programIn: number | null = null;
  info(): SwitcherInfo {
    return { connected: true, model: "Fake", productName: "ATEM Fake", mixEffects: 1, inputs: [1, 2].map((id) => ({ id, longName: `In ${id}`, shortName: `${id}`, external: true })), program: [this.programIn], preview: [null] };
  }
  async program(input: number) {
    this.programIn = input;
  }
  async preview() {}
  async cut() {}
  async auto() {}
  async close() {}
}
class FakePlayout extends EventEmitter implements PlayoutDriver {
  calls: string[] = [];
  graphics: unknown[] = [];
  info() {
    return { connected: true, version: "2.4.3", channels: [1], session: 1 };
  }
  async play(ch: number, layer: number, clip?: string) {
    this.calls.push(`play ${ch}-${layer}${clip ? ` ${clip}` : ""}`);
  }
  async loadbg() {}
  async stop() {}
  async clear() {}
  async playHtml(ch: number, layer: number, url: string) {
    this.calls.push(`html ${ch}-${layer} ${url}`);
  }
  async cgAdd(_c: number, _l: number, _t: string, data: unknown) {
    this.graphics.push(data);
  }
  async cgUpdate(_c: number, _l: number, data: unknown) {
    this.graphics.push(data);
  }
  async cgStop() {}
  async addConsumer() {}
  async removeConsumer() {}
  async close() {}
}

const root = mkdtempSync(join(tmpdir(), "tvsm-info-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
const sw = new FakeSwitcher();
const playout = new FakePlayout();
const drivers: DriverFactory = { switcher: () => sw, playout: () => playout };
let cookie = "";
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, headers: res.headers, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body };
};

test.before(async () => {
  p = await createPlatform(managementOptions({ drivers, autostart: false, onReady: (x) => (h = x) }));
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("info page: made by an editor, placed in an hour block with its own length, played on CasparCG", async () => {
  const made = await api("POST", "/api/infopages", { name: "Contact", settings: { title: "Contact", body: "Bel ons", durationSec: 30 } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const info = made.body;
  assert.equal(info.durationMs, 30_000);
  assert.ok(info.block, "every page has its own block for the library");
  assert.equal(info.block.genre, "info");

  // Picture upload, then a layout with the picture.
  const up = await api("POST", `/api/infopages/${info.id}/image`, { dataUrl: PNG });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.match(up.body.imageUrl, new RegExp(`^/infopage/img/${info.id}\\?v=`));
  const img = await api("GET", `/infopage/img/${info.id}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers["content-type"], "image/png");
  assert.equal((await api("POST", `/api/infopages/${info.id}/image`, { dataUrl: "data:text/html;base64,PGI+" })).status, 400);
  assert.equal((await api("PUT", `/api/infopages/${info.id}`, { name: "Contact redactie", settings: { ...info.settings, layout: "imageLeft" } })).status, 200);
  assert.equal((await api("GET", "/api/blocks")).body.blocks.find((b: { id: number }) => b.id === info.block.id).name, "Contact redactie");

  // In an hour block: the page's own length, unless the item sets one.
  const hour = await api("POST", "/api/blocks", { name: "Uur", items: [{ type: "info", infoPageId: info.id }, { type: "info", infoPageId: info.id, durationMs: 10_000 }] });
  assert.equal(hour.status, 200, JSON.stringify(hour.body));
  const detail = (await api("GET", `/api/blocks/${hour.body.id}`)).body;
  assert.equal(detail.items[0].type, "info");
  assert.equal(detail.items[0].infoPageName, "Contact redactie");
  assert.equal(detail.items[0].effectiveDurationMs, 30_000);
  assert.equal(detail.items[1].effectiveDurationMs, 10_000);
  assert.equal((await api("POST", "/api/blocks", { name: "Fout", items: [{ type: "info" }] })).status, 400);
  // Changing the length on the page changes the block.
  await api("PUT", `/api/infopages/${info.id}`, { name: "Contact redactie", settings: { ...info.settings, layout: "imageLeft", durationSec: 45 } });
  assert.equal((await api("GET", `/api/blocks/${hour.body.id}`)).body.block.durationMs, 55_000);

  // The live preview of unsaved settings, and the page CasparCG plays.
  const pre = await api("POST", "/api/infopages/preview", { id: info.id, settings: { title: "Nog niet opgeslagen", layout: "imageRight" } });
  assert.match(pre.body.html, /Nog niet opgeslagen/);
  assert.match(pre.body.html, /class="preview"/);
  assert.match(pre.body.html, new RegExp(`src="/infopage/img/${info.id}`));

  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "Studio", host: "10.40.5.11" });
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId, casparChannel: 1, playoutInput: 1 })).body;
  const page = await api("GET", `/infopage/page.html?id=${info.id}&channel=${ch.id}`);
  assert.equal(page.status, 200);
  assert.match(String(page.body), /<h1>Contact<\/h1>/);
  assert.match(String(page.body), new RegExp(`class="split left".*src="http://[^"]+/infopage/img/${info.id}`, "s"));
  assert.equal((await api("GET", `/infopage/page.html?id=${info.id}&preview=1`)).headers["x-frame-options"], "SAMEORIGIN");
  assert.equal((await api("GET", "/infopage/page.html?id=999")).status, 404);

  const t0 = Date.parse("2026-11-04T12:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: hour.body.id, title: "Uur" });
  await api("POST", `/api/control/${ch.id}/automation`, { on: true });
  h.director.now = () => t0 + 2000;
  h.director.invalidate();
  await h.director.tick();
  assert.ok(playout.calls.some((c) => new RegExp(`^html 1-10 http://.+/infopage/page\\.html\\?id=${info.id}&channel=${ch.id}$`).test(c)), playout.calls.join("\n"));
  assert.equal(sw.programIn, 1);
  assert.equal((playout.graphics.at(-1) as { hidden: boolean }).hidden, true, "the overlay steps aside");
  assert.equal((await api("GET", "/api/control")).body.channels[0].current.type, "info");

  // Delete: refused while used, unless forced; the items go with it.
  const copy = (await api("POST", `/api/infopages/${info.id}/duplicate`, { name: "Kopie" })).body;
  assert.ok(copy.imageUrl, "the copy has its own picture");
  assert.equal((await api("DELETE", `/api/infopages/${info.id}`)).status, 409);
  assert.equal((await api("DELETE", `/api/infopages/${info.id}?force=true`)).status, 200);
  assert.equal((await api("GET", `/api/blocks/${hour.body.id}`)).body.items.length, 0);
  assert.equal((await api("GET", "/api/infopages")).body.pages.length, 1);
});
