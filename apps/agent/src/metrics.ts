import { statfs } from "node:fs/promises";
import { cpus, freemem, hostname, loadavg, networkInterfaces, release, totalmem, type, uptime, arch, platform } from "node:os";
import { readFileSync } from "node:fs";
import type { NodeFacts, NodeMetrics } from "@tvsm/platform/agent-protocol";
import { AGENT_VERSION } from "./config.js";
import { readStudioConfig, studioStatus } from "./studio.js";

let lastCpu = cpuTimes();
const started = Date.now();

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

function osName() {
  try {
    const m = /PRETTY_NAME="([^"]+)"/.exec(readFileSync("/etc/os-release", "utf8"));
    if (m) return m[1]!;
  } catch {
    /* not linux */
  }
  return `${type()} ${release()}`;
}

export function facts(): NodeFacts {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.family === "IPv4")
    .map((i) => i!.address);
  return { hostname: hostname(), platform: platform(), os: osName(), arch: arch(), agentVersion: AGENT_VERSION, ips };
}

async function disks() {
  const mounts =
    process.platform === "win32"
      ? ["C:\\", "D:\\", "E:\\"]
      : (() => {
          try {
            return readFileSync("/proc/mounts", "utf8")
              .split("\n")
              .map((l) => l.split(" "))
              .filter((p) => p[1] && /^(ext[234]|xfs|btrfs|zfs|vfat|ntfs|cifs|nfs4?|overlay)$/.test(p[2] ?? "") && !p[1].startsWith("/snap"))
              .map((p) => p[1]!.replace(/\\040/g, " "));
          } catch {
            return ["/"];
          }
        })();
  const out: NodeMetrics["disks"] = [];
  for (const mount of [...new Set(mounts)]) {
    try {
      const s = await statfs(mount);
      const total = s.blocks * s.bsize;
      if (total > 0) out.push({ mount, total, used: total - s.bavail * s.bsize });
    } catch {
      /* drive absent */
    }
  }
  return out;
}

export async function metrics(): Promise<NodeMetrics> {
  const now = cpuTimes();
  const dTotal = now.total - lastCpu.total;
  const dIdle = now.idle - lastCpu.idle;
  lastCpu = now;
  const studio = readStudioConfig();
  return {
    cpuCount: cpus().length,
    cpuPercent: dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 1000) / 10 : 0,
    load1: process.platform === "win32" ? undefined : loadavg()[0],
    memTotal: totalmem(),
    memUsed: totalmem() - freemem(),
    disks: await disks(),
    uptimeSeconds: Math.round(uptime()),
    agentUptimeSeconds: Math.round((Date.now() - started) / 1000),
    ...(studio ? { studio: await studioStatus(studio) } : {}),
  };
}
