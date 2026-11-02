/**
 * "Coming up" slide (block item type `lineup`): a full-screen page that tells the viewer at what time the programmes of
 * the coming hour start. It is made from the schedule at the moment the slide goes on air; only programme files and
 * live items are listed (no commercials, jingles, bumpers, beeldkrant or webcams). The name of a programme is its title
 * in the library, which by default is the file name.
 *
 * The page is plain HTML without timers: CasparCG's HTML producer copies every changed frame, a static page costs
 * next to nothing.
 */
import { z } from "zod";
import type { TimelineEvent } from "./timeline.js";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const lineupSchema = z.object({
  /** Heading on the slide; empty = "Straks op <channel>" / "Coming up on <channel>". */
  heading: z.string().max(80).default(""),
  /** Language of the fixed texts and the date on screen. */
  language: z.enum(["nl", "en"]).default("nl"),
  /** How far ahead the slide looks, from the moment it goes on air. */
  minutesAhead: z.number().int().min(10).max(240).default(60),
  /** At most this many programmes on screen. */
  maxRows: z.number().int().min(2).max(10).default(7),
  colors: z
    .object({ background: hex.default("#2A1430"), panel: hex.default("#713C80"), accent: hex.default("#E92E7F"), text: hex.default("#FFFFFF") })
    .default({ background: "#2A1430", panel: "#713C80", accent: "#E92E7F", text: "#FFFFFF" }),
});
export type LineupSettings = z.infer<typeof lineupSchema>;

export interface LineupRow {
  start: number;
  title: string;
  live: boolean;
}

/** Library name of a file ("Sport_Weekoverzicht") as viewers should read it ("Sport Weekoverzicht"). */
export const displayTitle = (s: string) => s.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The programmes that start after `at` (the slide's own start) within `minutesAhead`: programme clips and live items.
 * Clips with the same name right after each other (a programme in parts) are one row.
 */
export function lineupRows(events: TimelineEvent[], at: number, s: Pick<LineupSettings, "minutesAhead" | "maxRows">): LineupRow[] {
  const until = at + s.minutesAhead * 60_000;
  const rows: LineupRow[] = [];
  for (const e of [...events].sort((a, b) => a.start - b.start)) {
    if (e.start <= at || e.start >= until || !e.leaf) continue;
    const isProgramme = e.type === "media" && e.leaf.blockKind === "program" && (e.leaf.category ?? "program") === "program";
    if (!isProgramme && e.type !== "live") continue;
    const title = displayTitle(e.title);
    if (!title) continue;
    if (rows.length && rows[rows.length - 1]!.title === title) continue;
    rows.push({ start: e.start, title, live: e.type === "live" });
    if (rows.length >= s.maxRows) break;
  }
  return rows;
}

const TEXT = {
  nl: { heading: "Straks op {channel}", sub: "Het programma van het komende uur", empty: "Het komende uur staat er verder niets op het programma.", live: "Live", locale: "nl-NL" },
  en: { heading: "Coming up on {channel}", sub: "The programmes of the coming hour", empty: "Nothing else is scheduled for the coming hour.", live: "Live", locale: "en-GB" },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface LineupPage {
  channel: string;
  settings: LineupSettings;
  rows: LineupRow[];
  at: number;
  timeZone: string;
  logoUrl: string | null;
  /** Editor preview: scale the 1920x1080 page to the iframe. */
  preview?: boolean;
}

/** The finished HTML page (1920x1080). */
export function lineupHtml(p: LineupPage) {
  const s = p.settings;
  const tx = TEXT[s.language];
  const time = new Intl.DateTimeFormat(tx.locale, { timeZone: p.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const dateText = new Intl.DateTimeFormat(tx.locale, { timeZone: p.timeZone, weekday: "long", day: "numeric", month: "long" }).format(p.at);
  const heading = s.heading.trim() || tx.heading.replace("{channel}", p.channel);
  const n = p.rows.length;
  // Fewer rows get more room: the list always fills the screen calmly.
  const size = n <= 3 ? 64 : n <= 5 ? 56 : n <= 7 ? 48 : 40;
  const rows = p.rows
    .map(
      (r, i) =>
        `<li style="animation-delay:${200 + i * 90}ms"><span class="t">${esc(time.format(r.start))}</span><span class="n">${esc(r.title)}</span>${r.live ? `<span class="chip">${esc(tx.live)}</span>` : ""}</li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="${s.language}">
<head>
<meta charset="utf-8" />
<title>${esc(heading)}</title>
<style>
  :root { --bg: ${s.colors.background}; --panel: ${s.colors.panel}; --accent: ${s.colors.accent}; --text: ${s.colors.text}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: var(--bg); color: var(--text);
    font-family: "Inter", "Segoe UI Variable Text", "Segoe UI", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  body.preview { transform-origin: 0 0; }
  #bg { position: absolute; inset: 0; background:
      radial-gradient(1200px 700px at 88% -10%, color-mix(in srgb, var(--accent) 34%, transparent), transparent 70%),
      radial-gradient(1100px 800px at -10% 110%, color-mix(in srgb, var(--panel) 70%, transparent), transparent 70%),
      var(--bg); }
  header { position: absolute; left: 120px; right: 120px; top: 80px; display: flex; align-items: center; gap: 32px; }
  header img { max-height: 92px; max-width: 320px; display: block; }
  header .bar { width: 10px; height: 92px; border-radius: 5px; background: var(--accent); flex-shrink: 0; }
  header h1 { margin: 0; font-family: "Epilogue", "Segoe UI Variable Display", "Segoe UI", Arial, sans-serif; font-size: 72px; font-weight: 800; letter-spacing: -.01em; line-height: 1.02; }
  header .sub { font-size: 30px; opacity: .78; margin-top: 8px; font-weight: 500; }
  header .date { margin-left: auto; text-align: right; font-size: 30px; opacity: .78; font-weight: 500; white-space: nowrap; }
  ol { position: absolute; left: 120px; right: 120px; top: 270px; bottom: 90px; margin: 0; padding: 0; list-style: none;
    display: flex; flex-direction: column; justify-content: center; gap: ${Math.round(size * 0.42)}px; }
  li { display: flex; align-items: center; gap: 48px; font-size: ${size}px; line-height: 1.15; padding: ${Math.round(size * 0.3)}px ${Math.round(size * 0.6)}px;
    border-radius: 20px; background: color-mix(in srgb, var(--panel) 46%, transparent); opacity: 0; animation: in 500ms cubic-bezier(.2,.8,.2,1) forwards; }
  li .t { flex: 0 0 auto; min-width: ${Math.round(size * 3.1)}px; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--accent); }
  li .n { flex: 1; min-width: 0; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  li .chip { flex-shrink: 0; background: var(--accent); color: #fff; font-size: ${Math.round(size * 0.48)}px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; padding: 8px 18px; border-radius: 8px; }
  .empty { position: absolute; inset: 270px 200px 90px; display: grid; place-items: center; text-align: center; font-size: 52px; font-weight: 600; opacity: .85; }
  @keyframes in { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
</style>
</head>
<body${p.preview ? ' class="preview"' : ""}>
<div id="bg"></div>
<header>${p.logoUrl ? `<img src="${esc(p.logoUrl)}" alt="" onerror="this.remove()" />` : ""}<span class="bar"></span>
  <div><h1>${esc(heading)}</h1><div class="sub">${esc(tx.sub)}</div></div>
  <div class="date">${esc(dateText.charAt(0).toUpperCase() + dateText.slice(1))}</div></header>
${n ? `<ol>${rows}</ol>` : `<div class="empty">${esc(tx.empty)}</div>`}
${p.preview ? `<script>(function(){function f(){var k=Math.min(innerWidth/1920,innerHeight/1080);document.body.style.transform="scale("+k+")";}addEventListener("resize",f);f();})();</script>` : ""}
</body>
</html>
`;
}
