import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions } from "../server/app.ts";
import { isoWeek, newestFolders, parseAutoRule, pickClips, weekOfName, yearOfPath } from "../server/autofill.ts";
import { autoCandidates, dbLoader } from "../server/content.ts";
import type { DriverFactory } from "../server/drivers.ts";
import { entryLeaves, expandBlock } from "../server/timeline.ts";

const MIN = 60_000;
const DAY = 86_400_000;

// ---- pure logic ---------------------------------------------------------------

test("newest clips: newest first, at most N, the oldest drop out", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const c = [1, 2, 3, 4, 5].map((id) => ({ id, addedAt: now - (6 - id) * DAY, durationMs: 2 * MIN }));
  const rule = parseAutoRule({ source: "folder", folder: "News", count: 3 });
  assert.deepEqual(pickClips(c, rule, now), [5, 4, 3]);
  // A new clip arrives: number 3 drops out.
  assert.deepEqual(pickClips([...c, { id: 6, addedAt: now - 1000, durationMs: MIN }], rule, now), [6, 5, 4]);
  // Played in the order they came in.
  assert.deepEqual(pickClips(c, { ...rule, order: "oldest_first" }, now), [3, 4, 5]);
  // Only clips that existed when the block starts (a block on air does not change).
  assert.deepEqual(pickClips(c, rule, now - 2.5 * DAY), [3, 2, 1]);
  // Not older than 2 days.
  assert.deepEqual(pickClips(c, { ...rule, maxAgeDays: 2 }, now), [5, 4]);
  // At most 5 minutes: two clips of 2 minutes fit, a third does not.
  assert.deepEqual(pickClips(c, { ...rule, maxMinutes: 5 }, now), [5, 4]);
  // One clip is always played, even when it alone is longer.
  assert.deepEqual(pickClips([{ id: 9, addedAt: now - 1, durationMs: 30 * MIN }], { ...rule, maxMinutes: 5 }, now), [9]);
  // Clips without a known length (still being checked) are skipped.
  assert.deepEqual(pickClips([{ id: 9, addedAt: now - 1, durationMs: null }, ...c], { ...rule, count: 1 }, now), [5]);
  // Broken rules fall back to the defaults.
  assert.equal(parseAutoRule("{nope").count, 5);
  assert.equal(parseAutoRule({ count: 999 }).count, 5);
});

test("dynamic slots: in turn, random and no repeats within a broadcast", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const c = [1, 2, 3, 4].map((id) => ({ id, addedAt: now - id * DAY, durationMs: 20_000, lastPickAt: null as number | null }));
  const rotate = parseAutoRule({ source: "folder", folder: "Bumpers", count: 1, pick: "rotate" });
  // Never picked: the newest first.
  assert.deepEqual(pickClips(c, rotate, now), [1]);
  // Picked longest ago comes next.
  const played = c.map((x) => ({ ...x, lastPickAt: now - (5 - x.id) * 3600_000 })); // 1 longest ago … 4 most recent
  assert.deepEqual(pickClips(played, rotate, now), [1]);
  assert.deepEqual(pickClips(played, rotate, now, { exclude: new Set([1]) }), [2]);
  // Nothing else left: repeating beats an empty slot.
  assert.deepEqual(pickClips(c.slice(0, 1), rotate, now, { exclude: new Set([1]) }), [1]);
  // Random: the same seed gives the same clip, the most recent pick is avoided.
  const random = { ...rotate, pick: "random" as const };
  const a = pickClips(played, random, now, { seed: "occ:x|b1/0" });
  assert.deepEqual(pickClips(played, random, now, { seed: "occ:x|b1/0" }), a);
  for (let i = 0; i < 20; i++) assert.notDeepEqual(pickClips(played, random, now, { seed: `s${i}` }), [4]);
});

test("newest subfolder: week names, ISO weeks and the year rollover", () => {
  assert.equal(weekOfName("wk 45"), 45);
  assert.equal(weekOfName("Wk45"), 45);
  assert.equal(weekOfName("week 07"), 7);
  assert.equal(weekOfName("Week_3 extra"), 3);
  assert.equal(weekOfName("Reportages"), null);
  assert.equal(weekOfName("new 2"), null);
  assert.equal(weekOfName("wk 60"), null);
  assert.equal(yearOfPath("PROGRAMMA/2026 Reportages/wk 45"), 2026);
  assert.equal(yearOfPath("PROGRAMMA/Reportages/wk 45"), null);
  assert.deepEqual(isoWeek("2026-11-02"), { year: 2026, week: 45 });
  assert.deepEqual(isoWeek("2026-11-01"), { year: 2026, week: 44 });
  assert.deepEqual(isoWeek("2027-01-01"), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek("2027-01-04"), { year: 2027, week: 1 });
  assert.deepEqual(isoWeek("2025-12-29"), { year: 2026, week: 1 });

  const P = "PROGRAMMA/2026 Reportages";
  const c = (folder: string, newestAt = 0) => ({ folder, newestAt });
  const w45 = { year: 2026, week: 45 };
  // This week's folder, also when an older week got a late clip.
  assert.deepEqual(newestFolders([c(`${P}/wk 44`, 9), c(`${P}/wk 45`, 1)], P, w45), [`${P}/wk 45`]);
  // Next week's folder filled in advance waits until its week starts (year in the path).
  assert.deepEqual(newestFolders([c(`${P}/wk 45`), c(`${P}/wk 46`)], P, w45), [`${P}/wk 45`]);
  assert.deepEqual(newestFolders([c(`${P}/wk 45`), c(`${P}/wk 46`)], P, { year: 2026, week: 46 }), [`${P}/wk 46`]);
  // Monday morning, this week's folder still empty (so not a candidate): last week keeps playing.
  assert.deepEqual(newestFolders([c(`${P}/wk 44`), c(`${P}/wk 45`)], P, { year: 2026, week: 46 }), [`${P}/wk 45`]);
  // No year in the path: after New Year "wk 1" is newer than "wk 52".
  const R = "PROGRAMMA/Reportages";
  assert.deepEqual(newestFolders([c(`${R}/wk 52`), c(`${R}/wk 1`)], R, { year: 2027, week: 1 }), [`${R}/wk 1`]);
  assert.deepEqual(newestFolders([c(`${R}/wk 52`), c(`${R}/wk 51`)], R, { year: 2027, week: 1 }), [`${R}/wk 52`]);
  // A year folder per year: parent PROGRAMMA moves on to "2027 Reportages" by itself.
  assert.deepEqual(newestFolders([c("PROGRAMMA/2026 Reportages/wk 52"), c("PROGRAMMA/2027 Reportages/wk 1")], "PROGRAMMA", { year: 2027, week: 1 }), ["PROGRAMMA/2027 Reportages/wk 1"]);
  // Two series with a week folder: both of this week play.
  assert.deepEqual(newestFolders([c("PROGRAMMA/2026 Sport/wk 45"), c(`${P}/wk 45`), c(`${P}/wk 44`)], "PROGRAMMA", w45), [`${P}/wk 45`, "PROGRAMMA/2026 Sport/wk 45"]);
  // Folders without week names: the one with the most recent clip.
  assert.deepEqual(newestFolders([c("Shows/Aflevering A", 5), c("Shows/Aflevering B", 7)], "Shows", w45), ["Shows/Aflevering B"]);
  // Only folders below the parent count.
  assert.deepEqual(newestFolders([c("Other/wk 45")], P, w45), []);
});

// ---- API end to end ---------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "tvsm-auto-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
const noDevices: DriverFactory = {
  switcher: () => {
    throw new Error("no ATEM in this test");
  },
  playout: () => {
    throw new Error("no studio in this test");
  },
};
let cookie = "";
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body };
};

test.before(async () => {
  p = await createPlatform(managementOptions({ drivers: noDevices, autostart: false }));
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("news block: newest clips of a folder fill it, a new clip pushes the oldest out", async () => {
  const dir = join(root, "media");
  mkdirSync(join(dir, "News", "Daily"), { recursive: true });
  mkdirSync(join(dir, "Idents"), { recursive: true });
  const now = Date.now();
  const files: [string, number][] = [
    ["News/old.mp4", 5],
    ["News/older.mp4", 6],
    ["News/Daily/mid.mp4", 3],
    ["News/new.mp4", 1],
    ["Idents/intro.mp4", 30],
  ];
  for (const [f, daysAgo] of files) {
    writeFileSync(join(dir, f), "x");
    const t = new Date(now - daysAgo * DAY);
    utimesSync(join(dir, f), t, t);
  }
  const src = (await api("POST", "/api/media/sources", { name: "Test", type: "local", config: { path: dir } })).body.id as number;
  await new Promise((r) => setTimeout(r, 300));
  const media = (await api("GET", "/api/media")).body.items as { id: number; name: string }[];
  const id = (n: string) => media.find((m) => m.name === n)!.id;
  for (const m of media) await api("PUT", `/api/media/${m.id}`, { category: "program", durationMs: 2 * MIN });

  // A rule without a folder or category is refused.
  assert.equal((await api("POST", "/api/blocks", { name: "Bad", items: [{ type: "auto", autoRule: { source: "folder", folder: "" } }] })).body.error, "auto_source_required");

  const block = (
    await api("POST", "/api/blocks", {
      name: "Nieuws",
      items: [
        { type: "media", mediaId: id("intro") },
        { type: "auto", autoRule: { source: "folder", folder: "News", count: 3 } },
      ],
    })
  ).body.id as number;
  let d = (await api("GET", `/api/blocks/${block}`)).body;
  const auto = d.items[1];
  assert.equal(auto.type, "auto");
  assert.equal(auto.autoSourceName, "News");
  assert.deepEqual(auto.autoClips.map((c: { name: string }) => c.name), ["new", "mid", "old"]);
  assert.equal(auto.effectiveDurationMs, 6 * MIN);
  assert.equal(d.block.durationMs, 8 * MIN);

  // A new clip arrives in the folder: it comes first and "old" drops out.
  writeFileSync(join(dir, "News", "breaking.mp4"), "x");
  await api("POST", `/api/media/sources/${src}/scan`);
  await new Promise((r) => setTimeout(r, 300));
  const breaking = ((await api("GET", "/api/media?q=breaking")).body.items as { id: number }[])[0]!.id;
  await api("PUT", `/api/media/${breaking}`, { category: "program", durationMs: MIN });
  d = (await api("GET", `/api/blocks/${block}`)).body;
  assert.deepEqual(d.items[1].autoClips.map((c: { name: string }) => c.name), ["breaking", "new", "mid"]);

  // The timeline plays the clips that existed when the block starts.
  const loader = dbLoader(p.ctx.db);
  assert.deepEqual(expandBlock(loader, block).map((l) => [l.title, !!l.auto]), [
    ["intro", false],
    ["breaking", true],
    ["new", true],
    ["mid", true],
  ]);
  assert.deepEqual(expandBlock(loader, block, [], null, false, now - 2 * DAY).map((l) => l.title), ["intro", "mid", "old", "older"]);

  // By category instead of folder.
  const cat = (await api("POST", "/api/categories", { name: "Nieuws", color: "#3B6CFF" })).body.id as number;
  await api("POST", "/api/media/assign-category", { ids: [id("old"), id("older")], categoryId: cat });
  await api("PUT", `/api/blocks/${block}`, { name: "Nieuws", items: [{ type: "auto", autoRule: { source: "category", categoryId: cat, count: 5, order: "oldest_first" } }] });
  d = (await api("GET", `/api/blocks/${block}`)).body;
  assert.equal(d.items[0].autoSourceName, "Nieuws");
  assert.deepEqual(d.items[0].autoClips.map((c: { name: string }) => c.name), ["older", "old"]);
  assert.equal(d.items[0].durationMs, null);
});

test("hour block from dynamic folders: ad, bumper, news, bumper", async () => {
  const dir = join(root, "media");
  for (const f of ["Reclames/ad1.mp4", "Reclames/ad2.mp4", "Bumpers/bump1.mp4", "Bumpers/bump2.mp4", "Bumpers/bump3.mp4", "Programma/item1.mp4", "Programma/item2.mp4"]) {
    mkdirSync(join(dir, f.split("/")[0]!), { recursive: true });
    writeFileSync(join(dir, f), "x");
    const t = new Date(Date.now() - DAY);
    utimesSync(join(dir, f), t, t);
  }
  const src = ((await api("GET", "/api/media/sources")).body.sources as { id: number }[])[0]!.id;
  await api("POST", `/api/media/sources/${src}/scan`);
  await new Promise((r) => setTimeout(r, 400));
  for (const m of (await api("GET", "/api/media?limit=500")).body.items as { id: number }[]) await api("PUT", `/api/media/${m.id}`, { category: "program", durationMs: 30_000 });
  const slot = (folder: string, pick: string) => ({ type: "auto", autoRule: { source: "folder", folder, count: 1, pick } });
  const block = (await api("POST", "/api/blocks", { name: "Uur", items: [slot("Reclames", "rotate"), slot("Bumpers", "rotate"), slot("Programma", "newest"), slot("Bumpers", "random")] })).body.id as number;
  const folderOf = (title: string) => title.replace(/\d+$/, "");
  const start = Date.now() + 10 * MIN;
  const hour1 = entryLeaves(dbLoader(p.ctx.db), { id: 9001, blockId: block, start }).map((l) => l.title);
  assert.deepEqual(hour1.map(folderOf), ["ad", "bump", "item", "bump"]);
  assert.notEqual(hour1[1], hour1[3], "no bumper twice in one hour");
  // Remembered: computing it again (next director tick, other loader) gives the same hour.
  assert.deepEqual(entryLeaves(dbLoader(p.ctx.db), { id: 9001, blockId: block, start }).map((l) => l.title), hour1);
  // The next hour, the other ad is in turn.
  const hour2 = entryLeaves(dbLoader(p.ctx.db), { id: 9002, blockId: block, start: start + 60 * MIN }).map((l) => l.title);
  assert.notEqual(hour2[0], hour1[0]);
  // The blocks page shows the slots without repeating a bumper.
  const d = (await api("GET", `/api/blocks/${block}`)).body;
  assert.notEqual(d.items[1].autoClips[0].id, d.items[3].autoClips[0].id);
});

test("only the newest subfolder: a folder per week plays this week's items", async () => {
  const dir = join(root, "weeks");
  const now = Date.now();
  // Week folders relative to today (station time zone Europe/Amsterdam, close enough to UTC for these offsets).
  const wk = (offsetDays: number) => {
    const d = new Date(now + offsetDays * DAY).toISOString().slice(0, 10);
    const w = isoWeek(d);
    return { name: `wk ${w.week}`, year: w.year };
  };
  const last = wk(-7);
  const cur = wk(0);
  const next = wk(7);
  const files: [string, number][] = [
    [`${last.year} Reportages/${last.name}/oud1.mp4`, 8],
    [`${last.year} Reportages/${last.name}/oud2.mp4`, 0.01], // a late addition to last week
    [`${cur.year} Reportages/${cur.name}/deze1.mp4`, 0.5],
    [`${cur.year} Reportages/${cur.name}/deze2.mp4`, 0.4],
    [`${next.year} Reportages/${next.name}/straks.mp4`, 0.2], // prepared in advance
    ["los.mp4", 0.1], // loose in the parent: never counts in this mode
  ];
  for (const [f, daysAgo] of files) {
    mkdirSync(join(dir, "PROGRAMMA", f, ".."), { recursive: true });
    writeFileSync(join(dir, "PROGRAMMA", f), "x");
    const t = new Date(now - daysAgo * DAY);
    utimesSync(join(dir, "PROGRAMMA", f), t, t);
  }
  await api("POST", "/api/media/sources", { name: "Weeks", type: "local", config: { path: dir } });
  await new Promise((r) => setTimeout(r, 300));
  const media = (await api("GET", "/api/media?limit=500")).body.items as { id: number; name: string; folder: string }[];
  for (const m of media.filter((m) => m.folder.startsWith("PROGRAMMA"))) await api("PUT", `/api/media/${m.id}`, { category: "program", durationMs: 3 * MIN });

  // The parent of the week folders (it holds no clips itself) is offered in the dialog as a folder.
  const parent = cur.year === next.year && cur.year === last.year ? `PROGRAMMA/${cur.year} Reportages` : "PROGRAMMA";
  const rule = { source: "folder", folder: parent, subfolders: "newest", count: 5, pick: "newest" };
  const r = await api("POST", "/api/blocks/auto-preview", { autoRule: rule });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.autoFolders, [`PROGRAMMA/${cur.year} Reportages/${cur.name}`]);
  assert.deepEqual(r.body.autoClips.map((c: { name: string }) => c.name), ["deze2", "deze1"]);
  assert.match(r.body.autoSourceName, new RegExp(`› .*${cur.name}$`));
  // "Everything in this folder" still plays all of it, newest first.
  const all = await api("POST", "/api/blocks/auto-preview", { autoRule: { ...rule, subfolders: "all" } });
  assert.equal(all.body.autoFolders, null);
  assert.ok(all.body.autoClips.some((c: { name: string }) => c.name === "oud2"));
  // Two weeks ago (before this week's clips existed) it was last week's folder.
  const before = autoCandidates(p.ctx.db, parseAutoRule(rule), now - 7 * DAY);
  assert.deepEqual(before.folders, [`PROGRAMMA/${last.year} Reportages/${last.name}`]);
  assert.deepEqual(before.rows.map((m) => m.name).sort(), ["oud1", "oud2"]); // oud2 did not exist yet; the pick skips it
});
