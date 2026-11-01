import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { beeldkrantDuration, beeldkrantSchema, buildPages, htmlToText, pageAt, parseFeed, truncate, wpPostsToItems, wpSite, wpUrls } from "../server/rsslogic.ts";

// ---- pure logic ---------------------------------------------------------------

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>IJmond360</title><link>https://ijmond360.nl/</link>
<item><title>Column: Sterke verhalen, slappe biertjes</title><link>https://ijmond360.nl/column/</link>
<dc:creator><![CDATA[Fons Deen]]></dc:creator><pubDate>Sun, 01 Nov 2026 08:00:00 +0000</pubDate>
<category><![CDATA[Columns]]></category><category><![CDATA[Wijk aan Zee]]></category>
<guid isPermaLink="false">https://ijmond360.nl/?p=28065</guid>
<description><![CDATA[<p>In Wijk aan Zee hebben we twee dingen in overvloed: wind en sterke verhalen. [&#8230;]</p>
<p>Het bericht <a href="https://ijmond360.nl/column/">Column: Sterke verhalen, slappe biertjes</a> verscheen eerst op <a href="https://ijmond360.nl">IJmond360</a>.</p>]]></description>
<content:encoded><![CDATA[<p>In Wijk aan Zee &amp; omstreken.</p><p><img src="https://ijmond360.nl/wp-content/uploads/neeltje.jpg" /></p>]]></content:encoded>
</item>
<item><title>Brand in Velsen &amp; omgeving</title><link>https://example.org/brand</link><guid>b1</guid><pubDate>Sat, 31 Oct 2026 20:00:00 +0000</pubDate>
<description>&lt;p&gt;Een &lt;b&gt;grote&lt;/b&gt; brand.&lt;/p&gt;</description><media:content url="https://example.org/brand.jpg" medium="image" /></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>NOS</title><link href="https://nos.nl/"/>
<entry><id>urn:1</id><title type="html">Kabinet &amp;amp; Kamer</title><link href="https://nos.nl/1"/><updated>2026-11-01T07:00:00Z</updated>
<summary type="html">&lt;p&gt;Het kabinet besluit.&lt;/p&gt;</summary><link rel="enclosure" type="image/jpeg" href="https://nos.nl/1.jpg"/><category term="politiek" label="Politiek"/></entry></feed>`;

const WP_POSTS = [
  {
    id: 28118,
    date_gmt: "2026-11-01T06:00:00",
    link: "https://ijmond360.nl/150-jaar-ijmuiden/",
    guid: { rendered: "https://ijmond360.nl/?p=28118" },
    title: { rendered: "150 jaar IJmuiden: het gevoel van thuis &#8211; haven" },
    excerpt: { rendered: "<p>IJmuiden bestaat vandaag 150 jaar. Generaties vissers hebben er hun stempel op gedrukt. Drie inwoners vertellen over trots en het gevoel van [&hellip;]</p>\n" },
    content: { rendered: "<p>IJmuiden bestaat vandaag 150 jaar.</p>" },
    _embedded: {
      "wp:featuredmedia": [{ source_url: "https://ijmond360.nl/IJmuiden.jpg", media_details: { sizes: { medium: { source_url: "https://ijmond360.nl/IJmuiden-300.jpg", width: 300 }, big: { source_url: "https://ijmond360.nl/IJmuiden-1536.jpg", width: 1536 }, huge: { source_url: "https://ijmond360.nl/IJmuiden-2048.jpg", width: 2048 } } } }],
      "wp:term": [[{ taxonomy: "category", name: "Velsen" }], [{ taxonomy: "post_tag", name: "150 jaar" }]],
    },
  },
];

test("rss: RSS 2.0, escaped HTML and Atom are parsed into clean items", () => {
  const f = parseFeed(RSS);
  assert.equal(f.title, "IJmond360");
  const [a, b] = f.items;
  assert.equal(a!.guid, "https://ijmond360.nl/?p=28065");
  // The WordPress footer ("Het bericht … verscheen eerst op …") and tags are gone.
  assert.equal(a!.summary, "In Wijk aan Zee hebben we twee dingen in overvloed: wind en sterke verhalen. …");
  assert.equal(a!.body, "In Wijk aan Zee & omstreken.");
  assert.equal(a!.imageUrl, "https://ijmond360.nl/wp-content/uploads/neeltje.jpg");
  assert.deepEqual(a!.categories, ["Columns", "Wijk aan Zee"]);
  assert.equal(a!.publishedAt, "2026-11-01T08:00:00.000Z");
  assert.equal(b!.title, "Brand in Velsen & omgeving");
  assert.equal(b!.summary, "Een grote brand.");
  assert.equal(b!.imageUrl, "https://example.org/brand.jpg");

  const atom = parseFeed(ATOM).items[0]!;
  assert.equal(atom.title, "Kabinet & Kamer");
  assert.equal(atom.summary, "Het kabinet besluit.");
  assert.equal(atom.imageUrl, "https://nos.nl/1.jpg");
  assert.deepEqual(atom.categories, ["Politiek"]);
  assert.throws(() => parseFeed("<html><body>no feed</body></html>"));
});

test("rss: WordPress REST posts, featured image and category feeds", () => {
  const [p] = wpPostsToItems(WP_POSTS);
  assert.equal(p!.title, "150 jaar IJmuiden: het gevoel van thuis – haven");
  assert.equal(p!.imageUrl, "https://ijmond360.nl/IJmuiden-1536.jpg");
  assert.deepEqual(p!.categories, ["Velsen"]);
  assert.equal(p!.publishedAt, "2026-11-01T06:00:00.000Z");
  assert.equal(wpSite("www.ijmond360.nl/category/sport/feed/"), "https://www.ijmond360.nl");
  assert.equal(wpSite("https://ijmond360.nl/wp-json/wp/v2/posts"), "https://ijmond360.nl");
  const u = wpUrls("https://www.ijmond360.nl/", [{ id: 108, slug: "sport", name: "Sport" }], 10);
  assert.match(u.rest, /^https:\/\/www\.ijmond360\.nl\/wp-json\/wp\/v2\/posts\?per_page=10&_embed=/);
  assert.match(u.rest, /categories=108/);
  assert.deepEqual(u.rss, ["https://www.ijmond360.nl/category/sport/feed/"]);
});

test("beeldkrant: text is cut to the maximum, pages follow the settings", () => {
  assert.equal(truncate("Kort.", 100), "Kort.");
  assert.equal(truncate("Eerste zin is lang genoeg. Tweede zin loopt door tot ver voorbij het maximum", 40), "Eerste zin is lang genoeg.");
  const t = truncate("Een tekst zonder punt die veel te lang is voor de pagina", 30);
  assert.ok(t.length <= 30 && t.endsWith("…"), t);
  assert.equal(truncate("iets", 0), "");
  assert.equal(htmlToText("<p>A</p><script>x()</script><p>B&nbsp;C</p>"), "A\nB C");

  const now = Date.parse("2026-11-01T10:00:00Z");
  const items = [
    { id: 1, feedId: 1, title: "Oud nieuws", summary: "x", body: "", imageUrl: null, categories: [], publishedAt: "2026-10-01T10:00:00Z", seenAt: "2026-10-01T10:00:00Z" },
    { id: 2, feedId: 1, title: "Nieuw", summary: "Nieuw. Dit is de samenvatting van het bericht met genoeg tekst.", body: "Lang verhaal.", imageUrl: "https://x/2.jpg", categories: ["Sport"], publishedAt: "2026-11-01T09:00:00Z", seenAt: "" },
    { id: 3, feedId: 2, title: "nieuw", summary: "Zelfde artikel uit een andere categorie", body: "", imageUrl: null, categories: [], publishedAt: "2026-11-01T08:00:00Z", seenAt: "" },
    { id: 4, feedId: 2, title: "Ouder", summary: "Tekst", body: "", imageUrl: "https://x/4.jpg", categories: [], publishedAt: "2026-11-01T07:00:00Z", seenAt: "" },
  ];
  const s = beeldkrantSchema.parse({ maxAgeHours: 48, maxTextChars: 30, layout: "photo-left" });
  const pages = buildPages(items, s, new Map([[1, "IJmond360"], [2, "Sport"]]), now, (i) => `/beeldkrant/img/${i.id}`);
  assert.deepEqual(pages.map((p) => p.id), [2, 4]); // too old and the double are left out
  assert.equal(pages[0]!.text, "Dit is de samenvatting van…");
  assert.equal(pages[0]!.image, "/beeldkrant/img/2");
  assert.equal(pages[0]!.category, "Sport");
  assert.equal(pages[0]!.source, "IJmond360");
  assert.equal(buildPages(items, { ...s, layout: "text" }, new Map(), now, () => "x")[0]!.image, null);
  assert.equal(buildPages(items, { ...s, textSource: "body" }, new Map(), now, () => "x")[0]!.text, "Lang verhaal.");
  assert.equal(buildPages(items, { ...s, maxItems: 1 }, new Map(), now, () => "x").length, 1);

  assert.equal(beeldkrantDuration(s, 5), 5 * 12_000);
  assert.equal(beeldkrantDuration(s, 0), 12_000);
  assert.equal(beeldkrantDuration({ ...s, duration: { mode: "fixed", fixedSeconds: 300 } }, 5), 300_000);
  assert.deepEqual(pageAt(0, 25_000, 3, 10), { index: 2, elapsedMs: 5000 });
  assert.deepEqual(pageAt(0, 31_000, 3, 10), { index: 0, elapsedMs: 1000 });
});

// ---- server: feeds, beeldkranten, planning, playout ----------------------------------

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

const root = mkdtempSync(join(tmpdir(), "tvsm-bk-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
let site: Server;
let base = "";
let restOpen = true;
const hits: string[] = [];
const sw = new FakeSwitcher();
const playout = new FakePlayout();
const drivers: DriverFactory = { switcher: () => sw, playout: () => playout };
let cookie = "";
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, headers: res.headers, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body, raw: res.rawPayload };
};

test.before(async () => {
  // A small WordPress site: REST API (can be closed), RSS per category, a picture.
  site = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    hits.push(u.pathname + u.search);
    if (u.pathname === "/wp-json/wp/v2/posts") {
      if (!restOpen) return res.writeHead(401).end("{}");
      const posts = u.searchParams.get("categories") === "108" ? WP_POSTS : [...WP_POSTS, { ...WP_POSTS[0], id: 1, guid: { rendered: "p1" }, title: { rendered: "Tweede bericht" } }];
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(posts.map((x) => ({ ...x, _embedded: { ...x._embedded, "wp:featuredmedia": [{ source_url: `${base}/pic.jpg` }] } }))));
    }
    if (u.pathname === "/wp-json/wp/v2/categories") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ id: 108, name: "Sport", slug: "sport", count: 198 }]));
    if (u.pathname === "/category/sport/feed/" || u.pathname === "/feed/") return res.writeHead(200, { "content-type": "application/rss+xml" }).end(RSS);
    if (u.pathname === "/atom.xml") return res.writeHead(200, { "content-type": "application/atom+xml" }).end(ATOM);
    if (u.pathname === "/pic.jpg") return res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  p = await createPlatform(managementOptions({ drivers, autostart: false, onReady: (x) => (h = x) }));
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
});
test.after(async () => {
  await p.server.close();
  site.close();
  rmSync(root, { recursive: true, force: true });
});

test("beeldkrant: WordPress and RSS feeds, pages, planning and playout on CasparCG", async () => {
  // WordPress categories and a test fetch before saving.
  const cats = await api("POST", "/api/rss/wordpress/categories", { url: `${base}/category/sport/` });
  assert.equal(cats.status, 200);
  assert.equal(cats.body.site, base);
  assert.deepEqual(cats.body.categories[0], { id: 108, slug: "sport", name: "Sport", count: 198 });
  const tried = await api("POST", "/api/rss/test", { kind: "wordpress", url: base, categories: [{ id: 108, slug: "sport", name: "Sport" }] });
  assert.equal(tried.body.via, "wp-json");
  assert.equal(tried.body.items.length, 1);

  // Feeds: the station's WordPress site (all posts), a category feed and an extra Atom feed.
  const wp = (await api("POST", "/api/rss/feeds", { name: "IJmond360", kind: "wordpress", url: `${base}/` })).body;
  assert.equal(wp.itemCount, 2);
  assert.equal(wp.via, "wp-json");
  const atom = (await api("POST", "/api/rss/feeds", { name: "NOS", kind: "rss", url: `${base}/atom.xml` })).body;
  assert.equal(atom.itemCount, 1);
  const bad = (await api("POST", "/api/rss/feeds", { name: "Kapot", kind: "rss", url: `${base}/missing.xml` })).body;
  assert.match(bad.lastError, /404/);
  assert.equal((await api("POST", `/api/rss/feeds/${bad.id}/refresh`)).status, 502);
  // REST API closed: the RSS feed of the site is used.
  restOpen = false;
  const sport = (await api("POST", "/api/rss/feeds", { name: "Sport", kind: "wordpress", url: base, categories: [{ id: 108, slug: "sport", name: "Sport" }] })).body;
  assert.equal(sport.via, "rss");
  assert.equal(sport.itemCount, 2);
  assert.ok(hits.includes("/category/sport/feed/"));
  restOpen = true;

  const settings = { secondsPerPage: 10, maxItems: 10, maxAgeHours: 0, maxTextChars: 120, layout: "photo-left", headerText: "IJmond360 Nieuws" };
  const bk = await api("POST", "/api/beeldkranten", { name: "Nieuws", feedIds: [wp.id, atom.id], settings });
  assert.equal(bk.status, 200, JSON.stringify(bk.body));
  assert.equal(bk.body.pageCount, 3);
  assert.equal(bk.body.durationMs, 30_000);
  assert.equal(bk.body.settings.textSize, "medium");
  assert.equal((await api("POST", "/api/beeldkranten", { name: "Fout", settings: { secondsPerPage: 1 } })).status, 400);

  // Live preview of unsaved settings.
  const pv = (await api("POST", "/api/beeldkranten/preview", { feedIds: [atom.id], settings: { ...settings, maxTextChars: 0 } })).body;
  assert.equal(pv.pages.length, 1);
  assert.equal(pv.pages[0].text, "");

  // Public data for the page on the studio node, with pictures through the management node.
  const data = await api("GET", `/beeldkrant/${bk.body.id}/data.json`);
  assert.equal(data.body.pages.length, 3);
  const withImage = data.body.pages.find((x: { image: string | null; source: string }) => x.source === "IJmond360" && x.image?.includes("/beeldkrant/img/"));
  const img = await api("GET", new URL(withImage.image).pathname);
  assert.equal(img.status, 200, JSON.stringify(img.body));
  assert.equal(img.headers["content-type"], "image/jpeg");
  const page = await api("GET", "/beeldkrant/page.html?id=1");
  assert.equal(page.status, 200);
  assert.match(String(page.body), /data\.json/);
  assert.equal(page.headers["x-frame-options"], "SAMEORIGIN");

  // A block with the beeldkrant: one pass of the pages, or a set length in the block.
  const blk = (await api("POST", `/api/beeldkranten/${bk.body.id}/block`)).body;
  assert.equal(blk.created, true);
  assert.equal((await api("POST", `/api/beeldkranten/${bk.body.id}/block`)).body.id, blk.id);
  const detail = (await api("GET", `/api/blocks/${blk.id}`)).body;
  assert.equal(detail.block.durationMs, 30_000);
  assert.equal(detail.items[0].beeldkrantName, "Nieuws");
  const longer = (await api("POST", "/api/blocks", { name: "Nieuws 10 min", items: [{ type: "beeldkrant", beeldkrantId: bk.body.id, durationMs: 600_000 }] })).body;
  assert.equal((await api("GET", `/api/blocks/${longer.id}`)).body.block.durationMs, 600_000);
  assert.equal((await api("POST", "/api/blocks", { name: "x", items: [{ type: "beeldkrant" }] })).status, 400);
  assert.equal((await api("DELETE", `/api/beeldkranten/${bk.body.id}`)).status, 409);

  // On air: CasparCG plays the page on the playout layer, the channel overlay steps aside.
  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "Studio", host: "10.40.5.11" });
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const studioId = (await api("GET", "/api/studios")).body.studios[0].id;
  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId, casparChannel: 1, playoutInput: 1 })).body;
  const t0 = Date.parse("2026-11-02T12:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: longer.id, title: "Nieuws" });
  await api("POST", `/api/control/${ch.id}/automation`, { on: true });
  h.director.now = () => t0 + 5000;
  h.director.invalidate();
  await h.director.tick();
  const html = playout.calls.find((c) => c.startsWith("html 1-10 "));
  assert.ok(html, playout.calls.join("\n"));
  assert.match(html!, new RegExp(`/beeldkrant/page\\.html\\?id=${bk.body.id}&start=${t0}$`));
  assert.equal(sw.programIn, 1);
  assert.equal((playout.graphics.at(-1) as { hidden: boolean }).hidden, true);
  const ctl = (await api("GET", "/api/control")).body.channels[0];
  assert.equal(ctl.current.type, "beeldkrant");

  // Deleting a feed takes its pages out; deleting a used beeldkrant needs force.
  await api("DELETE", `/api/rss/feeds/${atom.id}`);
  assert.equal((await api("GET", `/api/beeldkranten/${bk.body.id}`)).body.pageCount, 2);
  assert.equal((await api("DELETE", `/api/beeldkranten/${bk.body.id}?force=true`)).status, 200);
});
