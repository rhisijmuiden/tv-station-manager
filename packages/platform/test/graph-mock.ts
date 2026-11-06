/**
 * Tiny stand-in for Microsoft login + Graph OneDrive, enough for the backup target:
 * device code + refresh token (rotating), folders, simple upload, upload sessions, download via redirect, list, delete.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface GraphMock {
  base: string;
  files: Map<string, Buffer>;
  folders: Set<string>;
  /** Number of refresh-token grants served. */
  refreshes: number;
  /** Refresh tokens that are still accepted. */
  validRefresh: Set<string>;
  sessionChunks: number;
  close(): Promise<void>;
}

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

export async function startGraphMock(): Promise<GraphMock> {
  let devicePolls = 0;
  let tokenN = 0;
  const access = new Set<string>();
  const sessions = new Map<string, { path: string; parts: Buffer[]; size: number }>();
  const state = {
    files: new Map<string, Buffer>(),
    folders: new Set<string>([""]),
    refreshes: 0,
    validRefresh: new Set<string>(),
    sessionChunks: 0,
  };
  const issue = () => {
    tokenN++;
    const at = `at-${tokenN}`;
    const rt = `rt-${tokenN}`;
    access.add(at);
    state.validRefresh.add(rt);
    return { access_token: at, refresh_token: rt, expires_in: 3600, token_type: "Bearer" };
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const send = (status: number, json?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers });
      res.end(json !== undefined ? JSON.stringify(json) : undefined);
    };
    const raw = await body(req);

    // ---- login ----
    if (url.pathname.endsWith("/oauth2/v2.0/devicecode")) {
      return send(200, { device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 1, message: "go" });
    }
    if (url.pathname.endsWith("/oauth2/v2.0/token")) {
      const f = new URLSearchParams(raw.toString());
      if (f.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        if (devicePolls++ === 0) return send(400, { error: "authorization_pending" });
        return send(200, issue());
      }
      if (f.get("grant_type") === "refresh_token") {
        const rt = f.get("refresh_token")!;
        if (!state.validRefresh.has(rt)) return send(400, { error: "invalid_grant", error_description: "AADSTS70000: bad token" });
        state.validRefresh.delete(rt); // strict rotation: an old token never works twice
        state.refreshes++;
        return send(200, issue());
      }
      return send(400, { error: "unsupported_grant_type" });
    }

    // ---- upload sessions & downloads (pre-authorised URLs) ----
    if (url.pathname.startsWith("/upload/")) {
      const s = sessions.get(url.pathname.slice(8));
      if (!s) return send(404, { error: { code: "itemNotFound" } });
      if (req.method === "DELETE") return sessions.delete(url.pathname.slice(8)), send(204);
      if (req.headers.authorization) return send(401, { error: { code: "unauthenticated", message: "no bearer on upload url" } });
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers["content-range"]));
      if (!m || Number(m[2]) - Number(m[1]) + 1 !== raw.length) return send(400, { error: { code: "invalidRange" } });
      s.parts.push(raw);
      state.sessionChunks++;
      const got = s.parts.reduce((n, p) => n + p.length, 0);
      if (got < s.size) return send(202, { nextExpectedRanges: [`${got}-`] });
      state.files.set(s.path, Buffer.concat(s.parts));
      sessions.delete(url.pathname.slice(8));
      return send(201, { name: s.path.split("/").pop(), size: got });
    }
    if (url.pathname.startsWith("/dl/")) {
      const data = state.files.get(decodeURIComponent(url.pathname.slice(4)));
      if (!data) return send(404);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(data);
    }

    // ---- Graph ----
    const tok = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!access.has(tok)) return send(401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } });
    const g = url.pathname.replace(/^\/graph\/v1\.0/, "");
    if (g === "/me") return send(200, { mail: "backup@ijmond360.nl", userPrincipalName: "backup@ijmond360.nl", displayName: "Backup" });
    if (g === "/me/drive") return send(200, { driveType: "business", owner: { user: { displayName: "Backup" } }, quota: { remaining: 512 * 1024 ** 3 } });

    let path = "";
    let rest = "";
    if (g.startsWith("/me/drive/root:/")) {
      const m = /^\/me\/drive\/root:\/(.*?):(.*)$/.exec(g);
      if (!m) return send(400, { error: { code: "invalidRequest" } });
      path = m[1]!.split("/").map(decodeURIComponent).join("/");
      rest = m[2]!;
    } else if (g.startsWith("/me/drive/root")) rest = g.slice("/me/drive/root".length);
    else return send(404, { error: { code: "itemNotFound" } });

    const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");
    if (rest === "" && req.method === "GET") {
      if (state.folders.has(path)) return send(200, { id: path, folder: {} });
      if (state.files.has(path)) return send(200, { id: path, file: {} });
      return send(404, { error: { code: "itemNotFound", message: "not found" } });
    }
    if (rest === "" && req.method === "DELETE") {
      if (!state.files.delete(path)) return send(404, { error: { code: "itemNotFound" } });
      return send(204);
    }
    if (rest === "/children" && req.method === "POST") {
      if (!state.folders.has(path)) return send(404, { error: { code: "itemNotFound" } });
      const j = JSON.parse(raw.toString()) as { name: string };
      const full = path ? `${path}/${j.name}` : j.name;
      if (state.folders.has(full)) return send(409, { error: { code: "nameAlreadyExists" } });
      state.folders.add(full);
      return send(201, { id: full, name: j.name, folder: {} });
    }
    if (rest === "/children" && req.method === "GET") {
      if (!state.folders.has(path)) return send(404, { error: { code: "itemNotFound" } });
      const value = [
        ...[...state.folders].filter((f) => f && parentOf(f) === path).map((f) => ({ name: f.split("/").pop(), folder: {} })),
        ...[...state.files].filter(([f]) => parentOf(f) === path).map(([f, d]) => ({ name: f.split("/").pop(), size: d.length, file: {} })),
      ];
      // Page size 2 to exercise @odata.nextLink.
      const skip = Number(url.searchParams.get("skip") ?? 0);
      const page = value.slice(skip, skip + 2);
      const next = skip + 2 < value.length ? `${mock.base}/graph/v1.0${g}?skip=${skip + 2}` : undefined;
      return send(200, { value: page, ...(next ? { "@odata.nextLink": next } : {}) });
    }
    if (rest === "/content" && req.method === "PUT") {
      if (!state.folders.has(parentOf(path))) return send(409, { error: { code: "parentMissing" } });
      state.files.set(path, raw);
      return send(201, { name: path.split("/").pop(), size: raw.length });
    }
    if (rest === "/content" && req.method === "GET") {
      if (!state.files.has(path)) return send(404, { error: { code: "itemNotFound" } });
      return send(302, undefined, { location: `${mock.base}/dl/${encodeURIComponent(path)}` });
    }
    if (rest === "/createUploadSession" && req.method === "POST") {
      const id = `s${sessions.size + 1}-${Date.now()}`;
      sessions.set(id, { path, parts: [], size: Number.NaN });
      return send(200, { uploadUrl: `${mock.base}/upload/${id}` });
    }
    return send(400, { error: { code: "notImplemented", message: `${req.method} ${g}` } });
  });
  // Upload sessions learn their size from the first chunk's Content-Range.
  server.prependListener("request", (req) => {
    if (!req.url?.startsWith("/upload/") || req.method !== "PUT") return;
    const m = /\/(\d+)$/.exec(String(req.headers["content-range"]));
    const s = sessions.get(req.url.slice(8));
    if (s && m && Number.isNaN(s.size)) s.size = Number(m[1]);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const mock: GraphMock = Object.assign(state, {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
  return mock;
}
