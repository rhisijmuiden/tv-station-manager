import { Client } from "basic-ftp";
import { posix } from "node:path";
import type { BackupTarget, FtpConfig, RemoteFile } from "./types.js";

export class FtpTarget implements BackupTarget {
  constructor(private cfg: FtpConfig, private secure: boolean) {}

  private async connect<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client(30_000);
    const implicit = this.secure && this.cfg.tlsMode === "implicit";
    try {
      await c.access({
        host: this.cfg.host,
        port: this.cfg.port ?? (implicit ? 990 : 21),
        user: this.cfg.username,
        password: this.cfg.password,
        secure: this.secure ? (implicit ? "implicit" : true) : false,
        secureOptions: this.secure ? { rejectUnauthorized: this.cfg.verifyCertificate, minVersion: "TLSv1.2", servername: this.cfg.host } : undefined,
      });
      await c.ensureDir(this.cfg.directory || "/");
      return await fn(c);
    } finally {
      c.close();
    }
  }

  async test() {
    return this.connect(async (c) => {
      const probe = `.tvsm-write-test-${Date.now()}`;
      const { Readable } = await import("node:stream");
      await c.uploadFrom(Readable.from(["ok"]), probe);
      await c.remove(probe);
      const pwd = await c.pwd();
      return { details: `${this.secure ? "FTPS" : "FTP"} ok, directory ${pwd}` };
    });
  }

  upload(localPath: string, remoteName: string) {
    return this.connect(async (c) => {
      const tmp = `${remoteName}.part`;
      await c.uploadFrom(localPath, tmp);
      await c.rename(tmp, remoteName);
    });
  }

  download(remoteName: string, localPath: string) {
    return this.connect(async (c) => {
      await c.downloadTo(localPath, posix.basename(remoteName));
    });
  }

  list(): Promise<RemoteFile[]> {
    return this.connect(async (c) => (await c.list()).filter((f) => f.isFile).map((f) => ({ name: f.name, size: f.size })));
  }

  remove(remoteName: string) {
    return this.connect(async (c) => {
      await c.remove(remoteName);
    });
  }
}
