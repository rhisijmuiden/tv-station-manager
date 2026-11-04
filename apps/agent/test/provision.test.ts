import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inUpdateWindow } from "@tvsm/platform/agent-protocol";
import { shouldAutoUpdate } from "../src/autoupdate.ts";
import { parseInventory } from "../src/inventory.ts";
import { activeProvision, pollProvision, taskRunning } from "../src/provision.ts";

const at = (h: number, m = 0) => new Date(2026, 10, 4, h, m);

test("update window, also past midnight; empty = any time", () => {
  assert.ok(inUpdateWindow(at(3, 30), "03:00", "05:00"));
  assert.ok(!inUpdateWindow(at(5, 0), "03:00", "05:00"));
  assert.ok(inUpdateWindow(at(23), "22:00", "04:00"));
  assert.ok(inUpdateWindow(at(1), "22:00", "04:00"));
  assert.ok(!inUpdateWindow(at(12), "22:00", "04:00"));
  assert.ok(inUpdateWindow(at(12), "", ""));
});

test("automatic update decision", () => {
  const base = { auto: { enabled: true, windowStart: "", windowEnd: "" }, latest: "0.2.0-test.60", current: "0.2.0-test.59", now: at(4), lastAttempt: 0, busy: false };
  assert.ok(shouldAutoUpdate(base));
  assert.ok(!shouldAutoUpdate({ ...base, latest: "0.2.0-test.59" }));
  assert.ok(!shouldAutoUpdate({ ...base, latest: "0.2.0-test.58" }), "never downgrades by itself");
  assert.ok(!shouldAutoUpdate({ ...base, auto: { ...base.auto, enabled: false } }));
  assert.ok(!shouldAutoUpdate({ ...base, busy: true }), "not while provisioning");
  assert.ok(!shouldAutoUpdate({ ...base, current: "0.0.0-dev" }));
  assert.ok(!shouldAutoUpdate({ ...base, lastAttempt: at(3, 30).getTime() }), "retries once per hour");
  assert.ok(!shouldAutoUpdate({ ...base, auto: { enabled: true, windowStart: "03:00", windowEnd: "04:00" } }));
  assert.ok(!shouldAutoUpdate({ ...base, latest: null }));
});

test("inventory output is normalised", () => {
  const inv = parseInventory('\uFEFF{"os":"Windows Server 2025 Standard (26100)","powershell":"5.1.26100","desktopVideo":"15.3.1","decklinks":"DeckLink Duo (1)","gpu":{"name":"NVIDIA Quadro P620","driver":"32.0.15.8241"},"ffmpeg":null,"vcredist":"14.44.35211","casparcg":"v2.4.3-stable","mediamtx":"v1.21.3","shareCredentials":true,"rebootPending":false,"studioParked":false}');
  assert.ok(inv);
  assert.deepEqual(inv.decklinks, ["DeckLink Duo (1)"]);
  assert.equal(inv.gpu?.name, "NVIDIA Quadro P620");
  assert.equal(inv.ffmpeg, null);
  assert.equal(inv.shareCredentials, true);
  assert.equal(parseInventory("WARNING: something"), null);
  assert.equal(parseInventory('{"gpu":{"name":""},"decklinks":[1,"x"]}')!.gpu, null);
});

test("provisioning job: progress, final result once, crash detection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tvsm-prov-"));
  try {
    assert.equal(await pollProvision(dir), null);
    const now = Date.parse("2026-11-04T08:00:00Z");
    writeFileSync(join(dir, "request.json"), JSON.stringify({ id: 7, startedAt: new Date(now - 10_000).toISOString() }));
    assert.deepEqual(await pollProvision(dir, now, async () => true), { id: 7, status: "running", result: "Starting" });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ id: 7, state: "running", step: "ffmpeg" }));
    assert.equal(activeProvision(dir)?.step, "ffmpeg");
    assert.deepEqual(await pollProvision(dir, now + 5_000, async () => true), { id: 7, status: "running", result: "ffmpeg" });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ id: 7, state: "done", step: "done", message: "Node set up as ingest", rebootRequired: true }));
    assert.deepEqual(await pollProvision(dir), { id: 7, status: "done", result: "Node set up as ingest Restart required." });
    assert.equal(await pollProvision(dir), null, "reported once");
    assert.ok(existsSync(join(dir, "last-request.json")));
    assert.equal(activeProvision(dir), null);

    // The task died without a result (machine restarted mid-job).
    writeFileSync(join(dir, "request.json"), JSON.stringify({ id: 8, startedAt: new Date(Date.now() - 600_000).toISOString() }));
    writeFileSync(join(dir, "status.json"), JSON.stringify({ id: 8, state: "running", step: "decklink" }));
    const old = new Date(Date.now() - 300_000);
    utimesSync(join(dir, "status.json"), old, old);
    const r = await pollProvision(dir, Date.now(), async () => false);
    assert.equal(r?.status, "failed");
    assert.match(r!.result!, /^decklink: provisioning stopped unexpectedly/);
    assert.ok(taskRunning('"\\tvsm-provision","N/A","Running"'));
    assert.ok(!taskRunning('"\\tvsm-provision","N/A","Ready"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
