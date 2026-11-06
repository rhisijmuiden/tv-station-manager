// Prints the changelog of one version as Markdown (GitHub release notes).
// Usage: node scripts/changelog-notes.mts <version> [en|nl]   (0.9.1-test.72 -> 0.9.1)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseVersion, buildChangelog, releaseMarkdown } from "../packages/ui/src/changelog.ts";

const [version = "", lang = "en"] = process.argv.slice(2);
const root = join(import.meta.dirname, "../changelog");
const files: Record<string, unknown> = {};
for (const v of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()))
  for (const f of readdirSync(join(root, v.name))) files[`changelog/${v.name}/${f}`] = JSON.parse(readFileSync(join(root, v.name, f), "utf8"));
const release = buildChangelog(files).find((r) => r.version === baseVersion(version));
if (release) process.stdout.write(releaseMarkdown(release, lang === "nl" ? "nl" : "en"));
