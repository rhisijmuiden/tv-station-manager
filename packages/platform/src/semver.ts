/** Minimal semver compare supporting pre-releases like 1.2.0-test.7. */
export function parseVersion(v: string) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-~]([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ? m[4].split(".") : [] };
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return a.localeCompare(b);
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1; // release > pre-release
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
