/**
 * Kiloview inventory: encoders (E3) and decoders (D260) that carry the TV signal between studios.
 *
 * READ ONLY. The orchestrator logs in over the device's HTTP API and polls a fixed list of status requests
 * (`allowedPath` in kiloviewlogic.ts). Reboot, restore and factory reset are plain GETs on these boxes, so the client
 * refuses every path that is not on the list. No route here changes anything on a device.
 * Lost input, a watched stream that stops, a decoder output without picture, a wrong format and offline are logged
 * and mailed.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  activeInterface,
  allowedPath,
  issueKey,
  KILOVIEW_KINDS,
  kiloviewIssues,
  LOGIN_PATH,
  maskSecrets,
  parseDecoder,
  parseEncoder,
  runningKeys,
  type KiloviewKind,
  type KiloviewSnapshot,
} from "./kiloviewlogic.js";
import type { Issue } from "./monitorlogic.js";

/** Appended after TERANEX_MIGRATIONS / PROVISION_MIGRATIONS (append-only). */
export const KILOVIEW_MIGRATIONS = [
  `CREATE TABLE kiloviews (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('encoder', 'decoder')),
     host TEXT NOT NULL UNIQUE,
     username TEXT NOT NULL DEFAULT 'admin',
     password TEXT NOT NULL DEFAULT '',
     location TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',
     expected_format TEXT NOT NULL DEFAULT '',
     watch TEXT,
     online INTEGER NOT NULL DEFAULT 0,
     snapshot TEXT,
     last_error TEXT,
     last_seen_at TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE TABLE kiloview_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kiloview_id TEXT NOT NULL REFERENCES kiloviews(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     message TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE INDEX kiloview_events_dev ON kiloview_events(kiloview_id, at);`,
];

// ---- HTTP client ------------------------------------------------------------------------------------

export interface KiloviewTarget {
  kind: KiloviewKind;
  host: string;
  username: string;
  password: string;
}
/** One device session: logs in when needed and reads the status. Tests use a fake. */
export interface KiloviewClient {
  poll(): Promise<KiloviewSnapshot>;
}
export type KiloviewConnector = (t: KiloviewTarget) => KiloviewClient;

const TIMEOUT_MS = 5000;

export class AuthError extends Error {}

/** Header-safe JSON (the D260 wants the login answer as JSON in a header; names can be non-ASCII). */
const headerJson = (v: unknown) => JSON.stringify(v).replace(/[^\x20-\x7E]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export class RealKiloviewClient implements KiloviewClient {
  private login: Record<string, unknown> | null = null;
  constructor(private readonly t: KiloviewTarget) {}

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    // The allowlist is the safety net: nothing else ever leaves the orchestrator.
    if (!allowedPath(this.t.kind, method, path)) throw new Error(`refused: ${method} ${path} is not a read-only status request`);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.login && path !== LOGIN_PATH[this.t.kind]) {
      if (this.t.kind === "encoder") headers.Authorization = String(this.login.token ?? "");
      else headers.app = headerJson({ ...this.login, language: "en", software: "" });
    }
    const res = await fetch(`http://${this.t.host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) throw new AuthError(`HTTP ${res.status}`);
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status}: not a Kiloview answer`);
    }
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    const o = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
    if (o && o.result === "error") {
      const msg = String(o.msg ?? "");
      // E3: "Unauthorized"; D260: "1" (no session) / "2" (token no longer valid).
      if (/unauthori[sz]ed|token|login/i.test(msg) || msg === "1" || msg === "2") throw new AuthError(msg || "unauthorized");
      throw new Error(msg || "device error");
    }
    // Most answers are wrapped in {result, data}; some E3 answers are bare objects or arrays.
    return o && o.result === "ok" && "data" in o ? o.data : json;
  }

  private async signIn() {
    this.login = null;
    let data: unknown;
    try {
      data = await this.request("POST", LOGIN_PATH[this.t.kind], { username: this.t.username, password: this.t.password });
    } catch (e) {
      if (e instanceof AuthError) throw new AuthError("login_failed");
      throw e;
    }
    const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    if (!d.token) throw new AuthError("login_failed");
    this.login = d;
  }

  private async get(path: string) {
    if (!this.login) await this.signIn();
    try {
      return await this.request("GET", path);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      // The session ran out: log in once more and repeat.
      await this.signIn();
      return this.request("GET", path);
    }
  }

  async poll(): Promise<KiloviewSnapshot> {
    const raw: Record<string, unknown> = {};
    const read = async (path: string, optional = false) => {
      try {
        const v = await this.get(path);
        raw[path] = maskSecrets(v);
        return v;
      } catch (e) {
        if (optional && !(e instanceof AuthError)) return undefined;
        throw e;
      }
    };
    if (this.t.kind === "encoder") {
      const system = await read("/api/systemctrl/system/getSystemInfo?version=true");
      const active = await read("/api/codec/vin/active_interface");
      const m = activeInterface(active);
      const detail = await read(`/api/codec/${m}/vin/detail`);
      const venc = await read(`/api/codec/${m}/venc/settings`, true);
      const audio = await read(`/api/codec/${m}/audio/input`, true);
      const streams = await read(`/api/streamer/${m}/stream/list`);
      const network = await read("/api/systemctrl/system/getNetworkSpeed", true);
      return { ...parseEncoder({ system, active, detail, venc, audio, streams, network }), raw };
    }
    const system = await read("/api/report/system_info");
    const outputs = await read("/api/output/list");
    const details: Record<string, unknown> = {};
    for (const o of Array.isArray(outputs) ? outputs : []) {
      const id = String((o as Record<string, unknown>)?.id ?? "");
      if (/^\d{1,3}$/.test(id)) details[id] = await read(`/api/output/get?output_id=${id}`, true);
    }
    const codec = await read("/api/report/codec_info", true);
    return { ...parseDecoder({ system, outputs, details, codec }), raw };
  }
}
export const realKiloviewConnector: KiloviewConnector = (t) => new RealKiloviewClient(t);

// ---- registry + API --------------------------------------------------------------------------------

interface KiloviewRow {
  id: string;
  name: string;
  kind: KiloviewKind;
  host: string;
  username: string;
  password: string;
  location: string;
  notes: string;
  expected_format: string;
  watch: string | null;
  online: number;
  snapshot: string | null;
  last_error: string | null;
  last_seen_at: string | null;
  created_at: string;
}

const hostRe = /^[A-Za-z0-9.:-]+$/;
const kiloviewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(KILOVIEW_KINDS),
  host: z.string().trim().min(1).max(253).regex(hostRe, "invalid_host"),
  username: z.string().trim().min(1).max(64),
  /** Empty on edit = keep the stored password. */
  password: z.string().max(128).optional(),
  location: z.string().trim().max(120).optional(),
  notes: z.string().max(2000).optional(),
  /** Encoder: expected input format; decoder: expected output format (e.g. 1080i50). Empty = no check. */
  expectedFormat: z
    .string()
    .trim()
    .max(32)
    .regex(/^[A-Za-z0-9. ]*$/, "invalid_format")
    .optional(),
});

export const POLL_MS = 10_000;
/** Failed polls in a row before a box counts as offline (one lost answer is not an outage). */
const FAILS_BEFORE_OFFLINE = 2;
/** A problem must be seen on this many polls in a row before it is mailed. */
const POLLS_BEFORE_ALERT = 2;

export function registerKiloview(app: FastifyInstance, platform: Platform, connect: KiloviewConnector = realKiloviewConnector, pollMs = POLL_MS) {
  const { db, log, secrets } = platform.ctx;
  interface Entry {
    client: KiloviewClient;
    /** The poll that is running; a second request waits for it instead of starting another. */
    inflight: Promise<void> | null;
    fails: number;
    /** Problems seen per key: how many polls in a row, and whether a mail went out. */
    problems: Map<string, { issue: Issue; seen: number; mailed: boolean }>;
  }
  const entries = new Map<string, Entry>();
  const get = (id: string) => db.prepare("SELECT * FROM kiloviews WHERE id = ?").get(id) as KiloviewRow | undefined;
  const event = (id: string, type: string, message: string) => db.prepare("INSERT INTO kiloview_events (kiloview_id, type, message) VALUES (?, ?, ?)").run(id, type, message);
  const target = (r: KiloviewRow): KiloviewTarget => ({ kind: r.kind, host: r.host, username: r.username, password: r.password ? secrets.decrypt(r.password) : "" });
  const watchOf = (r: KiloviewRow) => (r.watch ? (JSON.parse(r.watch) as string[]) : null);
  const snapOf = (r: KiloviewRow) => (r.snapshot ? (JSON.parse(r.snapshot) as KiloviewSnapshot) : null);
  const label = (r: KiloviewRow) => `${r.name} (${r.host})`;

  const describe = (i: Issue) => {
    const p = i.params ?? {};
    switch (i.code) {
      case "no_input_signal":
        return "No signal on the input";
      case "stream_stopped":
        return `Stream "${p.name}" stopped`;
      case "decode_stopped":
        return `${p.name}: no picture from ${p.source ? `"${p.source}"` : "the source"}`;
      case "input_format":
        return `Input is ${p.got}, expected ${p.want}`;
      case "output_format":
        return `${p.name} outputs ${p.got}, expected ${p.want}`;
      case "temp_high":
        return `Temperature ${p.deg} °C`;
      case "cpu_high":
        return `CPU at ${p.pct}%`;
      default:
        return i.code;
    }
  };

  const open = (r: KiloviewRow) => {
    entries.set(r.id, { client: connect(target(r)), inflight: null, fails: 0, problems: new Map() });
  };

  /** Compares the problems of this poll with the previous ones: logs new / cleared ones, mails the lasting ones. */
  const track = (r: KiloviewRow, e: Entry, issues: Issue[]) => {
    const now = new Map(issues.filter((i) => i.code !== "device_offline").map((i) => [issueKey(i), i]));
    for (const [k, i] of now) {
      const p = e.problems.get(k) ?? { issue: i, seen: 0, mailed: false };
      p.issue = i;
      p.seen++;
      if (p.seen === 1) event(r.id, i.level === "down" ? "problem" : "warning", describe(i));
      if (!p.mailed && p.seen >= POLLS_BEFORE_ALERT) {
        p.mailed = true;
        log.warn({ kiloview: r.name, issue: i.code }, "Kiloview problem");
        void platform.mail.alert(`${i.level === "down" ? "KILOVIEW PROBLEM" : "Kiloview warning"}: ${r.name}`, `${label(r)}: ${describe(i)}.`);
      }
      e.problems.set(k, p);
    }
    for (const [k, p] of e.problems) {
      if (now.has(k)) continue;
      e.problems.delete(k);
      event(r.id, "resolved", `Resolved: ${describe(p.issue)}`);
      if (p.mailed) void platform.mail.alert(`Kiloview OK again: ${r.name}`, `${label(r)}: resolved: ${describe(p.issue)}.`);
    }
  };

  const pollOne = (id: string): Promise<void> => {
    const e = entries.get(id);
    if (!e) return Promise.resolve();
    e.inflight ??= doPoll(id, e).finally(() => (e.inflight = null));
    return e.inflight;
  };
  const doPoll = async (id: string, e: Entry) => {
    try {
      const snap = await e.client.poll();
      let r = get(id);
      if (!r || entries.get(id) !== e) return;
      e.fails = 0;
      // First picture of the device: what runs now is what must keep running (editable on the detail page).
      const watch = watchOf(r) ?? runningKeys(snap);
      db.prepare("UPDATE kiloviews SET online = 1, snapshot = ?, watch = ?, last_error = NULL, last_seen_at = ? WHERE id = ?").run(JSON.stringify(snap), JSON.stringify(watch), new Date().toISOString(), id);
      if (!r.online) {
        event(id, "online", `Connected: ${[snap.product, snap.firmware && `firmware ${snap.firmware}`].filter(Boolean).join(", ") || "Kiloview"}`);
        if (r.last_seen_at) void platform.mail.alert(`Kiloview back online: ${r.name}`, `${label(r)} is reachable again.`);
      }
      r = get(id)!;
      track(r, e, kiloviewIssues({ online: true, lastSeenAt: r.last_seen_at, expectedFormat: r.expected_format, watch, snapshot: snap }));
    } catch (err) {
      const r = get(id);
      if (!r || entries.get(id) !== e) return;
      const msg = err instanceof AuthError ? "login_failed" : (err as Error).name === "TimeoutError" ? "timeout" : (err as Error).message;
      e.fails++;
      db.prepare("UPDATE kiloviews SET last_error = ? WHERE id = ?").run(msg, id);
      log.debug({ kiloview: r.host, err: msg }, "kiloview poll failed");
      if (r.online && e.fails >= FAILS_BEFORE_OFFLINE) {
        db.prepare("UPDATE kiloviews SET online = 0 WHERE id = ?").run(id);
        event(id, "offline", msg === "login_failed" ? "Login refused (check user name and password)" : `Not reachable (${msg})`);
        log.warn({ kiloview: r.name }, "Kiloview offline");
        void platform.mail.alert(`KILOVIEW OFFLINE: ${r.name}`, `${label(r)} does not answer (${msg}).\nLast seen: ${r.last_seen_at ?? "never"}`);
        e.problems.clear();
      }
    }
  };
  const pollAll = async () => {
    await Promise.all([...entries.keys()].map(pollOne));
  };

  for (const r of db.prepare("SELECT * FROM kiloviews").all() as unknown as KiloviewRow[]) open(r);
  const timer = setInterval(() => void pollAll(), pollMs);
  timer.unref();
  app.addHook("onReady", async () => void pollAll());
  app.addHook("onClose", async () => {
    clearInterval(timer);
    entries.clear();
  });

  const toPublic = (r: KiloviewRow) => {
    const snapshot = snapOf(r);
    const watch = watchOf(r);
    const online = Boolean(r.online);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      host: r.host,
      username: r.username,
      hasPassword: !!r.password,
      location: r.location,
      notes: r.notes,
      expectedFormat: r.expected_format,
      watch,
      online,
      lastError: r.last_error,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
      snapshot,
      issues: kiloviewIssues({ online, lastSeenAt: r.last_seen_at, expectedFormat: r.expected_format, watch, snapshot }),
    };
  };
  const find = (id: string) => {
    const r = get(id);
    if (!r) throw new HttpError(404, "not_found");
    return r;
  };
  const list = () => (db.prepare("SELECT * FROM kiloviews ORDER BY name COLLATE NOCASE").all() as unknown as KiloviewRow[]).map(toPublic);
  const counts = () => {
    const all = list();
    return { total: all.length, online: all.filter((d) => d.online).length, problems: all.filter((d) => d.online && d.issues.some((i) => i.level === "down")).length };
  };

  app.get("/api/kiloview", async () => ({ kiloviews: list() }));

  app.get("/api/kiloview/:id", async (req) => {
    const r = find((req.params as { id: string }).id);
    return { kiloview: toPublic(r), events: db.prepare("SELECT type, message, at FROM kiloview_events WHERE kiloview_id = ? ORDER BY id DESC LIMIT 50").all(r.id) };
  });

  /** Tries the login and one status read with the given details (nothing is stored, nothing changes on the device). */
  app.post("/api/kiloview/test", async (req) => {
    requireRole(req, "admin");
    const b = kiloviewSchema.extend({ id: z.string().optional() }).parse(req.body);
    const stored = b.id ? get(b.id) : undefined;
    const password = b.password || (stored?.password ? secrets.decrypt(stored.password) : "");
    try {
      const snap = await connect({ kind: b.kind, host: b.host, username: b.username, password }).poll();
      return { ok: true, product: snap.product, firmware: snap.firmware };
    } catch (err) {
      return { ok: false, error: err instanceof AuthError ? "login_failed" : (err as Error).name === "TimeoutError" ? "timeout" : (err as Error).message };
    }
  });

  app.post("/api/kiloview", async (req) => {
    requireRole(req, "admin");
    const b = kiloviewSchema.parse(req.body);
    if (db.prepare("SELECT 1 FROM kiloviews WHERE host = ?").get(b.host)) throw new HttpError(409, "host_exists");
    const id = randomUUID();
    db.prepare("INSERT INTO kiloviews (id, name, kind, host, username, password, location, notes, expected_format) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      b.name,
      b.kind,
      b.host,
      b.username,
      b.password ? secrets.encrypt(b.password) : "",
      b.location ?? "",
      b.notes ?? "",
      b.expectedFormat ?? "",
    );
    event(id, "added", `Registered by ${req.user!.username} at ${b.host}`);
    open(get(id)!);
    void pollOne(id);
    return toPublic(get(id)!);
  });

  app.put("/api/kiloview/:id", async (req) => {
    requireRole(req, "admin");
    const r = find((req.params as { id: string }).id);
    const b = kiloviewSchema.parse(req.body);
    if (b.host !== r.host && db.prepare("SELECT 1 FROM kiloviews WHERE host = ?").get(b.host)) throw new HttpError(409, "host_exists");
    const password = b.password ? secrets.encrypt(b.password) : r.password;
    db.prepare("UPDATE kiloviews SET name = ?, kind = ?, host = ?, username = ?, password = ?, location = ?, notes = ?, expected_format = ? WHERE id = ?").run(
      b.name,
      b.kind,
      b.host,
      b.username,
      password,
      b.location ?? r.location,
      b.notes ?? r.notes,
      b.expectedFormat ?? r.expected_format,
      r.id,
    );
    const reconnect = b.host !== r.host || b.kind !== r.kind || b.username !== r.username || password !== r.password;
    if (b.host !== r.host) event(r.id, "host", `Address changed ${r.host} → ${b.host} by ${req.user!.username}`);
    if (b.kind !== r.kind || b.host !== r.host) db.prepare("UPDATE kiloviews SET online = 0, snapshot = NULL, watch = NULL WHERE id = ?").run(r.id);
    if (reconnect) open(get(r.id)!);
    void pollOne(r.id);
    return toPublic(get(r.id)!);
  });

  /** Which streams (encoder) / outputs (decoder) must keep running. Stored in the orchestrator only. */
  app.put("/api/kiloview/:id/watch", async (req) => {
    requireRole(req, "admin");
    const r = find((req.params as { id: string }).id);
    const b = z.object({ watch: z.array(z.string().max(64)).max(64) }).parse(req.body);
    db.prepare("UPDATE kiloviews SET watch = ? WHERE id = ?").run(JSON.stringify(b.watch), r.id);
    event(r.id, "watch", `Watch list changed by ${req.user!.username}`);
    return toPublic(get(r.id)!);
  });

  app.delete("/api/kiloview/:id", async (req) => {
    requireRole(req, "admin");
    const id = (req.params as { id: string }).id;
    entries.delete(id);
    db.prepare("DELETE FROM kiloviews WHERE id = ?").run(id);
    return { ok: true };
  });

  return { counts, list, pollAll };
}

export type PublicKiloview = ReturnType<ReturnType<typeof registerKiloview>["list"]>[number];
