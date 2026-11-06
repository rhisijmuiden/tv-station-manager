/** SMB and OneDrive backup targets: pure helpers, the OneDrive upload session, the table migration. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { migrate, MIGRATIONS } from "../src/db.ts";
import { chunkRanges, CHUNK, folderPath, friendlyAuthError, OneDriveTarget, pollDeviceCode, startDeviceCode } from "../src/backup/targets/onedrive.ts";
import { parseSmbLs, smbArgs, smbDirParts, smbFailure, smbQuote, SmbTarget } from "../src/backup/targets/smb.ts";
import { onedriveConfigSchema, smbConfigSchema } from "../src/backup/targets/types.ts";
import { startGraphMock, type GraphMock } from "./graph-mock.ts";

const dir = mkdtempSync(join(tmpdir(), "tvsm-targets-"));
let graph: GraphMock;
before(async () => {
  graph = await startGraphMock();
  process.env.TVSM_SSO_AUTHORITY = `${graph.base}/login`;
  process.env.TVSM_GRAPH_URL = `${graph.base}/graph/v1.0`;
});
after(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

test("smb: config, arguments and quoting", () => {
  const cfg = smbConfigSchema.parse({ host: "unas.local", share: "\\\\backup\\", username: "tvsm", password: "x", encrypt: true, port: 4455 });
  assert.equal(cfg.share, "backup");
  assert.equal(cfg.protocol, "SMB3");
  assert.equal(cfg.directory, "tvsm-backups");
  assert.deepEqual(smbArgs(cfg, "/tmp/a", "tvsm-backups"), ["//unas.local/backup", "-A", "/tmp/a", "-m", "SMB3", "-p", "4455", "--client-protection=encrypt", "-D", "tvsm-backups"]);
  assert.ok(smbArgs({ ...cfg, username: "" }, "/tmp/a").includes("-N"));
  assert.deepEqual(smbDirParts("/a//b\\c/"), ["a", "b", "c"]);
  assert.throws(() => smbDirParts("a/../b"));
  assert.equal(smbQuote("x/y.tar.gz"), '"x\\y.tar.gz"');
  assert.equal(smbQuote("/tmp/x/y", true), '"/tmp/x/y"');
  assert.throws(() => smbQuote('bad"name'));
  assert.throws(() => smbQuote("a; rm"));
});

test("smb: ls output and NT_STATUS errors", () => {
  const out = `  .                                   D        0  Fri Nov  6 17:50:28 2026
  ..                                  D        0  Fri Nov  6 17:50:28 2026
  sub                                 D        0  Fri Nov  6 17:50:28 2026
  app_host_full_1.tar.gz              A   123456  Fri Nov  6 17:55:53 2026
  app host incr.tar.gz.json           N      812  Fri Nov  6 17:55:54 2026

		264212084 blocks of size 1024. 30959100 blocks available`;
  assert.deepEqual(parseSmbLs(out), [
    { name: "app_host_full_1.tar.gz", size: 123456 },
    { name: "app host incr.tar.gz.json", size: 812 },
  ]);
  assert.equal(smbFailure("NT_STATUS_OBJECT_NAME_COLLISION making remote directory \\a", ["NT_STATUS_OBJECT_NAME_COLLISION"]), null);
  assert.match(smbFailure("putting file x\nNT_STATUS_ACCESS_DENIED opening remote file \\x")!, /ACCESS_DENIED/);
});

test("smb: a wrong password gives a clear error", { skip: !process.env.TVSM_IT_SMB_HOST }, async () => {
  const t = new SmbTarget(
    smbConfigSchema.parse({
      host: process.env.TVSM_IT_SMB_HOST,
      port: process.env.TVSM_IT_SMB_PORT ? Number(process.env.TVSM_IT_SMB_PORT) : undefined,
      share: process.env.TVSM_IT_SMB_SHARE,
      username: process.env.TVSM_IT_SMB_USER,
      password: "wrong",
    }),
  );
  await assert.rejects(t.test(), /wrong user name or password/);
});

test("smb: encrypted connection round trip", { skip: !process.env.TVSM_IT_SMB_HOST }, async () => {
  const t = new SmbTarget(
    smbConfigSchema.parse({
      host: process.env.TVSM_IT_SMB_HOST,
      port: process.env.TVSM_IT_SMB_PORT ? Number(process.env.TVSM_IT_SMB_PORT) : undefined,
      share: process.env.TVSM_IT_SMB_SHARE,
      username: process.env.TVSM_IT_SMB_USER,
      password: process.env.TVSM_IT_SMB_PASS,
      encrypt: true,
      directory: `it-smb-enc/${Date.now()}/deep`,
    }),
  );
  assert.match((await t.test()).details, /encrypted/);
  const src = join(dir, "enc.bin");
  writeFileSync(src, randomBytes(200_000));
  await t.upload(src, "enc.bin");
  assert.deepEqual(await t.list(), [{ name: "enc.bin", size: 200_000 }]);
  await t.download("enc.bin", join(dir, "enc.out"));
  assert.ok(readFileSync(join(dir, "enc.out")).equals(readFileSync(src)));
  await t.remove("enc.bin");
  await t.remove("enc.bin"); // already gone: no error
  assert.deepEqual(await t.list(), []);
});

test("onedrive: paths, chunks and error hints", () => {
  assert.equal(folderPath("/Back-ups/TV station/"), "Back-ups/TV%20station");
  assert.throws(() => folderPath("a/../b"));
  assert.equal(CHUNK % (320 * 1024), 0);
  assert.deepEqual(chunkRanges(10, 4), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 9 },
  ]);
  assert.deepEqual(chunkRanges(0), []);
  assert.match(friendlyAuthError("invalid_client", "AADSTS7000218: The request body must contain client_secret"), /Allow public client flows/);
  assert.match(friendlyAuthError("invalid_grant", "AADSTS70008: expired"), /connect OneDrive again/);
});

test("onedrive: large file goes through an upload session, tokens rotate and are saved", async () => {
  const start = await startDeviceCode("contoso", "app-1");
  assert.equal((await pollDeviceCode("contoso", "app-1", start.device_code)).status, "pending");
  const done = await pollDeviceCode("contoso", "app-1", start.device_code);
  assert.equal(done.status, "done");
  const saved: Record<string, unknown>[] = [];
  const cfg = onedriveConfigSchema.parse({ clientId: "app-1", tenant: "contoso", folder: "Big", account: "big@x", refreshToken: done.status === "done" ? done.refreshToken : "" });
  const t = new OneDriveTarget(cfg, { saveConfig: (p) => saved.push(p) });
  const src = join(dir, "big.bin");
  const size = CHUNK * 2 + 12345;
  writeFileSync(src, randomBytes(size));
  const before = graph.sessionChunks;
  await t.upload(src, "big.bin");
  assert.equal(graph.sessionChunks - before, 3);
  assert.equal(graph.files.get("Big/big.bin")!.length, size);
  assert.deepEqual(await t.list(), [{ name: "big.bin", size }]);
  await t.download("big.bin", join(dir, "big.out"));
  assert.ok(readFileSync(join(dir, "big.out")).equals(readFileSync(src)));
  // The refresh token was rotated once and handed to the store.
  assert.equal(saved.length, 1);
  assert.ok(graph.validRefresh.has(String(saved[0]!.refreshToken)));
  await t.remove("big.bin");
  assert.equal(graph.files.has("Big/big.bin"), false);
});

test("onedrive: not connected and revoked sign-ins", async () => {
  await assert.rejects(new OneDriveTarget(onedriveConfigSchema.parse({ clientId: "a" })).list(), /not connected/);
  await assert.rejects(new OneDriveTarget(onedriveConfigSchema.parse({ clientId: "a", account: "z", refreshToken: "revoked" })).list(), /connect OneDrive again/);
});

test("migration: backup_targets accepts new protocols and keeps run links", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, -1));
  db.prepare("INSERT INTO backup_targets (name, protocol, config) VALUES ('old', 'scp', '{}')").run();
  db.prepare("INSERT INTO backup_runs (id, target_id, kind, status, started_at) VALUES ('r1', 1, 'full', 'success', 'now')").run();
  assert.throws(() => db.prepare("INSERT INTO backup_targets (name, protocol, config) VALUES ('nas', 'smb', '{}')").run(), /CHECK/);
  migrate(db, MIGRATIONS);
  assert.equal((db.prepare("SELECT target_id FROM backup_runs WHERE id = 'r1'").get() as { target_id: number }).target_id, 1);
  db.prepare("INSERT INTO backup_targets (name, protocol, config) VALUES ('nas', 'smb', '{}')").run();
  const rows = db.prepare("SELECT id, protocol FROM backup_targets ORDER BY id").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: 1, protocol: "scp" },
    { id: 2, protocol: "smb" },
  ]);
  // The foreign key still points at the rebuilt table.
  db.prepare("DELETE FROM backup_targets WHERE id = 1").run();
  assert.equal((db.prepare("SELECT target_id FROM backup_runs WHERE id = 'r1'").get() as { target_id: number | null }).target_id, null);
});
