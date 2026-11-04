import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmMatches, planProvision, provisionRequestSchema, type PlanNode } from "../server/provisionlogic.ts";

const inv = {
  collectedAt: "2026-11-04T07:00:00Z",
  os: "Windows Server 2025",
  powershell: "5.1",
  desktopVideo: "15.3.1",
  decklinks: ["DeckLink Duo (1)", "DeckLink Duo (2)"],
  gpu: { name: "Quadro P620", driver: "582.41" },
  ffmpeg: null,
  vcredist: "14.44.35211",
  casparcg: "v2.4.3-stable",
  mediamtx: "v1.21.3",
  shareCredentials: true,
  rebootPending: false,
  studioParked: false,
};
const studio = {
  casparcg: { service: "running", connected: true, version: "2.4.3", channels: [] },
  ingest: { service: "running", rtmpUrl: null, streams: [{ name: "live/a", ready: true, readers: 1, tracks: [] }] },
  outputs: [
    { device: 1, channel: 1, format: "1080i5000" },
    { device: 2, channel: 2, format: "1080i5000" },
  ],
  mediaPath: "\\\\unas\\TV",
  mediaReachable: true,
  role: "playout" as const,
};
const node: PlanNode = { name: "CASPARCG02", platform: "win32", online: true, role: "playout", agentCapabilities: ["provision"], studio, inventory: inv, busy: false };
const req = (o: object) => provisionRequestSchema.parse(o);
const keys = (p: { key: string }[]) => p.map((x) => x.key);

test("role change on a running TV node: warnings, steps, no typed name when not on air", () => {
  const p = planProvision(node, req({ role: "live", outputs: 1, managementHosts: ["10.40.6.202"] }), { onAir: [], deckLinkSource: "" });
  assert.equal(p.blocked, false);
  assert.equal(p.requireTypedName, false);
  assert.equal(p.disruptive, true);
  assert.deepEqual(keys(p.steps), ["casparcg", "mediamtx", "config", "firewall", "restartServices", "setRole"]);
  assert.deepEqual(p.steps.at(-1)!.params, { role: "live" });
  const w = keys(p.warnings);
  for (const k of ["outputsFewer", "casparRestart", "liveInUse", "managementSync"]) assert.ok(w.includes(k), k);
  assert.ok(!w.includes("noManagementHost"));
});

test("on program: typing the name is required; preview only warns", () => {
  const onAir = [{ atem: "ATEM 4K", input: 8, inputName: "Playout", bus: "program" as const }];
  assert.equal(planProvision(node, req({ role: "studio" }), { onAir, deckLinkSource: "" }).requireTypedName, true);
  assert.equal(planProvision(node, req({ role: "studio" }), { onAir: [{ ...onAir[0]!, bus: "preview" }], deckLinkSource: "" }).requireTypedName, false);
  // Removing the studio role always needs the name.
  const none = planProvision(node, req({ role: "none" }), { onAir: [], deckLinkSource: "" });
  assert.equal(none.requireTypedName, true);
  assert.deepEqual(keys(none.steps), ["disableStudio", "setRole"]);
  assert.deepEqual(none.steps[1]!.params, { role: "other" });
});

test("bare Windows PC: everything installed, DeckLink needs a source, old agent updates first", () => {
  const bare: PlanNode = { ...node, studio: null, agentCapabilities: [], inventory: { ...inv, desktopVideo: null, decklinks: [], vcredist: null, casparcg: null, mediamtx: null } };
  const blocked = planProvision(bare, req({ role: "playout", components: ["decklink", "ffmpeg"] }), { onAir: [], deckLinkSource: "" });
  assert.ok(blocked.blocked);
  assert.ok(keys(blocked.warnings).includes("deckLinkNoSource"));
  const p = planProvision(bare, req({ role: "playout", components: ["decklink", "ffmpeg"], rebootWhenDone: true, mediaPath: "\\\\10.40.0.154\\TV_Data\\Uitzending", smbUser: "reinder", smbPassword: "x" }), {
    onAir: [],
    deckLinkSource: "https://example.com/dv.zip",
  });
  assert.equal(p.blocked, false);
  assert.deepEqual(keys(p.steps), ["updateAgent", "vcredist", "decklink", "ffmpeg", "casparcg", "mediamtx", "config", "share", "firewall", "restartServices", "reboot", "setRole"]);
  assert.ok(keys(p.warnings).includes("managementAdd"));
  assert.ok(keys(p.warnings).includes("noManagementHost"));
  assert.equal(p.requireTypedName, false);
});

test("blocks: offline, Linux, busy, share user without password; schema checks the share path", () => {
  const w = (n: Partial<PlanNode>, r: object = { role: "playout" }) => keys(planProvision({ ...node, ...n }, req(r), { onAir: [], deckLinkSource: "" }).warnings);
  assert.ok(w({ online: false }).includes("offline"));
  assert.ok(w({ platform: "linux" }).includes("notWindows"));
  assert.ok(w({ busy: true }).includes("busy"));
  assert.ok(w({}, { role: "playout", smbUser: "x" }).includes("smbPasswordMissing"));
  assert.throws(() => req({ role: "playout", mediaPath: "/mnt/tv" }));
  assert.ok(confirmMatches(" casparcg02", "CASPARCG02"));
  assert.ok(!confirmMatches("", "CASPARCG02"));
});
