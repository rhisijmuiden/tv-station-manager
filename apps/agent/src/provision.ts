/**
 * Provisioning on Windows nodes: turns the node into a TV node / ingest node / both (or removes the studio role) and
 * installs the software that needs (VC++ runtime, DeckLink driver, CasparCG, MediaMTX, FFmpeg). The work is done by
 * provision.ps1 (shipped in the agent zip), started as a one-off scheduled task (SYSTEM) so it survives an agent
 * restart; it writes its progress to status.json, which the agent reports in every heartbeat.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandResult, ProvisionPayload } from "@tvsm/platform/agent-protocol";

export const TASK = "tvsm-provision";
/** A job that has not finished after this long is reported as failed. */
const MAX_RUNTIME_MS = 3 * 60 * 60_000;

export const provisionDir = () =>
  process.env.TVSM_PROVISION_DIR ?? join(process.env.ProgramData ?? "C:\\ProgramData", "TVSM", "agent", "provision");
const agentDir = () => dirname(process.argv[1] ?? process.execPath);

export interface ProvisionStatus {
  id: number;
  state: "running" | "done" | "failed";
  step: string;
  message?: string;
  rebootRequired?: boolean;
  /** Last lines of the log, for a failed job. */
  log?: string;
  updatedAt?: string;
}
interface Request {
  id: number;
  startedAt: string;
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
};

const capture = (cmd: string, args: string[], timeoutMs = 20_000) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", () => resolve({ code: -1, out }));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

/** The job that is running now, or null. */
export function activeProvision(dir = provisionDir()): { commandId: number; startedAt: string; step: string } | null {
  const req = readJson<Request>(join(dir, "request.json"));
  if (!req) return null;
  const st = readJson<ProvisionStatus>(join(dir, "status.json"));
  return { commandId: req.id, startedAt: req.startedAt, step: st && st.id === req.id ? st.step : "Starting" };
}

/** Writes the request (the share password in a separate file the script deletes) and starts provision.ps1. */
export async function startProvision(id: number, payload: ProvisionPayload, dir = provisionDir()): Promise<string> {
  if (process.platform !== "win32") throw new Error("Provisioning is only available on Windows nodes");
  const active = activeProvision(dir);
  if (active && active.commandId !== id) throw new Error(`Provisioning #${active.commandId} is still running`);
  mkdirSync(dir, { recursive: true });
  const { smbPassword, ...rest } = payload;
  rmSync(join(dir, "status.json"), { force: true });
  if (smbPassword) writeFileSync(join(dir, "smbpass.txt"), smbPassword, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(dir, "payload.json"), JSON.stringify({ id, ...rest }, null, 2));
  writeFileSync(join(dir, "request.json"), JSON.stringify({ id, startedAt: new Date().toISOString() } satisfies Request));
  const script = join(agentDir(), "provision.ps1");
  if (!existsSync(script)) throw new Error(`provision.ps1 missing in ${agentDir()}`);
  const tr = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}" -Dir "${dir}"`;
  const create = await capture("schtasks.exe", ["/Create", "/F", "/TN", TASK, "/SC", "ONCE", "/ST", "00:00", "/RU", "SYSTEM", "/RL", "HIGHEST", "/TR", tr]);
  if (create.code !== 0) {
    rmSync(join(dir, "request.json"), { force: true });
    throw new Error(`schtasks /Create failed: ${create.out.trim()}`);
  }
  const run = await capture("schtasks.exe", ["/Run", "/TN", TASK]);
  if (run.code !== 0) {
    rmSync(join(dir, "request.json"), { force: true });
    throw new Error(`schtasks /Run failed: ${run.out.trim()}`);
  }
  return "Started";
}

/** `schtasks /Query /FO CSV /NH` → true while the task runs. */
export const taskRunning = (csv: string) => /"Running"/i.test(csv);

let lastTaskCheck = 0;
/**
 * Called every heartbeat: the progress (running) or the final result of the active job. A final result is reported
 * once; the request then moves to last-request.json.
 */
export async function pollProvision(dir = provisionDir(), now = Date.now(), isRunning?: () => Promise<boolean>): Promise<CommandResult | null> {
  const req = readJson<Request>(join(dir, "request.json"));
  if (!req) return null;
  const st = readJson<ProvisionStatus>(join(dir, "status.json"));
  const finish = (status: "done" | "failed", text: string): CommandResult => {
    try {
      renameSync(join(dir, "request.json"), join(dir, "last-request.json"));
    } catch {
      rmSync(join(dir, "request.json"), { force: true });
    }
    return { id: req.id, status, result: text.slice(0, 3900) };
  };
  if (st && st.id === req.id && (st.state === "done" || st.state === "failed")) {
    const reboot = st.rebootRequired ? " Restart required." : "";
    const text = st.state === "done" ? `${st.message ?? "Done"}${reboot}` : `${st.step}: ${st.message ?? "failed"}${st.log ? `\n${st.log}` : ""}`;
    return finish(st.state, text);
  }
  const started = Date.parse(req.startedAt) || now;
  if (now - started > MAX_RUNTIME_MS) return finish("failed", `Provisioning did not finish within ${MAX_RUNTIME_MS / 3_600_000} hours (see ${join(dir, "provision.log")})`);
  // Machine restarted or the script was killed: the task is no longer running but never wrote a result.
  const statusAge = st ? now - statSafe(join(dir, "status.json")) : now - started;
  if (statusAge > 120_000 && now - lastTaskCheck > 30_000) {
    lastTaskCheck = now;
    const running = isRunning ? await isRunning() : taskRunning((await capture("schtasks.exe", ["/Query", "/TN", TASK, "/FO", "CSV", "/NH"])).out);
    if (!running) return finish("failed", `${st?.step ?? "Start"}: provisioning stopped unexpectedly (see ${join(dir, "provision.log")})`);
  }
  return { id: req.id, status: "running", result: st?.id === req.id ? st.step : "Starting" };
}

const statSafe = (file: string) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};
