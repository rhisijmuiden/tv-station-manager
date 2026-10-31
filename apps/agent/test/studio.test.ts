import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assetName } from "../src/commands.ts";
import { amcp, maskStreamName, parseAmcp, parseInfoChannels, parseScState, readStudioConfig } from "../src/studio.ts";

test("amcp: parses 200/201/4xx replies and keeps partial data", () => {
  const r = parseAmcp("201 VERSION OK\r\n2.4.0 abc Stable\r\n200 INFO OK\r\n1 1080i5000 PLAYING\r\n2 1080i5000 PLAYING\r\n\r\n404 PLAY FAILED\r\n200 INF");
  assert.deepEqual(r.replies, [
    { code: 201, lines: ["2.4.0 abc Stable"] },
    { code: 200, lines: ["1 1080i5000 PLAYING", "2 1080i5000 PLAYING"] },
    { code: 404, lines: [] },
  ]);
  assert.equal(r.rest, "200 INF");
  assert.deepEqual(parseAmcp("200 INFO OK\r\n\r\n").replies, [{ code: 200, lines: [] }]);
  assert.deepEqual(parseInfoChannels(["1 1080i5000 PLAYING", "2 720p5000", "junk"]), [
    { id: 1, format: "1080i5000", status: "PLAYING" },
    { id: 2, format: "720p5000", status: "UNKNOWN" },
  ]);
});

test("amcp: talks to a server one command at a time", async () => {
  const srv = createServer((sock) => {
    sock.on("data", (d) => {
      const cmd = d.toString().trim();
      // Split the reply over two writes, like a real TCP stream may.
      if (cmd === "VERSION") {
        sock.write("201 VERSION OK\r\n2.4");
        setTimeout(() => sock.write(".0 Stable\r\n"), 5);
      } else if (cmd === "INFO") sock.write("200 INFO OK\r\n1 1080i5000 PLAYING\r\n\r\n");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const [v, info] = await amcp(port, ["VERSION", "INFO"]);
  assert.equal(v!.lines[0], "2.4.0 Stable");
  assert.deepEqual(info!.lines, ["1 1080i5000 PLAYING"]);
  srv.close();
  await assert.rejects(amcp(port, ["VERSION"], 500));
});

test("windows: service state, studio config and update asset", () => {
  assert.equal(parseScState("SERVICE_NAME: tvsm-casparcg\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 4  RUNNING\r\n"), "running");
  assert.equal(parseScState("[SC] EnumQueryServicesStatus:OpenService FAILED 1060"), "missing");
  assert.equal(assetName("v0.2.0-test.12", "win32"), "tvsm-agent_0.2.0.test.12_windows-x64.zip");
  assert.match(assetName("0.2.0", "linux"), /^tvsm-agent_0\.2\.0_(amd64|arm64|\w+)\.deb$/);

  const dir = mkdtempSync(join(tmpdir(), "tvsm-studio-"));
  const file = join(dir, "studio.json");
  // PowerShell's Set-Content -Encoding UTF8 writes a BOM.
  writeFileSync(file, "\uFEFF" + JSON.stringify({ casparDir: "C:\\TVSM\\casparcg", mediaPath: "\\\\unas\\TV", outputs: [{ device: 1, channel: 1, format: "1080i5000" }] }));
  process.env.TVSM_STUDIO_CONFIG = file;
  const cfg = readStudioConfig()!;
  assert.equal(cfg.amcpPort, 5250);
  assert.equal(cfg.casparService, "tvsm-casparcg");
  assert.equal(cfg.mediaPath, "\\\\unas\\TV");
  assert.equal(cfg.outputs.length, 1);
  process.env.TVSM_STUDIO_CONFIG = join(dir, "missing.json");
  assert.equal(readStudioConfig(), null);
  rmSync(dir, { recursive: true, force: true });
});

test("studio: stream keys are masked in the status report", () => {
  assert.equal(maskStreamName("live/reporter-zandvoort-0123456789abcdef01234567"), "live/reporter-zandvoort-0123…4567");
  assert.equal(maskStreamName("live/cam1"), "live/cam1");
});
