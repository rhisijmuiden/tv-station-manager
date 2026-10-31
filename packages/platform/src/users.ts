import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PlatformContext } from "./context.js";
import { HttpError } from "./context.js";
import { hashPassword } from "./crypto.js";

/**
 * User roles, from most to least privileged.
 * - admin:    everything, including System (mail, backup, updates, users)
 * - editor:   content and planning (the editor-in-chief / hoofdredacteur), plus operator rights
 * - operator: live control only (control room); read access elsewhere
 */
export const ROLES = ["admin", "editor", "operator"] as const;
export type Role = (typeof ROLES)[number];
const rank = (r: string) => ({ admin: 3, editor: 2, operator: 1 })[r as Role] ?? 0;

/** Throws 403 unless the signed-in user has at least `min`. */
export function requireRole(req: FastifyRequest, min: Role) {
  if (!req.user || rank(req.user.role) < rank(min)) throw new HttpError(403, "forbidden");
}
export const hasRole = (role: string | undefined, min: Role) => rank(role ?? "") >= rank(min);

/** Platform routes that only administrators may change (GET of update status stays open for the Info dialog). */
const ADMIN_ONLY = [/^\/api\/settings\//, /^\/api\/backup\//, /^\/api\/users(\/|$)/, /^\/api\/system\/update\/(apply|check|settings)/];

export function registerUsers(app: FastifyInstance, ctx: PlatformContext) {
  app.addHook("preHandler", async (req) => {
    const path = req.url.split("?")[0]!;
    if (req.user && ADMIN_ONLY.some((r) => r.test(path))) requireRole(req, "admin");
  });

  const pub = (r: Record<string, unknown>) => ({
    id: Number(r.id),
    username: String(r.username),
    displayName: (r.display_name as string) ?? null,
    email: (r.email as string) ?? null,
    role: String(r.role),
    language: String(r.language),
    createdAt: String(r.created_at),
  });
  const adminCount = () => (ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;

  app.get("/api/users", async () => ({ users: (ctx.db.prepare("SELECT * FROM users ORDER BY username COLLATE NOCASE").all() as Record<string, unknown>[]).map(pub) }));

  const base = z.object({
    displayName: z.string().max(120).nullable().optional(),
    email: z.email().nullable().optional().or(z.literal("").transform(() => null)),
    role: z.enum(ROLES),
    language: z.enum(["en", "nl"]).default("en"),
  });

  app.post("/api/users", async (req) => {
    const b = base.extend({ username: z.string().trim().min(3).max(64).regex(/^[\w.@-]+$/), password: z.string().min(10).max(256) }).parse(req.body);
    const exists = ctx.db.prepare("SELECT 1 FROM users WHERE username = ?").get(b.username);
    if (exists) throw new HttpError(409, "username_taken");
    const r = ctx.db
      .prepare("INSERT INTO users (username, password_hash, display_name, email, role, language) VALUES (?, ?, ?, ?, ?, ?)")
      .run(b.username, await hashPassword(b.password), b.displayName ?? null, b.email ?? null, b.role, b.language);
    return pub(ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(Number(r.lastInsertRowid)) as Record<string, unknown>);
  });

  app.put("/api/users/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const cur = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!cur) throw new HttpError(404, "not_found");
    const b = base.extend({ password: z.string().min(10).max(256).optional().or(z.literal("").transform(() => undefined)) }).parse(req.body);
    if (cur.role === "admin" && b.role !== "admin" && adminCount() <= 1) throw new HttpError(400, "last_admin");
    ctx.db.prepare("UPDATE users SET display_name = ?, email = ?, role = ?, language = ? WHERE id = ?").run(b.displayName ?? null, b.email ?? null, b.role, b.language, id);
    if (b.password) {
      ctx.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(b.password), id);
      if (id !== req.user!.id) ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    if (b.role !== cur.role && id !== req.user!.id) ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    return pub(ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown>);
  });

  app.delete("/api/users/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (id === req.user!.id) throw new HttpError(400, "cannot_delete_self");
    const cur = ctx.db.prepare("SELECT role FROM users WHERE id = ?").get(id) as { role: string } | undefined;
    if (!cur) throw new HttpError(404, "not_found");
    if (cur.role === "admin" && adminCount() <= 1) throw new HttpError(400, "last_admin");
    ctx.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return { ok: true };
  });
}
