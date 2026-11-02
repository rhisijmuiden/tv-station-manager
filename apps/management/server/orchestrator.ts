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
  app.post("/api/orchestrator-link/test", async (req) => {
    requireRole(req, "admin");
    const err = await link.poll();
    return { ok: !err, error: err, ...link.status() };
  });
}
