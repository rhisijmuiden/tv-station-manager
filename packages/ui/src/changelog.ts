/**
 * Changelog shown on the "What's new" page (Info window) and used for the
 * GitHub release notes. Pure: no Vite or React here, so tests and
 * scripts/changelog-notes.ts can use it too.
 *
 * Data lives in `changelog/<version>/` at the repo root (see CONTRIBUTING.md):
 *   release.json      { "date"?: "YYYY-MM-DD", "summary"?: { "en", "nl" } }  (no date = not released yet)
 *   <feature>.json    { "apps": [...], "pr"?: [number], "changes": [{ "kind", "en", "nl" }] }
 * One file per feature keeps parallel branches free of merge conflicts.
 */

export const CHANGE_KINDS = ["added", "changed", "improved", "fixed", "removed"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const CHANGE_APPS = ["management", "orchestrator", "studio", "platform"] as const;
export type ChangeApp = (typeof CHANGE_APPS)[number];

export interface Localized {
  en: string;
  nl: string;
}
export interface Change extends Localized {
  kind: ChangeKind;
  apps: ChangeApp[];
  pr: number[];
  /** Feature file name without .json. */
  feature: string;
}
export interface Release {
  version: string;
  /** ISO date; undefined while the version is still in test. */
  date?: string;
  summary?: Localized;
  changes: Change[];
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function localized(v: unknown, where: string): Localized {
  const o = v as Partial<Localized> | null;
  if (!o || typeof o.en !== "string" || typeof o.nl !== "string" || !o.en.trim() || !o.nl.trim())
    throw new Error(`${where}: needs non-empty "en" and "nl" texts`);
  return { en: o.en.trim(), nl: o.nl.trim() };
}

/** "x/y/changelog/0.9.1/ticker.json" -> ["0.9.1", "ticker"] */
function splitPath(path: string): [string, string] {
  const parts = path.replace(/\\/g, "/").split("/");
  const file = parts.pop() ?? "";
  const version = parts.pop() ?? "";
  if (!file.endsWith(".json")) throw new Error(`${path}: changelog files must be .json`);
  return [version, file.slice(0, -5)];
}

function compareSemver(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Turns the raw files (path -> parsed JSON) into releases, newest first.
 * Throws on anything malformed so a broken entry fails the tests, not the page.
 */
export function buildChangelog(files: Record<string, unknown>): Release[] {
  const releases = new Map<string, Release>();
  const get = (version: string, path: string) => {
    if (!SEMVER.test(version)) throw new Error(`${path}: folder must be a version like 1.2.3`);
    let r = releases.get(version);
    if (!r) releases.set(version, (r = { version, changes: [] }));
    return r;
  };
  for (const [path, raw] of Object.entries(files)) {
    const [version, name] = splitPath(path);
    const release = get(version, path);
    const data = (raw && typeof raw === "object" && "default" in raw ? (raw as { default: unknown }).default : raw) as Record<string, unknown>;
    if (!data || typeof data !== "object") throw new Error(`${path}: not a JSON object`);
    if (name === "release") {
      if (data.date !== undefined) {
        if (typeof data.date !== "string" || !DATE.test(data.date)) throw new Error(`${path}: date must be YYYY-MM-DD`);
        release.date = data.date;
      }
      if (data.summary !== undefined) release.summary = localized(data.summary, `${path} summary`);
      continue;
    }
    const apps = data.apps;
    if (!Array.isArray(apps) || !apps.length || apps.some((a) => !CHANGE_APPS.includes(a as ChangeApp)))
      throw new Error(`${path}: "apps" must list one or more of ${CHANGE_APPS.join(", ")}`);
    const pr = data.pr ?? [];
    if (!Array.isArray(pr) || pr.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error(`${path}: "pr" must be a list of PR numbers`);
    const changes = data.changes;
    if (!Array.isArray(changes) || !changes.length) throw new Error(`${path}: "changes" must have at least one entry`);
    changes.forEach((c: { kind?: unknown }, i) => {
      if (!CHANGE_KINDS.includes(c?.kind as ChangeKind)) throw new Error(`${path} change ${i + 1}: kind must be one of ${CHANGE_KINDS.join(", ")}`);
      release.changes.push({ ...localized(c, `${path} change ${i + 1}`), kind: c.kind as ChangeKind, apps: apps as ChangeApp[], pr: pr as number[], feature: name });
    });
  }
  const first = (c: Change) => c.pr[0] ?? Number.MAX_SAFE_INTEGER;
  for (const r of releases.values()) r.changes.sort((a, b) => first(a) - first(b) || a.feature.localeCompare(b.feature));
  return [...releases.values()].filter((r) => r.changes.length || r.summary).sort((a, b) => compareSemver(b.version, a.version));
}

/** "0.9.1-test.72" -> "0.9.1" */
export function baseVersion(version: string) {
  return version.replace(/^v/, "").split(/[-+]/)[0];
}

export function changesByKind(changes: Change[]) {
  return CHANGE_KINDS.map((kind) => ({ kind, changes: changes.filter((c) => c.kind === kind) })).filter((g) => g.changes.length);
}

const HEADINGS: Record<"en" | "nl", Record<ChangeKind, string>> = {
  en: { added: "Added", changed: "Changed", improved: "Improved", fixed: "Fixed", removed: "Removed" },
  nl: { added: "Toegevoegd", changed: "Gewijzigd", improved: "Verbeterd", fixed: "Opgelost", removed: "Verwijderd" },
};

/** Markdown for one release, used as GitHub release notes. */
export function releaseMarkdown(release: Release, lang: "en" | "nl" = "en") {
  const out: string[] = [];
  if (release.summary) out.push(release.summary[lang], "");
  for (const g of changesByKind(release.changes)) {
    out.push(`### ${HEADINGS[lang][g.kind]}`, "");
    for (const c of g.changes) out.push(`- ${c[lang]}${c.pr.length ? ` (${c.pr.map((n) => `#${n}`).join(", ")})` : ""}`);
    out.push("");
  }
  return out.join("\n").trim() + "\n";
}
