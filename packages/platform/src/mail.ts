import type { FastifyInstance } from "fastify";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { z } from "zod";
import type { PlatformContext } from "./context.js";
import { HttpError } from "./context.js";

const KEY = "mail";
const MASK = "********";

export const mailConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().trim().default(""),
  port: z.number().int().min(1).max(65535).default(587),
  /** starttls: plain connect then upgrade (587). tls: implicit TLS (465). none: no encryption (lab only). */
  security: z.enum(["starttls", "tls", "none"]).default("starttls"),
  minTlsVersion: z.enum(["TLSv1.2", "TLSv1.3"]).default("TLSv1.2"),
  verifyCertificate: z.boolean().default(true),
  auth: z
    .object({
      method: z.enum(["none", "password", "oauth2"]).default("password"),
      username: z.string().default(""),
      password: z.string().default(""),
      oauth2ClientId: z.string().default(""),
      oauth2ClientSecret: z.string().default(""),
      oauth2RefreshToken: z.string().default(""),
      oauth2TokenUrl: z.string().default(""),
    })
    .default({ method: "password", username: "", password: "", oauth2ClientId: "", oauth2ClientSecret: "", oauth2RefreshToken: "", oauth2TokenUrl: "" }),
  fromName: z.string().default("TV Station Manager"),
  fromAddress: z.string().default(""),
  replyTo: z.string().default(""),
  dkim: z
    .object({ enabled: z.boolean().default(false), domain: z.string().default(""), selector: z.string().default(""), privateKey: z.string().default("") })
    .default({ enabled: false, domain: "", selector: "", privateKey: "" }),
  /** Recipients for system alerts (backup failures, node offline, updates). */
  alertRecipients: z.array(z.email()).default([]),
});
export type MailConfig = z.infer<typeof mailConfigSchema>;

const SECRET_FIELDS = [
  ["auth", "password"],
  ["auth", "oauth2ClientSecret"],
  ["auth", "oauth2RefreshToken"],
  ["dkim", "privateKey"],
] as const;

export class MailService {
  constructor(private ctx: PlatformContext) {}

  getConfig(): MailConfig {
    const cfg = mailConfigSchema.parse(this.ctx.settings.get(KEY, {}));
    for (const [a, b] of SECRET_FIELDS) (cfg[a] as Record<string, string>)[b] = this.ctx.secrets.decrypt((cfg[a] as Record<string, string>)[b]!);
    return cfg;
  }

  /** Config safe to send to the browser: secrets replaced by a mask when set. */
  getPublicConfig() {
    const cfg = this.getConfig();
    for (const [a, b] of SECRET_FIELDS) {
      const o = cfg[a] as Record<string, string>;
      o[b] = o[b] ? MASK : "";
    }
    return cfg;
  }

  saveConfig(input: unknown) {
    const next = mailConfigSchema.parse(input);
    const current = this.getConfig();
    for (const [a, b] of SECRET_FIELDS) {
      const o = next[a] as Record<string, string>;
      const value = o[b] === MASK ? (current[a] as Record<string, string>)[b]! : o[b]!;
      o[b] = value ? this.ctx.secrets.encrypt(value) : "";
    }
    this.ctx.settings.set(KEY, next);
  }

  private transport(cfg: MailConfig) {
    if (!cfg.host) throw new HttpError(400, "mail_not_configured");
    const opts: SMTPTransport.Options = {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.security === "tls",
      requireTLS: cfg.security === "starttls",
      ignoreTLS: cfg.security === "none",
      tls: { minVersion: cfg.minTlsVersion, rejectUnauthorized: cfg.verifyCertificate, servername: cfg.host },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    };
    if (cfg.auth.method === "password" && cfg.auth.username) {
      opts.auth = { user: cfg.auth.username, pass: cfg.auth.password };
    } else if (cfg.auth.method === "oauth2") {
      opts.auth = {
        type: "OAuth2",
        user: cfg.auth.username,
        clientId: cfg.auth.oauth2ClientId,
        clientSecret: cfg.auth.oauth2ClientSecret,
        refreshToken: cfg.auth.oauth2RefreshToken,
        accessUrl: cfg.auth.oauth2TokenUrl || undefined,
      };
    }
    if (cfg.dkim.enabled && cfg.dkim.privateKey) {
      opts.dkim = { domainName: cfg.dkim.domain, keySelector: cfg.dkim.selector, privateKey: cfg.dkim.privateKey };
    }
    return nodemailer.createTransport(opts);
  }

  async send(msg: { to: string | string[]; subject: string; text: string; html?: string }, cfg = this.getConfig()) {
    if (!cfg.enabled) throw new HttpError(400, "mail_disabled");
    const t = this.transport(cfg);
    try {
      return await t.sendMail({
        from: { name: cfg.fromName, address: cfg.fromAddress || cfg.auth.username },
        replyTo: cfg.replyTo || undefined,
        ...msg,
      });
    } finally {
      t.close();
    }
  }

  /** Sends to the configured alert recipients; never throws (alerts must not break callers). */
  async alert(subject: string, text: string) {
    try {
      const cfg = this.getConfig();
      if (!cfg.enabled || cfg.alertRecipients.length === 0) return;
      await this.send({ to: cfg.alertRecipients, subject: `[${this.ctx.config.app.name}] ${subject}`, text: `${text}\n\nHost: ${this.ctx.config.hostname}` }, cfg);
    } catch (err) {
      this.ctx.log.warn({ err }, "failed to send alert mail");
    }
  }

  async verify(input?: unknown) {
    const cfg = input ? this.merge(input) : this.getConfig();
    const t = this.transport(cfg);
    try {
      await t.verify();
    } finally {
      t.close();
    }
  }

  /** Merge unsaved form input with stored secrets (so "test" works before saving). */
  merge(input: unknown): MailConfig {
    const next = mailConfigSchema.parse(input);
    const current = this.getConfig();
    for (const [a, b] of SECRET_FIELDS) {
      const o = next[a] as Record<string, string>;
      if (o[b] === MASK) o[b] = (current[a] as Record<string, string>)[b]!;
    }
    return next;
  }
}

export function registerMail(app: FastifyInstance, ctx: PlatformContext, mail: MailService) {
  app.get("/api/settings/mail", async () => mail.getPublicConfig());
  app.put("/api/settings/mail", async (req) => {
    mail.saveConfig(req.body);
    return mail.getPublicConfig();
  });
  app.post("/api/settings/mail/verify", async (req) => {
    try {
      await mail.verify((req.body as { config?: unknown })?.config);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  app.post("/api/settings/mail/test", async (req) => {
    const body = z.object({ to: z.email(), config: z.unknown().optional() }).parse(req.body);
    const cfg = body.config ? mail.merge(body.config) : mail.getConfig();
    try {
      const info = await mail.send(
        {
          to: body.to,
          subject: `${ctx.config.app.name}: test email`,
          text: `This is a test email from ${ctx.config.app.name} on ${ctx.config.hostname}.\nDit is een testmail van ${ctx.config.app.name} op ${ctx.config.hostname}.`,
        },
        { ...cfg, enabled: true },
      );
      return { ok: true, messageId: info.messageId, response: info.response };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
