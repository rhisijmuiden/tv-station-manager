/**
 * Studio node support (Windows + CasparCG + DeckLink). Active only when install-studio.ps1 has written studio.json.
 * Reports CasparCG (AMCP), the RTMP ingest server (MediaMTX) and the media share in every heartbeat, and runs the
 * studio commands (restart CasparCG / ingest).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import type { StudioStatus } from "@tvsm/platform/agent-protocol";

export interface StudioConfig {
  casparDir: string;
  amcpPort: number;
  casparService: string;
  ingestService: string;
  ingestApiPort: number;
  rtmpUrl: string | null;
  mediaPath: string | null;
  outputs: { device: number; channel: number; format: string }[];
}

export function studioConfigPath() {
  if (process.env.TVSM_STUDIO_CONFIG) return process.env.TVSM_STUDIO_CONFIG;
  if (process.platform === "win32") return join(process.env.ProgramData ?? "C:\\ProgramData", "TVSM", "studio", "studio.json");
  return "/etc/tvsm/studio/studio.json";
}

export function readStudioConfig(): StudioConfig | null {
  const p = studioConfigPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    const c = JSON.parse(raw) as Partial<StudioConfig>;
    return {
      casparDir: c.casparDir ?? "",
      amcpPort: c.amcpPort ?? 5250,
      casparService: c.casparService ?? "tvsm-casparcg",
      ingestService: c.ingestService ?? "tvsm-ingest",
      ingestApiPort: c.ingestApiPort ?? 9997,
      rtmpUrl: c.rtmpUrl ?? null,
      mediaPath: c.mediaPath ?? null,
      outputs: Array.isArray(c.outputs) ? c.outputs : [],
    };
  } catch {
    return null;
  }
}

// ---- AMCP ----------------------------------------------------------------------

/**
 * Parses AMCP replies. 200 = data lines until an empty line, 201 = one data line, anything else = status line only.
 * Returns the parsed replies and the unconsumed rest of the buffer.
 */
export function parseAmcp(buf: string): { replies: { code: number; lines: string[] }[]; rest: string } {
  const replies: { code: number; lines: string[] }[] = [];
  let rest = buf;
  for (;;) {
    const nl = rest.indexOf("\r\n");
    if (nl < 0) break;
    const head = rest.slice(0, nl);
    const code = Number(/^(\d{3})/.exec(head)?.[1] ?? 0);
    if (code === 201) {
      const nl2 = rest.indexOf("\r\n", nl + 2);
      if (nl2 < 0) break;
      replies.push({ code, lines: [rest.slice(nl + 2, nl2)] });
      rest = rest.slice(nl2 + 2);
    } else if (code === 200) {
      const end = rest.indexOf("\r\n\r\n", nl);
      if (end < 0) break;
      replies.push({ code, lines: end > nl ? rest.slice(nl + 2, end).split("\r\n").filter(Boolean) : [] });
      rest = rest.slice(end + 4);
    } else {
      replies.push({ code, lines: [] });
      rest = rest.slice(nl + 2);
    }
  }
  return { replies, rest };
}

/** Parses `INFO` lines like "1 1080i5000 PLAYING". */
export function parseInfoChannels(lines: string[]) {
  return lines
    .map((l) => /^(\d+)\s+(\S+)\s*(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ id: Number(m[1]), format: m[2]!, status: (m[3] || "").trim() || "UNKNOWN" }));
}

/** Sends AMCP commands one by one on a short-lived connection. */
export function amcp(port: number, commands: string[], timeoutMs = 3000): Promise<{ code: number; lines: string[] }[]> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    const out: { code: number; lines: string[] }[] = [];
    let buf = "";
    const timer = setTimeout(() => done(new Error("AMCP timeout")), timeoutMs);
    const done = (err?: Error) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(out);
    };
    const next = () => {
      if (out.length >= commands.length) return done();
      sock.write(`${commands[out.length]}\r\n`);
    };
    sock.setEncoding("utf8");
    sock.on("error", (e) => done(e));
    sock.on("data", (d: string) => {
      buf += d;
      const r = parseAmcp(buf);
      buf = r.rest;
      for (const reply of r.replies) {
        out.push(reply);
        next();
      }
    });
    sock.connect(port, "127.0.0.1", next);
  });
}

// ---- Windows services ------------------------------------------------------------

const capture = (cmd: string, args: string[], timeoutMs = 10_000) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = "";
    let p;
    try {
      p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      return resolve({ code: -1, out: "" });
    }
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", () => resolve({ code: -1, out }));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

/** `sc query` → "running" | "stopped" | "start_pending" | ... | "missing". */
export function parseScState(out: string) {
  const m = /STATE\s*:\s*\d+\s+(\w+)/.exec(out);
  return m ? m[1]!.toLowerCase() : "missing";
}

async function serviceState(name: string) {
  if (process.platform !== "win32") return "n/a";
  const r = await capture("sc.exe", ["query", name]);
  return parseScState(r.out);
}

export async function restartService(name: string) {
  if (process.platform !== "win32") throw new Error("Only available on Windows studio nodes");
  const r = await capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Restart-Service -Name '${name.replace(/'/g, "")}' -Force -ErrorAction Stop`], 60_000);
  if (r.code !== 0) throw new Error(r.out.trim().split("\n")[0] || `Restart of ${name} failed`);
  return `${name} restarted`;
}

// ---- status ------------------------------------------------------------------------

interface MtxPath {
  name: string;
  ready?: boolean;
  readers?: unknown[];
  tracks?: (string | { codec?: string })[];
  tracks2?: { codec?: string }[];
}

async function ingestStreams(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/v3/paths/list?itemsPerPage=100`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`MediaMTX API ${res.status}`);
  const j = (await res.json()) as { items?: MtxPath[] };
  return (j.items ?? []).map((p) => ({
    name: p.name,
    ready: !!p.ready,
    readers: p.readers?.length ?? 0,
    tracks: (p.tracks2 ?? p.tracks ?? []).map((t) => (typeof t === "string" ? t : (t.codec ?? "?"))),
  }));
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

export async function studioStatus(cfg: StudioConfig): Promise<StudioStatus> {
  const [casparService, ingestService] = await Promise.all([serviceState(cfg.casparService), serviceState(cfg.ingestService)]);
  let connected = false;
  let version: string | null = null;
  let channels: StudioStatus["casparcg"]["channels"] = [];
  try {
    const [v, info] = await amcp(cfg.amcpPort, ["VERSION", "INFO"]);
    connected = true;
    version = v?.lines[0]?.trim() || null;
    channels = parseInfoChannels(info?.lines ?? []);
  } catch {
    /* CasparCG not running */
  }
  const streams = await withTimeout(ingestStreams(cfg.ingestApiPort), 2500, [] as StudioStatus["ingest"]["streams"]);
  const mediaReachable = cfg.mediaPath ? await withTimeout(access(cfg.mediaPath).then(() => true), 3000, false) : null;
  return {
    casparcg: { service: casparService, connected, version, channels },
    ingest: { service: ingestService, rtmpUrl: cfg.rtmpUrl, streams },
    outputs: cfg.outputs,
    mediaPath: cfg.mediaPath,
    mediaReachable,
  };
}
