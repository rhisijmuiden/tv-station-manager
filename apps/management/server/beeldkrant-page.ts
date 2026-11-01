/**
 * Full-screen beeldkrant page (1920x1080) played by the CasparCG HTML producer on the studio node:
 *   PLAY <ch>-10 [HTML] "<management>/beeldkrant/page.html?id=<id>&start=<epoch ms>"
 * It fetches `/beeldkrant/<id>/data.json` (settings + pages) every minute and shows page
 * floor((now - start) / secondsPerPage) mod pageCount, so a restart or a second output shows the same page.
 * The clock is corrected with the management node's time (serverTime).
 * Preview: `page.html?preview=1` in an iframe of the editor gets { type: "beeldkrant", settings, pages, logoUrl, pin }
 * through postMessage (pin = page index to hold, or null to cycle).
 */
export const BEELDKRANT_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Beeldkrant</title>
<style>
  :root { --bg: #2A1430; --panel: #713C80; --accent: #E92E7F; --text: #FFFFFF; --scale: 1; --fade: 700ms; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: var(--bg); color: var(--text);
    font-family: "Inter", "Segoe UI Variable Text", "Segoe UI", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  body.preview { transform-origin: 0 0; }
  #bg { position: absolute; inset: 0; background:
      radial-gradient(1200px 700px at 88% -10%, color-mix(in srgb, var(--accent) 34%, transparent), transparent 70%),
      radial-gradient(1100px 800px at -10% 110%, color-mix(in srgb, var(--panel) 70%, transparent), transparent 70%),
      var(--bg); }
  header { position: absolute; left: 96px; right: 96px; top: 54px; height: 96px; display: flex; align-items: center; gap: 28px; z-index: 5; }
  header img { max-height: 84px; max-width: 300px; display: block; }
  header .name { font-family: "Epilogue", "Segoe UI Variable Display", "Segoe UI", Arial, sans-serif; font-size: 50px; font-weight: 800; letter-spacing: .01em; text-transform: uppercase; }
  header .bar { width: 8px; height: 56px; border-radius: 4px; background: var(--accent); }
  header .right { margin-left: auto; text-align: right; line-height: 1.05; }
  header .clock { font-size: 56px; font-weight: 700; font-variant-numeric: tabular-nums; }
  header .date { font-size: 24px; opacity: .78; margin-top: 4px; }
  footer { position: absolute; left: 96px; right: 96px; bottom: 44px; height: 64px; display: flex; align-items: center; gap: 24px; z-index: 5; font-size: 28px; }
  footer .text { opacity: .9; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  footer .num { margin-left: auto; font-weight: 700; font-variant-numeric: tabular-nums; background: color-mix(in srgb, var(--text) 12%, transparent); padding: 6px 18px; border-radius: 999px; }
  #progress { position: absolute; left: 96px; right: 96px; bottom: 124px; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--text) 16%, transparent); overflow: hidden; z-index: 5; }
  #progress i { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 3px; }

  .page { position: absolute; inset: 0; opacity: 0; transition: opacity var(--fade) ease, transform var(--fade) cubic-bezier(.2,.8,.2,1); }
  .page.on { opacity: 1; }
  body.t-slide .page { transform: translateX(80px); }
  body.t-slide .page.on { transform: none; }
  body.t-slide .page.off { transform: translateX(-80px); }
  body.t-none .page { transition: none; }
  .box { position: absolute; left: 96px; right: 96px; top: 190px; bottom: 160px; display: flex; gap: 64px; align-items: stretch; }
  .photo { position: relative; flex: 0 0 46%; border-radius: 22px; overflow: hidden; background: color-mix(in srgb, var(--panel) 60%, #000); box-shadow: 0 30px 80px rgba(0,0,0,.45); }
  .photo img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scale(1.0); transition: transform linear; }
  .page.on .photo img { transform: scale(1.07); }
  .copy { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
  .copy > * { flex-shrink: 0; }
  .meta { display: flex; align-items: center; gap: 18px; margin-bottom: 26px; font-size: calc(26px * var(--scale)); }
  .chip { background: var(--accent); color: #fff; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 8px 18px; border-radius: 8px; font-size: calc(24px * var(--scale)); }
  .when { opacity: .8; font-weight: 500; }
  .title { font-family: "Epilogue", "Segoe UI Variable Display", "Segoe UI", Arial, sans-serif; font-weight: 800; font-size: calc(68px * var(--scale)); line-height: 1.08; letter-spacing: -.01em; margin: 0 0 30px; text-wrap: balance; }
  .text { font-size: calc(36px * var(--scale)); line-height: 1.42; opacity: .94; white-space: pre-line; overflow: hidden; }
  .src { margin-top: 26px; font-size: calc(24px * var(--scale)); opacity: .7; }

  .l-photo-right .box { flex-direction: row-reverse; }
  .l-photo-top .box { flex-direction: column; gap: 36px; }
  .l-photo-top .photo { flex: 0 0 50%; }
  .l-photo-top .copy { justify-content: flex-start; }
  .l-photo-top .title { font-size: calc(56px * var(--scale)); margin-bottom: 18px; }
  .l-photo-top .text { font-size: calc(32px * var(--scale)); }
  .l-photo-full .photo { position: absolute; inset: 0; border-radius: 0; box-shadow: none; z-index: 0; }
  .l-photo-full .photo::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--bg) 94%, transparent) 0%, color-mix(in srgb, var(--bg) 72%, transparent) 46%, transparent 78%), linear-gradient(0deg, color-mix(in srgb, var(--bg) 90%, transparent), transparent 35%), linear-gradient(180deg, color-mix(in srgb, var(--bg) 75%, transparent), transparent 22%); }
  .l-photo-full .box { z-index: 2; }
  .l-photo-full .copy { flex: 0 0 56%; }
  .l-text .copy { max-width: 1500px; }
  .l-text .title { font-size: calc(80px * var(--scale)); }
  .l-text .text { font-size: calc(42px * var(--scale)); }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; font-size: 48px; font-weight: 600; opacity: .85; text-align: center; padding: 0 200px; }
</style>
</head>
<body class="t-fade">
<div id="bg"></div>
<header id="header"><img id="logo" alt="" style="display:none" /><span class="bar" id="bar"></span><span class="name" id="name"></span>
  <div class="right" id="clockbox"><div class="clock" id="clock"></div><div class="date" id="date"></div></div></header>
<div id="stage"></div>
<div id="progress"><i id="bar-progress"></i></div>
<footer><span class="text" id="footer"></span><span class="num" id="num"></span></footer>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var id = q.get("id");
  var preview = q.get("preview") === "1";
  var start = Number(q.get("start")) || Date.now();
  var skew = 0;
  var data = null;
  var pin = null;
  var shown = { key: null, el: null };
  var $ = function (i) { return document.getElementById(i); };
  var now = function () { return Date.now() + skew; };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var lang = function () { return data && data.settings.language === "en" ? "en-GB" : "nl-NL"; };
  var words = function () { return data && data.settings.language === "en" ? ["Today", "Yesterday"] : ["Vandaag", "Gisteren"]; };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso), n = new Date(now());
    var time = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (d.toDateString() === n.toDateString()) return words()[0] + " " + time;
    var y = new Date(n); y.setDate(n.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return words()[1] + " " + time;
    return d.toLocaleDateString(lang(), { day: "numeric", month: "long" }) + " " + time;
  }
  /** Shrinks the text until it fits its box (long titles / texts), down to 60 %. */
  function fit(page) {
    var copy = page.querySelector(".copy"), text = page.querySelector(".text"), title = page.querySelector(".title");
    if (!copy) return;
    // Layout sizes (not getBoundingClientRect): the preview scales the whole page down.
    var boxH = copy.parentNode.clientHeight;
    for (var f = 1; f >= 0.6; f -= 0.05) {
      page.style.setProperty("--scale", String(sizeScale() * f));
      if (copy.scrollHeight <= boxH + 1 && (!title || title.scrollWidth <= copy.clientWidth + 1)) return;
    }
    // Still too long: cut the text at whole lines, ending with "…".
    if (text) {
      var lh = parseFloat(getComputedStyle(text).lineHeight) || 40;
      var lines = Math.max(1, Math.floor((boxH - (copy.scrollHeight - text.scrollHeight)) / lh));
      text.style.display = "-webkit-box"; text.style.webkitBoxOrient = "vertical"; text.style.webkitLineClamp = String(lines);
    }
  }
  function sizeScale() { var s = data && data.settings.textSize; return s === "small" ? 0.86 : s === "large" ? 1.16 : 1; }

  function render(p, s) {
    var page = el("div", "page");
    var hasImg = !!(p.image && s.show.image && s.layout !== "text");
    page.classList.add("l-" + (hasImg ? s.layout : "text"));
    var box = el("div", "box");
    if (hasImg) {
      var ph = el("div", "photo"); var img = new Image(); img.src = p.image; img.alt = "";
      img.style.transitionDuration = (s.secondsPerPage + 1) + "s";
      img.onerror = function () { ph.remove(); page.className = page.className.replace(/l-\\S+/, "l-text"); };
      ph.appendChild(img);
      // Full-screen photo: behind everything (header, text and footer stay on top); other layouts: next to the text.
      if (s.layout === "photo-full") page.appendChild(ph); else box.appendChild(ph);
    }
    var copy = el("div", "copy");
    var meta = el("div", "meta");
    if (s.show.category && p.category) meta.appendChild(el("span", "chip", p.category));
    if (s.show.date && p.date) meta.appendChild(el("span", "when", when(p.date)));
    if (meta.childNodes.length) copy.appendChild(meta);
    copy.appendChild(el("h1", "title", p.title));
    if (p.text) copy.appendChild(el("div", "text", p.text));
    if (s.show.source && p.source) copy.appendChild(el("div", "src", p.source));
    box.appendChild(copy); page.appendChild(box);
    return page;
  }
  function show(key, make) {
    if (shown.key === key) return;
    var stage = $("stage"), old = shown.el, page = make();
    stage.appendChild(page);
    if (page.querySelector(".copy")) fit(page);
    void page.offsetWidth;
    page.classList.add("on");
    if (old) { old.classList.remove("on"); old.classList.add("off"); setTimeout(function () { old.remove(); }, 1500); }
    shown = { key: key, el: page };
  }
  function preload(p) { if (p && p.image) { var i = new Image(); i.src = p.image; } }

  function apply() {
    var s = data.settings, r = document.documentElement.style;
    r.setProperty("--bg", s.colors.background); r.setProperty("--panel", s.colors.panel); r.setProperty("--accent", s.colors.accent); r.setProperty("--text", s.colors.text);
    document.body.className = (preview ? "preview " : "") + "t-" + s.transition;
    $("name").textContent = s.headerText || ""; $("bar").style.display = s.headerText ? "" : "none";
    var logo = $("logo");
    logo.onerror = function () { logo.style.display = "none"; };
    if (data.logoUrl) { if (logo.getAttribute("src") !== data.logoUrl) logo.src = data.logoUrl; logo.style.display = ""; } else logo.style.display = "none";
    $("footer").textContent = s.footerText || "";
    $("clockbox").style.display = s.show.clock ? "" : "none";
    $("num").style.display = s.show.pageNumber ? "" : "none";
    $("progress").style.display = s.show.progress ? "" : "none";
  }

  function tick() {
    var t = new Date(now());
    $("clock").textContent = pad(t.getHours()) + ":" + pad(t.getMinutes());
    var ds = t.toLocaleDateString(lang(), { weekday: "long", day: "numeric", month: "long" });
    $("date").textContent = ds.charAt(0).toUpperCase() + ds.slice(1);
    if (!data) return;
    var s = data.settings, pages = data.pages || [], n = pages.length, per = s.secondsPerPage * 1000;
    if (!n) { $("num").textContent = ""; $("bar-progress").style.width = "0"; show("empty:" + s.emptyText, function () { var e = el("div", "page"); e.appendChild(el("div", "empty", s.emptyText)); return e; }); return; }
    var elapsed = Math.max(0, now() - start), idx = pin != null ? Math.min(pin, n - 1) : Math.floor(elapsed / per) % n;
    var p = pages[idx];
    show(JSON.stringify([p, s]), function () { return render(p, s); });
    preload(pages[(idx + 1) % n]);
    $("num").textContent = (idx + 1) + " / " + n;
    $("bar-progress").style.width = (pin != null ? 100 : ((elapsed % per) / per) * 100) + "%";
  }

  function load() {
    if (!id) return;
    var asked = Date.now();
    fetch("./" + encodeURIComponent(id) + "/data.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      if (d.serverTime) skew = d.serverTime - (asked + Date.now()) / 2;
      data = d; apply(); tick();
    }).catch(function () {});
  }

  if (preview) {
    var fitScreen = function () { var k = Math.min(innerWidth / 1920, innerHeight / 1080); document.body.style.transform = "scale(" + k + ")"; };
    addEventListener("resize", fitScreen); fitScreen();
    addEventListener("message", function (e) {
      if (e.origin !== location.origin || !e.data || e.data.type !== "beeldkrant") return;
      var restart = !data || (e.data.pin == null && pin != null);
      data = { settings: e.data.settings, pages: e.data.pages, logoUrl: e.data.logoUrl || null };
      pin = e.data.pin == null ? null : e.data.pin;
      if (restart) start = Date.now();
      shown.key = null; apply(); tick();
    });
    if (window.parent !== window) window.parent.postMessage({ type: "beeldkrant-ready" }, location.origin);
  }
  load();
  if (!preview) setInterval(load, 60000);
  setInterval(tick, 200);
  tick();
})();
</script>
</body>
</html>
`;
