/**
 * End-to-end test of the platform API: setup/login, mail settings masking, and
 * full + incremental backup and restore against real FTP, FTPS and SCP servers.
 * The backup part needs TVSM_IT_FTP_* / TVSM_IT_SCP_* env vars (see packages/platform/test/README.md).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPendingRestore, createPlatform, type Platform } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "tvsm-test-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
const media = join(root, "media");
// These tests exercise the first-run setup flow; the default admin has its own test below.
process.env.TVSM_DEFAULT_ADMIN = "off";
mkdirSync(media, { recursive: true });

let p: Platform;
let cookie = "";
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

test.before(async () => {
  p = await createPlatform({ app: { id: "testapp", name: "Test App", defaultPort: 0 }, backupSources: () => ({ media }) });
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("auth: setup, protected routes, login", async () => {
  assert.equal((await api("GET", "/api/system/info")).status, 401);
  assert.equal((await api("GET", "/api/auth/status")).body.setupRequired, true);
  assert.equal((await api("POST", "/api/auth/setup", { username: "admin", password: "correct horse battery" })).status, 200);
  assert.equal((await api("POST", "/api/auth/setup", { username: "x", password: "another password" })).status, 409);
  const info = await api("GET", "/api/system/info");
  assert.equal(info.status, 200);
  assert.equal(info.body.app.id, "testapp");
  await api("POST", "/api/auth/logout");
  cookie = "";
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "wrong password!!" })).status, 401);
  assert.equal((await api("POST", "/api/auth/login", { username: "ADMIN", password: "correct horse battery" })).status, 200);
});

test("mail: secrets are encrypted at rest and masked in the API", async () => {
  const saved = await api("PUT", "/api/settings/mail", {
    enabled: true,
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    auth: { method: "password", username: "u@example.com", password: "s3cret-pass" },
    fromAddress: "tv@example.com",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.auth.password, "********");
  const raw = p.ctx.db.prepare("SELECT value FROM settings WHERE key = 'mail'").get() as { value: string };
  assert.ok(!raw.value.includes("s3cret-pass"));
  // Saving the mask again keeps the stored secret.
  await api("PUT", "/api/settings/mail", { ...saved.body, host: "smtp2.example.com" });
  assert.equal(p.mail.getConfig().auth.password, "s3cret-pass");
});

test("default admin is created on first start and flagged until the password changes", async () => {
  const dRoot = mkdtempSync(join(tmpdir(), "tvsm-default-"));
  const saved = { data: process.env.TVSM_DATA_DIR, conf: process.env.TVSM_CONF_DIR };
  process.env.TVSM_DATA_DIR = join(dRoot, "data");
  process.env.TVSM_CONF_DIR = join(dRoot, "conf");
  delete process.env.TVSM_DEFAULT_ADMIN;
  const d = await createPlatform({ app: { id: "testapp", name: "Test App", defaultPort: 0 } });
  let c = "";
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await d.server.inject({ method: method as "GET", url, payload: payload as object, headers: c ? { cookie: c } : {} });
    const set = res.headers["set-cookie"];
    if (set) c = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  try {
    assert.equal((await call("GET", "/api/auth/status")).body.setupRequired, false);
    assert.equal((await call("POST", "/api/auth/login", { username: "admin", password: "admin" })).status, 200);
    assert.equal((await call("GET", "/api/auth/status")).body.defaultPasswordInUse, true);
    // Behind a reverse proxy the session cookie is marked Secure based on X-Forwarded-Proto.
    const proxied = await d.server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" }, headers: { "x-forwarded-proto": "https" } });
    assert.match(String(proxied.headers["set-cookie"]), /Secure/);
    assert.equal((await call("PUT", "/api/auth/password", { current: "admin", next: "a much better password" })).status, 200);
    assert.equal((await call("GET", "/api/auth/status")).body.defaultPasswordInUse, false);
  } finally {
    await d.server.close();
    process.env.TVSM_DEFAULT_ADMIN = "off";
    process.env.TVSM_DATA_DIR = saved.data;
    process.env.TVSM_CONF_DIR = saved.conf;
    rmSync(dRoot, { recursive: true, force: true });
  }
});

const targets: { name: string; protocol: "ftp" | "ftps" | "scp"; config: Record<string, unknown> }[] = [];
if (process.env.TVSM_IT_FTP_HOST) {
  const base = {
    host: process.env.TVSM_IT_FTP_HOST,
    port: Number(process.env.TVSM_IT_FTP_PORT ?? 21),
    username: process.env.TVSM_IT_FTP_USER,
    password: process.env.TVSM_IT_FTP_PASS,
    verifyCertificate: false,
  };
  targets.push({ name: "ftp", protocol: "ftp", config: { ...base, directory: "it-ftp" } });
  targets.push({ name: "ftps", protocol: "ftps", config: { ...base, directory: "it-ftps", tlsMode: "explicit" } });
}
if (process.env.TVSM_IT_SCP_HOST) {
  targets.push({
    name: "scp",
    protocol: "scp",
    config: {
      host: process.env.TVSM_IT_SCP_HOST,
      port: Number(process.env.TVSM_IT_SCP_PORT ?? 22),
      username: process.env.TVSM_IT_SCP_USER,
      authMethod: "key",
      privateKey: readFileSync(process.env.TVSM_IT_SCP_KEY!, "utf8"),
      directory: "it-scp/backups",
    },
  });
}

for (const t of targets) {
  test(`backup: full + incremental + restore over ${t.name}`, async () => {
    // Fresh instance per target: restore swaps the database file on disk.
    await p.server.close();
    const tRoot = mkdtempSync(join(tmpdir(), `tvsm-${t.name}-`));
    process.env.TVSM_DATA_DIR = join(tRoot, "data");
    process.env.TVSM_CONF_DIR = join(tRoot, "conf");
    rmSync(media, { recursive: true, force: true });
    mkdirSync(media, { recursive: true });
    p = await createPlatform({ app: { id: "testapp", name: "Test App", defaultPort: 0 }, backupSources: () => ({ media }) });
    cookie = "";
    await api("POST", "/api/auth/setup", { username: "admin", password: "correct horse battery" });
    // Unique remote directory per run.
    t.config.directory = `${t.config.directory}-${Date.now()}`;
    writeFileSync(join(media, "keep.txt"), "unchanged");
    writeFileSync(join(media, "change.txt"), "version 1");
    writeFileSync(join(media, "delete.txt"), "will be deleted");
    p.ctx.settings.set("marker", "before-full");

    const tested = await api("POST", "/api/backup/targets/test", { name: t.name, protocol: t.protocol, config: t.config });
    assert.equal(tested.body.ok, true, tested.body.error);
    const config = t.protocol === "scp" ? { ...t.config, hostKeySha256: tested.body.hostKeySha256 } : t.config;
    const created = await api("POST", "/api/backup/targets", { name: t.name, protocol: t.protocol, enabled: true, config });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.config.privateKey ?? created.body.config.password, "********");
    const targetId = created.body.id as number;

    const full = await p.backup.run(targetId, "full");
    assert.equal(full.kind, "full");

    writeFileSync(join(media, "change.txt"), "version 2");
    writeFileSync(join(media, "new.txt"), "brand new");
    rmSync(join(media, "delete.txt"));
    p.ctx.settings.set("marker", "after-incremental");
    const incr = await p.backup.run(targetId, "incremental");
    assert.equal(incr.kind, "incremental");
    const runs = p.backup.listRuns() as { id: string; fileCount: number }[];
    const incrRun = runs.find((r) => r.id === incr.id)!;
    // db + change.txt + new.txt (keep.txt and conf are unchanged).
    assert.equal(incrRun.fileCount, 3);

    const remote = await p.backup.listRemote(targetId);
    assert.deepEqual(remote.map((r) => r.kind), ["incremental", "full"]);

    // Wreck local state, then restore the incremental.
    writeFileSync(join(media, "change.txt"), "corrupted");
    writeFileSync(join(media, "junk.txt"), "junk");
    await p.backup.prepareRestore(targetId, incr.id);
    assert.ok(applyPendingRestore(p.ctx.config.dataDir, p.ctx.config.confDir, () => undefined));
    assert.equal(readFileSync(join(media, "keep.txt"), "utf8"), "unchanged");
    assert.equal(readFileSync(join(media, "change.txt"), "utf8"), "version 2");
    assert.equal(readFileSync(join(media, "new.txt"), "utf8"), "brand new");
    assert.equal(existsSync(join(media, "delete.txt")), false);
    assert.equal(existsSync(join(media, "junk.txt")), false);
    // Database file on disk was replaced with the snapshot from the incremental backup.
    const { DatabaseSync } = await import("node:sqlite");
    const restored = new DatabaseSync(join(p.ctx.config.dataDir, "app.db"));
    assert.equal((restored.prepare("SELECT value FROM settings WHERE key = 'marker'").get() as { value: string }).value, '"after-incremental"');
    restored.close();
  });
}
