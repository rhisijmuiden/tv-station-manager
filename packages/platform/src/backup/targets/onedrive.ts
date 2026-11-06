import { createWriteStream, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BackupTarget, OneDriveConfig, RemoteFile, TargetHooks } from "./types.js";

/**
 * OneDrive / OneDrive for Business target over Microsoft Graph. The administrator signs in once with the device-code
 * flow ("go to microsoft.com/devicelogin and type this code"); we keep only the refresh token (encrypted) and rotate it.
 * Scopes are delegated `Files.ReadWrite offline_access User.Read`: the app can only reach that account's own drive.
 */

export const ONEDRIVE_SCOPES = "Files.ReadWrite offline_access User.Read";
const loginBase = () => (process.env.TVSM_SSO_AUTHORITY ?? "https://login.microsoftonline.com").replace(/\/+$/, "");
const graphBase = () => (process.env.TVSM_GRAPH_URL ?? "https://graph.microsoft.com/v1.0").replace(/\/+$/, "");
/** Graph upload sessions want chunks in multiples of 320 KiB; 10 MiB = 32 x 320 KiB. */
export const CHUNK = 320 * 1024 * 32;
const SIMPLE_MAX = 4 * 1024 * 1024;

/** Graph path of the backup folder, each segment URL-encoded ("" = drive root). */
export function folderPath(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === ".." || p === ".")) throw new Error("OneDrive folder may not contain . or ..");
  return parts.map(encodeURIComponent).join("/");
}

/** Graph item address for a file (or the folder itself when `name` is omitted). */
export function itemUrl(folder: string, name?: string): string {
  const path = [folderPath(folder), name ? encodeURIComponent(name) : ""].filter(Boolean).join("/");
  return path ? `${graphBase()}/me/drive/root:/${path}:` : `${graphBase()}/me/drive/root`;
}

/** Byte ranges for an upload session. */
export function chunkRanges(size: number, chunk = CHUNK): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let start = 0; start < size; start += chunk) out.push({ start, end: Math.min(size, start + chunk) - 1 });
  return out;
}

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function tokenRequest(tenant: string, body: Record<string, string>) {
  const res = await fetch(`${loginBase()}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as TokenSet & { error?: string; error_description?: string };
  return { ok: res.ok, json };
}

// ---- device-code sign-in ------------------------------------------------------

export interface DeviceCodeStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

export async function startDeviceCode(tenant: string, clientId: string): Promise<DeviceCodeStart> {
  const res = await fetch(`${loginBase()}/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: ONEDRIVE_SCOPES }),
  });
  const json = (await res.json().catch(() => ({}))) as DeviceCodeStart & { error?: string; error_description?: string };
  if (!res.ok || !json.device_code) throw new Error(friendlyAuthError(json.error, json.error_description));
  return json;
}

export type DevicePoll = { status: "pending" } | { status: "done"; refreshToken: string; accessToken: string } | { status: "error"; error: string };

export async function pollDeviceCode(tenant: string, clientId: string, deviceCode: string): Promise<DevicePoll> {
  const { ok, json } = await tokenRequest(tenant, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: deviceCode });
  if (ok && json.refresh_token) return { status: "done", refreshToken: json.refresh_token, accessToken: json.access_token };
  if (json.error === "authorization_pending" || json.error === "slow_down") return { status: "pending" };
  return { status: "error", error: friendlyAuthError(json.error, json.error_description) };
}

/** Short, actionable messages for the errors an administrator is likely to hit. */
export function friendlyAuthError(code?: string, description?: string): string {
  const aad = /AADSTS\d+/.exec(description ?? "")?.[0];
  const hints: Record<string, string> = {
    AADSTS7000218: 'turn on "Allow public client flows" in the app registration (Authentication)',
    AADSTS700016: "application (client) ID not found in this tenant",
    AADSTS90002: "tenant not found",
    AADSTS65001: "admin consent for Files.ReadWrite is missing",
    AADSTS70000: "the sign-in was not accepted",
  };
  if (code === "expired_token") return "the code expired, start the sign-in again";
  if (code === "authorization_declined") return "the sign-in was cancelled";
  if (code === "invalid_grant") return `Microsoft sign-in is no longer valid, connect OneDrive again${aad ? ` (${aad})` : ""}`;
  if (aad && hints[aad]) return `Microsoft: ${hints[aad]} (${aad})`;
  return `Microsoft: ${(description ?? code ?? "sign-in failed").split("\n")[0]}`;
}

// ---- target ---------------------------------------------------------------------

/** Access tokens per account, shared between target instances (the engine creates one per operation). */
const tokenCache = new Map<string, { access: string; expires: number; refresh: string }>();
export const _clearOneDriveTokenCache = () => tokenCache.clear();

export class OneDriveTarget implements BackupTarget {
  constructor(private cfg: OneDriveConfig, private hooks: TargetHooks = {}) {}

  private cacheKey() {
    return `${this.cfg.tenant}|${this.cfg.clientId}|${this.cfg.account}`;
  }

  private async accessToken(): Promise<string> {
    if (!this.cfg.refreshToken) throw new Error("OneDrive is not connected yet: click Connect to Microsoft");
    const key = this.cacheKey();
    const hit = tokenCache.get(key);
    if (hit && hit.expires > Date.now() + 60_000) return hit.access;
    const refresh = hit?.refresh ?? this.cfg.refreshToken;
    const { ok, json } = await tokenRequest(this.cfg.tenant, {
      grant_type: "refresh_token",
      client_id: this.cfg.clientId,
      refresh_token: refresh,
      scope: ONEDRIVE_SCOPES,
    });
    if (!ok || !json.access_token) throw new Error(friendlyAuthError(json.error, (json as { error_description?: string }).error_description));
    const next = json.refresh_token ?? refresh;
    tokenCache.set(key, { access: json.access_token, expires: Date.now() + json.expires_in * 1000, refresh: next });
    if (next !== this.cfg.refreshToken) {
      this.cfg.refreshToken = next;
      this.hooks.saveConfig?.({ refreshToken: next });
    }
    return json.access_token;
  }

  /** Graph call with bearer token; retries throttling (429/503) honouring Retry-After. */
  private async graph(url: string, init: RequestInit & { auth?: boolean } = {}, attempt = 0): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.auth !== false) headers.set("authorization", `Bearer ${await this.accessToken()}`);
    const res = await fetch(url, { ...init, headers });
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 4) {
      const wait = Math.min(60, Number(res.headers.get("retry-after")) || 2 ** attempt) * 1000;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, wait));
      return this.graph(url, init, attempt + 1);
    }
    if (res.status === 401 && attempt === 0 && init.auth !== false) {
      tokenCache.delete(this.cacheKey());
      await res.body?.cancel();
      return this.graph(url, init, attempt + 1);
    }
    return res;
  }

  private async fail(res: Response, what: string): Promise<never> {
    const j = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const hint = res.status === 507 || j.error?.code === "quotaLimitReached" ? "OneDrive is full" : j.error?.message ?? res.statusText;
    throw new Error(`OneDrive ${what} failed: ${hint} (HTTP ${res.status})`);
  }

  /** Creates every segment of the backup folder that does not exist yet. */
  private async ensureFolder() {
    const parts = this.cfg.folder.split(/[\\/]+/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const here = parts.slice(0, i + 1).join("/");
      const probe = await this.graph(`${itemUrl(here)}?$select=id,folder`);
      if (probe.ok) {
        await probe.body?.cancel();
        continue;
      }
      if (probe.status !== 404) await this.fail(probe, "folder check");
      const parent = parts.slice(0, i).join("/");
      const res = await this.graph(`${itemUrl(parent)}/children`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: parts[i], folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      });
      if (!res.ok && res.status !== 409) await this.fail(res, "create folder");
      await res.body?.cancel();
    }
  }

  async test() {
    const me = await this.graph(`${graphBase()}/me/drive?$select=driveType,owner,quota`);
    if (!me.ok) await this.fail(me, "drive check");
    const drive = (await me.json()) as { driveType?: string; owner?: { user?: { displayName?: string } }; quota?: { remaining?: number } };
    await this.ensureFolder();
    const probe = `.tvsm-write-test-${Date.now()}`;
    const put = await this.graph(`${itemUrl(this.cfg.folder, probe)}/content`, { method: "PUT", body: "ok" });
    if (!put.ok) await this.fail(put, "write test");
    await put.body?.cancel();
    await this.remove(probe);
    const free = drive.quota?.remaining != null ? `, ${(drive.quota.remaining / 1024 ** 3).toFixed(1)} GB free` : "";
    const who = this.cfg.account || drive.owner?.user?.displayName || "";
    return { details: `OneDrive ok${who ? ` (${who})` : ""}, folder /${this.cfg.folder.replace(/^\/+/, "")}${free}` };
  }

  async upload(localPath: string, remoteName: string) {
    await this.ensureFolder();
    const size = statSync(localPath).size;
    const target = itemUrl(this.cfg.folder, remoteName);
    if (size <= SIMPLE_MAX) {
      const res = await this.graph(`${target}/content?@microsoft.graph.conflictBehavior=replace`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: await readRange(localPath, 0, size),
      });
      if (!res.ok) await this.fail(res, "upload");
      await res.body?.cancel();
      return;
    }
    // Upload session: the file only appears in OneDrive once the last chunk is in.
    const s = await this.graph(`${target}/createUploadSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    });
    if (!s.ok) await this.fail(s, "upload session");
    const { uploadUrl } = (await s.json()) as { uploadUrl: string };
    try {
      for (const r of chunkRanges(size)) {
        const res = await this.graph(uploadUrl, {
          method: "PUT",
          auth: false, // the upload URL is pre-authorised; Graph rejects a bearer token here
          headers: { "content-length": String(r.end - r.start + 1), "content-range": `bytes ${r.start}-${r.end}/${size}` },
          body: await readRange(localPath, r.start, r.end - r.start + 1),
        });
        if (!res.ok) await this.fail(res, "upload");
        await res.body?.cancel();
      }
    } catch (err) {
      await fetch(uploadUrl, { method: "DELETE" }).catch(() => undefined);
      throw err;
    }
  }

  async download(remoteName: string, localPath: string) {
    const res = await this.graph(`${itemUrl(this.cfg.folder, remoteName)}/content`, { redirect: "follow" });
    if (!res.ok || !res.body) await this.fail(res, "download");
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(localPath));
  }

  async list(): Promise<RemoteFile[]> {
    await this.ensureFolder();
    const out: RemoteFile[] = [];
    let url: string | undefined = `${itemUrl(this.cfg.folder)}/children?$select=name,size,file&$top=500`;
    while (url) {
      const res = await this.graph(url);
      if (!res.ok) await this.fail(res, "list");
      const page = (await res.json()) as { value: { name: string; size: number; file?: unknown }[]; "@odata.nextLink"?: string };
      for (const it of page.value) if (it.file) out.push({ name: it.name, size: it.size });
      url = page["@odata.nextLink"];
    }
    return out;
  }

  async remove(remoteName: string) {
    const res = await this.graph(itemUrl(this.cfg.folder, remoteName), { method: "DELETE" });
    if (!res.ok && res.status !== 404) await this.fail(res, "delete");
    await res.body?.cancel();
  }
}

async function readRange(path: string, start: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const fh = await open(path, "r");
  try {
    const buf = new Uint8Array(length);
    let off = 0;
    while (off < length) {
      const { bytesRead } = await fh.read(buf, off, length - off, start + off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally {
    await fh.close();
  }
}
