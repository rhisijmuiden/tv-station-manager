import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as tar from "tar";
import type { PlatformContext } from "../context.js";
import { diffManifest, scanTree, type Manifest } from "./manifest.js";
import { createTarget, SECRET_KEYS, type BackupTarget, type Protocol } from "./targets/index.js";

export type BackupKind = "full" | "incremental";

/** Metadata stored next to every archive on the remote (`<archive>.json`), so a fresh install can restore without a local database. */
export interface BackupMeta {
  format: 1;
  id: string;
  kind: BackupKind;
  parentId: string | null;
  baseId: string;
  app: string;
  host: string;
  version: string;
  createdAt: string;
  archive: string;
  fileCount: number;
  deleted: string[];
  /** Complete file set after this backup; used to remove stale files on restore. */
  manifest: Manifest;
}

export interface BackupTargetRow {
  id: number;
  name: string;
  protocol: Protocol;
  config: Record<string, unknown>;
  enabled: boolean;
}

/** Extra directories to back up: label -> absolute path. "db" and "conf" are reserved. */
export type BackupSources = Record<string, string>;

const PENDING = "restore-pending.json";

export class BackupEngine {
  private running = false;
  constructor(private ctx: PlatformContext, private sources: () => BackupSources) {}

  get isRunning() {
    return this.running;
  }

  // ---- targets -----------------------------------------------------------

  listTargets(): BackupTargetRow[] {
    return (this.ctx.db.prepare("SELECT id, name, protocol, config, enabled FROM backup_targets ORDER BY id").all() as Record<string, unknown>[]).map(
      (r) => ({
        id: Number(r.id),
        name: String(r.name),
        protocol: r.protocol as Protocol,
        config: this.decryptConfig(JSON.parse(String(r.config))),
        enabled: Boolean(r.enabled),
      }),
    );
  }

  getTarget(id: number) {
    const t = this.listTargets().find((x) => x.id === id);
    if (!t) throw new Error(`backup target ${id} not found`);
    return t;
  }

  saveTarget(input: { id?: number; name: string; protocol: Protocol; config: Record<string, unknown>; enabled: boolean }) {
    createTarget(input.protocol, input.config); // validates
    const cfg = this.encryptConfig(input.config);
    if (input.id) {
      this.ctx.db
        .prepare("UPDATE backup_targets SET name = ?, protocol = ?, config = ?, enabled = ? WHERE id = ?")
        .run(input.name, input.protocol, JSON.stringify(cfg), input.enabled ? 1 : 0, input.id);
      return input.id;
    }
    const r = this.ctx.db
      .prepare("INSERT INTO backup_targets (name, protocol, config, enabled) VALUES (?, ?, ?, ?)")
      .run(input.name, input.protocol, JSON.stringify(cfg), input.enabled ? 1 : 0);
    return Number(r.lastInsertRowid);
  }

  deleteTarget(id: number) {
    this.ctx.db.prepare("DELETE FROM backup_targets WHERE id = ?").run(id);
  }

  private encryptConfig(cfg: Record<string, unknown>) {
    const out = { ...cfg };
    for (const k of SECRET_KEYS) if (typeof out[k] === "string" && out[k]) out[k] = this.ctx.secrets.encrypt(out[k] as string);
    return out;
  }
  private decryptConfig(cfg: Record<string, unknown>) {
    const out = { ...cfg };
    for (const k of SECRET_KEYS) if (typeof out[k] === "string" && out[k]) out[k] = this.ctx.secrets.decrypt(out[k] as string);
    return out;
  }

  target(row: BackupTargetRow): BackupTarget {
    return createTarget(row.protocol, row.config);
  }

  // ---- backup ------------------------------------------------------------

  private lastSuccessful(targetId: number) {
    return this.ctx.db
      .prepare("SELECT id, base_id, manifest FROM backup_runs WHERE target_id = ? AND status = 'success' ORDER BY started_at DESC LIMIT 1")
      .get(targetId) as { id: string; base_id: string; manifest: string } | undefined;
  }

  async run(targetId: number, requested: BackupKind): Promise<{ id: string; kind: BackupKind; remoteName: string }> {
    if (this.running) throw new Error("A backup or restore is already running");
    this.running = true;
    const row = this.getTarget(targetId);
    const id = randomUUID();
    const startedAt = new Date();
    const prev = this.lastSuccessful(targetId);
    const kind: BackupKind = requested === "incremental" && prev ? "incremental" : "full";
    this.ctx.db
      .prepare("INSERT INTO backup_runs (id, target_id, kind, parent_id, base_id, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)")
      .run(id, targetId, kind, kind === "incremental" ? prev!.id : null, kind === "incremental" ? prev!.base_id : id, startedAt.toISOString());

    const work = await mkdtemp(join(this.ctx.config.dataDir, ".backup-"));
    try {
      // 1. Consistent snapshot of the SQLite database.
      const stage = join(work, "stage");
      mkdirSync(join(stage, "db"), { recursive: true });
      this.ctx.db.exec(`VACUUM INTO '${join(stage, "db", "app.db").replace(/'/g, "''")}'`);

      // 2. Build the manifest over db snapshot + conf + app sources.
      const prevManifest: Manifest = kind === "incremental" ? JSON.parse(prev!.manifest) : {};
      // The VACUUM output always has a fresh mtime; compare by hash only for the db.
      const prevNoDb = Object.fromEntries(Object.entries(prevManifest).filter(([p]) => !p.startsWith("db/")));
      const manifest: Manifest = {
        ...(await scanTree(join(stage, "db"), "db", {})),
        ...(await scanTree(this.ctx.config.confDir, "conf", prevNoDb)),
      };
      const roots: Record<string, string> = { db: join(stage, "db"), conf: this.ctx.config.confDir };
      for (const [label, path] of Object.entries(this.sources())) {
        Object.assign(manifest, await scanTree(path, `files/${label}`, prevNoDb));
        roots[`files/${label}`] = path;
      }
      const { changed, deleted } = kind === "incremental" ? diffManifest(prevManifest, manifest) : { changed: Object.values(manifest), deleted: [] };

      // 3. Copy the selected files into the archive tree and pack it.
      const tree = join(work, "tree");
      mkdirSync(tree);
      for (const e of changed) {
        const rootKey = Object.keys(roots).find((k) => e.path.startsWith(`${k}/`))!;
        const src = join(roots[rootKey]!, e.path.slice(rootKey.length + 1));
        const dst = join(tree, e.path);
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst, { preserveTimestamps: true });
      }
      const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      const archive = `${this.ctx.config.app.id}_${this.ctx.config.hostname}_${stamp}_${kind === "full" ? "full" : "incr"}_${id.slice(0, 8)}.tar.gz`;
      const meta: BackupMeta = {
        format: 1,
        id,
        kind,
        parentId: kind === "incremental" ? prev!.id : null,
        baseId: kind === "incremental" ? prev!.base_id : id,
        app: this.ctx.config.app.id,
        host: this.ctx.config.hostname,
        version: this.ctx.config.version,
        createdAt: startedAt.toISOString(),
        archive,
        fileCount: changed.length,
        deleted,
        manifest,
      };
      writeFileSync(join(tree, "tvsm-backup.json"), JSON.stringify(meta, null, 2));
      const archivePath = join(work, archive);
      await tar.create({ gzip: { level: 6 }, file: archivePath, cwd: tree, portable: true }, ["."]);
      const metaPath = join(work, `${archive}.json`);
      writeFileSync(metaPath, JSON.stringify(meta));

      // 4. Upload archive first, then metadata (metadata marks the backup as complete on the remote).
      const target = this.target(row);
      await target.upload(archivePath, archive);
      await target.upload(metaPath, `${archive}.json`);

      this.ctx.db
        .prepare("UPDATE backup_runs SET status = 'success', remote_name = ?, size_bytes = ?, file_count = ?, manifest = ?, finished_at = ? WHERE id = ?")
        .run(archive, statSync(archivePath).size, changed.length, JSON.stringify(manifest), new Date().toISOString(), id);
      this.ctx.log.info({ id, kind, archive, files: changed.length }, "backup completed");
      if (kind === "full") await this.applyRetention(row).catch((err) => this.ctx.log.warn({ err }, "backup retention failed"));
      return { id, kind, remoteName: archive };
    } catch (err) {
      this.ctx.db
        .prepare("UPDATE backup_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run((err as Error).message, new Date().toISOString(), id);
      throw err;
    } finally {
      this.running = false;
      await rm(work, { recursive: true, force: true });
    }
  }

  listRuns(limit = 100) {
    return this.ctx.db
      .prepare(
        `SELECT r.id, r.target_id AS targetId, t.name AS targetName, r.kind, r.parent_id AS parentId, r.base_id AS baseId, r.status,
                r.remote_name AS remoteName, r.size_bytes AS sizeBytes, r.file_count AS fileCount, r.error, r.started_at AS startedAt, r.finished_at AS finishedAt
           FROM backup_runs r LEFT JOIN backup_targets t ON t.id = r.target_id ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(limit);
  }

  // ---- remote catalogue & retention ---------------------------------------

  async listRemote(targetId: number): Promise<Omit<BackupMeta, "manifest">[]> {
    const target = this.target(this.getTarget(targetId));
    const files = await target.list();
    const names = new Set(files.map((f) => f.name));
    const metas: Omit<BackupMeta, "manifest">[] = [];
    const tmp = await mkdtemp(join(this.ctx.config.dataDir, ".catalog-"));
    try {
      for (const f of files) {
        if (!f.name.endsWith(".tar.gz.json") || !names.has(f.name.slice(0, -5))) continue;
        const local = join(tmp, f.name);
        await target.download(f.name, local);
        const { manifest: _m, ...meta } = JSON.parse(readFileSync(local, "utf8")) as BackupMeta;
        if (meta.format === 1) metas.push(meta);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async applyRetention(row: BackupTargetRow) {
    const keep = this.ctx.settings.get<{ retentionFull?: number }>("backup.schedule", {}).retentionFull ?? 4;
    if (keep < 1) return;
    const remote = await this.listRemote(row.id);
    const fulls = remote.filter((m) => m.kind === "full" && m.app === this.ctx.config.app.id);
    const expiredBases = new Set(fulls.slice(keep).map((m) => m.id));
    if (expiredBases.size === 0) return;
    const target = this.target(row);
    for (const m of remote.filter((x) => expiredBases.has(x.baseId))) {
      await target.remove(m.archive);
      await target.remove(`${m.archive}.json`);
      this.ctx.log.info({ archive: m.archive }, "backup removed by retention");
    }
  }

  // ---- restore -----------------------------------------------------------

  /**
   * Downloads the chain (full + incrementals up to `backupId`), builds the restored tree and schedules it
   * to be applied on next start (the database cannot be swapped while open). Caller then restarts the service.
   */
  async prepareRestore(targetId: number, backupId: string) {
    if (this.running) throw new Error("A backup or restore is already running");
    this.running = true;
    try {
      const remote = await this.listRemote(targetId);
      const byId = new Map(remote.map((m) => [m.id, m]));
      const chain: Omit<BackupMeta, "manifest">[] = [];
      for (let cur = byId.get(backupId); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
        chain.unshift(cur);
        if (cur.kind === "full") break;
      }
      if (chain.length === 0 || chain[0]!.kind !== "full") throw new Error("Backup chain is incomplete: the full backup it depends on is missing");

      const dir = join(this.ctx.config.dataDir, "restore");
      rmSync(dir, { recursive: true, force: true });
      const tree = join(dir, "tree");
      mkdirSync(tree, { recursive: true });
      const target = this.target(this.getTarget(targetId));
      let finalMeta: BackupMeta | undefined;
      for (const m of chain) {
        const file = join(dir, m.archive);
        await target.download(m.archive, file);
        await tar.extract({ file, cwd: tree, strict: true });
        rmSync(file);
        finalMeta = JSON.parse(readFileSync(join(tree, "tvsm-backup.json"), "utf8")) as BackupMeta;
        for (const p of m.deleted) rmSync(join(tree, p), { force: true });
      }
      // Drop anything not in the final manifest (safety net for deletes across the chain).
      for (const p of Object.keys(await scanTree(tree, "r"))) {
        const rel = p.slice(2); // strip "r/"
        if (rel !== "tvsm-backup.json" && !(rel in finalMeta!.manifest)) rmSync(join(tree, rel), { force: true });
      }
      if (!existsSync(join(tree, "db", "app.db"))) throw new Error("Restored backup has no database");
      writeFileSync(
        join(this.ctx.config.dataDir, PENDING),
        JSON.stringify({ tree, backupId, createdAt: finalMeta!.createdAt, sources: this.sources(), requestedAt: new Date().toISOString() }),
      );
      return { backupId, createdAt: finalMeta!.createdAt, chain: chain.map((c) => c.archive) };
    } finally {
      this.running = false;
    }
  }
}

/** Applies a prepared restore. Must run before the database is opened. Returns true when a restore was applied. */
export function applyPendingRestore(dataDir: string, confDir: string, log: (msg: string) => void = console.log): boolean {
  const pendingFile = join(dataDir, PENDING);
  if (!existsSync(pendingFile)) return false;
  const pending = JSON.parse(readFileSync(pendingFile, "utf8")) as { tree: string; backupId: string; sources: BackupSources };
  const { tree } = pending;
  // Database.
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, `app.db${suffix}`), { force: true });
  cpSync(join(tree, "db", "app.db"), join(dataDir, "app.db"));
  // Configuration (includes secret.key, required to decrypt stored credentials).
  if (existsSync(join(tree, "conf"))) cpSync(join(tree, "conf"), confDir, { recursive: true, force: true, preserveTimestamps: true });
  // App sources.
  for (const [label, path] of Object.entries(pending.sources ?? {})) {
    const src = join(tree, "files", label);
    if (!existsSync(src)) continue;
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    cpSync(src, path, { recursive: true, preserveTimestamps: true });
  }
  rmSync(pendingFile);
  rmSync(dirname(tree), { recursive: true, force: true });
  log(`Restored backup ${pending.backupId}`);
  return true;
}
