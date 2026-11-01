import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import type { DriverFactory } from "../server/drivers.ts";
import { addDaysIso, autoPick, distribute, layoutClock, occurrenceParts, overlaps, seriesChanges, seriesKey, stationDay, stationTime, weekdayOf } from "../server/hourclock.ts";

const MIN = 60_000;

// ---- pure logic ---------------------------------------------------------------

test("hour clock: fixed parts in order, flexible windows share the rest of the hour", () => {
  const durations: Record<number, number> = { 1: 30_000, 2: 4 * MIN, 3: 3 * MIN };
  const l = layoutClock(
    [
      { kind: "block", blockId: 1, durationMs: null, title: "Ident" },
      { kind: "block", blockId: 2, durationMs: null, title: "News" },
      { kind: "program", blockId: null, durationMs: null, title: null },
      { kind: "block", blockId: 3, durationMs: 5 * MIN, title: "Ads" }, // reserved 5 min, the block itself is 3
      { kind: "program", blockId: null, durationMs: null, title: null },
    ],
    (id) => durations[id]!,
  );
  assert.deepEqual(
    l.segments.map((s) => [s.offsetMs / 1000, s.durationMs / 1000]),
    [
      [0, 30],
      [30, 240],
      [270, 1515],
      [1785, 300],
      [2085, 1515],
    ],
  );
  assert.equal(l.programMs, 50.5 * MIN);
  assert.equal(l.overbooked, false);
  assert.equal(layoutClock([{ kind: "block", blockId: 1, durationMs: 61 * MIN, title: null }], () => 0).overbooked, true);
});

test("hour clock: occurrence parts follow the wall clock, content is spread without splitting items", () => {
  const layout = layoutClock(
    [
      { kind: "block", blockId: 1, durationMs: 5 * MIN, title: "Opening" },
      { kind: "program", blockId: null, durationMs: null, title: null },
      { kind: "block", blockId: 2, durationMs: 5 * MIN, title: "Ads" },
    ],
    () => 0,
  );
  const t0 = Date.parse("2026-11-02T17:00:00Z");
  const { fixed, windows } = occurrenceParts(t0, t0 + 2 * 60 * MIN, layout);
  assert.deepEqual(fixed.map((f) => [(f.start - t0) / MIN, f.blockId]), [
    [0, 1],
    [55, 2],
    [60, 1],
    [115, 2],
  ]);
  assert.deepEqual(windows.map((w) => [(w.start - t0) / MIN, (w.end - t0) / MIN]), [
    [5, 55],
    [65, 115],
  ]);
  // Starting at :30 begins halfway through the clock: the opening of that hour is skipped.
  const half = occurrenceParts(t0 + 30 * MIN, t0 + 90 * MIN, layout, 30);
  assert.deepEqual(half.fixed.map((f) => (f.start - t0) / MIN), [55, 60]);
  assert.deepEqual(half.windows.map((w) => [(w.start - t0) / MIN, (w.end - t0) / MIN]), [
    [30, 55],
    [65, 90],
  ]);

  // 50-minute windows: 30 + 15 fit, 20 moves to the next hour, 60 fits nowhere (goes to the first empty window).
  const d = distribute([30 * MIN, 15 * MIN, 20 * MIN, 25 * MIN, 10 * MIN], windows);
  assert.deepEqual(d.placements.map((p) => [p.skip, p.take]), [
    [0, 2],
    [2, 2],
  ]);
  assert.equal(d.overflowCount, 1);
  assert.equal(d.overflowMs, 10 * MIN);
  const long = distribute([60 * MIN, 10 * MIN], windows);
  assert.deepEqual(long.placements.map((p) => [p.skip, p.take, p.tooLong]), [
    [0, 1, true],
    [1, 1, false],
  ]);
  // No clock: one window for the whole occurrence.
  assert.equal(occurrenceParts(t0, t0 + 90 * MIN, null).windows.length, 1);
});

test("auto pick: least recently used first, first fit per window, no repeats", () => {
  const pool = [
    { id: 1, durationMs: 40 * MIN },
    { id: 2, durationMs: 30 * MIN },
    { id: 3, durationMs: 9 * MIN },
    { id: 4, durationMs: 20 * MIN },
  ];
  assert.deepEqual(autoPick(pool, [50 * MIN, 50 * MIN]), [1, 3, 2, 4]);
});

test("week slots overlap across midnight and the end of the week; station time follows DST", () => {
  assert.equal(overlaps({ weekday: 0, startMin: 18 * 60, durationMin: 120 }, { weekday: 0, startMin: 19 * 60, durationMin: 60 }), true);
  assert.equal(overlaps({ weekday: 0, startMin: 18 * 60, durationMin: 60 }, { weekday: 0, startMin: 19 * 60, durationMin: 60 }), false);
  assert.equal(overlaps({ weekday: 6, startMin: 23 * 60, durationMin: 120 }, { weekday: 0, startMin: 0, durationMin: 30 }), true);
  // Amsterdam: CET (+1) in winter, CEST (+2) in summer.
  assert.equal(new Date(stationTime("2026-11-02", 18 * 60, "Europe/Amsterdam")).toISOString(), "2026-11-02T17:00:00.000Z");
  assert.equal(new Date(stationTime("2026-07-06", 18 * 60, "Europe/Amsterdam")).toISOString(), "2026-07-06T16:00:00.000Z");
  // The night DST ends (25 October 2026): 03:00 local is 02:00 UTC.
  assert.equal(new Date(stationTime("2026-10-25", 3 * 60, "Europe/Amsterdam")).toISOString(), "2026-10-25T02:00:00.000Z");
  assert.deepEqual(stationDay(Date.parse("2026-11-01T23:30:00Z"), "Europe/Amsterdam"), { date: "2026-11-02", weekday: 0, minute: 30 });
  assert.equal(weekdayOf("2026-11-02"), 0);
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
});

// ---- API end to end ---------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "tvsm-week-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let h: ManagementHandles;
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
  p = await createPlatform(managementOptions({ drivers: noDevices, autostart: false, onReady: (x) => (h = x) }));
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("week schedule: hour clock, category slot, editor rundown, publish to schedule and EPG", async () => {
  const dir = join(root, "media");
  mkdirSync(join(dir, "Sport"), { recursive: true });
  mkdirSync(join(dir, "Idents"), { recursive: true });
  for (const f of ["Sport/a.mp4", "Sport/b.mp4", "Sport/c.mp4", "Idents/ident.mp4", "Idents/news.mp4"]) writeFileSync(join(dir, f), "x");
  assert.equal((await api("POST", "/api/media/sources", { name: "Test", type: "local", config: { path: dir } })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const media = (await api("GET", "/api/media")).body.items as { id: number; name: string }[];
  const id = (n: string) => media.find((m) => m.name === n)!.id;
  const len: Record<string, number> = { a: 25 * MIN, b: 20 * MIN, c: 30 * MIN, ident: 30_000, news: 4.5 * MIN };
  for (const [n, ms] of Object.entries(len)) await api("PUT", `/api/media/${id(n)}`, { category: "program", durationMs: ms });

  // Categories; a whole folder gets one.
  const sport = (await api("POST", "/api/categories", { name: "Sport", color: "#1DB97A" })).body.id;
  assert.equal((await api("POST", "/api/media/assign-category", { folder: "Sport", categoryId: sport })).body.changed, 3);
  const cats = (await api("GET", "/api/categories")).body.categories;
  assert.equal(cats[0].mediaCount, 3);
  assert.equal((await api("GET", `/api/media?categoryId=${sport}`)).body.total, 3);

  // Hour clock: ident + news at the top of the hour, programme, 5-minute ad break at :55.
  const ident = (await api("POST", "/api/blocks", { name: "Ident + news", items: [{ type: "media", mediaId: id("ident") }, { type: "media", mediaId: id("news") }] })).body.id;
  const ads = (await api("POST", "/api/blocks", { name: "Ads", kind: "commercial", items: [{ type: "media", mediaId: id("ident") }] })).body.id;
  const clock = await api("POST", "/api/clocks", {
    name: "Standard hour",
    items: [
      { kind: "block", blockId: ident },
      { kind: "program" },
      { kind: "block", blockId: ads, durationMs: 5 * MIN },
    ],
  });
  assert.equal(clock.status, 200);
  const c = (await api("GET", `/api/clocks/${clock.body.id}`)).body;
  assert.equal(c.layout.programMs, 50 * MIN);

  const ch = (await api("POST", "/api/channels", { name: "IJmond", atemId: null, studioId: null, playoutInput: null })).body.id;
  assert.equal((await api("PUT", `/api/week/channels/${ch}`, { weekEnabled: true, clockId: clock.body.id })).status, 200);

  // A date next week, so publishing (which starts at "now") includes it.
  const date = addDaysIso(new Date().toISOString().slice(0, 10), 8);
  const wd = weekdayOf(date);
  const slot = await api("POST", "/api/week/slots", { channelId: ch, weekdays: [wd], startMin: 18 * 60, durationMin: 120, categoryId: sport, title: "Sportuur" });
  assert.equal(slot.status, 200);
  const slotId = slot.body.ids[0];
  assert.equal((await api("POST", "/api/week/slots", { channelId: ch, weekdays: [wd], startMin: 19 * 60, durationMin: 60, categoryId: sport })).body.error, "slot_overlap");
  // The same slot on other days (copy day).
  assert.equal((await api("POST", "/api/week/copy-day", { channelId: ch, from: wd, to: [(wd + 1) % 7] })).body.copied, 1);

  // Publishing picked media from the category for every hour.
  const occs = (await api("GET", `/api/week/occurrences?channel=${ch}&from=${date}&days=1`)).body.occurrences;
  assert.equal(occs.length, 1);
  assert.equal(occs[0].state, "auto");
  assert.equal(occs[0].capacityMs, 100 * MIN);
  const start = stationTime(date, 18 * 60, "Europe/Amsterdam");
  const sched = async () =>
    (await api("GET", `/api/schedule?channel=${ch}&from=${new Date(start - MIN).toISOString()}&to=${new Date(start + 121 * MIN).toISOString()}`)).body.entries as {
      id: number;
      startAt: string;
      programTitle: string;
      origin: string;
      block: { name: string };
    }[];
  let entries = await sched();
  // Every hour starts the same way: ident + news at :00, ads at :55.
  const at = (e: { startAt: string }) => (Date.parse(e.startAt) - start) / MIN;
  assert.deepEqual(
    entries.filter((e) => e.block.name !== "Ads" || true).map((e) => [at(e), e.programTitle]),
    [
      [0, "Ident + news"],
      [5, "Sportuur"],
      [55, "Ads"],
      [60, "Ident + news"],
      [65, "Sportuur"],
      [115, "Ads"],
    ],
  );
  assert.ok(entries.every((e) => e.origin === "week"));
  // Publishing again without changes keeps the entries (and their ids, which the director uses to preload).
  const again = (await api("POST", "/api/week/publish", { channelId: ch })).body;
  assert.equal(again.created, 0);
  assert.equal(again.removed, 0);
  assert.deepEqual((await sched()).map((e) => e.id), entries.map((e) => e.id));
  assert.equal((await api("DELETE", `/api/schedule/${entries[0]!.id}`)).body.error, "week_entry");

  // EPG: one programme for the whole slot.
  const epg = (await api("GET", `/api/epg?from=${new Date(start - MIN).toISOString()}&to=${new Date(start + 121 * MIN).toISOString()}`)).body.programmes;
  assert.deepEqual(
    epg.map((x: { title: string; startAt: string; endAt: string; genre: string }) => [x.title, at({ startAt: x.startAt }), at({ startAt: x.endAt }), x.genre]),
    [["Sportuur", 0, 120, "Sport"]],
  );

  // The editor puts the rundown together: c (30) + a (25) do not fit one 50-minute window, so a moves to the next hour.
  assert.equal((await api("PUT", `/api/week/occurrences/${slotId}/${date}`, { items: [{ type: "media", mediaId: id("c") }, { type: "media", mediaId: id("b") }, { type: "media", mediaId: id("a") }], ready: true })).status, 200);
  const detail = (await api("GET", `/api/week/occurrences/${slotId}/${date}`)).body;
  assert.equal(detail.occurrence.state, "manual");
  assert.equal(detail.occurrence.ready, true);
  const windows = detail.parts.filter((x: { type: string }) => x.type === "window");
  assert.deepEqual(
    windows.map((w: { items: { title: string }[] }) => w.items.map((i) => i.title)),
    [["c", "b"], ["a"]],
  );
  entries = await sched();
  assert.deepEqual(entries.filter((e) => e.programTitle === "Sportuur").map(at), [5, 65]);

  // A manual entry wins: generated entries that start while it plays are left out.
  const live = (await api("POST", "/api/blocks", { name: "Live match", items: [{ type: "media", mediaId: id("c") }] })).body.id;
  await api("POST", "/api/schedule", { channelId: ch, startAt: new Date(start + 50 * MIN).toISOString(), blockId: live });
  await api("POST", "/api/week/publish", { channelId: ch });
  entries = await sched();
  assert.deepEqual(
    entries.map((e) => [at(e), e.programTitle]),
    [
      [0, "Ident + news"],
      [5, "Sportuur"],
      [50, "Live match"],
      [115, "Ads"],
    ],
  );

  // Back to automatic.
  assert.equal((await api("DELETE", `/api/week/occurrences/${slotId}/${date}`)).status, 200);
  assert.equal((await api("GET", `/api/week/occurrences/${slotId}/${date}`)).body.occurrence.state, "auto");

  // Drag and drop: media dropped on a date is added to what is planned (here the automatic pick).
  const before = (await api("GET", `/api/week/occurrences/${slotId}/${date}`)).body.items.length as number;
  const dropped = await api("POST", `/api/week/occurrences/${slotId}/${date}/append`, { items: [{ type: "media", mediaId: id("news") }], at: 0 });
  assert.equal(dropped.status, 200);
  assert.equal(dropped.body.total, before + 1);
  const afterDrop = (await api("GET", `/api/week/occurrences/${slotId}/${date}`)).body;
  assert.equal(afterDrop.occurrence.state, "manual");
  assert.equal(afterDrop.items[0].mediaId, id("news"));
  // Dropped at the end, keeps the order of what was there.
  await api("POST", `/api/week/occurrences/${slotId}/${date}/append`, { items: [{ type: "block", childBlockId: ident }] });
  const items2 = (await api("GET", `/api/week/occurrences/${slotId}/${date}`)).body.items as { type: string; mediaId: number | null; childBlockId: number | null }[];
  assert.equal(items2.length, before + 2);
  assert.equal(items2.at(-1)!.childBlockId, ident);
  assert.equal((await api("POST", `/api/week/occurrences/${slotId}/${date}/append`, { items: [] })).status, 400);
  await api("DELETE", `/api/week/occurrences/${slotId}/${date}`);

  // A clip dropped on an hour clock becomes a block; the same clip again reuses it.
  const fm = await api("POST", "/api/blocks/from-media", { mediaIds: [id("ident")] });
  assert.equal(fm.status, 200);
  assert.equal(fm.body.created, true);
  assert.equal((await api("POST", "/api/blocks/from-media", { mediaIds: [id("ident")] })).body.id, fm.body.id);
  const fmBlock = (await api("GET", `/api/blocks/${fm.body.id}`)).body;
  assert.equal(fmBlock.block.name, "ident");
  assert.equal(fmBlock.block.durationMs, 30_000);
  const multi = (await api("POST", "/api/blocks/from-media", { mediaIds: [id("a"), id("b")] })).body;
  assert.equal(multi.created, true);
  const mb = (await api("GET", `/api/blocks/${multi.id}`)).body;
  assert.equal(mb.block.name, "a +1");
  assert.equal(mb.block.categoryId, sport);
  assert.equal((await api("POST", "/api/blocks/from-media", { mediaIds: [999999] })).status, 404);

  // Switching the week schedule off removes the generated entries.
  await api("PUT", `/api/week/channels/${ch}`, { weekEnabled: false, clockId: clock.body.id });
  assert.deepEqual((await sched()).map((e) => e.programTitle), ["Live match"]);
  assert.ok(h.planner);
});

test("series: the same slot on several weekdays is edited as one", async () => {
  // Pure: what is added, kept and removed.
  const cur = [
    { id: 1, weekday: 0 },
    { id: 2, weekday: 2 },
    { id: 3, weekday: 4 },
  ];
  const c = seriesChanges(cur, [4, 0, 5, 5]);
  assert.deepEqual(c.keep.map((k) => k.id), [1, 3]);
  assert.deepEqual(c.remove.map((k) => k.id), [2]);
  assert.deepEqual(c.add, [5]);
  const base = { startMin: 600, durationMin: 60, clockMode: "channel", clockId: 9, blockId: null, categoryId: 1, title: "" };
  assert.equal(seriesKey(base), seriesKey({ ...base, clockId: null, title: null }));
  assert.notEqual(seriesKey(base), seriesKey({ ...base, startMin: 660 }));

  const ch = (await api("POST", "/api/channels", { name: "Series", atemId: null, studioId: null, playoutInput: null })).body.id;
  const block = (await api("POST", "/api/blocks", { name: "Morning hour", items: [] })).body.id;
  const made = await api("POST", "/api/week/slots", { channelId: ch, weekdays: [0, 2, 4], startMin: 9 * 60, durationMin: 60, blockId: block });
  assert.equal(made.status, 200);
  const other = (await api("POST", "/api/week/slots", { channelId: ch, weekdays: [0], startMin: 10 * 60, durationMin: 60, blockId: block })).body.ids[0];
  const first = made.body.ids[0];
  assert.deepEqual((await api("GET", `/api/week/slots/${first}/series`)).body.slots.map((s: { weekday: number }) => s.weekday), [0, 2, 4]);
  // The 10:00 slot is its own series.
  assert.equal((await api("GET", `/api/week/slots/${other}/series`)).body.slots.length, 1);

  // Mon, Tue, Thu, Sat and one hour later... clashes with the 10:00 slot on Monday.
  const clash = await api("PUT", `/api/week/slots/${first}/series`, { weekdays: [0, 1, 3, 5], startMin: 10 * 60, durationMin: 60, blockId: block });
  assert.equal(clash.body.error, "slot_overlap");
  assert.equal((await api("GET", `/api/week?channel=${ch}`)).body.slots.length, 4, "nothing changed");

  const moved = await api("PUT", `/api/week/slots/${first}/series`, { weekdays: [0, 1, 3, 5], startMin: 8 * 60, durationMin: 60, blockId: block, title: "Ochtend" });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.added, 3);
  assert.equal(moved.body.removed, 2);
  assert.ok(moved.body.ids.includes(first), "Monday keeps its slot (and its rundowns)");
  const slots = (await api("GET", `/api/week?channel=${ch}`)).body.slots as { weekday: number; startMin: number; title: string | null }[];
  assert.deepEqual(slots.filter((s) => s.title === "Ochtend").map((s) => [s.weekday, s.startMin]).sort(), [[0, 480], [1, 480], [3, 480], [5, 480]]);

  // A 24-hour series cannot run on two days in a row.
  assert.equal((await api("PUT", `/api/week/slots/${other}/series`, { weekdays: [2, 3], startMin: 12 * 60, durationMin: 1440, blockId: block })).body.error, "slot_overlap");

  assert.equal((await api("DELETE", `/api/week/slots/${first}/series`)).body.removed, 4);
  assert.equal((await api("GET", `/api/week?channel=${ch}`)).body.slots.length, 1);
});

test("one programme at several times of the day, all or nothing", async () => {
  const ch = (await api("POST", "/api/channels", { name: "Repeat", atemId: null, studioId: null, playoutInput: null })).body.id;
  const block = (await api("POST", "/api/blocks", { name: "Hour template", items: [] })).body.id;
  const r = await api("POST", "/api/week/slots", { channelId: ch, weekdays: [5, 6], startMin: 0, startMins: [14 * 60, 12 * 60, 13 * 60], durationMin: 60, blockId: block });
  assert.equal(r.status, 200);
  assert.equal(r.body.ids.length, 6);
  const slots = (await api("GET", `/api/week?channel=${ch}`)).body.slots as { weekday: number; startMin: number }[];
  assert.deepEqual(slots.filter((s) => s.weekday === 5).map((s) => s.startMin).sort(), [720, 780, 840]);
  // Times that run into each other: nothing is made.
  const bad = await api("POST", "/api/week/slots", { channelId: ch, weekdays: [0], startMin: 0, startMins: [600, 630], durationMin: 60, blockId: block });
  assert.equal(bad.body.error, "slot_overlap");
  assert.equal((await api("GET", `/api/week?channel=${ch}`)).body.slots.length, 6);
});
