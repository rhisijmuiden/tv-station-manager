import assert from "node:assert/strict";
import { test } from "node:test";
import { blockFill, compile, fillIn, nextHour, parseFill, programAt, type BlockRef, type Loader, type MediaRef, type ScheduleEntry } from "../server/timeline.ts";

// "Rest of the hour": when an hour block's material ends early, its beeldkrant (or webcam) plays until the next whole hour.

const H = 3600_000;
const T0 = Date.parse("2026-11-02T12:00:00Z");
const M = 60_000;

function loader(blocks: BlockRef[], media: MediaRef[]): Loader {
  return {
    block: (id) => blocks.find((b) => b.id === id),
    media: (id) => media.find((m) => m.id === id),
    live: () => undefined,
    beeldkrant: (id) => (id === 7 ? { id: 7, name: "Nieuws", durationMs: 30_000, showOverlay: false, audioSourceId: 3 } : undefined),
    webcam: (id) => (id === 9 ? { id: 9, name: "Strand", durationMs: 60_000, showOverlay: true } : undefined),
  };
}
const clip = (id: number, mins: number): MediaRef => ({ id, name: `clip${id}.mp4`, title: null, path: `clip${id}.mp4`, durationMs: mins * M, fps: 25, category: "program", missing: false });
const media = [clip(1, 40), clip(2, 3), clip(3, 70)];
const block = (id: number, items: number[], fill: string | null = null, kind: "program" | "commercial" = "program"): BlockRef => ({
  id,
  name: `Block ${id}`,
  kind,
  fill,
  items: items.map((m) => ({ type: "media", mediaId: m, childBlockId: null, liveSourceId: null, durationMs: null, title: null })),
});
const entry = (id: number, start: number, blockId: number, extra: Partial<ScheduleEntry> = {}): ScheduleEntry => ({ id, channelId: 1, start, blockId, title: null, description: null, inEpg: true, ...extra });

test("fill: parse and normalise the stored choice", () => {
  assert.deepEqual(parseFill("beeldkrant:7"), { type: "beeldkrant", id: 7 });
  assert.deepEqual(parseFill("webcam:12"), { type: "webcam", id: 12 });
  assert.equal(parseFill("media:1"), null);
  assert.equal(parseFill(null), null);
  assert.equal(fillIn("beeldkrant:007"), "beeldkrant:7");
  assert.equal(fillIn(""), null);
  assert.equal(fillIn("rubbish"), null);
  assert.equal(nextHour(T0), T0 + H);
  assert.equal(nextHour(T0 + 40 * M), T0 + H);
});

test("fill: the beeldkrant plays from the end of the material until the next hour, then the next programme", () => {
  const l = loader([block(1, [1], "beeldkrant:7"), block(2, [2])], media);
  const { events, entries } = compile(l, [entry(10, T0, 1), entry(11, T0 + H, 2)], T0, T0 + 2 * H);
  const fill = events.find((e) => e.fill);
  assert.ok(fill);
  assert.equal(fill.type, "beeldkrant");
  assert.equal(fill.start, T0 + 40 * M);
  assert.equal(fill.end, T0 + H);
  assert.equal(fill.scheduleId, 10);
  assert.equal(fill.leaf?.beeldkrantId, 7);
  assert.equal(fill.leaf?.audioSourceId, 3);
  assert.equal(fill.title, "Nieuws");
  // No channel filler inside the first hour; the next programme starts on the hour.
  assert.equal(events.filter((e) => e.type === "filler" && e.start < T0 + H).length, 0);
  assert.equal(events.find((e) => e.scheduleId === 11)!.start, T0 + H);
  assert.equal(entries[0]!.fillMs, 20 * M);
  assert.equal(entries[0]!.gapAfterMs, 0);
  // The second block has no choice: its gap is the channel filler.
  assert.equal(entries[1]!.fillMs, 0);
  assert.ok(events.some((e) => e.type === "filler" && e.start === T0 + H + 3 * M));
});

test("fill: never past the next whole hour, and nothing when the material fills or overruns the hour", () => {
  const l = loader([block(1, [1], "beeldkrant:7"), block(3, [3], "beeldkrant:7")], media);
  // Nothing planned after it: beeldkrant until 13:00, then the channel filler.
  let { events } = compile(l, [entry(10, T0, 1)], T0, T0 + 3 * H);
  assert.equal(events.find((e) => e.fill)!.end, T0 + H);
  assert.equal(events.find((e) => e.type === "filler")!.start, T0 + H);
  // Next programme at 12:50: the beeldkrant stops there.
  ({ events } = compile(l, [entry(10, T0, 1), entry(11, T0 + 50 * M, 1)], T0, T0 + 2 * H));
  const first = events.find((e) => e.fill && e.scheduleId === 10)!;
  assert.equal(first.end, T0 + 50 * M);
  // 70 minutes of material overruns into the next programme: no fill at all.
  ({ events } = compile(l, [entry(10, T0, 3), entry(11, T0 + H, 1)], T0, T0 + 2 * H));
  assert.equal(events.filter((e) => e.fill && e.scheduleId === 10).length, 0);
});

test("fill: joining halfway plays the page from where it would be; a webcam works too; a removed beeldkrant falls back to the filler", () => {
  const l = loader([block(1, [1], "beeldkrant:7"), block(4, [1], "webcam:9"), block(5, [1], "beeldkrant:99")], media);
  let { events } = compile(l, [entry(10, T0, 1)], T0 + 45 * M, T0 + H);
  const fill = events.find((e) => e.fill)!;
  assert.equal(fill.start, T0 + 45 * M);
  assert.equal(fill.offsetMs, 5 * M);
  ({ events } = compile(l, [entry(10, T0, 4)], T0, T0 + H));
  assert.equal(events.find((e) => e.fill)!.type, "webcam");
  assert.equal(events.find((e) => e.fill)!.leaf?.webcamId, 9);
  ({ events } = compile(l, [entry(10, T0, 5)], T0, T0 + H));
  assert.equal(events.filter((e) => e.fill).length, 0);
  assert.equal(events.find((e) => e.type === "filler")!.start, T0 + 40 * M);
});

test("fill: parts of one week-schedule occurrence follow the hour block, and the hour block shows it", () => {
  // Hour clock: programme window 00:00-55:00 (hour block), ad break at 55:00 with 5:00 reserved but 3:00 of ads.
  const l = loader([block(1, [1], "beeldkrant:7"), block(6, [2], null, "commercial")], media);
  const { events } = compile(l, [entry(10, T0, 1, { group: "occ" }), entry(11, T0 + 55 * M, 6, { group: "occ", inEpg: false })], T0, T0 + H);
  const fills = events.filter((e) => e.fill);
  assert.deepEqual(
    fills.map((e) => [e.scheduleId, (e.start - T0) / M, (e.end - T0) / M]),
    [
      [10, 40, 55],
      [11, 58, 60],
    ],
  );
  const p = programAt(events, T0 + 45 * M, () => ({ group: "occ", inEpg: true }));
  assert.ok(p);
  assert.equal(p.end, T0 + H);
  assert.equal(p.items[p.index]!.fill, true);
});

test("fill: an editor's rundown for a date follows the hour block it holds", () => {
  const rundown: BlockRef = { id: 20, name: "Rundown", kind: "program", items: [{ type: "block", mediaId: null, childBlockId: 1, liveSourceId: null, durationMs: null, title: null }] };
  const l = loader([block(1, [1], "beeldkrant:7"), rundown], media);
  assert.equal(blockFill(l, 20), "beeldkrant:7");
  assert.equal(blockFill(l, 99), null);
});
