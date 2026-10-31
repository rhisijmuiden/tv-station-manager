import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { arch, release as osRelease, uptime } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PlatformContext } from "./context.js";
import { HttpError } from "./context.js";
import { compareVersions } from "./semver.js";

export type Channel = "production" | "test";
const MASK = "********";

const updateSettingsSchema = z.object({
  channel: z.enum(["production", "test"]).default("production"),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default("rhisijmuiden/tv-station-manager"),
  githubToken: z.string().default(""),
  autoCheck: z.boolean().default(true),
});
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;

interface GhAsset {
  name: string;
  url: string;
  browser_download_url: string;
  size: number;
}
interface GhRelease {
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: GhAsset[];
}

export interface UpdateCheck {
  current: string;
  channel: Channel;
  latest: string | null;
  available: boolean;
  /** True when the latest version on the selected channel is older (e.g. after switching test -> production). */
  isDowngrade: boolean;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  canApply: boolean;
  reason?: string;
  checkedAt: string;
}

const debArch = () => ({ x64: "amd64", arm64: "arm64" })[arch()] ?? arch();

export class UpdateService {
  private lastCheck: UpdateCheck | null = null;
  private applying = false;
  constructor(private ctx: PlatformContext) {}

  getSettings(): UpdateSettings {
    const s = updateSettingsSchema.parse(this.ctx.settings.get("update", {}));
    return { ...s, githubToken: this.ctx.secrets.decrypt(s.githubToken) };
  }
  saveSettings(input: unknown) {
    const next = updateSettingsSchema.parse(input);
    const cur = this.getSettings();
    const token = next.githubToken === MASK ? cur.githubToken : next.githubToken;
    this.ctx.settings.set("update", { ...next, githubToken: token ? this.ctx.secrets.encrypt(token) : "" });
    this.lastCheck = null;
  }
  publicSettings() {
    const s = this.getSettings();
    return { ...s, githubToken: s.githubToken ? MASK : "" };
  }

  private headers(accept = "application/vnd.github+json") {
    const h: Record<string, string> = { Accept: accept, "User-Agent": `tvsm-${this.ctx.config.app.id}`, "X-GitHub-Api-Version": "2022-11-28" };
    const token = this.getSettings().githubToken;
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private assetPattern(version: string) {
    return `tvsm-${this.ctx.config.app.id}_${version.replace(/^v/, "").replace("-", "~")}_${debArch()}.deb`;
  }

  private async findLatest(channel: Channel): Promise<GhRelease | null> {
    const { repository } = this.getSettings();
    const res = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=50`, { headers: this.headers() });
    if (!res.ok) throw new HttpError(502, "update_check_failed", `GitHub responded ${res.status}`);
    const releases = ((await res.json()) as GhRelease[]).filter((r) => !r.draft && (channel === "test" || !r.prerelease));
    // Only releases that contain a package for this app and architecture.
    const usable = releases.filter((r) => r.assets.some((a) => a.name === this.assetPattern(r.tag_name)));
    usable.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
    return usable[0] ?? null;
  }

  async check(): Promise<UpdateCheck> {
    const { channel } = this.getSettings();
    const current = this.ctx.config.version;
    const latest = await this.findLatest(channel);
    const latestVersion = latest?.tag_name.replace(/^v/, "") ?? null;
    const cmp = latestVersion ? compareVersions(latestVersion, current) : 0;
    const onTestBuild = /-test\./.test(current);
    // Switching from test to production may require installing an older production build.
    const isDowngrade = !!latestVersion && cmp < 0 && channel === "production" && onTestBuild;
    this.lastCheck = {
      current,
      channel,
      latest: latestVersion,
      available: !!latestVersion && (cmp > 0 || isDowngrade),
      isDowngrade,
      releaseName: latest?.name,
      releaseNotes: latest?.body,
      releaseUrl: latest?.html_url,
      publishedAt: latest?.published_at,
      canApply: this.ctx.config.packaged,
      reason: this.ctx.config.packaged ? undefined : "development_build",
      checkedAt: new Date().toISOString(),
    };
    return this.lastCheck;
  }

  status() {
    return { applying: this.applying, lastCheck: this.lastCheck, state: this.ctx.settings.get("update.state", null) };
  }

  async apply() {
    if (!this.ctx.config.packaged) throw new HttpError(400, "development_build", "Updates can only be applied to an installed package");
    if (this.applying) throw new HttpError(409, "update_in_progress");
    const check = await this.check();
    if (!check.available || !check.latest) throw new HttpError(400, "no_update_available");
    const release = (await this.findLatest(check.channel))!;
    const assetName = this.assetPattern(release.tag_name);
    const asset = release.assets.find((a) => a.name === assetName)!;
    this.applying = true;
    try {
      const dir = join(this.ctx.config.dataDir, "updates");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, assetName);
      const res = await fetch(asset.url, { headers: this.headers("application/octet-stream"), redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));

      // Verify against SHA256SUMS published with the release.
      const sums = release.assets.find((a) => a.name === "SHA256SUMS");
      if (!sums) throw new Error("Release has no SHA256SUMS; refusing to install");
      const sumsRes = await fetch(sums.url, { headers: this.headers("application/octet-stream"), redirect: "follow" });
      const expected = (await sumsRes.text()).split("\n").find((l) => l.trim().endsWith(assetName))?.split(/\s+/)[0];
      const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (!expected || expected !== actual) throw new Error("Checksum mismatch; update aborted");

      this.ctx.settings.set("update.state", { status: "installing", from: check.current, to: check.latest, at: new Date().toISOString() });
      // The helper (installed by the package, allowed via sudoers) runs apt in a transient systemd unit,
      // so it survives the restart of this service.
      const helper = `/usr/lib/tvsm/${this.ctx.config.app.id}/apply-update`;
      if (!existsSync(helper)) throw new Error(`Update helper missing: ${helper}`);
      const child = spawn("sudo", ["-n", helper, file], { detached: true, stdio: "ignore" });
      child.unref();
      return { started: true, from: check.current, to: check.latest };
    } catch (err) {
      this.applying = false;
      this.ctx.settings.set("update.state", { status: "failed", error: (err as Error).message, at: new Date().toISOString() });
      throw err;
    }
  }

  systemInfo() {
    let os = "";
    try {
      os = /PRETTY_NAME="([^"]+)"/.exec(readFileSync("/etc/os-release", "utf8"))?.[1] ?? "";
    } catch {
      /* not linux */
    }
    return {
      app: this.ctx.config.app,
      version: this.ctx.config.version,
      channel: this.getSettings().channel,
      packaged: this.ctx.config.packaged,
      hostname: this.ctx.config.hostname,
      os: os || `${process.platform} ${osRelease()}`,
      node: process.version,
      arch: arch(),
      uptimeSeconds: Math.round(process.uptime()),
      systemUptimeSeconds: Math.round(uptime()),
    };
  }
}

export function registerUpdate(app: FastifyInstance, ctx: PlatformContext, updates: UpdateService) {
  app.get("/api/system/health", async () => ({ ok: true, version: ctx.config.version }));
  app.get("/api/system/info", async () => updates.systemInfo());
  app.get("/api/system/update", async () => ({ settings: updates.publicSettings(), ...updates.status() }));
  app.put("/api/system/update/settings", async (req) => {
    updates.saveSettings(req.body);
    return updates.publicSettings();
  });
  app.post("/api/system/update/check", async () => updates.check());
  app.post("/api/system/update/apply", async () => updates.apply());

  // Mark a finished update on startup and periodically check in the background.
  const state = ctx.settings.get<{ status: string; to?: string } | null>("update.state", null);
  if (state?.status === "installing") {
    ctx.settings.set("update.state", {
      status: state.to === ctx.config.version ? "installed" : "failed",
      to: state.to,
      error: state.to === ctx.config.version ? undefined : "Version after restart does not match",
      at: new Date().toISOString(),
    });
  }
  const timer = setInterval(() => {
    if (updates.getSettings().autoCheck) updates.check().catch(() => undefined);
  }, 6 * 60 * 60 * 1000);
  timer.unref();
}
