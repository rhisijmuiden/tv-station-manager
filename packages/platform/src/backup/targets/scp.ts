import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { posix } from "node:path";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { BackupTarget, RemoteFile, ScpConfig } from "./types.js";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Reads exact byte counts / lines from an SSH channel stream. */
class ChannelReader {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private ended = false;
  private stderr = "";
  constructor(private ch: ClientChannel) {
    ch.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    ch.stderr.on("data", (d: Buffer) => (this.stderr += d.toString()));
    ch.on("close", () => {
      this.ended = true;
      this.wake();
    });
  }
  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }
  private async need(n: number) {
    while (this.buf.length < n) {
      if (this.ended) throw new Error(`scp: connection closed${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  async take(n: number) {
    await this.need(n);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async line() {
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i >= 0) return (await this.take(i + 1)).toString("utf8").trimEnd();
      if (this.ended) throw new Error(`scp: connection closed${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  /** SCP status byte: 0 ok, 1 warning, 2 fatal (followed by a message line). */
  async ack() {
    const [code] = await this.take(1);
    if (code === 0) return;
    const msg = await this.line();
    throw new Error(`scp: ${msg}`);
  }
  async *chunks(total: number) {
    let left = total;
    while (left > 0) {
      await this.need(1);
      const n = Math.min(left, this.buf.length);
      left -= n;
      yield await this.take(n);
    }
  }
}

export class ScpTarget implements BackupTarget {
  private seenHostKey = "";
  constructor(private cfg: ScpConfig) {}

  private dir() {
    return this.cfg.directory || ".";
  }

  private connect<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const c = new Client();
      const opts: ConnectConfig = {
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.username,
        readyTimeout: 20_000,
        keepaliveInterval: 10_000,
        hostVerifier: (key: Buffer) => {
          const fp = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
          this.seenHostKey = fp;
          return !this.cfg.hostKeySha256 || this.cfg.hostKeySha256.replace(/^SHA256:/, "").replace(/=+$/, "") === fp;
        },
      };
      if (this.cfg.authMethod === "password") opts.password = this.cfg.password;
      else {
        opts.privateKey = this.cfg.privateKey;
        if (this.cfg.passphrase) opts.passphrase = this.cfg.passphrase;
      }
      c.on("ready", () => {
        fn(c).then(resolve, reject).finally(() => c.end());
      });
      c.on("error", (err) => {
        if (/verification failed/i.test(err.message)) reject(new Error(`Host key mismatch (got SHA256:${this.seenHostKey})`));
        else reject(err);
      });
      c.connect(opts);
    });
  }

  private exec(c: Client, cmd: string): Promise<{ stdout: string; code: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      c.exec(cmd, (err, ch) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        ch.on("data", (d: Buffer) => (stdout += d.toString()));
        ch.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        ch.on("close", (code: number) => resolve({ stdout, code: code ?? 0, stderr }));
      });
    });
  }

  private async run(c: Client, cmd: string) {
    const r = await this.exec(c, cmd);
    if (r.code !== 0) throw new Error(`${cmd.split(" ")[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout;
  }

  async test() {
    return this.connect(async (c) => {
      await this.run(c, `mkdir -p ${q(this.dir())}`);
      const probe = posix.join(this.dir(), `.tvsm-write-test-${Date.now()}`);
      await this.run(c, `touch ${q(probe)} && rm -f ${q(probe)}`);
      return { details: `SCP ok, ${this.cfg.username}@${this.cfg.host}:${this.dir()}`, hostKeySha256: `SHA256:${this.seenHostKey}` };
    });
  }

  upload(localPath: string, remoteName: string) {
    const size = statSync(localPath).size;
    const finalPath = posix.join(this.dir(), remoteName);
    const tmpName = `${remoteName}.part`;
    return this.connect(async (c) => {
      await this.run(c, `mkdir -p ${q(this.dir())}`);
      await new Promise<void>((resolve, reject) => {
        c.exec(`scp -t ${q(posix.join(this.dir(), tmpName))}`, async (err, ch) => {
          if (err) return reject(err);
          try {
            const r = new ChannelReader(ch);
            await r.ack();
            ch.write(`C0640 ${size} ${tmpName}\n`);
            await r.ack();
            for await (const chunk of createReadStream(localPath)) {
              if (!ch.write(chunk)) await new Promise<void>((res) => ch.once("drain", () => res()));
            }
            ch.write(Buffer.from([0]));
            await r.ack();
            ch.end();
            resolve();
          } catch (e) {
            ch.close();
            reject(e);
          }
        });
      });
      await this.run(c, `mv -f ${q(posix.join(this.dir(), tmpName))} ${q(finalPath)}`);
    });
  }

  download(remoteName: string, localPath: string) {
    return this.connect(
      (c) =>
        new Promise<void>((resolve, reject) => {
          c.exec(`scp -f ${q(posix.join(this.dir(), remoteName))}`, async (err, ch) => {
            if (err) return reject(err);
            try {
              const r = new ChannelReader(ch);
              ch.write(Buffer.from([0]));
              let header = await r.line();
              while (header.startsWith("T")) {
                ch.write(Buffer.from([0]));
                header = await r.line();
              }
              if (header.charCodeAt(0) === 1 || header.charCodeAt(0) === 2) throw new Error(`scp: ${header.slice(1)}`);
              const m = /^C\d{4} (\d+) /.exec(header);
              if (!m) throw new Error(`scp: unexpected header ${JSON.stringify(header)}`);
              ch.write(Buffer.from([0]));
              const out = createWriteStream(localPath);
              for await (const chunk of r.chunks(Number(m[1]))) {
                if (!out.write(chunk)) await new Promise<void>((res) => out.once("drain", () => res()));
              }
              await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
              await r.ack();
              ch.write(Buffer.from([0]));
              ch.end();
              resolve();
            } catch (e) {
              ch.close();
              reject(e);
            }
          });
        }),
    );
  }

  list(): Promise<RemoteFile[]> {
    return this.connect(async (c) => {
      await this.run(c, `mkdir -p ${q(this.dir())}`);
      // Portable listing: name<TAB>size per regular file.
      const out = await this.run(
        c,
        `cd ${q(this.dir())} && for f in *; do [ -f "$f" ] && printf '%s\\t%s\\n' "$f" "$(wc -c < "$f" | tr -d ' ')"; done; true`,
      );
      return out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [name, size] = l.split("\t");
          return { name: name!, size: Number(size) };
        });
    });
  }

  remove(remoteName: string) {
    return this.connect(async (c) => {
      await this.run(c, `rm -f ${q(posix.join(this.dir(), posix.basename(remoteName)))}`);
    });
  }
}
