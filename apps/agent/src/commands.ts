import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AgentCommand, CommandResult } from "@tvsm/platform/agent-protocol";
import { compareVersions } from "@tvsm/platform/semver";
import { AGENT_VERSION } from "./config.js";

const run = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", reject);
    p.unref();
    resolve();
  });

const assetArch = () => ({ x64: "amd64", arm64: "arm64" } as Record<string, string>)[process.arch] ?? process.arch;
const assetName = (version: string) => `tvsm-agent_${version.replace(/^v/, "").replace(/[-~]/g, ".")}_${assetArch()}.deb`;

interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

async function updateAgent(update: { channel: string; repository: string }): Promise<string> {
  if (process.platform !== "linux") throw new Error("Agent self-update is only available on Linux for now");
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
  const dir = join(tmpdir(), "tvsm-agent-update");
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
      default:
        return { result: { id: cmd.id, status: "failed", result: `Unknown command ${(cmd as AgentCommand).type}` } };
    }
  } catch (err) {
    return { result: { id: cmd.id, status: "failed", result: (err as Error).message } };
  }
}
