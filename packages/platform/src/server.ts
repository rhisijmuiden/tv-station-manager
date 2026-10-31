import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { ensureDefaultAdmin, registerAuth } from "./auth.js";
import { BackupEngine, applyPendingRestore, type BackupSources } from "./backup/engine.js";
import { BackupScheduler, registerBackup } from "./backup/routes.js";
import { loadRuntimeConfig, type AppIdentity } from "./config.js";
import { HttpError, type PlatformContext } from "./context.js";
import { SecretBox } from "./crypto.js";
import { Settings, migrate, openDb } from "./db.js";
import { MailService, registerMail } from "./mail.js";
import { UpdateService, registerUpdate } from "./update.js";

export interface PlatformOptions {
  app: AppIdentity;
  /** Directory with the built web UI (index.html). */
  webDir?: string;
  /** App-specific migrations (scope = app id). */
  migrations?: string[];
  /** Extra directories to include in backups. */
  backupSources?: (ctx: PlatformContext) => BackupSources;
  /** Register app-specific routes. */
  register?: (app: FastifyInstance, platform: Platform) => Promise<void> | void;
}

export interface Platform {
  ctx: PlatformContext;
  mail: MailService;
  backup: BackupEngine;
  updates: UpdateService;
  server: FastifyInstance;
}

export async function createPlatform(opts: PlatformOptions): Promise<Platform> {
  const config = loadRuntimeConfig(opts.app);
  applyPendingRestore(config.dataDir, config.confDir);

  const db = openDb(config.dataDir);
  migrate(db);
  if (opts.migrations) migrate(db, opts.migrations, opts.app.id);

  const server = Fastify({
    logger: { level: process.env.TVSM_LOG_LEVEL ?? "info" },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });
  const ctx: PlatformContext = { config, db, settings: new Settings(db), secrets: new SecretBox(config.confDir), log: server.log, backupPaths: [] };

  server.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "validation_failed", issues: err.issues });
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) server.log.error(err);
    return reply.status(status).send({ error: "error", message: (err as Error).message });
  });

  await server.register(cookie);
  await ensureDefaultAdmin(ctx);
  registerAuth(server, ctx);

  const mail = new MailService(ctx);
  registerMail(server, ctx, mail);

  const backup = new BackupEngine(ctx, () => opts.backupSources?.(ctx) ?? {});
  const scheduler = new BackupScheduler(ctx, backup, mail);
  scheduler.reload();
  const restart = () => {
    server.log.warn("restarting to apply restore");
    server.close().finally(() => process.exit(0));
  };
  registerBackup(server, ctx, backup, scheduler, restart);

  const updates = new UpdateService(ctx);
  registerUpdate(server, ctx, updates);

  const platform: Platform = { ctx, mail, backup, updates, server };
  await opts.register?.(server, platform);

  if (opts.webDir && existsSync(opts.webDir)) {
    await server.register(fastifyStatic, { root: opts.webDir, wildcard: false });
    // SPA fallback.
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "not_found" });
      return reply.sendFile("index.html");
    });
  }

  server.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
  });

  return platform;
}

export async function startPlatform(opts: PlatformOptions) {
  const p = await createPlatform(opts);
  await p.server.listen({ port: p.ctx.config.port, host: p.ctx.config.host });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => p.server.close().finally(() => process.exit(0)));
  return p;
}
