import assert from "node:assert/strict";
import { test } from "node:test";
import { baseLayer, layerKind, layersSchema } from "../server/layers.ts";
import { blockHourStart, compile, entryLeaves, type BlockRef, type Loader, type MediaRef, type ScheduleEntry } from "../server/timeline.ts";

// Simple planning: every hour block begins with the channel's fixed hour start, and the base layer follows per-kind rules.

const H = 3600_000;
const M = 60_000;
const T0 = Date.parse("2026-11-02T12:00:00Z");

const clip = (id: number, mins: number): MediaRef => ({ id, name: `clip${id}.mp4`, title: null, path: `clip${id}.mp4`, durationMs: mins * M, fps: 25, category: "program", missing: false });
const media = [clip(1, 40), clip(2, 0.25)];
const item = (mediaId: number) => ({ type: "media" as const, mediaId, childBlockId: null, liveSourceId: null, durationMs: null, title: null });
const lineup = { type: "lineup" as const, mediaId: null, childBlockId: null, liveSourceId: null, durationMs: 30_000, title: null };
// 1 = hour block (wants the hour start), 2 = old block (does not), 5 = the hour start itself (slide + tune),
// 6 = an editor's rundown for a date that holds hour block 1.
const blocks: BlockRef[] = [
  { id: 1, name: "Nieuwsuur", kind: "program", hourStart: true, fill: "beeldkrant:7", items: [item(1)] },
  { id: 2, name: "Oud blok", kind: "program", items: [item(1)] },
  { id: 5, name: "Uurstart", kind: "program", items: [lineup, item(2)] },
  { id: 6, name: "Rundown", kind: "program", items: [{ type: "block", mediaId: null, childBlockId: 1, liveSourceId: null, durationMs: null, title: null }, item(2)] },
];
const loader = (opener: number | null): Loader => ({
  block: (id) => blocks.find((b) => b.id === id),
  media: (id) => media.find((m) => m.id === id),
  live: () => undefined,
  beeldkrant: (id) => (id === 7 ? { id: 7, name: "Beeldkrant", durationMs: 30_000, showOverlay: false } : undefined),
  hourStart: (ch) => (ch === 1 ? opener : null),
});
const entry = (id: number, start: number, blockId: number, extra: Partial<ScheduleEntry> = {}): ScheduleEntry => ({ id, channelId: 1, start, blockId, title: null, description: null, inEpg: true, ...extra });

test("hour start: an hour block begins with the channel's fixed start, then its own items, then the rest of the hour", () => {
  const { events } = compile(loader(5), [entry(10, T0, 1), entry(11, T0 + H, 1)], T0, T0 + 2 * H);
  const first = events.filter((e) => e.scheduleId === 10);
  assert.deepEqual(
    first.map((e) => [e.type, (e.start - T0) / 1000]),
    [
      ["lineup", 0],
      ["media", 30],
      ["media", 45],
      ["beeldkrant", 45 + 40 * 60],
    ],
  );
  assert.ok(first[0]!.leaf?.hourStart);
  assert.ok(!first[2]!.leaf?.hourStart);
  // The fill ends on the hour, and the next hour starts with the same fixed start.
  assert.equal(first.at(-1)!.end, T0 + H);
  assert.equal(events.find((e) => e.scheduleId === 11)!.type, "lineup");
});

test("hour start: off for old blocks, when the channel has none, for parts of an hour clock and for the start block itself", () => {
  assert.equal(entryLeaves(loader(5), entry(1, T0, 2)).length, 1);
  assert.equal(entryLeaves(loader(null), entry(1, T0, 1)).length, 1);
  assert.equal(entryLeaves(loader(5), { ...entry(1, T0, 1), channelId: 2 }).length, 1);
  assert.equal(entryLeaves(loader(5), entry(1, T0, 1, { skip: 0, take: 1 })).length, 1);
  assert.equal(entryLeaves(loader(5), entry(1, T0, 5)).length, 2);
  assert.equal(entryLeaves(loader(5), entry(1, T0, 1)).length, 3);
});

test("hour start: an editor's rundown follows the hour block it holds", () => {
  const l = loader(5);
  assert.equal(blockHourStart(l, 6), true);
  assert.equal(blockHourStart(l, 2), false);
  assert.deepEqual(
    entryLeaves(l, entry(1, T0, 6)).map((x) => x.type),
    ["lineup", "media", "media", "media"],
  );
});

test("layers: defaults keep the old behaviour; rules per kind; a beeldkrant that asks for the overlay keeps it", () => {
  const layers = layersSchema.parse({});
  assert.deepEqual(baseLayer(layers, { type: "media", leaf: { blockKind: "program" } }), { kind: "media", logo: true, clock: true, ticker: true });
  assert.equal(baseLayer(layers, { type: "beeldkrant", leaf: { blockKind: "program" } }).logo, false);
  assert.equal(baseLayer(layers, { type: "beeldkrant", leaf: { blockKind: "program", showOverlay: true } }).logo, true);
  assert.equal(baseLayer(layers, { type: "lineup" }).logo, false);
  assert.equal(layerKind({ type: "media", leaf: { blockKind: "commercial" } }), "commercial");
  assert.equal(layerKind({ type: "media", leaf: { category: "commercial" } }), "commercial");
  assert.equal(layerKind(null), "filler");
  const custom = layersSchema.parse({ webcam: { logo: true, clock: false, ticker: false } });
  assert.deepEqual(baseLayer(custom, { type: "webcam" }), { kind: "webcam", logo: true, clock: false, ticker: false });
});
