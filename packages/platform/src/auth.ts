import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PlatformContext } from "./context.js";
import { HttpError } from "./context.js";
import { hashPassword, randomToken, verifyPassword } from "./crypto.js";

export const SESSION_COOKIE = "tvsm_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionUser {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: string;
  language: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const PUBLIC_API = new Set(["/api/auth/status", "/api/auth/setup", "/api/auth/login", "/api/system/health"]);

const credentials = z.object({ username: z.string().trim().min(3).max(64), password: z.string().min(10).max(256) });

function userCount(ctx: PlatformContext) {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

function loadSession(ctx: PlatformContext, token: string | undefined): SessionUser | undefined {
  if (!token) return undefined;
  const row = ctx.db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.email, u.role, u.language, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token) as Record<string, unknown> | undefined;
  if (!row || Number(row.expires_at) < Date.now()) return undefined;
  // Sliding expiry.
  ctx.db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(Date.now() + SESSION_TTL_MS, token);
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: (row.display_name as string) ?? null,
    email: (row.email as string) ?? null,
    role: String(row.role),
    language: String(row.language),
  };
}

export function registerAuth(app: FastifyInstance, ctx: PlatformContext) {
  const startSession = (userId: number) => {
    const token = randomToken();
    ctx.db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, Date.now() + SESSION_TTL_MS);
    ctx.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    return token;
  };
  const cookieOpts = (req: FastifyRequest) => ({
    path: "/",
    httpOnly: true,
    sameSite: "strict" as const,
    secure: req.protocol === "https",
    maxAge: SESSION_TTL_MS / 1000,
  });

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    req.user = loadSession(ctx, req.cookies[SESSION_COOKIE]);
    const path = req.url.split("?")[0]!;
    if (!req.user && !PUBLIC_API.has(path)) throw new HttpError(401, "unauthorized");
  });

  app.get("/api/auth/status", async (req) => ({ setupRequired: userCount(ctx) === 0, user: req.user ?? null }));

  app.post("/api/auth/setup", async (req, reply) => {
    if (userCount(ctx) > 0) throw new HttpError(409, "already_set_up");
    const body = credentials.extend({ email: z.email().optional(), language: z.enum(["en", "nl"]).default("en") }).parse(req.body);
    const hash = await hashPassword(body.password);
    const res = ctx.db
      .prepare("INSERT INTO users (username, password_hash, email, role, language) VALUES (?, ?, ?, 'admin', ?)")
      .run(body.username, hash, body.email ?? null, body.language);
    reply.setCookie(SESSION_COOKIE, startSession(Number(res.lastInsertRowid)), cookieOpts(req));
    return { ok: true };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const row = ctx.db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(body.username) as
      | { id: number; password_hash: string }
      | undefined;
    // Always run a hash comparison to keep timing similar for unknown users.
    const ok = await verifyPassword(body.password, row?.password_hash ?? "scrypt$AAAA$AAAA");
    if (!row || !ok) throw new HttpError(401, "invalid_credentials");
    reply.setCookie(SESSION_COOKIE, startSession(row.id), cookieOpts(req));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) ctx.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.put("/api/auth/profile", async (req) => {
    const body = z
      .object({ displayName: z.string().max(120).nullable().optional(), email: z.email().nullable().optional(), language: z.enum(["en", "nl"]).optional() })
      .parse(req.body);
    const u = req.user!;
    ctx.db
      .prepare("UPDATE users SET display_name = ?, email = ?, language = ? WHERE id = ?")
      .run(body.displayName ?? u.displayName, body.email ?? u.email, body.language ?? u.language, u.id);
    return { ok: true };
  });

  app.put("/api/auth/password", async (req) => {
    const body = z.object({ current: z.string(), next: z.string().min(10).max(256) }).parse(req.body);
    const row = ctx.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user!.id) as { password_hash: string };
    if (!(await verifyPassword(body.current, row.password_hash))) throw new HttpError(400, "invalid_current_password");
    ctx.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(body.next), req.user!.id);
    ctx.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(req.user!.id, req.cookies[SESSION_COOKIE] ?? "");
    return { ok: true };
  });
}
