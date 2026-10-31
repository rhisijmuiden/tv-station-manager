/**
 * Subtitles: SubRip (.srt) or WebVTT (.vtt) files next to a clip on the media share ("Show.mp4" + "Show.srt", or
 * "Show.nl.srt"). The management node parses them into cues; the CasparCG overlay on the studio node shows them in
 * sync with the clip.
 */

export const SUB_EXT = /\.(srt|vtt)$/i;

export interface Cue {
  /** Start and end in milliseconds from the start of the clip. */
  s: number;
  e: number;
  t: string;
}

const time = (v: string) => {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(v.trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]!.padEnd(3, "0"));
};

/** Parses SRT and WebVTT. Formatting tags are removed except line breaks; cues are sorted by start. */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i]!.split("-->");
    const s = time(a ?? "");
    const e = time((b ?? "").trim().split(/\s+/)[0] ?? "");
    if (s == null || e == null || e <= s) continue;
    const t = lines
      .slice(i + 1)
      .map((l) => l.replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "").trim())
      .filter(Boolean)
      .join("\n");
    if (t) cues.push({ s, e, t: t.slice(0, 500) });
  }
  return cues.sort((x, y) => x.s - y.s);
}

/**
 * Finds the subtitle file for each video: same name with .srt/.vtt, preferring "<name>.srt", then "<name>.nl.srt",
 * then "<name>.en.srt", then any "<name>.<lang>.srt". Paths compare case-insensitively (SMB shares do).
 */
export function matchSubtitles(videos: string[], subs: string[]): Map<string, string> {
  const byStem = new Map<string, string[]>();
  for (const sub of subs) {
    const stem = sub.replace(SUB_EXT, "").toLowerCase();
    const plain = stem.replace(/\.[a-z]{2,3}(-[a-z]{2})?$/, "");
    for (const k of new Set([stem, plain])) byStem.set(k, [...(byStem.get(k) ?? []), sub]);
  }
  const rank = (stem: string, sub: string) => {
    const rest = sub.replace(SUB_EXT, "").toLowerCase().slice(stem.length);
    const ext = /\.srt$/i.test(sub) ? 0 : 0.5;
    return (rest === "" ? 0 : rest === ".nl" ? 1 : rest === ".en" ? 2 : 3) + ext;
  };
  const out = new Map<string, string>();
  for (const v of videos) {
    const stem = v.replace(/\.[^./]+$/, "").toLowerCase();
    const found = byStem.get(stem);
    if (found?.length) out.set(v, [...found].sort((a, b) => rank(stem, a) - rank(stem, b))[0]!);
  }
  return out;
}
