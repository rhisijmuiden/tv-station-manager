import { Cron } from "croner";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, type PlatformContext } from "../context.js";
import type { MailService } from "../mail.js";
import type { BackupEngine } from "./engine.js";
import { randomUUID } from "node:crypto";
import { ssoConfigSchema } from "../sso.js";
import { pollDeviceCode, startDeviceCode } from "./targets/onedrive.js";
import { PROTOCOLS, SECRET_KEYS } from "./targets/index.js";

const MASK = "********";
const SECRET: readonly string[] = SECRET_KEYS;
/** Device-code sign-ins in progress (or finished but not saved yet), by flow id. */
interface OneDriveFlow {
  tenant: string;
  clientId: string;
  deviceCode: string;
  expiresAt: number;
  refreshToken?: string;
  account?: string;
}
const flows = new Map<string, OneDriveFlow>();

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
  protocol: z.enum(PROTOCOLS),
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
    const config = { ...input.config };
    // A fresh OneDrive sign-in is referenced as "flow:<id>"; the refresh token itself never goes to the browser.
    if (typeof config.refreshToken === "string" && config.refreshToken.startsWith("flow:")) {
      const flow = flows.get(config.refreshToken.slice(5));
      if (!flow?.refreshToken) throw new HttpError(400, "onedrive_signin_expired");
      config.refreshToken = flow.refreshToken;
    }
    if (!input.id) return { ...input, config };
    const current = engine.getTarget(input.id).config;
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
    const parsed = targetSchema.parse(req.body);
    try {
      const input = unmask(parsed);
      const flowId = typeof parsed.config.refreshToken === "string" && parsed.config.refreshToken.startsWith("flow:") ? parsed.config.refreshToken.slice(5) : null;
      const { createTarget } = await import("./targets/index.js");
      const res = await createTarget(input.protocol, input.config, {
        // A rotated OneDrive token must not be lost between Test and Save.
        saveConfig: (patch) => {
          const flow = flowId ? flows.get(flowId) : undefined;
          if (flow && typeof patch.refreshToken === "string") flow.refreshToken = patch.refreshToken;
          else if (input.id) engine.updateTargetConfig(input.id, patch);
        },
      }).test();
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ---- OneDrive sign-in (device code) ----------------------------------------
  app.get("/api/backup/onedrive/defaults", async () => {
    const sso = ssoConfigSchema.safeParse(ctx.settings.get("sso", {}));
    return { tenant: (sso.success && sso.data.tenantId) || "common", clientId: (sso.success && sso.data.clientId) || "" };
  });
  app.post("/api/backup/onedrive/start", async (req) => {
    const body = z.object({ tenant: z.string().trim().min(1), clientId: z.string().trim().min(1) }).parse(req.body);
    for (const [id, f] of flows) if (f.expiresAt < Date.now() - 3600_000) flows.delete(id);
    try {
      const dc = await startDeviceCode(body.tenant, body.clientId);
      const flowId = randomUUID();
      flows.set(flowId, { tenant: body.tenant, clientId: body.clientId, deviceCode: dc.device_code, expiresAt: Date.now() + dc.expires_in * 1000 });
      return { ok: true, flowId, userCode: dc.user_code, verificationUri: dc.verification_uri, expiresIn: dc.expires_in, interval: dc.interval };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  app.post("/api/backup/onedrive/poll", async (req) => {
    const { flowId } = z.object({ flowId: z.string().uuid() }).parse(req.body);
    const flow = flows.get(flowId);
    if (!flow) return { status: "error", error: "the sign-in expired, start again" };
    if (flow.refreshToken) return { status: "done", account: flow.account, refreshToken: `flow:${flowId}` };
    if (flow.expiresAt < Date.now()) return { status: "error", error: "the code expired, start the sign-in again" };
    const r = await pollDeviceCode(flow.tenant, flow.clientId, flow.deviceCode);
    if (r.status !== "done") return r;
    let account = "";
    try {
      const graph = (process.env.TVSM_GRAPH_URL ?? "https://graph.microsoft.com/v1.0").replace(/\/+$/, "");
      const me = (await (await fetch(`${graph}/me?$select=userPrincipalName,mail,displayName`, { headers: { authorization: `Bearer ${r.accessToken}` } })).json()) as {
        userPrincipalName?: string;
        mail?: string;
        displayName?: string;
      };
      account = me.mail || me.userPrincipalName || me.displayName || "";
    } catch {
      /* the account name is only for display */
    }
    flow.refreshToken = r.refreshToken;
    flow.account = account;
    flow.expiresAt = Date.now() + 3600_000; // keep it an hour so the admin can still press Save
    return { status: "done", account, refreshToken: `flow:${flowId}` };
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
