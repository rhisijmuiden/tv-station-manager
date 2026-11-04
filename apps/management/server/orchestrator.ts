/**
 * Link to the orchestrator: which ATEMs are locked for manual control there.
 *
 * In the orchestrator an operator can lock an ATEM ("vastzetten"); the director then holds its
 * switches for that ATEM until it is released ("vrijgeven"). This node polls
 * `GET <orchestrator>/automation-api/v1/atem-control` with the orchestrator's automation token every few seconds.
 * ATEMs are matched by address (host), so both sides must use the same IP/hostname.
 *
 * When the orchestrator cannot be reached the last known locks stay in force (a lock is a deliberate human
 * decision); switching the link off here releases everything.
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export interface AtemLock {
  host: string;
  name: string;
  by: string | null;
  at: string | null;
  reason: string;
}
interface Stored {
  enabled: boolean;
  url: string;
  /** Encrypted with the platform secret box. */
  token: string;
}
interface Remote {
  serverTime: string;
  switchers: { id: string; name: string; host: string; mode: "automation" | "locked"; by: string | null; at: string | null; reason: string }[];
}

const KEY = "orchestrator.link";
export const POLL_MS = 3000;
const MONITORING_PATH = "/automation-api/v1/monitoring";
const MONITOR_CACHE_MS = 2000;
const norm = (h: string) => h.trim().toLowerCase();

export class OrchestratorLink extends EventEmitter {
  private locks = new Map<string, AtemLock>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  lastOkAt: string | null = null;
  lastError: string | null = null;
  /** Switchers the orchestrator knows (host → name), to show which local ATEMs are matched. */
  known = new Map<string, string>();

  constructor(
    private platform: Platform,
    private fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  private stored(): Stored {
    return this.platform.ctx.settings.get<Stored>(KEY, { enabled: false, url: "", token: "" });
  }
  config() {
    const s = this.stored();
    return { enabled: s.enabled, url: s.url, hasToken: !!s.token };
  }
  save(b: { enabled: boolean; url: string; token?: string }) {
    const cur = this.stored();
    const token = b.token === undefined ? cur.token : b.token ? this.platform.ctx.secrets.encrypt(b.token) : "";
    this.platform.ctx.settings.set(KEY, { enabled: b.enabled, url: b.url.replace(/\/+$/, ""), token });
    if (!b.enabled) this.setLocks([]);
    this.lastError = null;
    this.known.clear();
    this.monitorCache = null;
  }

  /** The lock on the ATEM at `host`, or null when the automation may switch it. */
  lockFor(host: string | null | undefined): AtemLock | null {
    return host ? (this.locks.get(norm(host)) ?? null) : null;
  }

  status() {
    return { ...this.config(), lastOkAt: this.lastOkAt, lastError: this.lastError, locks: [...this.locks.values()], known: [...this.known].map(([host, name]) => ({ host, name })) };
  }

  private setLocks(list: AtemLock[]) {
    const next = new Map(list.map((l) => [norm(l.host), l]));
    const same = next.size === this.locks.size && [...next.keys()].every((k) => this.locks.has(k));
    this.locks = next;
    if (!same) this.emit("change");
  }

  /** One poll; returns the error, or null. */
  async poll(): Promise<string | null> {
    const s = this.stored();
    if (!s.enabled || !s.url || !s.token) return null;
    if (this.polling) return null;
    this.polling = true;
    try {
      const res = await this.fetchImpl(`${s.url}/automation-api/v1/atem-control`, {
        headers: { authorization: `Bearer ${this.platform.ctx.secrets.decrypt(s.token)}` },
        signal: AbortSignal.timeout(2500),
      });
      if (res.status === 401) throw new Error("token rejected by the orchestrator");
      if (!res.ok) throw new Error(`orchestrator answered ${res.status}`);
      const body = (await res.json()) as Remote;
      this.known = new Map(body.switchers.map((x) => [norm(x.host), x.name]));
      this.setLocks(body.switchers.filter((x) => x.mode === "locked").map((x) => ({ host: x.host, name: x.name, by: x.by, at: x.at, reason: x.reason })));
      this.lastOkAt = new Date().toISOString();
      if (this.lastError) this.platform.ctx.log.info("orchestrator link restored");
      this.lastError = null;
      return null;
    } catch (e) {
      const msg = (e as Error).name === "TimeoutError" ? "orchestrator not reachable (timeout)" : (e as Error).message;
      if (msg !== this.lastError) this.platform.ctx.log.warn({ err: msg }, "orchestrator link");
      this.lastError = msg;
      return msg;
    } finally {
      this.polling = false;
    }
  }

  /**
   * GET a read-only path from the orchestrator's automation API with the stored token (monitoring).
   * Needs only the address + token; the "enabled" switch is about the ATEM locks.
   * Throws HttpError with a code the UI translates.
   */
  async fetchRemote<T>(path: string): Promise<T> {
    const s = this.stored();
    if (!s.url || !s.token) throw new HttpError(409, "orchestrator_not_linked");
    let res: Response;
    try {
      res = await this.fetchImpl(`${s.url}${path}`, {
        headers: { authorization: `Bearer ${this.platform.ctx.secrets.decrypt(s.token)}` },
        signal: AbortSignal.timeout(4000),
      });
    } catch (e) {
      throw new HttpError(502, "orchestrator_unreachable", (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message);
    }
    if (res.status === 401) throw new HttpError(502, "orchestrator_token_rejected");
    // An orchestrator from before this feature has no monitoring route.
    if (res.status === 404 && path === MONITORING_PATH) throw new HttpError(502, "orchestrator_outdated");
    if (res.status === 404) throw new HttpError(404, "not_found");
    if (!res.ok) throw new HttpError(502, "orchestrator_unreachable", `orchestrator answered ${res.status}`);
    return (await res.json()) as T;
  }

  private monitorCache: { at: number; data: Record<string, unknown> } | null = null;
  private monitorPending: Promise<Record<string, unknown>> | null = null;
  /** The orchestrator's monitoring overview; shared for a moment so many open browsers ask it once. */
  async monitoring(): Promise<Record<string, unknown>> {
    if (this.monitorCache && Date.now() - this.monitorCache.at < MONITOR_CACHE_MS) return this.monitorCache.data;
    this.monitorPending ??= this.fetchRemote<Record<string, unknown>>(MONITORING_PATH)
      .then((data) => {
        this.monitorCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => (this.monitorPending = null));
    return this.monitorPending;
  }

  start(intervalMs = POLL_MS) {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

const linkSchema = z.object({
  enabled: z.boolean(),
  url: z
    .string()
    .trim()
    .max(300)
    .refine((u) => u === "" || /^https?:\/\/[^\s/]+(\/.*)?$/.test(u), "invalid_url"),
  /** Omit to keep the stored token, "" to clear it. */
  token: z.string().trim().max(200).optional(),
});

export function registerOrchestratorLink(app: FastifyInstance, link: OrchestratorLink) {
  app.get("/api/orchestrator-link", async () => link.status());
  app.put("/api/orchestrator-link", async (req) => {
    requireRole(req, "admin");
    const b = linkSchema.parse(req.body);
    if (b.enabled && !b.url) throw new HttpError(400, "url_required");
    link.save(b);
    if (b.enabled) await link.poll();
    return link.status();
  });
  // The orchestrator's monitoring page, read-only, for everyone signed in here (no login on the orchestrator).
  app.get("/api/orchestrator-monitoring", async () => ({ ...(await link.monitoring()), source: link.config().url }));
  app.get("/api/orchestrator-monitoring/devices/:id/events", async (req) => {
    const id = (req.params as { id: string }).id;
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(404, "not_found");
    return link.fetchRemote<{ events: unknown[] }>(`${MONITORING_PATH}/devices/${id}/events`);
  });
  app.post("/api/orchestrator-link/test", async (req) => {
    requireRole(req, "admin");
    const err = await link.poll();
    return { ok: !err, error: err, ...link.status() };
  });
}
