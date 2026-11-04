/**
 * Info pages (block item type `info`): fixed full-screen pages that editors make themselves, such as contact details,
 * "about the station" or "how to reach us". A page has a title, text, an optional picture and a layout; its default
 * length is set on the page and used wherever it is placed in a block.
 *
 * Pure: settings, text formatting and the finished HTML page (1920x1080) that CasparCG's HTML producer plays. The page
 * has no timers, so it costs next to nothing to play. Colours come from the channel's "coming up" slide settings (the
 * station's house style), so all full-screen pages of a channel look alike.
 */
import { z } from "zod";

export const INFO_LAYOUTS = ["text", "imageRight", "imageLeft", "imageBackground", "imageOnly"] as const;
export type InfoLayout = (typeof INFO_LAYOUTS)[number];

export const infoPageSchema = z.object({
  /** Large heading on screen. */
  title: z.string().max(120).default(""),
  /** Smaller line under the heading. */
  subtitle: z.string().max(160).default(""),
  /** The text: an empty line starts a new paragraph, lines starting with "- " are a list, **word** is bold. */
  body: z.string().max(3000).default(""),
  /** Line at the bottom, e.g. website and phone number. */
  footer: z.string().max(160).default(""),
  layout: z.enum(INFO_LAYOUTS).default("text"),
  /** Default length when the page is placed in a block (a block item may still set its own). */
  durationSec: z.number().int().min(3).max(3600).default(20),
  /** Keep the channel overlay (logo, clock, ticker) on top of the page. */
  showOverlay: z.boolean().default(false),
  /** The channel logo in the page's header. */
  showLogo: z.boolean().default(true),
});
export type InfoPageSettings = z.infer<typeof infoPageSchema>;

export const DEFAULT_INFO_MS = 20_000;
export const needsImage = (layout: InfoLayout) => layout !== "text";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Escaped text with **bold** parts. */
export const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

export type TextBlock = { kind: "p"; lines: string[] } | { kind: "ul"; items: string[] };

/** Splits the editor's text into paragraphs and lists. */
export function textBlocks(body: string): TextBlock[] {
  const out: TextBlock[] = [];
  let cur: TextBlock | null = null;
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const bullet = /^[-•*]\s+(.*)$/.exec(line);
    if (!line) {
      cur = null;
    } else if (bullet) {
      if (cur?.kind !== "ul") out.push((cur = { kind: "ul", items: [] }));
      cur.items.push(bullet[1]!);
    } else {
      if (cur?.kind !== "p") out.push((cur = { kind: "p", lines: [] }));
      cur.lines.push(line);
    }
  }
  return out;
}

/** Text size in px: less text gets bigger letters, so a page always reads calmly. */
export function bodySize(body: string, narrow: boolean) {
  const lines = textBlocks(body).reduce((n, b) => n + (b.kind === "p" ? b.lines.length : b.items.length) + 0.6, 0);
  const chars = body.replace(/\s+/g, " ").trim().length * (narrow ? 1.7 : 1);
  const score = Math.max(lines * 60, chars);
  return score <= 180 ? 52 : score <= 360 ? 44 : score <= 650 ? 38 : score <= 1000 ? 32 : 27;
}

export interface InfoColors {
  background: string;
  panel: string;
  accent: string;
  text: string;
}

export interface InfoPageView {
  settings: InfoPageSettings;
  colors: InfoColors;
  imageUrl: string | null;
  logoUrl: string | null;
  language: "nl" | "en";
  /** Editor preview: scale the 1920x1080 page to the iframe. */
  preview?: boolean;
}

/** The finished HTML page (1920x1080). */
export function infoPageHtml(p: InfoPageView) {
  const s = p.settings;
  const c = p.colors;
  // A layout with a picture but none uploaded yet falls back to text only.
  const layout: InfoLayout = needsImage(s.layout) && !p.imageUrl ? "text" : s.layout;
  const side = layout === "imageLeft" || layout === "imageRight";
  const size = bodySize(s.body, side);
  const blocks = textBlocks(s.body)
    .map((b) => (b.kind === "p" ? `<p>${b.lines.map(inline).join("<br />")}</p>` : `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`))
    .join("");
  const logo = s.showLogo && p.logoUrl ? `<img class="logo" src="${esc(p.logoUrl)}" alt="" onerror="this.remove()" />` : "";
  const header = s.title || s.subtitle || logo ? `<header>${logo}<span class="bar"></span><div>${s.title ? `<h1>${inline(s.title)}</h1>` : ""}${s.subtitle ? `<div class="sub">${inline(s.subtitle)}</div>` : ""}</div></header>` : "";
  const footer = s.footer ? `<footer><span class="dot"></span>${inline(s.footer)}</footer>` : "";
  const img = p.imageUrl ? esc(p.imageUrl) : "";
  let main: string;
  if (layout === "imageOnly") main = `<img class="only" src="${img}" alt="" />`;
  else if (layout === "imageBackground") main = `<img class="cover" src="${img}" alt="" /><div class="shade"></div><div class="over">${header}${blocks ? `<div class="text">${blocks}</div>` : ""}</div>${footer}`;
  else if (side) main = `${header}<div class="split ${layout === "imageLeft" ? "left" : ""}"><div class="text">${blocks}</div><div class="pic"><img src="${img}" alt="" /></div></div>${footer}`;
  else main = `${header}<div class="text full">${blocks}</div>${footer}`;
  return `<!doctype html>
<html lang="${p.language}">
<head>
<meta charset="utf-8" />
<title>${esc(s.title || "Info")}</title>
<style>
  :root { --bg: ${c.background}; --panel: ${c.panel}; --accent: ${c.accent}; --text: ${c.text}; --size: ${size}px; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: var(--bg); color: var(--text);
    font-family: "Inter", "Segoe UI Variable Text", "Segoe UI", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  body.preview { transform-origin: 0 0; }
  #bg { position: absolute; inset: 0; background:
      radial-gradient(1200px 700px at 88% -10%, color-mix(in srgb, var(--accent) 34%, transparent), transparent 70%),
      radial-gradient(1100px 800px at -10% 110%, color-mix(in srgb, var(--panel) 70%, transparent), transparent 70%),
      var(--bg); }
  header { position: absolute; left: 120px; right: 120px; top: 80px; display: flex; align-items: center; gap: 32px; z-index: 2; }
  header .logo { max-height: 92px; max-width: 320px; display: block; }
  header .bar { width: 10px; align-self: stretch; min-height: 92px; border-radius: 5px; background: var(--accent); flex-shrink: 0; }
  header h1 { margin: 0; font-family: "Epilogue", "Segoe UI Variable Display", "Segoe UI", Arial, sans-serif; font-size: 72px; font-weight: 800; letter-spacing: -.01em; line-height: 1.04; }
  header .sub { font-size: 32px; opacity: .8; margin-top: 8px; font-weight: 500; }
  .text { font-size: var(--size); line-height: 1.38; font-weight: 500; animation: in 600ms cubic-bezier(.2,.8,.2,1) both 150ms; }
  .text p { margin: 0 0 .7em; }
  .text ul { margin: 0 0 .7em; padding: 0; list-style: none; }
  .text li { position: relative; padding-left: 1.15em; margin: 0 0 .32em; }
  .text li::before { content: ""; position: absolute; left: 0; top: .5em; width: .42em; height: .42em; border-radius: 50%; background: var(--accent); }
  .text b { font-weight: 800; color: color-mix(in srgb, var(--accent) 35%, var(--text)); }
  .text > :last-child { margin-bottom: 0; }
  .text.full { position: absolute; left: 120px; right: 120px; top: 270px; bottom: 150px; display: flex; flex-direction: column; justify-content: center;
    padding: 56px 72px; border-radius: 28px; background: color-mix(in srgb, var(--panel) 42%, transparent); }
  .split { position: absolute; left: 120px; right: 120px; top: 270px; bottom: 150px; display: flex; gap: 72px; align-items: stretch; }
  .split.left { flex-direction: row-reverse; }
  .split .text { flex: 1 1 52%; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
  .split .pic { flex: 1 1 48%; min-width: 0; border-radius: 28px; overflow: hidden; box-shadow: 0 24px 60px rgb(0 0 0 / .35); animation: in 700ms cubic-bezier(.2,.8,.2,1) both; }
  .split .pic img { width: 100%; height: 100%; object-fit: cover; display: block; }
  img.cover { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .shade { position: absolute; inset: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--bg) 92%, transparent) 0%, color-mix(in srgb, var(--bg) 70%, transparent) 46%, transparent 78%); }
  .over { position: absolute; inset: 0; }
  .over .text { position: absolute; left: 120px; width: 980px; top: 280px; bottom: 150px; display: flex; flex-direction: column; justify-content: center; text-shadow: 0 2px 12px rgb(0 0 0 / .35); }
  .over header { right: auto; max-width: 1200px; text-shadow: 0 2px 12px rgb(0 0 0 / .35); }
  img.only { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  footer { position: absolute; left: 120px; right: 120px; bottom: 64px; display: flex; align-items: center; gap: 20px; font-size: 34px; font-weight: 700; z-index: 2; }
  footer .dot { width: 16px; height: 16px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  @keyframes in { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
</style>
</head>
<body${p.preview ? ' class="preview"' : ""}>
${layout === "imageOnly" ? "" : '<div id="bg"></div>'}
${main}
${p.preview ? `<script>(function(){function f(){var k=Math.min(innerWidth/1920,innerHeight/1080);document.body.style.transform="scale("+k+")";}addEventListener("resize",f);f();})();</script>` : ""}
</body>
</html>
`;
}
