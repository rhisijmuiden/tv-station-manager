import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DriverFactory, PlayoutDriver, SwitcherDriver } from "./drivers.js";

/** Keeps one live connection per ATEM switcher and per studio node (CasparCG), and their CRUD API. */
export class DeviceHub {
  switchers = new Map<number, { name: string; host: string; driver: SwitcherDriver }>();
  playouts = new Map<number, { name: string; host: string; port: number; driver: PlayoutDriver }>();
  private listeners = new Set<() => void>();
  constructor(
    private platform: Platform,
    private factory: DriverFactory,
  ) {}

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }
  private changed = () => this.listeners.forEach((f) => f());

  async reload() {
    const { db, log } = this.platform.ctx;
    const atems = db.prepare("SELECT id, name, host FROM atem_devices WHERE enabled = 1").all() as { id: number; name: string; host: string }[];
    for (const [id, s] of this.switchers)
      if (!atems.some((a) => a.id === id && a.host === s.host)) {
        await s.driver.close();
        this.switchers.delete(id);
      }
    for (const a of atems) {
      const cur = this.switchers.get(a.id);
      if (cur) cur.name = a.name;
      else {
        const driver = this.factory.switcher(a.host);
        driver.on("change", this.changed);
        driver.on("log", (m) => log.debug({ atem: a.name, m }, "atem"));
        this.switchers.set(a.id, { name: a.name, host: a.host, driver });
      }
    }
    const nodes = db.prepare("SELECT id, name, host, port FROM studio_nodes WHERE enabled = 1").all() as { id: number; name: string; host: string; port: number }[];
    for (const [id, p] of this.playouts)
      if (!nodes.some((n) => n.id === id && n.host === p.host && n.port === p.port)) {
        await p.driver.close();
        this.playouts.delete(id);
      }
    for (const n of nodes) {
      const cur = this.playouts.get(n.id);
      if (cur) cur.name = n.name;
      else {
        const driver = this.factory.playout(n.host, n.port);
        driver.on("change", this.changed);
        driver.on("log", (m) => log.debug({ studio: n.name, m }, "casparcg"));
        this.playouts.set(n.id, { name: n.name, host: n.host, port: n.port, driver });
      }
    }
    this.changed();
  }

  async close() {
    for (const s of this.switchers.values()) await s.driver.close();
    for (const p of this.playouts.values()) await p.driver.close();
    this.switchers.clear();
    this.playouts.clear();
  }

  switcher(id: number | null | undefined) {
    return id == null ? undefined : this.switchers.get(id)?.driver;
  }
  playout(id: number | null | undefined) {
    return id == null ? undefined : this.playouts.get(id)?.driver;
  }
}

const host = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\w.:-]+$/, "invalid host");

export function registerDevices(app: FastifyInstance, platform: Platform, hub: DeviceHub) {
  const { db } = platform.ctx;
  const id = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  // ---- ATEM switchers --------------------------------------------------------
  const atemIn = z.object({ name: z.string().trim().min(1).max(80), host, enabled: z.boolean().default(true) });
  const atemOut = (r: { id: number; name: string; host: string; enabled: number }) => ({
    id: r.id,
    name: r.name,
    host: r.host,
    enabled: !!r.enabled,
    status: hub.switcher(r.id)?.info() ?? { connected: false, model: null, productName: null, mixEffects: 0, inputs: [], program: [], preview: [] },
  });
  app.get("/api/atems", async () => ({ atems: (db.prepare("SELECT * FROM atem_devices ORDER BY name").all() as Parameters<typeof atemOut>[0][]).map(atemOut) }));
  app.post("/api/atems", async (req) => {
    requireRole(req, "admin");
    const b = atemIn.parse(req.body);
    db.prepare("INSERT INTO atem_devices (name, host, enabled) VALUES (?, ?, ?)").run(b.name, b.host, b.enabled ? 1 : 0);
    await hub.reload();
    return { ok: true };
  });
  app.put("/api/atems/:id", async (req) => {
    requireRole(req, "admin");
    const b = atemIn.parse(req.body);
    db.prepare("UPDATE atem_devices SET name = ?, host = ?, enabled = ? WHERE id = ?").run(b.name, b.host, b.enabled ? 1 : 0, id(req));
    await hub.reload();
    return { ok: true };
  });
  app.delete("/api/atems/:id", async (req) => {
    requireRole(req, "admin");
    db.prepare("DELETE FROM atem_devices WHERE id = ?").run(id(req));
    await hub.reload();
    return { ok: true };
  });

  // ---- Studio nodes (CasparCG) -----------------------------------------------
  const studioIn = z.object({ name: z.string().trim().min(1).max(80), host, port: z.number().int().min(1).max(65535).default(5250), enabled: z.boolean().default(true) });
  const studioOut = (r: { id: number; name: string; host: string; port: number; enabled: number }) => ({
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    enabled: !!r.enabled,
    status: hub.playout(r.id)?.info() ?? { connected: false, version: null },
  });
  app.get("/api/studios", async () => ({ studios: (db.prepare("SELECT * FROM studio_nodes ORDER BY name").all() as Parameters<typeof studioOut>[0][]).map(studioOut) }));
  app.post("/api/studios", async (req) => {
    requireRole(req, "admin");
    const b = studioIn.parse(req.body);
    db.prepare("INSERT INTO studio_nodes (name, host, port, enabled) VALUES (?, ?, ?, ?)").run(b.name, b.host, b.port, b.enabled ? 1 : 0);
    await hub.reload();
    return { ok: true };
  });
  app.put("/api/studios/:id", async (req) => {
    requireRole(req, "admin");
    const b = studioIn.parse(req.body);
    db.prepare("UPDATE studio_nodes SET name = ?, host = ?, port = ?, enabled = ? WHERE id = ?").run(b.name, b.host, b.port, b.enabled ? 1 : 0, id(req));
    await hub.reload();
    return { ok: true };
  });
  app.delete("/api/studios/:id", async (req) => {
    requireRole(req, "admin");
    db.prepare("DELETE FROM studio_nodes WHERE id = ?").run(id(req));
    await hub.reload();
    return { ok: true };
  });

  // ---- Live sources ------------------------------------------------------------
  const liveIn = z
    .object({
      name: z.string().trim().min(1).max(80),
      kind: z.enum(["atem", "rtmp"]),
      atemInput: z.number().int().min(0).max(65535),
      studioId: z.number().int().nullable().optional(),
      casparChannel: z.number().int().min(1).max(16).nullable().optional(),
      url: z.string().trim().max(1000).nullable().optional(),
    })
    .refine((v) => v.kind === "atem" || (v.studioId && v.casparChannel && v.url && /^(rtmps?|srt|udp|rtsp|https?):\/\//.test(v.url)), { message: "rtmp_needs_studio_channel_url" });
  const liveOut = (r: Record<string, unknown>) => ({ id: r.id, name: r.name, kind: r.kind, atemInput: r.atem_input, studioId: r.studio_id, casparChannel: r.caspar_channel, url: r.url });
  app.get("/api/live-sources", async () => ({ sources: (db.prepare("SELECT * FROM live_sources ORDER BY name").all() as Record<string, unknown>[]).map(liveOut) }));
  app.post("/api/live-sources", async (req) => {
    requireRole(req, "admin");
    const b = liveIn.parse(req.body);
    db.prepare("INSERT INTO live_sources (name, kind, atem_input, studio_id, caspar_channel, url) VALUES (?, ?, ?, ?, ?, ?)").run(b.name, b.kind, b.atemInput, b.studioId ?? null, b.casparChannel ?? null, b.url ?? null);
    return { ok: true };
  });
  app.put("/api/live-sources/:id", async (req) => {
    requireRole(req, "admin");
    const b = liveIn.parse(req.body);
    db.prepare("UPDATE live_sources SET name = ?, kind = ?, atem_input = ?, studio_id = ?, caspar_channel = ?, url = ? WHERE id = ?").run(
      b.name,
      b.kind,
      b.atemInput,
      b.studioId ?? null,
      b.casparChannel ?? null,
      b.url ?? null,
      id(req),
    );
    return { ok: true };
  });
  app.delete("/api/live-sources/:id", async (req) => {
    requireRole(req, "admin");
    db.prepare("DELETE FROM live_sources WHERE id = ?").run(id(req));
    return { ok: true };
  });

  const notFound = () => {
    throw new HttpError(404, "not_found");
  };
  return { notFound };
}
