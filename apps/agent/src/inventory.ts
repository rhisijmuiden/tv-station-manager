/**
 * Software/hardware inventory of a Windows node (inventory.ps1 in the agent folder prints one JSON object). Collected
 * at start and every 10 minutes, so the orchestrator can show what is installed and plan a role change.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NodeInventory } from "@tvsm/platform/agent-protocol";

const EVERY_MS = 10 * 60_000;
let cached: NodeInventory | null = null;
let at = 0;
let running = false;

const str = (v: unknown, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Normalises the script output; anything unexpected becomes null/empty instead of failing the heartbeat. */
export function parseInventory(raw: string, now = new Date()): NodeInventory | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw.replace(/^﻿/, "").trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const gpu = j.gpu as { name?: unknown; driver?: unknown } | null | undefined;
  const decklinks = Array.isArray(j.decklinks) ? j.decklinks : typeof j.decklinks === "string" ? [j.decklinks] : [];
  return {
    collectedAt: now.toISOString(),
    os: str(j.os, 200),
    powershell: str(j.powershell, 40),
    desktopVideo: str(j.desktopVideo, 40),
    decklinks: decklinks.map((d) => str(d)).filter((d): d is string => !!d).slice(0, 16),
    gpu: gpu && str(gpu.name, 200) ? { name: str(gpu.name, 200)!, driver: str(gpu.driver, 60) } : null,
    ffmpeg: str(j.ffmpeg, 80),
    vcredist: str(j.vcredist, 40),
    casparcg: str(j.casparcg, 40),
    mediamtx: str(j.mediamtx, 40),
    shareCredentials: j.shareCredentials === true,
    rebootPending: j.rebootPending === true,
    studioParked: j.studioParked === true,
  };
}

function collect(): Promise<NodeInventory | null> {
  const script = join(dirname(process.argv[1] ?? process.execPath), "inventory.ps1");
  if (!existsSync(script)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => p.kill(), 90_000);
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(null));
    p.on("close", () => {
      clearTimeout(timer);
      resolve(parseInventory(out));
    });
  });
}

/** Last inventory; starts a refresh in the background when it is old (or `force`). Windows only. */
export function inventory(force = false): NodeInventory | null {
  if (process.platform !== "win32") return null;
  if (!running && (force || Date.now() - at > EVERY_MS)) {
    running = true;
    at = Date.now();
    void collect()
      .then((inv) => {
        if (inv) cached = inv;
      })
      .finally(() => (running = false));
  }
  return cached;
}
