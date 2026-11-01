/**
 * Connection diagram: which server / DeckLink output / other box is cabled to which ATEM input, and how ATEMs feed
 * each other. Stored in `diagram_devices` (position + cards) and `diagram_links` (one cable from an output port to
 * an input port). Logic shared with the UI lives in `diagramlogic.ts`.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PublicSwitcher } from "./atem.js";
import { atemPorts, CABLES, cardPorts, danglingLinks, DEVICE_TYPES, linkError, type Card, type Link, type ResolvedPort } from "./diagramlogic.js";

export const DIAGRAM_MIGRATIONS = [
  `CREATE TABLE diagram_devices (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('node','atem','device')),
     ref_id TEXT,
     name TEXT NOT NULL DEFAULT '',
     device_type TEXT NOT NULL DEFAULT 'other',
     x REAL NOT NULL DEFAULT 0,
     y REAL NOT NULL DEFAULT 0,
     cards TEXT NOT NULL DEFAULT '[]',
     notes TEXT NOT NULL DEFAULT '',
     UNIQUE (kind, ref_id)
   );
   CREATE TABLE diagram_links (
     id TEXT PRIMARY KEY,
     from_device TEXT NOT NULL REFERENCES diagram_devices(id) ON DELETE CASCADE,
     from_port TEXT NOT NULL,
     to_device TEXT NOT NULL REFERENCES diagram_devices(id) ON DELETE CASCADE,
     to_port TEXT NOT NULL,
     cable TEXT NOT NULL DEFAULT 'sdi',
     label TEXT NOT NULL DEFAULT '',
     UNIQUE (to_device, to_port)
   );
   CREATE TRIGGER diagram_node_gone AFTER DELETE ON nodes BEGIN DELETE FROM diagram_devices WHERE kind = 'node' AND ref_id = OLD.id; END;
   CREATE TRIGGER diagram_atem_gone AFTER DELETE ON atem_switchers BEGIN DELETE FROM diagram_devices WHERE kind = 'atem' AND ref_id = OLD.id; END;`,
];

interface DeviceRow {
  id: string;
  kind: "node" | "atem" | "device";
  ref_id: string | null;
  name: string;
  device_type: string;
  x: number;
  y: number;
  cards: string;
  notes: string;
}
interface LinkRow {
  id: string;
  from_device: string;
  from_port: string;
  to_device: string;
  to_port: string;
  cable: string;
  label: string;
}

const portSchema = z.object({
  id: z.string().trim().min(1).max(32).regex(/^[\w-]+$/),
  label: z.string().trim().min(1).max(40),
  dir: z.enum(["in", "out"]),
  type: z.string().trim().max(16).optional(),
  channel: z.number().int().min(1).max(64).nullable().optional(),
});
const cardSchema = z.object({
  id: z.string().trim().min(1).max(32).regex(/^[\w-]+$/),
  model: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  ports: z.array(portSchema).max(40),
});
const cardsSchema = z
  .array(cardSchema)
  .max(12)
  .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, "duplicate_card")
  .refine((cs) => cs.every((c) => new Set(c.ports.map((p) => p.id)).size === c.ports.length), "duplicate_port");
const pos = z.number().finite().min(-1e6).max(1e6);
const newDevice = z.object({
  kind: z.enum(["node", "atem", "device"]),
  refId: z.string().max(64).optional(),
  name: z.string().trim().max(80).optional(),
  deviceType: z.enum(DEVICE_TYPES).optional(),
  x: pos.default(0),
  y: pos.default(0),
  cards: cardsSchema.optional(),
});
const editDevice = z.object({
  name: z.string().trim().max(80).optional(),
  deviceType: z.enum(DEVICE_TYPES).optional(),
  cards: cardsSchema.optional(),
  notes: z.string().max(2000).optional(),
});
const end = z.object({ device: z.string().max(64), port: z.string().max(80) });
const newLink = z.object({ from: end, to: end, cable: z.enum(CABLES).default("sdi"), label: z.string().trim().max(60).default("") });
const editLink = z.object({ cable: z.enum(CABLES).optional(), label: z.string().trim().max(60).optional() });

const toLink = (r: LinkRow): Link => ({ id: r.id, from: { device: r.from_device, port: r.from_port }, to: { device: r.to_device, port: r.to_port }, cable: r.cable as Link["cable"], label: r.label });

export function registerDiagram(app: FastifyInstance, platform: Platform, atems: () => PublicSwitcher[]) {
  const { db } = platform.ctx;
  const devices = () => db.prepare("SELECT * FROM diagram_devices").all() as unknown as DeviceRow[];
  const links = () => (db.prepare("SELECT * FROM diagram_links").all() as unknown as LinkRow[]).map(toLink);
  const nodes = () => db.prepare("SELECT id, name, role, status, online, hostname FROM nodes WHERE status = 'approved'").all() as { id: string; name: string; role: string; status: string; online: number; hostname: string }[];

  /** Ports of every device on the diagram. */
  const portMap = () => {
    const sw = new Map(atems().map((a) => [a.id, a]));
    const m = new Map<string, ResolvedPort[]>();
    for (const d of devices()) m.set(d.id, d.kind === "atem" ? atemPorts(sw.get(d.ref_id ?? "")?.snapshot) : cardPorts(JSON.parse(d.cards) as Card[]));
    return m;
  };
  const getDevice = (id: string) => {
    const d = db.prepare("SELECT * FROM diagram_devices WHERE id = ?").get(id) as DeviceRow | undefined;
    if (!d) throw new HttpError(404, "not_found");
    return d;
  };

  /** Keeps the ATEM inventory's "fed by node" in step with cables from a node into an ATEM input. */
  const syncFedBy = (l: Link, removed: boolean) => {
    const from = db.prepare("SELECT kind, ref_id FROM diagram_devices WHERE id = ?").get(l.from.device) as { kind: string; ref_id: string | null } | undefined;
    const to = db.prepare("SELECT kind, ref_id FROM diagram_devices WHERE id = ?").get(l.to.device) as { kind: string; ref_id: string | null } | undefined;
    const input = /^in:(\d+)$/.exec(l.to.port);
    if (from?.kind !== "node" || to?.kind !== "atem" || !to.ref_id || !input) return;
    if (removed) db.prepare("UPDATE atem_inputs SET node_id = NULL WHERE switcher_id = ? AND input_id = ? AND node_id = ?").run(to.ref_id, Number(input[1]), from.ref_id);
    else
      db.prepare(
        `INSERT INTO atem_inputs (switcher_id, input_id, node_id) VALUES (?, ?, ?)
         ON CONFLICT (switcher_id, input_id) DO UPDATE SET node_id = excluded.node_id`,
      ).run(to.ref_id, Number(input[1]), from.ref_id);
  };

  app.get("/api/diagram", async () => {
    const sw = new Map(atems().map((a) => [a.id, a]));
    const nd = new Map(nodes().map((n) => [n.id, n]));
    const all = devices();
    const ports = portMap();
    const ls = links();
    return {
      devices: all.map((d) => {
        const a = d.kind === "atem" ? sw.get(d.ref_id ?? "") : undefined;
        const n = d.kind === "node" ? nd.get(d.ref_id ?? "") : undefined;
        return {
          id: d.id,
          kind: d.kind,
          refId: d.ref_id,
          name: d.name || a?.name || n?.name || "",
          deviceType: d.device_type,
          x: d.x,
          y: d.y,
          cards: JSON.parse(d.cards) as Card[],
          notes: d.notes,
          ports: ports.get(d.id) ?? [],
          online: a ? a.online : n ? !!n.online : null,
          node: n ? { role: n.role, hostname: n.hostname } : null,
          atem: a
            ? {
                host: a.host,
                model: a.snapshot?.productName ?? a.snapshot?.modelKey ?? null,
                mixEffects: a.snapshot?.mixEffects ?? 1,
                auxes: a.snapshot?.auxes ?? 0,
                program: a.snapshot?.program ?? [],
                preview: a.snapshot?.preview ?? [],
                auxSources: a.snapshot?.auxSources ?? [],
                inputs: a.snapshot?.inputs ?? [],
                control: a.control,
              }
            : null,
        };
      }),
      links: ls,
      // Cables to ports that disappeared (e.g. an ATEM reports fewer inputs): shown as a warning, kept until fixed.
      broken: danglingLinks(ls, (id) => ports.get(id)).map((l) => l.id),
      available: {
        nodes: nodes()
          .filter((n) => !all.some((d) => d.kind === "node" && d.ref_id === n.id))
          .map((n) => ({ id: n.id, name: n.name, role: n.role })),
        atems: [...sw.values()].filter((a) => !all.some((d) => d.kind === "atem" && d.ref_id === a.id)).map((a) => ({ id: a.id, name: a.name })),
      },
    };
  });

  app.post("/api/diagram/devices", async (req) => {
    requireRole(req, "editor");
    const b = newDevice.parse(req.body);
    if (b.kind === "node" && !nodes().some((n) => n.id === b.refId)) throw new HttpError(400, "unknown_node");
    if (b.kind === "atem" && !atems().some((a) => a.id === b.refId)) throw new HttpError(400, "unknown_atem");
    if (b.kind === "device" && !b.name) throw new HttpError(400, "name_required");
    if (b.kind !== "device" && db.prepare("SELECT 1 FROM diagram_devices WHERE kind = ? AND ref_id = ?").get(b.kind, b.refId!)) throw new HttpError(409, "already_placed");
    const id = randomUUID();
    db.prepare("INSERT INTO diagram_devices (id, kind, ref_id, name, device_type, x, y, cards) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      b.kind,
      b.kind === "device" ? null : b.refId!,
      b.kind === "device" ? b.name! : "",
      b.deviceType ?? (b.kind === "node" ? "server" : b.kind === "atem" ? "router" : "other"),
      b.x,
      b.y,
      JSON.stringify(b.kind === "atem" ? [] : (b.cards ?? [])),
    );
    return { id };
  });

  app.put("/api/diagram/devices/:id", async (req) => {
    requireRole(req, "editor");
    const d = getDevice((req.params as { id: string }).id);
    const b = editDevice.parse(req.body);
    if (b.cards && d.kind === "atem") throw new HttpError(400, "atem_ports_fixed");
    db.prepare("UPDATE diagram_devices SET name = ?, device_type = ?, cards = ?, notes = ? WHERE id = ?").run(
      d.kind === "device" ? (b.name || d.name) : (b.name ?? d.name),
      b.deviceType ?? d.device_type,
      b.cards ? JSON.stringify(b.cards) : d.cards,
      b.notes ?? d.notes,
      d.id,
    );
    // Cables on ports that were removed from a card go too.
    if (b.cards) {
      const keys = new Set(cardPorts(b.cards).map((p) => p.key));
      for (const l of links().filter((l) => (l.from.device === d.id && !keys.has(l.from.port)) || (l.to.device === d.id && !keys.has(l.to.port)))) {
        syncFedBy(l, true);
        db.prepare("DELETE FROM diagram_links WHERE id = ?").run(l.id);
      }
    }
    return { ok: true };
  });

  app.put("/api/diagram/layout", async (req) => {
    requireRole(req, "editor");
    const b = z.object({ positions: z.array(z.object({ id: z.string().max(64), x: pos, y: pos })).max(500) }).parse(req.body);
    const st = db.prepare("UPDATE diagram_devices SET x = ?, y = ? WHERE id = ?");
    for (const p of b.positions) st.run(Math.round(p.x), Math.round(p.y), p.id);
    return { ok: true };
  });

  app.delete("/api/diagram/devices/:id", async (req) => {
    requireRole(req, "editor");
    const d = getDevice((req.params as { id: string }).id);
    for (const l of links().filter((l) => l.from.device === d.id || l.to.device === d.id)) syncFedBy(l, true);
    db.prepare("DELETE FROM diagram_devices WHERE id = ?").run(d.id);
    return { ok: true };
  });

  app.post("/api/diagram/links", async (req) => {
    requireRole(req, "editor");
    const b = newLink.parse(req.body);
    const ports = portMap();
    const err = linkError(b.from, b.to, (id) => ports.get(id), links());
    if (err) throw new HttpError(err === "input_taken" ? 409 : 400, err);
    const l: Link = { id: randomUUID(), ...b };
    db.prepare("INSERT INTO diagram_links (id, from_device, from_port, to_device, to_port, cable, label) VALUES (?, ?, ?, ?, ?, ?, ?)").run(l.id, l.from.device, l.from.port, l.to.device, l.to.port, l.cable, l.label);
    syncFedBy(l, false);
    return l;
  });

  app.put("/api/diagram/links/:id", async (req) => {
    requireRole(req, "editor");
    const r = db.prepare("SELECT * FROM diagram_links WHERE id = ?").get((req.params as { id: string }).id) as LinkRow | undefined;
    if (!r) throw new HttpError(404, "not_found");
    const b = editLink.parse(req.body);
    db.prepare("UPDATE diagram_links SET cable = ?, label = ? WHERE id = ?").run(b.cable ?? r.cable, b.label ?? r.label, r.id);
    return { ok: true };
  });

  app.delete("/api/diagram/links/:id", async (req) => {
    requireRole(req, "editor");
    const r = db.prepare("SELECT * FROM diagram_links WHERE id = ?").get((req.params as { id: string }).id) as LinkRow | undefined;
    if (!r) throw new HttpError(404, "not_found");
    syncFedBy(toLink(r), true);
    db.prepare("DELETE FROM diagram_links WHERE id = ?").run(r.id);
    return { ok: true };
  });
}
