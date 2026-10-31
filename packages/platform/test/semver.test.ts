import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions } from "../src/semver.ts";
import { diffManifest } from "../src/backup/manifest.ts";

test("compareVersions orders releases and test pre-releases", () => {
  assert.ok(compareVersions("1.2.0", "1.1.9") > 0);
  assert.ok(compareVersions("1.2.0-test.3", "1.2.0") < 0);
  assert.ok(compareVersions("1.2.0-test.10", "1.2.0-test.9") > 0);
  assert.ok(compareVersions("v1.3.0-test.1", "1.2.0") > 0);
  assert.equal(compareVersions("1.0.0", "v1.0.0"), 0);
});

test("diffManifest finds changed and deleted files", () => {
  const e = (path: string, sha256: string) => ({ path, size: 1, mtimeMs: 1, sha256 });
  const prev = { a: e("a", "1"), b: e("b", "2"), c: e("c", "3") };
  const next = { a: e("a", "1"), b: e("b", "x"), d: e("d", "4") };
  const { changed, deleted } = diffManifest(prev, next);
  assert.deepEqual(changed.map((x) => x.path).sort(), ["b", "d"]);
  assert.deepEqual(deleted, ["c"]);
});
