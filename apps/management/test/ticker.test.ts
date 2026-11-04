import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import { cgData, type DriverFactory, type PlayoutDriver, type SwitcherDriver, type SwitcherInfo } from "../server/drivers.ts";
import { graphicsSchema } from "../server/content.ts";
import { tickerData, tickerHeadlines, tickerHeight, tickerItems, tickerSchema } from "../server/tickerlogic.ts";

// ---- pure logic ---------------------------------------------------------------

test("ticker: headlines newest first, too old and doubles left out, time in front", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const items = [
    { id: 1, title: "Oud nieuws", publishedAt: "2026-10-30T08:00:00Z", seenAt: "" },
    { id: 2, title: "  Brand in   Velsen ", publishedAt: "2026-11-02T09:12:00Z", seenAt: "" },
    { id: 3, title: "Brand in Velsen", publishedAt: "2026-11-02T09:00:00Z", seenAt: "" },
    { id: 4, title: "Telstar wint", publishedAt: null, seenAt: "2026-11-02T11:00:00Z" },
    { id: 5, title: "", publishedAt: "2026-11-02T11:30:00Z", seenAt: "" },
  ];
  const s = tickerSchema.parse({ maxAgeHours: 24 });
  assert.deepEqual(tickerHeadlines(items, s, now), ["Telstar wint", "Brand in Velsen"]);
  assert.deepEqual(tickerHeadlines(items, { ...s, maxAgeHours: 0 }, now), ["Telstar wint", "Brand in Velsen", "Oud nieuws"]);
  assert.deepEqual(tickerHeadlines(items, { ...s, maxItems: 1 }, now), ["Telstar wint"]);
  assert.deepEqual(tickerHeadlines(items, { ...s, showTime: true }, now, "Europe/Amsterdam"), ["12:00 Telstar wint", "10:12 Brand in Velsen"]);

  assert.deepEqual(tickerItems({ source: "text", text: "Welkom\n\n  Bel 0255 " }, ["Kop"]), ["Welkom", "Bel 0255"]);
  assert.deepEqual(tickerItems({ source: "rss", text: "Welkom" }, ["Kop"]), ["Kop"]);
  assert.deepEqual(tickerItems({ source: "both", text: "Welkom" }, ["Kop"]), ["Welkom", "Kop"]);

  assert.equal(tickerHeight(30), 64);
  const d = tickerData(tickerSchema.parse({ source: "rss", separator: "|" }), true, []);
  assert.equal(d.enabled, false); // nothing to scroll: the bar stays away
  const e = tickerData(tickerSchema.parse({ source: "both", text: "A", separator: "|", label: "Nieuws" }), true, ["B"]);
  assert.deepEqual(e.items, ["A", "B"]);
  assert.equal(e.text, "A   |   B");
  assert.equal(e.label, "Nieuws");
});

test("ticker: settings saved before RSS keep working", () => {
  const g = graphicsSchema.parse({ ticker: { enabled: true, text: "Oud" } });
  assert.equal(g.ticker.source, "text");
  assert.equal(g.ticker.speed, 120);
  assert.equal(g.ticker.colors.accent, "#E92E7F");
  assert.throws(() => tickerSchema.parse({ speed: 5000 }));
  assert.throws(() => tickerSchema.parse({ colors: { text: "red" } }));
});

// ---- server: overlay data, refresh, beeldkrant room ------------------------------------

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

const root = mkdtempSync(join(tmpdir(), "tvsm-ticker-"));
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
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body };
};

test.before(async () => {
  p = await createPlatform(managementOptions({ drivers, autostart: false, onReady: (x) => (h = x) }));
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

type TickerOut = { enabled: boolean; items: string[]; speed: number; fontSize: number; height: number; label: string; colors: { background: string } };
const lastTicker = () => (playout.graphics.at(-1) as { ticker: TickerOut }).ticker;

test("ticker: RSS headlines in the overlay, picked up every few minutes, room on the beeldkrant", async () => {
  const { db } = p.ctx;
  // A feed with items as the RSS module stores them (fetching is tested in beeldkrant.test.ts).
  const feedId = Number(db.prepare("INSERT INTO rss_feeds (name, kind, url, categories, enabled, refresh_min, max_items) VALUES ('IJmond360', 'rss', 'http://x/feed', '[]', 1, 10, 20)").run().lastInsertRowid);
  const item = db.prepare("INSERT INTO rss_items (feed_id, guid, title, published_at) VALUES (?, ?, ?, ?)");
  item.run(feedId, "a", "Brand in Velsen", "2026-11-02T11:00:00Z");
  item.run(feedId, "b", "Telstar wint van Ajax", "2026-11-02T11:30:00Z");

  // Preview of unsaved settings on the channel page.
  const pv = (await api("POST", "/api/ticker/preview", { source: "both", text: "Welkom", feedIds: [feedId], maxAgeHours: 0, fontSize: 40 })).body;
  assert.deepEqual(pv.items, ["Welkom", "Telstar wint van Ajax", "Brand in Velsen"]);
  assert.equal(pv.headlines, 2);
  assert.equal(pv.height, 84);
  assert.equal((await api("POST", "/api/ticker/preview", { speed: 1 })).status, 400);

  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "Studio", host: "10.40.5.11" });
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId, casparChannel: 1, playoutInput: 1 })).body;
  const g = ch.graphics;
  const ticker = { ...g.ticker, enabled: true, source: "rss", feedIds: [feedId], maxAgeHours: 0, speed: 200, fontSize: 36, label: "Nieuws", refreshMinutes: 5, colors: { ...g.ticker.colors, background: "#000000" } };
  const saved = await api("PUT", `/api/channels/${ch.id}/graphics`, { ...g, ticker, layers: { ...g.layers, beeldkrant: { logo: false, clock: false, ticker: true } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.graphics.ticker.speed, 200);
  assert.equal((await api("PUT", `/api/channels/${ch.id}/graphics`, { ...g, ticker: { ...ticker, fontSize: 500 } })).status, 400);

  // A beeldkrant on air with the ticker kept over it: the page keeps room at the bottom.
  const bk = (await api("POST", "/api/beeldkranten", { name: "Nieuws", feedIds: [feedId], settings: { maxAgeHours: 0 } })).body;
  const blk = (await api("POST", "/api/blocks", { name: "Nieuws", items: [{ type: "beeldkrant", beeldkrantId: bk.id, durationMs: 3600_000 }] })).body;
  const t0 = Date.parse("2026-11-02T12:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: blk.id, title: "Nieuws" });
  await api("POST", `/api/control/${ch.id}/automation`, { on: true });
  h.director.now = () => t0 + 5000;
  h.director.invalidate();
  await h.director.tick();
  const html = playout.calls.find((c) => c.startsWith("html 1-10 "));
  assert.match(html!, new RegExp(`/beeldkrant/page\\.html\\?id=${bk.id}&start=${t0}&ticker=${tickerHeight(36)}$`), playout.calls.join("\n"));
  const tk = lastTicker();
  assert.equal(tk.enabled, true);
  assert.deepEqual(tk.items, ["Telstar wint van Ajax", "Brand in Velsen"]);
  assert.equal(tk.speed, 200);
  assert.equal(tk.height, 76);
  assert.equal(tk.label, "Nieuws");
  assert.equal(tk.colors.background, "#000000");
  assert.equal((playout.graphics.at(-1) as { hidden: boolean }).hidden, false);

  // A new article: the running line keeps its headlines until the refresh time has passed.
  item.run(feedId, "c", "Sluis IJmuiden weer open", "2026-11-02T11:50:00Z");
  h.director.now = () => t0 + 2 * 60_000;
  await h.director.tick();
  assert.equal(lastTicker().items.length, 2);
  h.director.now = () => t0 + 6 * 60_000;
  await h.director.tick();
  assert.deepEqual(lastTicker().items, ["Sluis IJmuiden weer open", "Telstar wint van Ajax", "Brand in Velsen"]);

  // Feed switched off: no headlines, so no bar either.
  db.prepare("UPDATE rss_feeds SET enabled = 0 WHERE id = ?").run(feedId);
  await api("PUT", `/api/channels/${ch.id}/graphics`, { ...saved.body.graphics, ticker: { ...ticker, maxItems: 5 } });
  h.director.invalidate();
  await h.director.tick();
  assert.equal(lastTicker().enabled, false);
});

// ---- AMCP: template data reaches the overlay in one piece ----------------------------

/** CasparCG's AMCP tokenizer: spaces split, double quotes group (and disappear), a backslash escapes the next character. */
function amcpTokens(line: string) {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let esc = false;
  for (const c of line) {
    if (esc) {
      cur += c === "n" ? "\n" : c;
      esc = false;
    } else if (c === "\\") esc = true;
    else if (c === '"') quoted = !quoted;
    else if (c === " " && !quoted) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

test("ticker: CG UPDATE data survives CasparCG's AMCP parser (spaces, quotes, $, new lines)", () => {
  const data = { channel: "Ijmond 360", ticker: { enabled: true, items: ['Wil en buurtgenoten willen "plantenbakken" terug…', "Prijs $5 \\ stuk", "regel\nnieuw"] } };
  const tokens = amcpTokens(`CG 1-20 UPDATE 1 ${cgData(data)}`);
  assert.equal(tokens.length, 5);
  assert.deepEqual(JSON.parse(tokens[4]!), data);
  // What was sent before: the raw JSON, cut at the first space.
  assert.throws(() => JSON.parse(amcpTokens(`CG 1-20 UPDATE 1 ${JSON.stringify(data)}`)[4]!));
});
