/**
 * "Identify outputs": a full-screen test card with the output number, played by CasparCG's HTML producer on every
 * channel of a studio node, above playout and graphics, for a short time. Shows which SDI connector is which output.
 */
export const IDENTIFY_LAYER = 90;
export const IDENTIFY_SECONDS = 60;

const COLORS = ["#3B6CFF", "#E5484D", "#30A46C", "#F5A524", "#8E4EC6", "#12A594", "#D6409F", "#6E56CF"];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function identifyPage(n: number, of: number, node: string) {
  const color = COLORS[(n - 1) % COLORS.length];
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Output ${n}</title>
<style>
  html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:${color};color:#fff;font-family:"Segoe UI",Arial,sans-serif}
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px}
  .num{font-size:520px;font-weight:800;line-height:1;text-shadow:0 12px 40px rgba(0,0,0,.35)}
  .label{font-size:72px;font-weight:700;letter-spacing:.04em}
  .sub{font-size:40px;opacity:.9}
  .clock{position:absolute;bottom:84px;right:128px;font-size:48px;font-variant-numeric:tabular-nums;opacity:.9}
  .safe{position:absolute;inset:54px 96px;border:4px dashed rgba(255,255,255,.55)}
</style></head>
<body><div class="safe"></div><div class="wrap">
  <div class="num">${n}</div>
  <div class="label">OUTPUT ${n} &middot; UITGANG ${n}</div>
  <div class="sub">${esc(node)} &middot; CasparCG ${n} / ${of} &middot; DeckLink device ${n}</div>
</div><div class="clock" id="c"></div>
<script>const c=document.getElementById("c");const t=()=>{c.textContent=new Date().toLocaleTimeString("nl-NL",{hour12:false})};t();setInterval(t,1000);</script>
</body></html>`;
}
