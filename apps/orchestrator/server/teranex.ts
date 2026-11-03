/**
 * Teranex inventory: the orchestrator keeps track of Blackmagic Teranex converters (Teranex AV, Express, 2D / 3D).
 *
 * READ ONLY. A Teranex often sits in the live chain (switcher -> Teranex -> broadcast encoder), so the orchestrator
 * never changes its settings: it connects over the Teranex Ethernet Protocol (TCP 9800), reads the status the device
 * sends (model, input source / format / signal, audio source, output format, genlock) and only sends "PING" as a
 * keep-alive. Lost input signal, a different input format than expected and offline are logged and mailed.
 * On the connection diagram a Teranex is a `device` row with `ref_id = teranex:<id>`.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyBlock, emptySnapshot, normFormat, parseBlocks, type TeranexSnapshot } from "./teranexlogic.js";

/** Appended after MONITOR_MIGRATIONS (the trigger cleans up the Teranex's diagram box). */
export const TERANEX_MIGRATIONS = [
  `CREATE TABLE teranexes (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     host TEXT NOT NULL UNIQUE,
     location TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',
     expected_input TEXT NOT NULL DEFAULT '',
     online INTEGER NOT NULL DEFAULT 0,
     snapshot TEXT,
     last_seen_at TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE TABLE teranex_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     teranex_id TEXT NOT NULL REFERENCES teranexes(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     message TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE INDEX teranex_events_dev ON teranex_events(teranex_id, at);
   CREATE TRIGGER diagram_teranex_gone AFTER DELETE ON teranexes BEGIN DELETE FROM diagram_devices WHERE kind = 'device' AND ref_id = 'teranex:' || OLD.id; END;`,
  // HyperDeck support was parked: boxes of HyperDecks on the diagram stay (with their cables) as ordinary devices.
  `DROP TRIGGER IF EXISTS diagram_hyperdeck_gone;
   UPDATE diagram_devices SET ref_id = NULL, name = CASE WHEN name = '' THEN COALESCE((SELECT h.name FROM hyperdecks h WHERE 'hyperdeck:' || h.id = diagram_devices.ref_id), 'HyperDeck') ELSE name END
     WHERE kind = 'device' AND ref_id LIKE 'hyperdeck:%';`,
];

export const TERANEX_PORT = 9800;

/** One connection to a Teranex. Real implementation: a TCP socket; tests use a fake. Read only by design. */
export interface TeranexLink extends EventEmitter {
  readonly connected: boolean;
  snapshot(): TeranexSnapshot | null;
  close(): Promise<void>;
}
export type TeranexConnector = (host: string) => TeranexLink;

export const realTeranexConnector: TeranexConnector = (host) => new RealTeranexLink(host);

const RECONNECT_MS = 5000;
const PING_MS = 10_000;
/** No data at all (not even the ACK on a PING) for this long = the link is dead. */
const SILENT_MS = 30_000;

class RealTeranexLink extends EventEmitter implements TeranexLink {
  private sock: Socket | null = null;
  private state: TeranexSnapshot | null = null;
  private ready = false;
  private closed = false;
  private buf = "";
  private lastData = 0;
  private ping: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private readonly host: string;
  private readonly port: number;
  constructor(host: string) {
    super();
    // "host:port" (one colon) is accepted for devices behind NAT and for tests; the default port is 9800.
    const m = /^([^:]+):(\d{1,5})$/.exec(host);
    this.host = m ? m[1]! : host;
    this.port = m ? Number(m[2]) : TERANEX_PORT;
    this.open();
  }
  get connected() {
    return this.ready && !!this.sock && !this.sock.destroyed;
  }
  private open() {
    if (this.closed) return;
    this.buf = "";
    this.state = emptySnapshot();
    const s = new Socket();
    this.sock = s;
    s.setEncoding("utf8");
    s.setKeepAlive(true, 10_000);
    s.setTimeout(10_000, () => {
      if (!this.ready) s.destroy(new Error("connect timeout"));
    });
    s.on("connect", () => {
      this.lastData = Date.now();
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (Date.now() - this.lastData > SILENT_MS) {
          this.emit("log", "no data, reconnecting");
          s.destroy();
          return;
        }
        // The only thing ever sent: a keep-alive the device answers with ACK. It changes nothing.
        if (!s.destroyed) s.write("PING:\n\n");
      }, PING_MS);
      this.ping.unref();
    });
    s.on("data", (chunk: string) => this.onData(chunk));
    s.on("error", (e) => this.emit("log", `socket: ${e.message}`));
    s.on("close", () => {
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      const was = this.ready;
      this.ready = false;
      if (was) this.emit("change");
      if (!this.closed) {
        this.retry = setTimeout(() => this.open(), RECONNECT_MS);
        this.retry.unref();
      }
    });
    s.connect(this.port, this.host);
  }
  private onData(chunk: string) {
    this.lastData = Date.now();
    this.buf += chunk;
    if (this.buf.length > 256_000) this.buf = this.buf.slice(-64_000);
    const { blocks, rest } = parseBlocks(this.buf);
    this.buf = rest;
    let changed = false;
    for (const b of blocks) if (this.state && applyBlock(this.state, b)) changed = true;
    // Ready once the device has told what it is or what it sees on its input.
    if (!this.ready && this.state && (this.state.blocks["VIDEO INPUT"] || this.state.blocks["TERANEX DEVICE"] || this.state.blocks["PROTOCOL PREAMBLE"])) {
      this.ready = true;
      changed = true;
    }
    if (changed && this.ready) this.emit("change");
  }
  snapshot() {
    return this.connected && this.state ? structuredClone(this.state) : null;
  }
  async close() {
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    if (this.retry) clearTimeout(this.retry);
    this.removeAllListeners();
    this.sock?.destroy();
  }
}

// ---- registry + API ---------------------------------------------------------------

interface TeranexRow {
  id: string;
  name: string;
  host: string;
  location: string;
  notes: string;
  expected_input: string;
  online: number;
  snapshot: string | null;
  last_seen_at: string | null;
  created_at: string;
}

const teranexSchema = z.object({
  name: z.string().trim().min(1).max(80),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.:-]+$/, "invalid_host"),
  location: z.string().trim().max(120).optional(),
  notes: z.string().max(2000).optional(),
  /** Format the input should carry, e.g. "1080i50"; empty = no check. */
  expectedInput: z
    .string()
    .trim()
    .max(32)
    .regex(/^[A-Za-z0-9. ]*$/, "invalid_format")
    .optional(),
});

/** Grace period before a lost connection counts as "offline". */
const OFFLINE_AFTER_MS = 15_000;
/** The input must be gone this long before "no signal" is mailed (a source switch upstream is not an outage). */
const NO_SIGNAL_ALERT_MS = 5_000;

export function registerTeranex(app: FastifyInstance, platform: Platform, connect: TeranexConnector = realTeranexConnector) {
  const { db, log } = platform.ctx;
  interface Entry {
    link: TeranexLink;
    persist: NodeJS.Timeout | null;
    downSince: number | null;
    signal: boolean | null;
    lostSince: number | null;
    lostMailed: boolean;
    inMode: string | null;
    outMode: string | null;
    mismatch: boolean;
  }
  const links = new Map<string, Entry>();
  const get = (id: string) => db.prepare("SELECT * FROM teranexes WHERE id = ?").get(id) as TeranexRow | undefined;
  const event = (id: string, type: string, message: string) => db.prepare("INSERT INTO teranex_events (teranex_id, type, message) VALUES (?, ?, ?)").run(id, type, message);

  const persist = (id: string) => {
    const e = links.get(id);
    const row = get(id);
    if (!e || !row) return;
    const snap = e.link.snapshot();
    if (!e.link.connected || !snap) return;
    e.downSince = null;
    db.prepare("UPDATE teranexes SET online = 1, snapshot = ?, last_seen_at = ? WHERE id = ?").run(JSON.stringify(snap), new Date().toISOString(), id);
    if (!row.online) {
      event(id, "online", `Connected: ${snap.model}${snap.softwareVersion ? ` (software ${snap.softwareVersion})` : ""}`);
      if (row.last_seen_at) void platform.mail.alert(`Teranex back online: ${row.name}`, `${row.name} (${row.host}) is reachable again.`);
    }
    // Input signal: lost / back. Changes made on the device itself are picked up the same way.
    const sig = snap.input.signalPresent;
    if (sig === false && e.signal !== false) {
      e.lostSince = Date.now();
      e.lostMailed = false;
      event(id, "signal", `No signal on the input${snap.input.videoSource ? ` (${snap.input.videoSource})` : ""}`);
    } else if (sig === true && e.signal === false) {
      event(id, "signal", `Input signal back${snap.input.videoMode ? `: ${snap.input.videoMode}` : ""}`);
      if (e.lostMailed) void platform.mail.alert(`Teranex input back: ${row.name}`, `${row.name} (${row.host}) sees a signal on its input again.`);
      e.lostSince = null;
      e.lostMailed = false;
    }
    e.signal = sig;
    if (e.inMode != null && snap.input.videoMode !== e.inMode && snap.input.videoMode) event(id, "format", `Input format ${e.inMode} → ${snap.input.videoMode}`);
    if (e.outMode != null && snap.output.videoMode !== e.outMode && snap.output.videoMode) event(id, "format", `Output format ${e.outMode} → ${snap.output.videoMode}`);
    e.inMode = snap.input.videoMode;
    e.outMode = snap.output.videoMode;
    const want = row.expected_input.trim();
    const mismatch = !!want && sig !== false && !!snap.input.videoMode && normFormat(snap.input.videoMode) !== normFormat(want);
    if (mismatch && !e.mismatch) {
      event(id, "format", `Input is ${snap.input.videoMode}, expected ${want}`);
      void platform.mail.alert(`Teranex input format: ${row.name}`, `${row.name} (${row.host}) receives ${snap.input.videoMode} instead of ${want}.`);
    }
    e.mismatch = mismatch;
  };
  const schedulePersist = (id: string) => {
    const e = links.get(id);
    if (!e || e.persist) return;
    e.persist = setTimeout(() => {
      e.persist = null;
      persist(id);
    }, 500);
    e.persist.unref();
  };

  const open = (row: TeranexRow) => {
    const link = connect(row.host);
    const entry: Entry = { link, persist: null, downSince: null, signal: null, lostSince: null, lostMailed: false, inMode: null, outMode: null, mismatch: false };
    const prev = row.snapshot ? (JSON.parse(row.snapshot) as TeranexSnapshot) : null;
    if (prev) {
      entry.signal = prev.input.signalPresent;
      entry.inMode = prev.input.videoMode;
      entry.outMode = prev.output.videoMode;
    }
    links.set(row.id, entry);
    link.on("change", () => {
      if (link.connected) {
        if (!get(row.id)?.online) persist(row.id);
        else schedulePersist(row.id);
      } else entry.downSince ??= Date.now();
    });
    link.on("log", (m: string) => log.debug({ teranex: row.host, m }, "teranex"));
  };
  const closeLink = async (id: string) => {
    const e = links.get(id);
    if (!e) return;
    links.delete(id);
    if (e.persist) clearTimeout(e.persist);
    await e.link.close().catch(() => undefined);
  };

  for (const row of db.prepare("SELECT * FROM teranexes").all() as unknown as TeranexRow[]) open(row);

  const sweep = () => {
    for (const [id, e] of links) {
      const row = get(id);
      if (!row) continue;
      if (e.link.connected) {
        e.downSince = null;
        if (e.signal === false && e.lostSince && !e.lostMailed && Date.now() - e.lostSince >= NO_SIGNAL_ALERT_MS) {
          e.lostMailed = true;
          log.warn({ teranex: row.name }, "Teranex input signal lost");
          void platform.mail.alert(`TERANEX NO INPUT: ${row.name}`, `${row.name} (${row.host}) has no signal on its input. Everything after it (e.g. the broadcast encoder) gets no picture from it.`);
        }
        continue;
      }
      e.downSince ??= Date.now();
      if (row.online && Date.now() - e.downSince >= OFFLINE_AFTER_MS) {
        db.prepare("UPDATE teranexes SET online = 0 WHERE id = ?").run(id);
        event(id, "offline", "Connection to the Teranex lost");
        log.warn({ teranex: row.name }, "Teranex offline");
        void platform.mail.alert(`TERANEX OFFLINE: ${row.name}`, `${row.name} (${row.host}) is not reachable on TCP ${TERANEX_PORT}.\nLast seen: ${row.last_seen_at}`);
      }
    }
  };
  const timer = setInterval(sweep, 2500);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await Promise.all([...links.keys()].map(closeLink));
  });

  const toPublic = (r: TeranexRow) => {
    const live = links.get(r.id)?.link;
    const snap = (live?.connected ? live.snapshot() : null) ?? (r.snapshot ? (JSON.parse(r.snapshot) as TeranexSnapshot) : null);
    return {
      id: r.id,
      name: r.name,
      host: r.host,
      location: r.location,
      notes: r.notes,
      expectedInput: r.expected_input,
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
  const list = () => (db.prepare("SELECT * FROM teranexes ORDER BY name COLLATE NOCASE").all() as unknown as TeranexRow[]).map(toPublic);
  const counts = () => {
    const all = list();
    return { total: all.length, online: all.filter((d) => d.online).length, noSignal: all.filter((d) => d.online && d.snapshot?.input.signalPresent === false).length };
  };

  app.get("/api/teranex", async () => ({ teranexes: list() }));

  app.get("/api/teranex/:id", async (req) => {
    const r = find((req.params as { id: string }).id);
    return { teranex: toPublic(r), events: db.prepare("SELECT type, message, at FROM teranex_events WHERE teranex_id = ? ORDER BY id DESC LIMIT 50").all(r.id) };
  });

  app.post("/api/teranex", async (req) => {
    requireRole(req, "admin");
    const b = teranexSchema.parse(req.body);
    if (db.prepare("SELECT 1 FROM teranexes WHERE host = ?").get(b.host)) throw new HttpError(409, "host_exists");
    const id = randomUUID();
    db.prepare("INSERT INTO teranexes (id, name, host, location, notes, expected_input) VALUES (?, ?, ?, ?, ?, ?)").run(id, b.name, b.host, b.location ?? "", b.notes ?? "", b.expectedInput ?? "");
    event(id, "added", `Registered by ${req.user!.username} at ${b.host}`);
    open(get(id)!);
    return toPublic(get(id)!);
  });

  app.put("/api/teranex/:id", async (req) => {
    requireRole(req, "admin");
    const r = find((req.params as { id: string }).id);
    const b = teranexSchema.parse(req.body);
    if (b.host !== r.host && db.prepare("SELECT 1 FROM teranexes WHERE host = ?").get(b.host)) throw new HttpError(409, "host_exists");
    db.prepare("UPDATE teranexes SET name = ?, host = ?, location = ?, notes = ?, expected_input = ? WHERE id = ?").run(
      b.name,
      b.host,
      b.location ?? r.location,
      b.notes ?? r.notes,
      b.expectedInput ?? r.expected_input,
      r.id,
    );
    if (b.host !== r.host) {
      event(r.id, "host", `Address changed ${r.host} → ${b.host} by ${req.user!.username}`);
      db.prepare("UPDATE teranexes SET online = 0 WHERE id = ?").run(r.id);
      await closeLink(r.id);
      open(get(r.id)!);
    } else {
      const e = links.get(r.id);
      if (e) e.mismatch = false;
      schedulePersist(r.id);
    }
    return toPublic(get(r.id)!);
  });

  app.delete("/api/teranex/:id", async (req) => {
    requireRole(req, "admin");
    const id = (req.params as { id: string }).id;
    await closeLink(id);
    db.prepare("DELETE FROM teranexes WHERE id = ?").run(id);
    return { ok: true };
  });

  return { counts, list };
}

export type PublicTeranex = ReturnType<ReturnType<typeof registerTeranex>["list"]>[number];
