/**
 * ATEM inventory: the orchestrator keeps track of every Blackmagic ATEM switcher in the facility.
 *
 * It connects read-only (it never switches sources: that is the management node's job) and keeps a snapshot of
 * model, firmware protocol, video mode, inputs with their names and the current program/preview per M/E.
 * The only thing it writes to a switcher is input names (long + short label), on request of a user.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Atem, Enums } from "atem-connection";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export const ATEM_MIGRATIONS = [
  `CREATE TABLE atem_switchers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     host TEXT NOT NULL UNIQUE,
     location TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',
     online INTEGER NOT NULL DEFAULT 0,
     snapshot TEXT,
     last_seen_at TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE TABLE atem_inputs (
     switcher_id TEXT NOT NULL REFERENCES atem_switchers(id) ON DELETE CASCADE,
     input_id INTEGER NOT NULL,
     node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
     note TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (switcher_id, input_id)
   );
   CREATE TABLE atem_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     switcher_id TEXT NOT NULL REFERENCES atem_switchers(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     message TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE INDEX atem_events_switcher ON atem_events(switcher_id, at);`,
];

// ---- device snapshot ----------------------------------------------------------

export interface AtemInput {
  id: number;
  longName: string;
  shortName: string;
  /** "external" = a physical connector; the rest are internal sources (black, bars, colour, media player, ...). */
  kind: "external" | "black" | "bars" | "color" | "mediaplayer" | "supersource" | "other";
  /** Connector type of an external input, e.g. SDI or HDMI. */
  port: string | null;
  namesDefault: boolean;
}
export interface AtemSnapshot {
  /** atem-connection model number and enum key, e.g. 16 / "MiniExtreme". */
  model: number;
  modelKey: string;
  productName: string | null;
  protocol: string | null;
  videoMode: string | null;
  mixEffects: number;
  keyers: number[];
  downstreamKeyers: number;
  auxes: number;
  mediaPlayers: number;
  superSources: number;
  multiviewers: number;
  inputs: AtemInput[];
  program: (number | null)[];
  preview: (number | null)[];
}

/** One connection to a switcher. Real implementation: atem-connection; tests use a fake. */
export interface AtemLink extends EventEmitter {
  readonly connected: boolean;
  snapshot(): AtemSnapshot | null;
  rename(input: number, longName: string, shortName: string): Promise<void>;
  close(): Promise<void>;
}
export type AtemConnector = (host: string) => AtemLink;

const PORT_KIND: Record<string, AtemInput["kind"]> = {
  External: "external",
  Black: "black",
  ColorBars: "bars",
  ColorGenerator: "color",
  MediaPlayerFill: "mediaplayer",
  SuperSource: "supersource",
};
const VISIBLE_KINDS = new Set(Object.values(PORT_KIND));

export const realAtemConnector: AtemConnector = (host) => new RealAtemLink(host);

const enumKey = (en: object, v: number | undefined) => (v == null ? null : ((en as Record<number, string>)[v] ?? null));

class RealAtemLink extends EventEmitter implements AtemLink {
  connected = false;
  private atem = new Atem({ disableMultithreaded: true });
  constructor(host: string) {
    super();
    this.atem.on("connected", () => {
      this.connected = true;
      this.emit("change");
    });
    this.atem.on("disconnected", () => {
      this.connected = false;
      this.emit("change");
    });
    this.atem.on("stateChanged", () => this.emit("change"));
    this.atem.on("error", (e) => this.emit("log", String(e)));
    void this.atem.connect(host).catch((e) => this.emit("log", String(e)));
  }
  snapshot(): AtemSnapshot | null {
    const s = this.atem.state;
    if (!s || !this.connected) return null;
    const mes = s.info.capabilities?.mixEffects ?? (s.video.mixEffects.length || 1);
    const inputs: AtemInput[] = Object.values(s.inputs)
      .filter((i) => !!i)
      .map((i) => {
        const kind = PORT_KIND[enumKey(Enums.InternalPortType, i!.internalPortType) ?? ""] ?? "other";
        return {
          id: i!.inputId,
          longName: i!.longName,
          shortName: i!.shortName,
          kind,
          port: kind === "external" ? enumKey(Enums.ExternalPortType, i!.externalPortType) : null,
          namesDefault: !!i!.areNamesDefault,
        };
      })
      .filter((i) => VISIBLE_KINDS.has(i.kind))
      .sort((a, b) => a.id - b.id);
    const vm = enumKey(Enums.VideoMode, s.settings.videoMode);
    const pv = s.info.apiVersion as number | undefined;
    return {
      model: s.info.model,
      modelKey: enumKey(Enums.Model, s.info.model) ?? "Unknown",
      productName: s.info.productIdentifier ?? null,
      protocol: pv == null ? null : `${pv >>> 16}.${pv & 0xffff}`,
      // Enum keys look like "N1080i50" / "P625i50PAL": drop the leading marker.
      videoMode: vm ? vm.replace(/^[NP](?=\d)/, "") : null,
      mixEffects: mes,
      keyers: Array.from({ length: mes }, (_, i) => s.info.mixEffects[i]?.keyCount ?? 0),
      downstreamKeyers: s.info.capabilities?.downstreamKeyers ?? s.video.downstreamKeyers.length,
      auxes: s.info.capabilities?.auxilliaries ?? 0,
      mediaPlayers: s.info.capabilities?.mediaPlayers ?? 0,
      superSources: s.info.capabilities?.superSources ?? 0,
      multiviewers: s.info.multiviewer?.count ?? 0,
      inputs,
      program: Array.from({ length: mes }, (_, i) => s.video.mixEffects[i]?.programInput ?? null),
      preview: Array.from({ length: mes }, (_, i) => s.video.mixEffects[i]?.previewInput ?? null),
    };
  }
  async rename(input: number, longName: string, shortName: string) {
    if (!this.connected) throw new Error("ATEM not connected");
    await this.atem.setInputSettings({ longName, shortName }, input);
  }
  async close() {
    this.atem.removeAllListeners();
    await this.atem.destroy().catch(() => undefined);
  }
}

// ---- registry + API ---------------------------------------------------------------

interface SwitcherRow {
  id: string;
  name: string;
  host: string;
  location: string;
  notes: string;
  online: number;
  snapshot: string | null;
  last_seen_at: string | null;
  created_at: string;
}

/** ATEM labels: long name max 20, short name max 4 characters, printable ASCII (what the switcher can display). */
const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[\x20-\x7e]+$/, "ascii_only");
const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:-]+$/, "invalid_host");
const switcherSchema = z.object({
  name: z.string().trim().min(1).max(80),
  host: hostSchema,
  location: z.string().trim().max(120).optional(),
  notes: z.string().max(2000).optional(),
});
const inputSchema = z.object({
  longName: label(20).optional(),
  shortName: label(4).optional(),
  nodeId: z.string().max(64).nullable().optional(),
  note: z.string().max(200).optional(),
});

/** Grace period before a lost connection counts as "offline" (the ATEM protocol reconnects by itself). */
const OFFLINE_AFTER_MS = 15_000;

export function registerAtem(app: FastifyInstance, platform: Platform, connect: AtemConnector = realAtemConnector) {
  const { db, log } = platform.ctx;
  const links = new Map<string, { link: AtemLink; persist: NodeJS.Timeout | null; downSince: number | null }>();
  const get = (id: string) => db.prepare("SELECT * FROM atem_switchers WHERE id = ?").get(id) as SwitcherRow | undefined;
  const event = (id: string, type: string, message: string) => db.prepare("INSERT INTO atem_events (switcher_id, type, message) VALUES (?, ?, ?)").run(id, type, message);

  const persist = (id: string) => {
    const entry = links.get(id);
    const row = get(id);
    if (!entry || !row) return;
    const snap = entry.link.snapshot();
    if (entry.link.connected && snap) {
      entry.downSince = null;
      db.prepare("UPDATE atem_switchers SET online = 1, snapshot = ?, last_seen_at = ? WHERE id = ?").run(JSON.stringify(snap), new Date().toISOString(), id);
      if (!row.online) {
        event(id, "online", `Connected: ${snap.productName ?? snap.modelKey}${snap.protocol ? ` (protocol ${snap.protocol})` : ""}`);
        if (row.last_seen_at) void platform.mail.alert(`ATEM back online: ${row.name}`, `${row.name} (${row.host}) is reachable again.`);
      }
    }
  };
  const schedulePersist = (id: string) => {
    const entry = links.get(id);
    if (!entry || entry.persist) return;
    // State changes come in bursts (every frame of a transition): write at most once per second.
    entry.persist = setTimeout(() => {
      entry.persist = null;
      persist(id);
    }, 1000);
    entry.persist.unref();
  };

  const open = (row: SwitcherRow) => {
    const link = connect(row.host);
    const entry = { link, persist: null as NodeJS.Timeout | null, downSince: null as number | null };
    links.set(row.id, entry);
    link.on("change", () => {
      if (link.connected) {
        // First state after (re)connect is written straight away so the UI sees the device immediately.
        if (!get(row.id)?.online) persist(row.id);
        else schedulePersist(row.id);
      } else if (entry.downSince == null) entry.downSince = Date.now();
    });
    link.on("log", (m: string) => log.debug({ atem: row.host, m }, "atem"));
  };
  const closeLink = async (id: string) => {
    const e = links.get(id);
    if (!e) return;
    links.delete(id);
    if (e.persist) clearTimeout(e.persist);
    await e.link.close().catch(() => undefined);
  };

  for (const row of db.prepare("SELECT * FROM atem_switchers").all() as unknown as SwitcherRow[]) open(row);

  const sweep = () => {
    for (const [id, e] of links) {
      if (e.link.connected) {
        e.downSince = null;
        continue;
      }
      e.downSince ??= Date.now();
      const row = get(id);
      if (row?.online && Date.now() - e.downSince >= OFFLINE_AFTER_MS) {
        db.prepare("UPDATE atem_switchers SET online = 0 WHERE id = ?").run(id);
        event(id, "offline", "Connection to the switcher lost");
        log.warn({ atem: row.name }, "ATEM offline");
        void platform.mail.alert(`ATEM OFFLINE: ${row.name}`, `${row.name} (${row.host}) is not reachable.\nLast seen: ${row.last_seen_at}`);
      }
    }
  };
  const timer = setInterval(sweep, 5000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await Promise.all([...links.keys()].map(closeLink));
  });

  const inputMeta = (id: string) =>
    db.prepare("SELECT input_id AS inputId, node_id AS nodeId, note FROM atem_inputs WHERE switcher_id = ?").all(id) as { inputId: number; nodeId: string | null; note: string }[];

  const toPublic = (r: SwitcherRow) => {
    const live = links.get(r.id)?.link;
    const snap = (live?.connected ? live.snapshot() : null) ?? (r.snapshot ? (JSON.parse(r.snapshot) as AtemSnapshot) : null);
    return {
      id: r.id,
      name: r.name,
      host: r.host,
      location: r.location,
      notes: r.notes,
      online: Boolean(live?.connected ?? r.online),
      lastSeenAt: live?.connected ? new Date().toISOString() : r.last_seen_at,
      createdAt: r.created_at,
      snapshot: snap,
      inputs: inputMeta(r.id),
    };
  };
  const find = (id: string) => {
    const r = get(id);
    if (!r) throw new HttpError(404, "not_found");
    return r;
  };

  const counts = () => {
    const all = db.prepare("SELECT id, online FROM atem_switchers").all() as { id: string; online: number }[];
    return { total: all.length, online: all.filter((a) => links.get(a.id)?.link.connected ?? a.online).length };
  };

  app.get("/api/atem", async () => ({ switchers: (db.prepare("SELECT * FROM atem_switchers ORDER BY name COLLATE NOCASE").all() as unknown as SwitcherRow[]).map(toPublic) }));

  app.get("/api/atem/:id", async (req) => {
    const r = find((req.params as { id: string }).id);
    return { switcher: toPublic(r), events: db.prepare("SELECT type, message, at FROM atem_events WHERE switcher_id = ? ORDER BY id DESC LIMIT 50").all(r.id) };
  });

  app.post("/api/atem", async (req) => {
    requireRole(req, "admin");
    const b = switcherSchema.parse(req.body);
    if (db.prepare("SELECT 1 FROM atem_switchers WHERE host = ?").get(b.host)) throw new HttpError(409, "host_exists");
    const id = randomUUID();
    db.prepare("INSERT INTO atem_switchers (id, name, host, location, notes) VALUES (?, ?, ?, ?, ?)").run(id, b.name, b.host, b.location ?? "", b.notes ?? "");
    event(id, "added", `Registered by ${req.user!.username} at ${b.host}`);
    open(get(id)!);
    return toPublic(get(id)!);
  });

  app.put("/api/atem/:id", async (req) => {
    requireRole(req, "admin");
    const r = find((req.params as { id: string }).id);
    const b = switcherSchema.parse(req.body);
    if (b.host !== r.host && db.prepare("SELECT 1 FROM atem_switchers WHERE host = ?").get(b.host)) throw new HttpError(409, "host_exists");
    db.prepare("UPDATE atem_switchers SET name = ?, host = ?, location = ?, notes = ? WHERE id = ?").run(b.name, b.host, b.location ?? r.location, b.notes ?? r.notes, r.id);
    if (b.host !== r.host) {
      event(r.id, "host", `Address changed ${r.host} → ${b.host} by ${req.user!.username}`);
      db.prepare("UPDATE atem_switchers SET online = 0 WHERE id = ?").run(r.id);
      await closeLink(r.id);
      open(get(r.id)!);
    }
    return toPublic(get(r.id)!);
  });

  app.delete("/api/atem/:id", async (req) => {
    requireRole(req, "admin");
    const id = (req.params as { id: string }).id;
    await closeLink(id);
    db.prepare("DELETE FROM atem_switchers WHERE id = ?").run(id);
    return { ok: true };
  });

  /** Renames an input on the switcher itself and/or stores which node feeds it. */
  app.put("/api/atem/:id/inputs/:input", async (req) => {
    requireRole(req, "editor");
    const r = find((req.params as { id: string }).id);
    const inputId = Number((req.params as { input: string }).input);
    if (!Number.isInteger(inputId) || inputId < 0) throw new HttpError(400, "invalid_input");
    const b = inputSchema.parse(req.body);
    const link = links.get(r.id)?.link;
    const current = (link?.snapshot() ?? (r.snapshot ? (JSON.parse(r.snapshot) as AtemSnapshot) : null))?.inputs.find((i) => i.id === inputId);
    if (!current) throw new HttpError(404, "unknown_input");
    if (b.nodeId && !db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(b.nodeId)) throw new HttpError(400, "unknown_node");

    const longName = b.longName ?? current.longName;
    const shortName = b.shortName ?? current.shortName;
    if (longName !== current.longName || shortName !== current.shortName) {
      if (!link?.connected) throw new HttpError(409, "atem_offline");
      await link.rename(inputId, longName, shortName);
      persist(r.id);
      event(r.id, "rename", `Input ${inputId}: "${current.longName}" / ${current.shortName} → "${longName}" / ${shortName} by ${req.user!.username}`);
    }
    if (b.nodeId !== undefined || b.note !== undefined) {
      const prev = inputMeta(r.id).find((m) => m.inputId === inputId);
      db.prepare(
        `INSERT INTO atem_inputs (switcher_id, input_id, node_id, note) VALUES (?, ?, ?, ?)
         ON CONFLICT (switcher_id, input_id) DO UPDATE SET node_id = excluded.node_id, note = excluded.note`,
      ).run(r.id, inputId, b.nodeId !== undefined ? b.nodeId : (prev?.nodeId ?? null), b.note ?? prev?.note ?? "");
    }
    return toPublic(get(r.id)!);
  });

  return { counts };
}
