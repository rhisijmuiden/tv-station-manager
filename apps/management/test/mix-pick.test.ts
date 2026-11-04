import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions } from "../server/app.ts";
import { autoMedia, newPickMemory } from "../server/content.ts";

const root = mkdtempSync(join(tmpdir(), "tvsm-mix-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
test.before(async () => {
  p = await createPlatform(managementOptions({ autostart: false }));
});
test.after(async () => {
  await p.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("mix rule over all week folders: newest overall first, random rest kept for the hour, rebuilt next hour", () => {
  const db = p.ctx.db;
  const src = Number(db.prepare("INSERT INTO media_sources (name, type, config) VALUES ('UNAS', 'local', '{}')").run().lastInsertRowid);
  const hour = Date.now() + 3600_000 - (Date.now() % 3600_000);
  const add = (folder: string, name: string, agoH: number) =>
    Number(
      db
        .prepare("INSERT INTO media (source_id, path, name, folder, mtime, duration_ms, probe_status) VALUES (?, ?, ?, ?, ?, 300000, 'ok')")
        .run(src, `${folder}/${name}.mp4`, name, folder, new Date(hour - agoH * 3600_000).toISOString()).lastInsertRowid,
    );
  for (let w = 40; w <= 45; w++) for (let i = 0; i < 3; i++) add(`PROGRAMMA/2026 Reportages/wk ${w}`, `wk${w}-${i}`, (46 - w) * 168 + i);
  const newest = add("PROGRAMMA/2026 Reportages/wk 45", "vers", 0.5);
  const rule = JSON.stringify({ source: "folder", folder: "PROGRAMMA", subfolders: "all", pick: "mix", count: 4, newestCount: 1 });
  const slot = { key: "occ:15", path: "b1/0" };
  const a = autoMedia(db, rule, hour, slot, newPickMemory());
  assert.equal(a.length, 4);
  assert.equal(a[0]!.id, newest);
  // Clips from older week folders are in the random part too.
  assert.equal(new Set(a.map((m) => m.id)).size, 4);
  // Same broadcast again: same picks.
  assert.deepEqual(autoMedia(db, rule, hour, slot, newPickMemory()).map((m) => m.id), a.map((m) => m.id));
  // A new clip comes in before the hour: it opens the hour, the random part stays.
  const newer = add("PROGRAMMA/2026 Reportages/wk 45", "nog-verser", 0.1);
  const b = autoMedia(db, rule, hour, slot, newPickMemory());
  assert.equal(b[0]!.id, newer);
  assert.deepEqual(b.slice(1).map((m) => m.id), a.slice(1).map((m) => m.id));
  // Next hour: its own random part.
  const c = autoMedia(db, rule, hour + 3600_000, { key: "occ:16", path: "b1/0" }, newPickMemory());
  assert.equal(c[0]!.id, newer);
  assert.notDeepEqual(c.slice(1).map((m) => m.id), b.slice(1).map((m) => m.id));
});
