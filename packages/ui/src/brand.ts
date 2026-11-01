/** Reads a colour token of the active house style (e.g. "primary", "warning") as a hex string. */
export function brandColor(token: string, fallback = "#3B6CFF"): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--tvsm-${token}`).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}
