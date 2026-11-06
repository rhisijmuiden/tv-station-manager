import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupTarget, RemoteFile, SmbConfig } from "./types.js";

/**
 * SMB / Windows share target (NAS, Windows server, UniFi UNAS). Uses Samba's `smbclient`, which speaks SMB2/SMB3
 * with signing and optional SMB3 encryption, so nothing has to be mounted and no root rights are needed.
 */

/** Folder segments of the configured directory (forward or backslashes, no empty parts, no "..". */
export function smbDirParts(directory: string): string[] {
  const parts = directory.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === ".." || p === ".")) throw new Error("SMB directory may not contain . or ..");
  return parts;
}

/** Quotes a name for an smbclient -c command. smbclient has no escape for double quotes, so they are refused. */
export function smbQuote(name: string, local = false): string {
  if (/["\r\n;]/.test(name)) throw new Error(`unsupported file name for SMB: ${name}`);
  return `"${local ? name : name.replace(/\//g, "\\")}"`;
}

/** Arguments that pick the server, share, credentials and protection. */
export function smbArgs(cfg: SmbConfig, authFile: string, directory?: string): string[] {
  const args = [`//${cfg.host}/${cfg.share}`, "-A", authFile, "-m", cfg.protocol];
  if (cfg.port) args.push("-p", String(cfg.port));
  if (cfg.encrypt) args.push("--client-protection=encrypt");
  if (!cfg.username) args.push("-N");
  if (directory) args.push("-D", directory);
  return args;
}

/** Parses the file rows of smbclient `ls` output (directories, "." and ".." skipped). */
export function parseSmbLs(out: string): RemoteFile[] {
  const files: RemoteFile[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = /^\s{2}(.*?)\s+([A-Z]{0,8})\s+(\d+)\s+\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4}\s*$/.exec(raw);
    if (!m) continue;
    const [, name, attrs, size] = m;
    if (!name || name === "." || name === ".." || attrs!.includes("D")) continue;
    files.push({ name, size: Number(size) });
  }
  return files;
}

/** First NT_STATUS error in the output, ignoring the ones listed (e.g. "folder already exists"). */
export function smbFailure(output: string, ignore: string[] = []): string | null {
  for (const m of output.matchAll(/^(.*?)(NT_STATUS_[A-Z0-9_]+)(.*)$/gm)) {
    if (ignore.includes(m[2]!)) continue;
    return m[0]!.trim();
  }
  return null;
}

const FRIENDLY: Record<string, string> = {
  NT_STATUS_LOGON_FAILURE: "wrong user name or password",
  NT_STATUS_BAD_NETWORK_NAME: "share not found",
  NT_STATUS_ACCESS_DENIED: "access denied",
  NT_STATUS_CONNECTION_REFUSED: "server refused the connection (port 445 closed?)",
  NT_STATUS_HOST_UNREACHABLE: "server not reachable",
  NT_STATUS_IO_TIMEOUT: "server not reachable (timeout)",
  NT_STATUS_OBJECT_NAME_NOT_FOUND: "file or folder not found",
  NT_STATUS_OBJECT_PATH_NOT_FOUND: "folder not found",
  NT_STATUS_DISK_FULL: "share is full",
};
const explain = (line: string) => {
  const code = /NT_STATUS_[A-Z0-9_]+/.exec(line)?.[0];
  return code && FRIENDLY[code] ? `SMB: ${FRIENDLY[code]} (${code})` : `SMB: ${line}`;
};

export class SmbTarget implements BackupTarget {
  constructor(private cfg: SmbConfig) {}

  private dir() {
    return smbDirParts(this.cfg.directory).join("\\");
  }

  /** Runs smbclient with a temporary credentials file (the password never shows up in `ps`). */
  private async smb(commands: string, opts: { inDir?: boolean; ignore?: string[]; timeoutMs?: number } = {}) {
    const tmp = mkdtempSync(join(tmpdir(), "tvsm-smb-"));
    const auth = join(tmp, "auth");
    const c = this.cfg;
    writeFileSync(auth, `username = ${c.username || "guest"}\npassword = ${c.password}\n${c.domain ? `domain = ${c.domain}\n` : ""}`, { mode: 0o600 });
    try {
      const args = [...smbArgs(c, auth, opts.inDir && this.dir() ? this.dir() : undefined), "-c", commands];
      const out = await new Promise<string>((resolve, reject) => {
        const p = spawn("smbclient", args, { stdio: ["ignore", "pipe", "pipe"] });
        let text = "";
        const timer = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
        p.stdout.on("data", (d) => (text += d));
        p.stderr.on("data", (d) => (text += d));
        p.on("error", (e) => {
          clearTimeout(timer);
          reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error("smbclient is not installed (apt install smbclient)") : e);
        });
        p.on("close", (code, signal) => {
          clearTimeout(timer);
          if (signal) return reject(new Error("SMB: timed out"));
          const fail = smbFailure(text, opts.ignore);
          if (fail) return reject(new Error(explain(fail)));
          const onlyIgnored = (opts.ignore ?? []).some((c) => text.includes(c));
          if (code !== 0 && !onlyIgnored) return reject(new Error(`SMB: ${text.trim().split("\n").pop() || `smbclient exit ${code}`}`));
          resolve(text);
        });
      });
      return out;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Creates the backup folder (and parents) when missing. */
  private async ensureDir() {
    const parts = smbDirParts(this.cfg.directory);
    if (!parts.length) return;
    const mk = parts.map((_, i) => `mkdir ${smbQuote(parts.slice(0, i + 1).join("\\"))}`).join("; ");
    await this.smb(mk, { ignore: ["NT_STATUS_OBJECT_NAME_COLLISION"] });
  }

  async test() {
    await this.ensureDir();
    const probe = `.tvsm-write-test-${Date.now()}`;
    const tmp = mkdtempSync(join(tmpdir(), "tvsm-smbprobe-"));
    try {
      writeFileSync(join(tmp, "probe"), "ok");
      await this.smb(`put ${smbQuote(join(tmp, "probe"), true)} ${smbQuote(probe)}; del ${smbQuote(probe)}`, { inDir: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const where = `\\\\${this.cfg.host}\\${this.cfg.share}${this.dir() ? `\\${this.dir()}` : ""}`;
    return { details: `SMB ok (${this.cfg.protocol}${this.cfg.encrypt ? ", encrypted" : ""}), ${where}` };
  }

  async upload(localPath: string, remoteName: string) {
    await this.ensureDir();
    const part = `${remoteName}.part`;
    // Upload under a temporary name, then rename: a half-written archive never looks like a backup.
    await this.smb(`put ${smbQuote(localPath, true)} ${smbQuote(part)}; rename ${smbQuote(part)} ${smbQuote(remoteName)} -f`, {
      inDir: true,
      timeoutMs: 6 * 3600_000,
    });
  }

  async download(remoteName: string, localPath: string) {
    await this.smb(`get ${smbQuote(remoteName)} ${smbQuote(localPath, true)}`, { inDir: true, timeoutMs: 6 * 3600_000 });
  }

  async list(): Promise<RemoteFile[]> {
    await this.ensureDir();
    return parseSmbLs(await this.smb("ls", { inDir: true }));
  }

  async remove(remoteName: string) {
    await this.smb(`del ${smbQuote(remoteName)}`, { inDir: true, ignore: ["NT_STATUS_NO_SUCH_FILE", "NT_STATUS_OBJECT_NAME_NOT_FOUND"] });
  }
}
