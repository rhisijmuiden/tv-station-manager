/**
 * HyperDeck inventory: the orchestrator keeps track of Blackmagic HyperDeck recorders / players.
 *
 * One connection per deck over the HyperDeck Ethernet Protocol (TCP 9993, via hyperdeck-connection). It keeps a
 * snapshot of model, transport (record / play / stop, timecode, format), media slots with recording time left and
 * the selected input, and lets operators start a recording, play and stop. Offline and "almost full while
 * recording" are mailed as alerts. On the connection diagram a deck is a `device` row with `ref_id = hyperdeck:<id>`.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Commands, Hyperdeck } from "hyperdeck-connection";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cleanClipName, LOW_RECORD_TIME_S, recordTimeLeft, type HyperdeckSlot, type HyperdeckSnapshot, type TransportStatus } from "./hyperdecklogic.js";

/** Appended after DIAGRAM_MIGRATIONS (the trigger cleans up the deck's diagram box). */
export const HYPERDECK_MIGRATIONS = [
  `CREATE TABLE hyperdecks (
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
   CREATE TABLE hyperdeck_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     deck_id TEXT NOT NULL REFERENCES hyperdecks(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     message TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE INDEX hyperdeck_events_deck ON hyperdeck_events(deck_id, at);
   CREATE TRIGGER diagram_hyperdeck_gone AFTER DELETE ON hyperdecks BEGIN DELETE FROM diagram_devices WHERE kind = 'device' AND ref_id = 'hyperdeck:' || OLD.id; END;`,
];

export type TransportAction = "record" | "play" | "stop";

/** One connection to a deck. Real implementation: hyperdeck-connection; tests use a fake. */
export interface HyperdeckLink extends EventEmitter {
  readonly connected: boolean;
  snapshot(): HyperdeckSnapshot | null;
  transport(action: TransportAction, clipName?: string): Promise<void>;
  close(): Promise<void>;
}
export type HyperdeckConnector = (host: string) => HyperdeckLink;

export const realHyperdeckConnector: HyperdeckConnector = (host) => new RealHyperdeckLink(host);

/** Slot info refresh: recording time left only changes in notifications on some firmware. */
const SLOT_REFRESH_MS = 10_000;

class RealHyperdeckLink extends EventEmitter implements HyperdeckLink {
  private deck = new Hyperdeck({ pingPeriod: 5000 });
  private state: HyperdeckSnapshot | null = null;
  private ready = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(host: string) {
    super();
    this.deck.on("connected", (info) => {
      void this.load(info.model, info.protocolVersion).catch((e) => this.emit("log", `load failed: ${String(e)}`));
    });
    this.deck.on("disconnected", () => {
      this.ready = false;
      this.emit("change");
    });
    this.deck.on("error", (m, e) => this.emit("log", `${m}: ${String(e)}`));
    this.deck.on("notify.transport", (t) => {
      if (!this.state) return;
      const clean = Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined));
      this.state.transport = { ...this.state.transport, ...clean } as HyperdeckSnapshot["transport"];
      this.emit("change");
    });
    this.deck.on("notify.displayTimecode", (t) => {
      if (!this.state) return;
      this.state.transport.displayTimecode = t.displayTimecode;
      this.emit("change");
    });
    this.deck.on("notify.slot", (s) => {
      if (!this.state) return;
      const cur = this.state.slots.find((x) => x.id === s.slotId);
      if (cur) Object.assign(cur, Object.fromEntries(Object.entries(s).filter(([k, v]) => v !== undefined && k !== "slotId")));
      this.emit("change");
    });
    this.deck.on("notify.configuration", (c) => {
      if (!this.state) return;
      if (c.videoInput) this.state.videoInput = c.videoInput;
      if (c.fileFormat) this.state.fileFormat = c.fileFormat;
      this.emit("change");
    });
    this.deck.on("notify.remote", (r) => {
      if (!this.state || r.enabled == null) return;
      this.state.remoteEnabled = r.enabled;
      this.emit("change");
    });
    // "host:port" (one colon) is accepted for decks behind NAT and for tests; the default port is 9993.
    const m = /^([^:]+):(\d{1,5})$/.exec(host);
    this.deck.connect(m ? m[1]! : host, m ? Number(m[2]) : undefined);
  }
  get connected() {
    return this.deck.connected && this.ready;
  }
  private async load(model: string, protocolVersion: number) {
    const info = await this.deck.sendCommand(new Commands.DeviceInfoCommand());
    const t = await this.deck.sendCommand(new Commands.TransportInfoCommand());
    const slots = await this.readSlots(info.slots);
    const conf = await this.deck.sendCommand(new Commands.ConfigurationGetCommand()).catch(() => null);
    const remote = await this.deck.sendCommand(new Commands.RemoteGetCommand()).catch(() => null);
    const notify = new Commands.NotifySetCommand();
    notify.transport = true;
    notify.slot = true;
    notify.configuration = true;
    notify.remote = true;
    await this.deck.sendCommand(notify).catch((e) => this.emit("log", `notify: ${String(e)}`));
    // Running timecode (protocol 1.11+); older decks refuse the parameter, so it is asked for separately.
    const tc = new Commands.NotifySetCommand();
    tc.displayTimecode = true;
    await this.deck.sendCommand(tc).catch(() => undefined);
    this.state = {
      model: info.model || model,
      protocolVersion: info.protocolVersion ?? protocolVersion ?? null,
      transport: {
        status: t.status as TransportStatus,
        speed: t.speed,
        slotId: t.slotId,
        clipId: t.clipId,
        timecode: t.timecode,
        displayTimecode: t.displayTimecode,
        videoFormat: t.videoFormat ?? null,
        inputVideoFormat: t.inputVideoFormat ?? null,
        loop: t.loop,
      },
      slots,
      videoInput: conf?.videoInput ?? null,
      fileFormat: conf?.fileFormat ?? null,
      remoteEnabled: remote?.enabled ?? null,
    };
    this.ready = true;
    this.emit("change");
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.connected || !this.state) return;
      void this.readSlots(this.state.slots.length)
        .then((s) => {
          if (this.state) this.state.slots = s;
          this.emit("change");
        })
        .catch(() => undefined);
    }, SLOT_REFRESH_MS);
    this.timer.unref();
  }
  private async readSlots(count: number): Promise<HyperdeckSlot[]> {
    const out: HyperdeckSlot[] = [];
    for (let id = 1; id <= Math.min(count, 8); id++) {
      const s = await this.deck.sendCommand(new Commands.SlotInfoCommand(id)).catch(() => null);
      if (s) out.push({ id, status: s.status, volumeName: s.volumeName ?? "", recordingTime: s.recordingTime ?? 0, videoFormat: s.videoFormat ?? null });
    }
    return out;
  }
  snapshot() {
    return this.connected && this.state ? structuredClone(this.state) : null;
  }
  async transport(action: TransportAction, clipName?: string) {
    if (!this.connected) throw new Error("HyperDeck not connected");
    if (action === "record") await this.deck.sendCommand(new Commands.RecordCommand(clipName || undefined));
    else if (action === "play") await this.deck.sendCommand(new Commands.PlayCommand());
    else await this.deck.sendCommand(new Commands.StopCommand());
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.deck.removeAllListeners();
    await this.deck.disconnect().catch(() => undefined);
  }
}

// ---- registry + API ---------------------------------------------------------------

interface DeckRow {
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

const deckSchema = z.object({
  name: z.string().trim().min(1).max(80),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.:-]+$/, "invalid_host"),
  location: z.string().trim().max(120).optional(),
  notes: z.string().max(2000).optional(),
});
const transportSchema = z.object({ action: z.enum(["record", "play", "stop"]), clipName: z.string().max(120).optional() });

/** Grace period before a lost connection counts as "offline" (the library reconnects by itself). */
const OFFLINE_AFTER_MS = 15_000;

export function registerHyperdecks(app: FastifyInstance, platform: Platform, connect: HyperdeckConnector = realHyperdeckConnector) {
  const { db, log } = platform.ctx;
  const links = new Map<string, { link: HyperdeckLink; persist: NodeJS.Timeout | null; downSince: number | null; lowWarned: boolean; status: TransportStatus | null; quietUntil: number }>();
  const get = (id: string) => db.prepare("SELECT * FROM hyperdecks WHERE id = ?").get(id) as DeckRow | undefined;
  const event = (id: string, type: string, message: string) => db.prepare("INSERT INTO hyperdeck_events (deck_id, type, message) VALUES (?, ?, ?)").run(id, type, message);

  const persist = (id: string) => {
    const entry = links.get(id);
    const row = get(id);
    if (!entry || !row) return;
    const snap = entry.link.snapshot();
    if (!entry.link.connected || !snap) return;
    entry.downSince = null;
    db.prepare("UPDATE hyperdecks SET online = 1, snapshot = ?, last_seen_at = ? WHERE id = ?").run(JSON.stringify(snap), new Date().toISOString(), id);
    if (!row.online) {
      event(id, "online", `Connected: ${snap.model}${snap.protocolVersion ? ` (protocol ${snap.protocolVersion})` : ""}`);
      if (row.last_seen_at) void platform.mail.alert(`HyperDeck back online: ${row.name}`, `${row.name} (${row.host}) is reachable again.`);
    }
    // Transport changes made on the deck itself (front panel, ATEM, management node) are logged too.
    const st = snap.transport.status;
    // Right after a command from the orchestrator the deck's confirmation is not logged a second time.
    if (entry.status && entry.status !== st && (st === "record" || entry.status === "record") && Date.now() >= entry.quietUntil) event(id, "transport", st === "record" ? "Recording started" : `Recording stopped (${st})`);
    entry.status = st;
    const left = recordTimeLeft(snap);
    if (st === "record" && left != null && left < LOW_RECORD_TIME_S) {
      if (!entry.lowWarned) {
        entry.lowWarned = true;
        event(id, "disk", `Less than ${Math.round(LOW_RECORD_TIME_S / 60)} minutes of recording time left`);
        void platform.mail.alert(`HyperDeck almost full: ${row.name}`, `${row.name} (${row.host}) is recording with ${Math.floor(left / 60)} minutes left on the media.`);
      }
    } else if (left == null || left >= LOW_RECORD_TIME_S) entry.lowWarned = false;
  };
  const schedulePersist = (id: string) => {
    const entry = links.get(id);
    if (!entry || entry.persist) return;
    // Timecode notifications can come every frame: write at most once per second.
    entry.persist = setTimeout(() => {
      entry.persist = null;
      persist(id);
    }, 1000);
    entry.persist.unref();
  };

  const open = (row: DeckRow) => {
    const link = connect(row.host);
    const entry = { link, persist: null as NodeJS.Timeout | null, downSince: null as number | null, lowWarned: false, status: null as TransportStatus | null, quietUntil: 0 };
    links.set(row.id, entry);
    link.on("change", () => {
      if (link.connected) {
        if (!get(row.id)?.online) persist(row.id);
        else schedulePersist(row.id);
      } else entry.downSince ??= Date.now();
    });
    link.on("log", (m: string) => log.debug({ hyperdeck: row.host, m }, "hyperdeck"));
  };
  const closeLink = async (id: string) => {
    const e = links.get(id);
    if (!e) return;
    links.delete(id);
    if (e.persist) clearTimeout(e.persist);
    await e.link.close().catch(() => undefined);
  };

  for (const row of db.prepare("SELECT * FROM hyperdecks").all() as unknown as DeckRow[]) open(row);

  const sweep = () => {
    for (const [id, e] of links) {
      if (e.link.connected) {
        e.downSince = null;
        continue;
      }
      e.downSince ??= Date.now();
      const row = get(id);
      if (row?.online && Date.now() - e.downSince >= OFFLINE_AFTER_MS) {
        db.prepare("UPDATE hyperdecks SET online = 0 WHERE id = ?").run(id);
        event(id, "offline", "Connection to the deck lost");
        log.warn({ hyperdeck: row.name }, "HyperDeck offline");
        void platform.mail.alert(`HYPERDECK OFFLINE: ${row.name}`, `${row.name} (${row.host}) is not reachable.\nLast seen: ${row.last_seen_at}`);
      }
    }
  };
  const timer = setInterval(sweep, 5000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await Promise.all([...links.keys()].map(closeLink));
  });

  const toPublic = (r: DeckRow) => {
    const live = links.get(r.id)?.link;
    const snap = (live?.connected ? live.snapshot() : null) ?? (r.snapshot ? (JSON.parse(r.snapshot) as HyperdeckSnapshot) : null);
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
    };
  };
  const find = (id: string) => {
    const r = get(id);
    if (!r) throw new HttpError(404, "not_found");
    return r;
  };
  const list = () => (db.prepare("SELECT * FROM hyperdecks ORDER BY name COLLATE NOCASE").all() as unknown as DeckRow[]).map(toPublic);
  const counts = () => {
    const all = list();
    return { total: all.length, online: all.filter((d) => d.online).length, recording: all.filter((d) => d.online && d.snapshot?.transport.status === "record").length };
  };

  app.get("/api/hyperdecks", async () => ({ decks: list() }));

  app.get("/api/hyperdecks/:id", async (req) => {
    const r = find((req.params as { id: string }).id);
    return { deck: toPublic(r), events: db.prepare("SELECT type, message, at FROM hyperdeck_events WHERE deck_id = ? ORDER BY id DESC LIMIT 50").all(r.id) };
  });

  app.post("/api/hyperdecks", async (req) => {
    requireRole(req, "admin");
    const b = deckSchema.parse(req.body);
    if (db.prepare("SELECT 1 FROM hyperdecks WHERE host = ?").get(b.host)) throw new HttpError(409, "host_exists");
    const id = randomUUID();
    db.prepare("INSERT INTO hyperdecks (id, name, host, location, notes) VALUES (?, ?, ?, ?, ?)").run(id, b.name, b.host, b.location ?? "", b.notes ?? "");
    event(id, "added", `Registered by ${req.user!.username} at ${b.host}`);
    open(get(id)!);
    return toPublic(get(id)!);
  });

  app.put("/api/hyperdecks/:id", async (req) => {
    requireRole(req, "admin");
    const r = find((req.params as { id: string }).id);
    const b = deckSchema.parse(req.body);
    if (b.host !== r.host && db.prepare("SELECT 1 FROM hyperdecks WHERE host = ?").get(b.host)) throw new HttpError(409, "host_exists");
    db.prepare("UPDATE hyperdecks SET name = ?, host = ?, location = ?, notes = ? WHERE id = ?").run(b.name, b.host, b.location ?? r.location, b.notes ?? r.notes, r.id);
    if (b.host !== r.host) {
      event(r.id, "host", `Address changed ${r.host} → ${b.host} by ${req.user!.username}`);
      db.prepare("UPDATE hyperdecks SET online = 0 WHERE id = ?").run(r.id);
      await closeLink(r.id);
      open(get(r.id)!);
    }
    return toPublic(get(r.id)!);
  });

  app.delete("/api/hyperdecks/:id", async (req) => {
    requireRole(req, "admin");
    const id = (req.params as { id: string }).id;
    await closeLink(id);
    db.prepare("DELETE FROM hyperdecks WHERE id = ?").run(id);
    return { ok: true };
  });

  app.post("/api/hyperdecks/:id/transport", async (req) => {
    requireRole(req, "operator");
    const r = find((req.params as { id: string }).id);
    const b = transportSchema.parse(req.body);
    const link = links.get(r.id)?.link;
    const snap = link?.connected ? link.snapshot() : null;
    if (!link || !snap) throw new HttpError(409, "hyperdeck_offline");
    if (b.action === "record" && !snap.slots.some((s) => s.status === "mounted")) throw new HttpError(409, "no_media");
    const name = b.clipName ? cleanClipName(b.clipName) : "";
    try {
      await link.transport(b.action, name || undefined);
    } catch (e) {
      // Most common cause: "Remote" is switched off in the deck's setup.
      throw new HttpError(502, snap.remoteEnabled === false ? "remote_disabled" : "hyperdeck_failed", (e as Error).message);
    }
    const entry = links.get(r.id);
    if (entry) entry.quietUntil = Date.now() + 3000;
    event(r.id, "transport", `${b.action === "record" ? `Record${name ? ` "${name}"` : ""}` : b.action === "play" ? "Play" : "Stop"} by ${req.user!.username}`);
    schedulePersist(r.id);
    return toPublic(get(r.id)!);
  });

  return { counts, list };
}

export type PublicHyperdeck = ReturnType<ReturnType<typeof registerHyperdecks>["list"]>[number];
