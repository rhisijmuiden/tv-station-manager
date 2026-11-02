import { Cron } from "croner";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PlatformContext } from "../context.js";
import type { MailService } from "../mail.js";
import type { BackupEngine } from "./engine.js";

const MASK = "********";
const SECRET = ["password", "privateKey", "passphrase"];

export const scheduleSchema = z.object({
  enabled: z.boolean().default(false),
  targetIds: z.array(z.number().int()).default([]),
  /** Cron expressions (server local time). */
  fullCron: z.string().default("0 3 * * 0"),
  incrementalCron: z.string().default("0 3 * * 1-6"),
  retentionFull: z.number().int().min(1).max(365).default(4),
  notifyOnFailure: z.boolean().default(true),
  notifyOnSuccess: z.boolean().default(false),
});
export type BackupSchedule = z.infer<typeof scheduleSchema>;

const targetSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().trim().min(1).max(80),
  protocol: z.enum(["ftp", "ftps", "scp"]),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()),
});

export class BackupScheduler {
  private jobs: Cron[] = [];
  constructor(private ctx: PlatformContext, private engine: BackupEngine, private mail: MailService) {}

  get schedule(): BackupSchedule {
    return scheduleSchema.parse(this.ctx.settings.get("backup.schedule", {}));
  }

  reload() {
    this.jobs.forEach((j) => j.stop());
    this.jobs = [];
    const s = this.schedule;
    if (!s.enabled) return;
    this.jobs.push(new Cron(s.fullCron, { protect: true }, () => this.runAll("full")));
    this.jobs.push(new Cron(s.incrementalCron, { protect: true }, () => this.runAll("incremental")));
  }

  nextRuns() {
    return this.jobs.map((j) => j.nextRun()?.toISOString() ?? null);
  }

  async runAll(kind: "full" | "incremental") {
    const s = this.schedule;
    for (const targetId of s.targetIds) {
      try {
        const r = await this.engine.run(targetId, kind);
        if (s.notifyOnSuccess) await this.mail.alert(`Backup completed (${r.kind})`, `Backup ${r.remoteName} completed.`);
      } catch (err) {
        this.ctx.log.error({ err, targetId }, "scheduled backup failed");
        if (s.notifyOnFailure) await this.mail.alert("Backup FAILED", `Scheduled ${kind} backup to target ${targetId} failed:\n${(err as Error).message}`);
      }
    }
  }
}

export function registerBackup(app: FastifyInstance, ctx: PlatformContext, engine: BackupEngine, scheduler: BackupScheduler, restart: () => void) {
  const publicTarget = (t: ReturnType<BackupEngine["listTargets"]>[number]) => ({
    ...t,
    config: Object.fromEntries(Object.entries(t.config).map(([k, v]) => [k, SECRET.includes(k) && v ? MASK : v])),
  });
  const unmask = (input: z.infer<typeof targetSchema>) => {
    if (!input.id) return input;
    const current = engine.getTarget(input.id).config;
    const config = { ...input.config };
    for (const k of SECRET) if (config[k] === MASK) config[k] = current[k];
    return { ...input, config };
  };

  app.get("/api/backup/targets", async () => engine.listTargets().map(publicTarget));
  app.post("/api/backup/targets", async (req) => {
    const id = engine.saveTarget(unmask(targetSchema.parse(req.body)));
    return publicTarget(engine.getTarget(id));
  });
  app.delete("/api/backup/targets/:id", async (req) => {
    engine.deleteTarget(Number((req.params as { id: string }).id));
    return { ok: true };
  });
  app.post("/api/backup/targets/test", async (req) => {
    const input = unmask(targetSchema.parse(req.body));
    try {
      const { createTarget } = await import("./targets/index.js");
      const res = await createTarget(input.protocol, input.config).test();
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  app.get("/api/backup/schedule", async () => ({ ...scheduler.schedule, nextRuns: scheduler.nextRuns() }));
  app.put("/api/backup/schedule", async (req) => {
    const s = scheduleSchema.parse(req.body);
    for (const expr of [s.fullCron, s.incrementalCron]) new Cron(expr, { paused: true }).stop(); // validate
    ctx.settings.set("backup.schedule", s);
    scheduler.reload();
    return { ...scheduler.schedule, nextRuns: scheduler.nextRuns() };
  });

  app.get("/api/backup/runs", async () => ({ running: engine.isRunning, runs: engine.listRuns() }));
  app.post("/api/backup/run", async (req) => {
    const body = z.object({ targetId: z.number().int(), kind: z.enum(["full", "incremental"]) }).parse(req.body);
    // Run in the background; the UI polls /api/backup/runs.
    engine.run(body.targetId, body.kind).catch((err) => ctx.log.error({ err }, "manual backup failed"));
    return { started: true };
  });

  app.get("/api/backup/remote/:targetId", async (req) => engine.listRemote(Number((req.params as { targetId: string }).targetId)));
  app.post("/api/backup/restore", async (req) => {
    const body = z.object({ targetId: z.number().int(), backupId: z.string().uuid() }).parse(req.body);
    const res = await engine.prepareRestore(body.targetId, body.backupId);
    // Give the response time to flush, then restart so the restore is applied before the DB opens.
    setTimeout(restart, 750);
    return { ok: true, restarting: true, ...res };
  });
}
