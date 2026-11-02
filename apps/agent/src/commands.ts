import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AgentCommand, CommandResult } from "@tvsm/platform/agent-protocol";
import { compareVersions } from "@tvsm/platform/semver";
import { AGENT_VERSION } from "./config.js";
import { readStudioConfig, restartService } from "./studio.js";

const run = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", reject);
    p.unref();
    resolve();
  });

const assetArch = () => ({ x64: "amd64", arm64: "arm64" } as Record<string, string>)[process.arch] ?? process.arch;
/** Release asset for this platform: a .deb on Linux, the zip that build-zip.sh makes on Windows. */
export const assetName = (version: string, platform: string = process.platform) => {
  const v = version.replace(/^v/, "").replace(/[-~]/g, ".");
  return platform === "win32" ? `tvsm-agent_${v}_windows-x64.zip` : `tvsm-agent_${v}_${assetArch()}.deb`;
};

const capture = (cmd: string, args: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    let out = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out }));
  });

/**
 * Windows: the agent runs under WinSW, which kills child processes when the service stops. So the update runs as a
 * one-off scheduled task (SYSTEM) that stops the service, unpacks the new zip over the install folder and starts it.
 */
async function installWindows(zip: string) {
  const dir = dirname(zip);
  const script = join(dir, "update-agent.ps1");
  copyFileSync(join(dirname(process.argv[1] ?? process.execPath), "update-agent.ps1"), script);
  const task = "tvsm-agent-update";
  const create = await capture("schtasks.exe", ["/Create", "/F", "/TN", task, "/SC", "ONCE", "/ST", "00:00", "/RU", "SYSTEM", "/RL", "HIGHEST", "/TR", `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}"`]);
  if (create.code !== 0) throw new Error(`schtasks /Create failed: ${create.out.trim()}`);
  const start = await capture("schtasks.exe", ["/Run", "/TN", task]);
  if (start.code !== 0) throw new Error(`schtasks /Run failed: ${start.out.trim()}`);
}

interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

async function updateAgent(update: { channel: string; repository: string }): Promise<string> {
  if (process.platform !== "linux" && process.platform !== "win32") throw new Error(`Agent self-update is not available on ${process.platform}`);
  const res = await fetch(`https://api.github.com/repos/${update.repository}/releases?per_page=50`, { headers: { "User-Agent": "tvsm-agent" } });
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  const releases = ((await res.json()) as GhRelease[])
    .filter((r) => !r.draft && (update.channel === "test" || !r.prerelease))
    .filter((r) => r.assets.some((a) => a.name === assetName(r.tag_name)))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const latest = releases[0];
  if (!latest) throw new Error(`No agent release found on the ${update.channel} channel`);
  const version = latest.tag_name.replace(/^v/, "");
  if (compareVersions(version, AGENT_VERSION) === 0) return `Already on ${version}`;
  const asset = latest.assets.find((a) => a.name === assetName(latest.tag_name))!;
  const sums = latest.assets.find((a) => a.name === "SHA256SUMS");
  if (!sums) throw new Error("Release has no SHA256SUMS");
  const dir = process.platform === "win32" ? join(process.env.ProgramData ?? "C:\\ProgramData", "TVSM", "agent", "update") : join(tmpdir(), "tvsm-agent-update");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, asset.name);
  const dl = await fetch(asset.browser_download_url, { redirect: "follow" });
  if (!dl.ok || !dl.body) throw new Error(`Download failed: ${dl.status}`);
  await pipeline(Readable.fromWeb(dl.body as never), createWriteStream(file));
  const expected = (await (await fetch(sums.browser_download_url, { redirect: "follow" })).text())
    .split("\n")
    .find((l) => l.trim().endsWith(asset.name))
    ?.split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (!expected || expected !== actual) throw new Error("Checksum mismatch; update aborted");
  if (process.platform === "win32") {
    await installWindows(file);
    return `Installing ${version}`;
  }
  // Runs outside this service so it survives the agent restart.
  await run("systemd-run", ["--unit", `tvsm-agent-update-${Date.now()}`, "--collect", "/usr/bin/env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "--allow-downgrades", file]);
  return `Installing ${version}`;
}

/** Executes a command. Restart/reboot happen after the result is reported (see `after`). */
export async function execute(
  cmd: AgentCommand,
  update: { channel: string; repository: string },
): Promise<{ result: CommandResult; after?: () => void }> {
  try {
    switch (cmd.type) {
      case "restart-agent":
        // The service manager (systemd / WinSW) restarts the process.
        return { result: { id: cmd.id, status: "done", result: "Restarting agent" }, after: () => setTimeout(() => process.exit(0), 500) };
      case "reboot":
        return {
          result: { id: cmd.id, status: "done", result: "Rebooting" },
          after: () => void (process.platform === "win32" ? run("shutdown", ["/r", "/t", "5", "/c", "TV Station Manager"]) : run("systemctl", ["reboot"])),
        };
      case "update-agent":
        return { result: { id: cmd.id, status: "done", result: await updateAgent(update) } };
      case "restart-casparcg":
      case "restart-ingest": {
        const studio = readStudioConfig();
        if (!studio) throw new Error("This node is not set up as a studio node (install-studio.ps1)");
        const svc = cmd.type === "restart-casparcg" ? studio.casparService : studio.ingestService;
        return { result: { id: cmd.id, status: "done", result: await restartService(svc) } };
      }
      default:
        return { result: { id: cmd.id, status: "failed", result: `Unknown command ${(cmd as AgentCommand).type}` } };
    }
  } catch (err) {
    return { result: { id: cmd.id, status: "failed", result: (err as Error).message } };
  }
}
