import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions, type ManagementHandles } from "../server/app.ts";
import { audioGain, audioProducer } from "../server/audio.ts";
import type { DriverFactory, PlayoutDriver, SwitcherDriver, SwitcherInfo } from "../server/drivers.ts";
import { audioIn, expandBlock, type BlockRef, type Loader } from "../server/timeline.ts";

// ---- pure logic ---------------------------------------------------------------

test("audio: the nearest choice wins (item, block, parent block, beeldkrant default)", () => {
  const blocks: Record<number, BlockRef> = {
    1: {
      id: 1,
      name: "Uur",
      kind: "program",
      audio: "7",
      items: [
        { type: "media", mediaId: 1, childBlockId: null, liveSourceId: null, durationMs: null, title: null },
        { type: "media", mediaId: 1, childBlockId: null, liveSourceId: null, durationMs: null, title: null, audio: "none" },
        { type: "block", mediaId: null, childBlockId: 2, liveSourceId: null, durationMs: null, title: null },
        { type: "block", mediaId: null, childBlockId: 3, liveSourceId: null, durationMs: null, title: null, audio: "9" },
        { type: "live", mediaId: null, childBlockId: null, liveSourceId: 1, durationMs: 60_000, title: null },
      ],
    },
    // Nested block without its own choice: follows the parent.
    2: { id: 2, name: "Reclame", kind: "commercial", items: [{ type: "media", mediaId: 1, childBlockId: null, liveSourceId: null, durationMs: null, title: null }] },
    // Nested block with its own choice, overridden by the item that holds it.
    3: { id: 3, name: "Nieuws", kind: "program", audio: "8", items: [{ type: "media", mediaId: 1, childBlockId: null, liveSourceId: null, durationMs: null, title: null }] },
    // A beeldkrant without a choice in the block takes its own default.
    4: { id: 4, name: "Bk", kind: "program", items: [{ type: "beeldkrant", beeldkrantId: 1, mediaId: null, childBlockId: null, liveSourceId: null, durationMs: null, title: null }] },
    5: { id: 5, name: "Bk stil", kind: "program", audio: "none", items: [{ type: "beeldkrant", beeldkrantId: 1, mediaId: null, childBlockId: null, liveSourceId: null, durationMs: null, title: null }] },
  };
  const loader: Loader = {
    block: (id) => blocks[id],
    media: (id) => ({ id, name: "clip.mp4", title: null, path: "clip.mp4", durationMs: 10_000, fps: 25, category: "program", missing: false }),
    live: (id) => ({ id, name: "Live", kind: "rtmp" }),
    beeldkrant: (id) => ({ id, name: "Nieuws", durationMs: 30_000, showOverlay: false, audioSourceId: 4 }),
  };
  assert.deepEqual(
    expandBlock(loader, 1).map((l) => l.audioSourceId),
    [7, null, 7, 9, null],
  );
  assert.equal(expandBlock(loader, 4)[0]!.audioSourceId, 4);
  assert.equal(expandBlock(loader, 5)[0]!.audioSourceId, null);

  assert.equal(audioIn(""), null);
  assert.equal(audioIn("none"), "none");
  assert.equal(audioIn(3), "3");
  assert.equal(audioIn("x"), null);

  assert.deepEqual(audioProducer({ kind: "stream", address: "https://radio.example/live.mp3" }), { producer: '"https://radio.example/live.mp3"', loop: true });
  assert.deepEqual(audioProducer({ kind: "soundcard", address: "Line In (Realtek(R) Audio)" }), { producer: '"dshow://audio=Line In (Realtek(R) Audio)"', loop: false });
  assert.deepEqual(audioProducer({ kind: "decklink", address: "2" }), { producer: "DECKLINK 2", loop: false });
  assert.throws(() => audioProducer({ kind: "stream", address: 'x" LOOP' }));
  assert.equal(audioGain(70), 0.7);
  assert.equal(audioGain(400), 1.5);
});

// ---- server: sources, planning, playout -------------------------------------------

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
  session = 1;
  failAudio = false;
  info() {
    return { connected: true, version: "2.4.3", channels: [1], session: this.session };
  }
  async play(ch: number, layer: number, clip?: string) {
    this.calls.push(`play ${ch}-${layer}${clip ? ` ${clip}` : ""}`);
  }
  async loadbg() {}
  async stop() {}
  async clear(ch: number, layer?: number) {
    this.calls.push(`clear ${ch}-${layer}`);
  }
  async playHtml(ch: number, layer: number) {
    this.calls.push(`html ${ch}-${layer}`);
  }
  async playAudio(ch: number, layer: number, producer: string, volume: number, loop: boolean) {
    if (this.failAudio) throw new Error("CasparCG 404 PLAY FAILED");
    this.calls.push(`audio ${ch}-${layer} ${producer} ${volume}${loop ? " loop" : ""}`);
  }
  async volume(ch: number, layer: number, v: number) {
    this.calls.push(`volume ${ch}-${layer} ${v}`);
  }
  async cgAdd() {}
  async cgUpdate() {}
  async cgStop() {}
  async addConsumer() {}
  async removeConsumer() {}
  async close() {}
}

const root = mkdtempSync(join(tmpdir(), "tvsm-audio-"));
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

test("audio: radio under the beeldkrant and a line input under a clip, on their own CasparCG layer", async () => {
  await api("POST", "/api/atems", { name: "ATEM", host: "10.40.6.50" });
  await api("POST", "/api/studios", { name: "Studio 1", host: "10.40.5.11" });
  await api("POST", "/api/studios", { name: "Studio 2", host: "10.40.5.12" });
  const atemId = (await api("GET", "/api/atems")).body.atems[0].id;
  const studios = (await api("GET", "/api/studios")).body.studios as { id: number; name: string }[];
  const s1 = studios.find((s) => s.name === "Studio 1")!.id;
  const s2 = studios.find((s) => s.name === "Studio 2")!.id;

  // Sources: checks on the address and the studio node of a physical input.
  assert.equal((await api("POST", "/api/audio-sources", { name: "x", kind: "stream", address: "ftp://x" })).body.error, "invalid_url");
  assert.equal((await api("POST", "/api/audio-sources", { name: "x", kind: "soundcard", address: "Line In" })).body.error, "studio_required");
  assert.equal((await api("POST", "/api/audio-sources", { name: "x", kind: "decklink", address: "een", studioId: s1 })).body.error, "invalid_device");
  const radio = (await api("POST", "/api/audio-sources", { name: "Radio IJmond", kind: "stream", address: "https://radio.example/live.mp3", studioId: s1, volume: 60 })).body;
  assert.equal(radio.studioId, null);
  const line = (await api("POST", "/api/audio-sources", { name: "Jack studio", kind: "soundcard", address: "Line In (Realtek(R) Audio)", studioId: s1 })).body;
  const other = (await api("POST", "/api/audio-sources", { name: "Jack studio 2", kind: "soundcard", address: "Line In", studioId: s2 })).body;

  // A beeldkrant with the radio under it; a block with a clip and the line input under it.
  const bk = (await api("POST", "/api/beeldkranten", { name: "Nieuws", feedIds: [], settings: { secondsPerPage: 10, duration: { mode: "fixed", fixedSeconds: 600 }, audioSourceId: radio.id } })).body;
  assert.equal(bk.settings.audioSourceId, radio.id);
  const block = (await api("POST", "/api/blocks", { name: "Uur", audio: String(line.id), items: [{ type: "beeldkrant", beeldkrantId: bk.id, durationMs: 60_000 }, { type: "beeldkrant", beeldkrantId: bk.id, durationMs: 60_000, audio: "none" }, { type: "beeldkrant", beeldkrantId: bk.id, durationMs: 60_000, audio: String(other.id) }] })).body;
  const detail = (await api("GET", `/api/blocks/${block.id}`)).body;
  assert.equal(detail.block.audio, String(line.id));
  assert.deepEqual(detail.items.map((i: { audio: string | null }) => i.audio), [null, "none", String(other.id)]);
  const bkOnly = (await api("POST", `/api/beeldkranten/${bk.id}/block`)).body;
  assert.equal((await api("GET", "/api/audio-sources")).body.sources.find((s: { id: number }) => s.id === line.id).usage.blocks, 1);

  const ch = (await api("POST", "/api/channels", { name: "IJmond360", atemId, studioId: s1, casparChannel: 1, playoutInput: 1 })).body;
  const t0 = Date.parse("2026-11-02T12:00:00Z");
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0).toISOString(), blockId: bkOnly.id, title: "Beeldkrant" });
  await api("POST", "/api/schedule", { channelId: ch.id, startAt: new Date(t0 + 3600_000).toISOString(), blockId: block.id, title: "Uur" });
  await api("POST", `/api/control/${ch.id}/automation`, { on: true });
  const tick = async (at: number) => {
    h.director.now = () => at;
    h.director.invalidate();
    await h.director.tick();
  };

  // Beeldkrant: its own radio default under it, picture hidden on layer 5.
  await tick(t0 + 5000);
  assert.ok(playout.calls.includes('audio 1-5 "https://radio.example/live.mp3" 0.6 loop'), playout.calls.join("\n"));
  let ctl = (await api("GET", "/api/control")).body.channels[0];
  assert.deepEqual(ctl.audio, { sourceId: radio.id, name: "Radio IJmond", kind: "stream", playing: true, error: null });
  // Next page of the same beeldkrant: the radio keeps playing (no restart).
  playout.calls = [];
  await tick(t0 + 25_000);
  assert.ok(!playout.calls.some((c) => c.startsWith("audio") || c.startsWith("clear")), playout.calls.join("\n"));
  // Volume changed by the editor: only the mixer volume.
  await api("PUT", `/api/audio-sources/${radio.id}`, { name: "Radio IJmond", kind: "stream", address: "https://radio.example/live.mp3", volume: 80 });
  await tick(t0 + 26_000);
  assert.deepEqual(playout.calls, ["volume 1-5 0.8"]);

  // The hour block: the block's line input wins over the beeldkrant default, then silence, then a wrong-node input.
  playout.calls = [];
  await tick(t0 + 3600_000 + 1000);
  assert.deepEqual(playout.calls.filter((c) => !c.startsWith("html")), ["clear 1-5", 'audio 1-5 "dshow://audio=Line In (Realtek(R) Audio)" 0.7']);
  playout.calls = [];
  await tick(t0 + 3600_000 + 61_000);
  assert.deepEqual(playout.calls.filter((c) => !c.startsWith("html")), ["clear 1-5"]);
  playout.calls = [];
  await tick(t0 + 3600_000 + 121_000);
  assert.deepEqual(playout.calls.filter((c) => !c.startsWith("html")), []);
  ctl = (await api("GET", "/api/control")).body.channels[0];
  assert.equal(ctl.audio.playing, false);
  assert.match(ctl.audio.error, /another studio node/);

  // CasparCG restarted while the radio plays: it is started again; a failing source is retried later.
  await tick(t0 + 5000);
  playout.session = 2;
  playout.calls = [];
  await tick(t0 + 6000);
  assert.deepEqual(playout.calls.filter((c) => c.startsWith("audio") || c.startsWith("clear")), ['audio 1-5 "https://radio.example/live.mp3" 0.8 loop']);
  playout.session = 3;
  playout.failAudio = true;
  await tick(t0 + 7000);
  ctl = (await api("GET", "/api/control")).body.channels[0];
  assert.match(ctl.audio.error, /PLAY FAILED/);
  playout.failAudio = false;
  playout.calls = [];
  await tick(t0 + 8000);
  assert.deepEqual(playout.calls.filter((c) => c.startsWith("audio")), []);
  await tick(t0 + 14_000);
  assert.equal(playout.calls.filter((c) => c.startsWith("audio")).length, 1);

  // Automation off: the audio stops. Deleting a source takes it out of blocks and beeldkranten.
  playout.calls = [];
  await api("POST", `/api/control/${ch.id}/automation`, { on: false });
  assert.deepEqual(playout.calls, ["clear 1-5"]);
  assert.equal((await api("DELETE", `/api/audio-sources/${line.id}`)).status, 200);
  assert.equal((await api("GET", `/api/blocks/${block.id}`)).body.block.audio, null);
  assert.equal((await api("DELETE", `/api/audio-sources/${radio.id}`)).status, 200);
  assert.equal((await api("GET", `/api/beeldkranten/${bk.id}`)).body.settings.audioSourceId, null);
});
