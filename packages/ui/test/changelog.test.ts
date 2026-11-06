import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { baseVersion, buildChangelog, releaseMarkdown } from "../src/changelog.ts";

const ROOT = join(import.meta.dirname, "../../../changelog");

function readAll() {
  const files: Record<string, unknown> = {};
  for (const v of readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()))
    for (const f of readdirSync(join(ROOT, v.name))) files[`changelog/${v.name}/${f}`] = JSON.parse(readFileSync(join(ROOT, v.name, f), "utf8"));
  return files;
}

test("every changelog file in the repo is valid (en + nl, known kinds and apps)", () => {
  const releases = buildChangelog(readAll());
  assert.ok(releases.length >= 3);
  assert.deepEqual(
    releases.map((r) => r.version),
    [...releases.map((r) => r.version)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
  );
});

test("the version in package.json has a changelog folder", () => {
  const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8"));
  const releases = buildChangelog(readAll());
  assert.ok(
    releases.some((r) => r.version === baseVersion(version)),
    `add changelog/${version}/ (release.json without date + a file per feature)`,
  );
});

test("only the newest version may be without a release date", () => {
  const [, ...older] = buildChangelog(readAll());
  for (const r of older) assert.ok(r.date, `changelog/${r.version}/release.json needs a "date"`);
});

test("buildChangelog rejects bad entries", () => {
  const ok = { apps: ["management"], changes: [{ kind: "added", en: "A", nl: "B" }] };
  assert.throws(() => buildChangelog({ "c/1.0.0/x.json": { ...ok, changes: [{ kind: "added", en: "A" }] } }), /"nl"/);
  assert.throws(() => buildChangelog({ "c/1.0.0/x.json": { ...ok, changes: [{ kind: "new", en: "A", nl: "B" }] } }), /kind/);
  assert.throws(() => buildChangelog({ "c/1.0.0/x.json": { ...ok, apps: ["radio"] } }), /apps/);
  assert.throws(() => buildChangelog({ "c/next/x.json": ok }), /version/);
  assert.throws(() => buildChangelog({ "c/1.0.0/release.json": { date: "4 nov" } }), /date/);
});

test("releases sort newest first and changes by PR; markdown groups by kind", () => {
  const r = buildChangelog({
    "c/1.2.0/release.json": { default: { summary: { en: "Sum", nl: "Sam" } } },
    "c/1.2.0/b.json": { apps: ["orchestrator"], pr: [9], changes: [{ kind: "fixed", en: "Fix b", nl: "Fix b nl" }] },
    "c/1.2.0/a.json": { apps: ["management"], pr: [4], changes: [{ kind: "added", en: "Add a", nl: "Nieuw a" }] },
    "c/1.10.0/z.json": { apps: ["platform"], changes: [{ kind: "removed", en: "Gone", nl: "Weg" }] },
  });
  assert.deepEqual(r.map((x) => x.version), ["1.10.0", "1.2.0"]);
  assert.deepEqual(r[1].changes.map((c) => c.feature), ["a", "b"]);
  assert.equal(releaseMarkdown(r[1]), "Sum\n\n### Added\n\n- Add a (#4)\n\n### Fixed\n\n- Fix b (#9)\n");
  assert.match(releaseMarkdown(r[1], "nl"), /### Toegevoegd\n\n- Nieuw a/);
  assert.equal(baseVersion("0.9.1-test.72"), "0.9.1");
});
