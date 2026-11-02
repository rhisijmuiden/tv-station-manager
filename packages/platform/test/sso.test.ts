/**
 * Microsoft Entra ID sign-in against a local mock OpenID provider (discovery, JWKS,
 * token endpoint with a signed id_token): login redirect, callback, account
 * creation and linking, app-role mapping, and the local-password fallback.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SECRET = "client-secret-value";

const root = mkdtempSync(join(tmpdir(), "tvsm-sso-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:local-admin-pass";

const { createPlatform } = await import("../src/index.ts");
type Platform = Awaited<ReturnType<typeof createPlatform>>;

// --- mock identity provider --------------------------------------------------
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
let idp: Server;
let issuer = "";
/** Claims for the next id_token; nonce is filled in from the authorize request. */
let next: Record<string, unknown> = {};
let nonce = "";

const readBody = (req: import("node:http").IncomingMessage) =>
  new Promise<URLSearchParams>((res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => res(new URLSearchParams(d)));
  });

async function startIdp() {
  idp = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === `/${TENANT}/v2.0/.well-known/openid-configuration`) {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth2/v2.0/authorize`,
        token_endpoint: `${issuer}/oauth2/v2.0/token`,
        jwks_uri: `${issuer}/discovery/v2.0/keys`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        subject_types_supported: ["pairwise"],
      });
    }
    if (url.pathname === `/${TENANT}/v2.0/discovery/v2.0/keys`) return json(200, { keys: [jwk] });
    if (url.pathname === `/${TENANT}/v2.0/oauth2/v2.0/token`) {
      const body = await readBody(req);
      if (body.get("client_id") !== CLIENT || body.get("client_secret") !== SECRET) return json(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
      if (body.get("grant_type") === "client_credentials") return json(200, { access_token: "app-token", token_type: "Bearer", expires_in: 3600 });
      if (body.get("code") !== "good-code" || !body.get("code_verifier")) return json(400, { error: "invalid_grant" });
      const idToken = await new SignJWT({ tid: TENANT, nonce, ...next })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience(CLIENT)
        .setSubject(String(next.oid ?? "sub"))
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return json(200, { access_token: "user-token", token_type: "Bearer", expires_in: 3600, id_token: idToken });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  const port = (idp.address() as { port: number }).port;
  process.env.TVSM_SSO_AUTHORITY = `http://127.0.0.1:${port}`;
  issuer = `http://127.0.0.1:${port}/${TENANT}/v2.0`;
}

// --- helpers --------------------------------------------------------------------
let p: Platform;
const inject = async (method: string, url: string, cookies: Record<string, string>, payload?: unknown) => {
  const res = await p.server.inject({
    method: method as "GET",
    url,
    payload: payload as object,
    headers: { host: "tv.example.com", "x-forwarded-proto": "https", cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  const set = res.headers["set-cookie"];
  for (const c of set ? (Array.isArray(set) ? set : [set]) : []) {
    const [kv] = String(c).split(";");
    const i = kv!.indexOf("=");
    const v = kv!.slice(i + 1);
    if (v) cookies[kv!.slice(0, i)] = v;
    else delete cookies[kv!.slice(0, i)];
  }
  return res;
};
const admin: Record<string, string> = {};

/** Runs login -> provider -> callback for a browser with the given claims; returns its cookies and final redirect. */
async function signIn(claims: Record<string, unknown>, opts: { tamperState?: boolean } = {}) {
  next = claims;
  const browser: Record<string, string> = {};
  const start = await inject("GET", "/api/auth/sso/login?returnTo=/nodes", browser);
  assert.equal(start.statusCode, 302);
  const auth = new URL(String(start.headers.location));
  assert.equal(auth.origin + auth.pathname, `${issuer}/oauth2/v2.0/authorize`);
  assert.equal(auth.searchParams.get("redirect_uri"), "https://tv.example.com/api/auth/sso/callback");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  nonce = auth.searchParams.get("nonce")!;
  const state = opts.tamperState ? "forged" : auth.searchParams.get("state")!;
  const cb = await inject("GET", `/api/auth/sso/callback?code=good-code&state=${encodeURIComponent(state)}`, browser);
  assert.equal(cb.statusCode, 302);
  return { browser, location: String(cb.headers.location) };
}
const status = async (c: Record<string, string>) => JSON.parse((await inject("GET", "/api/auth/status", c)).body);

const ssoSettings = (over: Record<string, unknown> = {}) => ({ enabled: true, tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, ...over });

test.before(async () => {
  await startIdp();
  p = await createPlatform({ app: { id: "ssotest", name: "SSO Test", defaultPort: 0 } });
  assert.equal((await inject("POST", "/api/auth/login", admin, { username: "admin", password: "local-admin-pass" })).statusCode, 200);
});
test.after(async () => {
  await p.server.close();
  idp.close();
  rmSync(root, { recursive: true, force: true });
});

test("sso: disabled by default, settings are admin-only and the secret is masked", async () => {
  assert.equal((await status({})).sso, null);
  const off = await inject("GET", "/api/auth/sso/login", {});
  assert.equal(off.headers.location, "/?sso_error=disabled");
  assert.equal((await inject("PUT", "/api/settings/sso", admin, ssoSettings({ tenantId: "common" }))).statusCode, 400);
  assert.equal((await inject("PUT", "/api/settings/sso", admin, { enabled: true, tenantId: TENANT })).statusCode, 400);
  const saved = await inject("PUT", "/api/settings/sso", admin, ssoSettings());
  assert.equal(saved.statusCode, 200);
  const body = JSON.parse(saved.body);
  assert.equal(body.clientSecret, "********");
  assert.equal(body.redirectUri, "https://tv.example.com/api/auth/sso/callback");
  const row = p.ctx.db.prepare("SELECT value FROM settings WHERE key = 'sso'").get() as { value: string };
  assert.ok(!row.value.includes(SECRET), "secret is encrypted at rest");
  // Saving the mask keeps the stored secret.
  assert.equal((await inject("PUT", "/api/settings/sso", admin, { ...body, buttonLabel: "Office 365" })).statusCode, 200);
  assert.deepEqual((await status({})).sso, { provider: "entra", label: "Office 365" });
});

test("sso: connection test checks the client secret", async () => {
  const ok = JSON.parse((await inject("POST", "/api/settings/sso/test", admin, {})).body);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.issuer, issuer);
  const bad = JSON.parse((await inject("POST", "/api/settings/sso/test", admin, { config: ssoSettings({ clientSecret: "wrong" }) })).body);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid client secret/);
});

test("sso: first sign-in creates an account with the default role, next sign-in reuses it", async () => {
  const claims = { oid: "oid-jan", preferred_username: "Jan@IJmond360.nl", name: "Jan Jansen" };
  const first = await signIn(claims);
  assert.equal(first.location, "/nodes");
  const s = await status(first.browser);
  assert.equal(s.user.username, "jan@ijmond360.nl");
  assert.equal(s.user.displayName, "Jan Jansen");
  assert.equal(s.user.role, "operator");
  assert.equal(s.user.authProvider, "entra");
  await signIn({ ...claims, name: "Jan J." });
  const n = p.ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'jan@ijmond360.nl'").get() as { n: number };
  assert.equal(n.n, 1);
  // A Microsoft account cannot sign in with a password, and cannot set one.
  assert.equal((await inject("POST", "/api/auth/login", {}, { username: "jan@ijmond360.nl", password: "!" })).statusCode, 401);
  assert.equal((await inject("PUT", "/api/auth/password", first.browser, { current: "x", next: "something-long" })).statusCode, 400);
});

test("sso: forged state is rejected", async () => {
  const r = await signIn({ oid: "oid-x", preferred_username: "x@ijmond360.nl" }, { tamperState: true });
  assert.equal(r.location, "/?sso_error=token_invalid");
  assert.equal((await status(r.browser)).user, null);
});

test("sso: pre-provisioned accounts, domain filter and app roles", async () => {
  const cfg = JSON.parse((await inject("GET", "/api/settings/sso", admin)).body);
  await inject("PUT", "/api/settings/sso", admin, { ...cfg, autoCreateUsers: false, allowedDomains: ["ijmond360.nl"] });
  assert.equal((await signIn({ oid: "oid-new", preferred_username: "new@ijmond360.nl" })).location, "/?sso_error=not_provisioned");
  assert.equal((await signIn({ oid: "oid-ext", preferred_username: "ext@other.com" })).location, "/?sso_error=domain_not_allowed");

  const created = await inject("POST", "/api/users", admin, { username: "Piet@IJmond360.nl", authProvider: "entra", role: "editor" });
  assert.equal(created.statusCode, 200, created.body);
  const piet = await signIn({ oid: "oid-piet", preferred_username: "piet@ijmond360.nl" });
  assert.equal((await status(piet.browser)).user.role, "editor");
  // A local account with the same name is never taken over.
  await inject("POST", "/api/users", admin, { username: "local@ijmond360.nl", password: "a-long-password", role: "admin" });
  assert.equal((await signIn({ oid: "oid-local", preferred_username: "local@ijmond360.nl" })).location, "/?sso_error=account_conflict");

  await inject("PUT", "/api/settings/sso", admin, { ...cfg, useAppRoles: true });
  const boss = await signIn({ oid: "oid-piet", preferred_username: "piet@ijmond360.nl", roles: ["TVSM.Operator", "TVSM.Admin"] });
  assert.equal((await status(boss.browser)).user.role, "admin");
  assert.equal((await signIn({ oid: "oid-piet", preferred_username: "piet@ijmond360.nl", roles: [] })).location, "/?sso_error=no_role");

  // The local administrator keeps working as a fallback.
  assert.equal((await inject("POST", "/api/auth/login", {}, { username: "admin", password: "local-admin-pass" })).statusCode, 200);
});
