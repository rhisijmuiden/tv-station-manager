import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as oidc from "openid-client";
import { z } from "zod";
import type { PlatformContext } from "./context.js";
import { HttpError } from "./context.js";
import { ROLES, type Role } from "./users.js";

/**
 * Single sign-on with Microsoft Entra ID (Office 365) over OpenID Connect:
 * authorization code flow with PKCE, a confidential client (client secret),
 * id_token signature/issuer/audience/nonce checked by openid-client.
 * Local accounts keep working next to it as a fallback.
 */

const KEY = "sso";
const MASK = "********";
const FLOW_COOKIE = "tvsm_sso_flow";
const FLOW_TTL_MS = 10 * 60 * 1000;
export const SSO_CALLBACK_PATH = "/api/auth/sso/callback";
export const SSO_PUBLIC_PATHS = ["/api/auth/sso/login", SSO_CALLBACK_PATH];

/** Base URL of the Microsoft identity platform (overridable for tests or sovereign clouds). */
const authority = () => (process.env.TVSM_SSO_AUTHORITY ?? "https://login.microsoftonline.com").replace(/\/+$/, "");

const roleValues = z.object({
  admin: z.string().trim().default("TVSM.Admin"),
  editor: z.string().trim().default("TVSM.Editor"),
  operator: z.string().trim().default("TVSM.Operator"),
});

export const ssoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Directory (tenant) ID, a GUID. Multi-tenant endpoints (common, organizations) are not allowed. */
  tenantId: z
    .string()
    .trim()
    .toLowerCase()
    .default("")
    .refine((v) => v === "" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v), { message: "tenant_id_guid" }),
  clientId: z.string().trim().toLowerCase().default(""),
  clientSecret: z.string().default(""),
  /** Public base URL of this app (e.g. https://tv.example.com). Empty: derived from the request. */
  publicUrl: z.string().trim().default(""),
  /** Text on the login button. Empty: "Sign in with Microsoft". */
  buttonLabel: z.string().trim().max(60).default(""),
  /** Create a TVSM account on the first Microsoft sign-in. Off: an admin must add the user first (Users page). */
  autoCreateUsers: z.boolean().default(true),
  /** Role for new accounts when app roles are not used. */
  defaultRole: z.enum(ROLES).default("operator"),
  /** Take the role from the Entra app roles in the token on every sign-in. */
  useAppRoles: z.boolean().default(false),
  roleValues: roleValues.default({ admin: "TVSM.Admin", editor: "TVSM.Editor", operator: "TVSM.Operator" }),
  /** Only accept accounts from these e-mail domains (empty = every account in the tenant). */
  allowedDomains: z.array(z.string().trim().toLowerCase()).default([]),
});
export type SsoConfig = z.infer<typeof ssoConfigSchema>;

export interface SsoClaims {
  oid: string;
  tid?: string;
  preferred_username?: string;
  email?: string;
  upn?: string;
  name?: string;
  roles?: string[];
}

type Resolved = { ok: true; userId: number } | { ok: false; error: string };

export class SsoService {
  private cache: { key: string; config: oidc.Configuration; at: number } | null = null;
  constructor(private ctx: PlatformContext) {}

  getConfig(): SsoConfig {
    const cfg = ssoConfigSchema.parse(this.ctx.settings.get(KEY, {}));
    cfg.clientSecret = this.ctx.secrets.decrypt(cfg.clientSecret);
    return cfg;
  }

  getPublicConfig() {
    const cfg = this.getConfig();
    return { ...cfg, clientSecret: cfg.clientSecret ? MASK : "" };
  }

  /** Form input merged with the stored secret (the browser only ever sees the mask). */
  merge(input: unknown): SsoConfig {
    const next = ssoConfigSchema.parse(input);
    if (next.clientSecret === MASK) next.clientSecret = this.getConfig().clientSecret;
    return next;
  }

  saveConfig(input: unknown) {
    const next = this.merge(input);
    if (next.enabled && (!next.tenantId || !next.clientId || !next.clientSecret)) throw new HttpError(400, "sso_incomplete");
    this.ctx.settings.set(KEY, { ...next, clientSecret: next.clientSecret ? this.ctx.secrets.encrypt(next.clientSecret) : "" });
    this.cache = null;
  }

  isEnabled() {
    const c = this.getConfig();
    return c.enabled && !!c.tenantId && !!c.clientId && !!c.clientSecret;
  }

  issuerUrl(cfg: SsoConfig) {
    return new URL(`${authority()}/${encodeURIComponent(cfg.tenantId)}/v2.0`);
  }

  async client(cfg = this.getConfig(), fresh = false): Promise<oidc.Configuration> {
    const key = JSON.stringify([cfg.tenantId, cfg.clientId, cfg.clientSecret, authority()]);
    if (!fresh && this.cache && this.cache.key === key && Date.now() - this.cache.at < 60 * 60 * 1000) return this.cache.config;
    const insecure = this.issuerUrl(cfg).protocol === "http:";
    const config = await oidc.discovery(this.issuerUrl(cfg), cfg.clientId, cfg.clientSecret, oidc.ClientSecretPost(cfg.clientSecret), {
      execute: insecure ? [oidc.allowInsecureRequests] : [],
    });
    if (!fresh) this.cache = { key, config, at: Date.now() };
    return config;
  }

  redirectUri(req: FastifyRequest, cfg = this.getConfig()) {
    const base = cfg.publicUrl ? cfg.publicUrl.replace(/\/+$/, "") : `${req.protocol}://${req.host}`;
    return `${base}${SSO_CALLBACK_PATH}`;
  }

  /**
   * Checks tenant, client ID and secret without a user: OIDC discovery plus a
   * client-credentials token request (Entra rejects a wrong secret there).
   */
  async test(input?: unknown) {
    const cfg = input ? this.merge(input) : this.getConfig();
    if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) throw new HttpError(400, "sso_incomplete");
    const config = await this.client(cfg, true);
    await oidc.clientCredentialsGrant(config, { scope: "https://graph.microsoft.com/.default" });
    return { issuer: config.serverMetadata().issuer };
  }

  /** Maps the token's app roles to the highest TVSM role, or null. */
  roleFromClaims(cfg: SsoConfig, roles: string[] | undefined): Role | null {
    const have = new Set((roles ?? []).map((r) => r.toLowerCase()));
    for (const r of ROLES) if (cfg.roleValues[r] && have.has(cfg.roleValues[r].toLowerCase())) return r;
    return null;
  }

  /** Finds, links or creates the local account for a verified Microsoft identity. */
  resolveUser(claims: SsoClaims, cfg = this.getConfig()): Resolved {
    const db = this.ctx.db;
    const login = (claims.preferred_username ?? claims.upn ?? claims.email ?? "").trim().toLowerCase();
    const email = (claims.email ?? (login.includes("@") ? login : "")).trim().toLowerCase() || null;
    if (!claims.oid || !login) return { ok: false, error: "missing_claims" };
    const externalId = `${claims.tid ?? ""}:${claims.oid}`;
    if (cfg.allowedDomains.length) {
      const domain = (email ?? login).split("@")[1] ?? "";
      if (!cfg.allowedDomains.includes(domain)) return { ok: false, error: "domain_not_allowed" };
    }
    const tokenRole = cfg.useAppRoles ? this.roleFromClaims(cfg, claims.roles) : null;
    if (cfg.useAppRoles && !tokenRole) return { ok: false, error: "no_role" };

    type Row = { id: number; role: string; auth_provider: string; external_id: string | null };
    let user = db.prepare("SELECT id, role, auth_provider, external_id FROM users WHERE external_id = ?").get(externalId) as Row | undefined;
    if (!user) {
      // An account an admin added up front for this Microsoft login (Users page, sign-in "Microsoft").
      const pre = db.prepare("SELECT id, role, auth_provider, external_id FROM users WHERE username = ?").get(login) as Row | undefined;
      if (pre && (pre.auth_provider !== "entra" || pre.external_id)) return { ok: false, error: "account_conflict" };
      if (pre) {
        db.prepare("UPDATE users SET external_id = ? WHERE id = ?").run(externalId, pre.id);
        user = { ...pre, external_id: externalId };
      }
    }
    if (!user) {
      if (!cfg.autoCreateUsers) return { ok: false, error: "not_provisioned" };
      const r = db
        .prepare("INSERT INTO users (username, password_hash, display_name, email, role, language, auth_provider, external_id) VALUES (?, '!', ?, ?, ?, 'en', 'entra', ?)")
        .run(login, claims.name ?? null, email, tokenRole ?? cfg.defaultRole, externalId);
      this.ctx.log.info({ username: login }, "created account from Microsoft sign-in");
      return { ok: true, userId: Number(r.lastInsertRowid) };
    }
    let role = user.role;
    if (tokenRole && tokenRole !== user.role) {
      const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
      // Never demote the last administrator from a token.
      if (!(user.role === "admin" && admins <= 1)) role = tokenRole;
    }
    db.prepare("UPDATE users SET display_name = COALESCE(?, display_name), email = COALESCE(?, email), role = ? WHERE id = ?").run(claims.name ?? null, email, role, user.id);
    if (role !== user.role) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    return { ok: true, userId: user.id };
  }
}

interface FlowState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  redirectUri: string;
  exp: number;
}

const safeReturnTo = (v: unknown) => (typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/");

export function registerSso(app: FastifyInstance, ctx: PlatformContext, sso: SsoService, startSession: (req: FastifyRequest, reply: FastifyReply, userId: number) => void) {
  const fail = (reply: FastifyReply, code: string) => {
    reply.clearCookie(FLOW_COOKIE, { path: "/api/auth/sso" });
    return reply.redirect(`/?sso_error=${encodeURIComponent(code)}`);
  };

  app.get("/api/auth/sso/login", async (req, reply) => {
    if (!sso.isEnabled()) return fail(reply, "disabled");
    const cfg = sso.getConfig();
    let config: oidc.Configuration;
    try {
      config = await sso.client(cfg);
    } catch (err) {
      ctx.log.error({ err }, "Microsoft sign-in: discovery failed");
      return fail(reply, "provider_unreachable");
    }
    const flow: FlowState = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
      returnTo: safeReturnTo((req.query as { returnTo?: string }).returnTo),
      redirectUri: sso.redirectUri(req, cfg),
      exp: Date.now() + FLOW_TTL_MS,
    };
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: flow.redirectUri,
      scope: "openid profile email",
      response_type: "code",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    // Lax so the browser sends it back on the top-level redirect from login.microsoftonline.com.
    reply.setCookie(FLOW_COOKIE, ctx.secrets.encrypt(JSON.stringify(flow)), {
      path: "/api/auth/sso",
      httpOnly: true,
      sameSite: "lax",
      secure: flow.redirectUri.startsWith("https:"),
      maxAge: FLOW_TTL_MS / 1000,
    });
    return reply.redirect(url.href);
  });

  app.get(SSO_CALLBACK_PATH, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.error) {
      ctx.log.warn({ error: q.error, description: q.error_description }, "Microsoft sign-in returned an error");
      return fail(reply, q.error === "access_denied" ? "access_denied" : "provider_error");
    }
    let flow: FlowState;
    try {
      flow = JSON.parse(ctx.secrets.decrypt(req.cookies[FLOW_COOKIE] ?? "")) as FlowState;
      if (!flow.state || flow.exp < Date.now()) throw new Error("expired");
    } catch {
      return fail(reply, "flow_expired");
    }
    const cfg = sso.getConfig();
    if (!sso.isEnabled()) return fail(reply, "disabled");
    let claims: SsoClaims;
    try {
      const config = await sso.client(cfg);
      const current = new URL(flow.redirectUri);
      current.search = new URLSearchParams(q as Record<string, string>).toString();
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims() as unknown as SsoClaims;
    } catch (err) {
      ctx.log.warn({ err }, "Microsoft sign-in: token exchange or validation failed");
      return fail(reply, "token_invalid");
    }
    const res = sso.resolveUser(claims, cfg);
    if (!res.ok) {
      ctx.log.warn({ username: claims.preferred_username, reason: res.error }, "Microsoft sign-in refused");
      return fail(reply, res.error);
    }
    reply.clearCookie(FLOW_COOKIE, { path: "/api/auth/sso" });
    startSession(req, reply, res.userId);
    return reply.redirect(flow.returnTo);
  });

  // Admin routes (/api/settings/* is admin-only).
  app.get("/api/settings/sso", async (req) => ({
    ...sso.getPublicConfig(),
    redirectUri: sso.redirectUri(req),
    callbackPath: SSO_CALLBACK_PATH,
  }));
  app.put("/api/settings/sso", async (req) => {
    sso.saveConfig(req.body);
    return { ...sso.getPublicConfig(), redirectUri: sso.redirectUri(req), callbackPath: SSO_CALLBACK_PATH };
  });
  app.post("/api/settings/sso/test", async (req) => {
    try {
      return { ok: true, ...(await sso.test((req.body as { config?: unknown })?.config)) };
    } catch (err) {
      const e = err as { error?: string; error_description?: string; message?: string };
      return { ok: false, error: e.error_description?.split("\r\n")[0] ?? e.error ?? e.message ?? String(err) };
    }
  });
}
