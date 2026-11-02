/**
 * Webcam page (1920x1080) played by the CasparCG HTML producer on the studio node.
 *   page.html?id=<id>            picture / MJPEG camera full screen, with the caption
 *   page.html?id=<id>&caption=1  only the caption on a transparent page (layer above a video stream or web page)
 *   page.html?id=<id>&offline=1  "picture not available" card while the stream does not come in
 * Data from `/webcam/<id>/data.json`; pictures and MJPEG come through the management node, so the studio node
 * needs no internet access for them.
 */
export const WEBCAM_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Webcam</title>
<style>
  :root { --bg: #2A1430; --panel: #713C80; --accent: #E92E7F; --text: #FFFFFF; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #000; color: var(--text);
    font-family: "Inter", "Segoe UI Variable Text", "Segoe UI", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  body.caption { background: transparent; }
  #pic { position: absolute; inset: 0; }
  #pic img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .6s ease; }
  #pic img.on { opacity: 1; }
  body.contain #pic img { object-fit: contain; }
  #cap { position: absolute; display: none; align-items: center; gap: 22px; padding: 18px 34px 18px 22px; border-radius: 18px;
    background: color-mix(in srgb, var(--bg) 78%, transparent); backdrop-filter: blur(6px); box-shadow: 0 18px 50px rgba(0,0,0,.35);
    font-size: 40px; font-weight: 700; max-width: 1300px; }
  #cap.on { display: flex; }
  #cap.bottom-left { left: 96px; bottom: 84px; }
  #cap.bottom-right { right: 96px; bottom: 84px; }
  #cap.top-left { left: 96px; top: 70px; }
  #cap.top-right { right: 96px; top: 70px; }
  #cap .live { display: none; align-items: center; gap: 12px; background: var(--accent); padding: 8px 18px; border-radius: 10px;
    font-size: 26px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  #cap.live .live { display: flex; }
  #cap .live i { width: 14px; height: 14px; border-radius: 50%; background: #fff; animation: blink 1.6s ease-in-out infinite; }
  #cap .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @keyframes blink { 50% { opacity: .25; } }
  #off { position: absolute; inset: 0; display: none; place-items: center; text-align: center;
    background: radial-gradient(1200px 700px at 85% -10%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 70%),
      radial-gradient(1100px 800px at -10% 110%, color-mix(in srgb, var(--panel) 70%, transparent), transparent 70%), var(--bg); }
  body.offline #off { display: grid; }
  #off .icon { width: 150px; height: 150px; margin: 0 auto 40px; border-radius: 40px; display: grid; place-items: center; background: color-mix(in srgb, var(--text) 10%, transparent); }
  #off h1 { font-family: "Epilogue", "Segoe UI Variable Display", "Segoe UI", Arial, sans-serif; font-size: 78px; margin: 0 0 18px; }
  #off p { font-size: 36px; opacity: .8; margin: 0; }
</style>
</head>
<body>
<div id="pic"></div>
<div id="off"><div>
  <div class="icon"><svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="8"/><circle cx="12" cy="10" r="3"/><path d="M7 22h10"/><path d="M12 22v-4"/></svg></div>
  <h1 id="offName"></h1><p id="offText"></p>
</div></div>
<div id="cap"><span class="live"><i></i><span id="liveWord">Live</span></span><span class="text" id="capText"></span></div>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var id = q.get("id");
  var onlyCaption = q.get("caption") === "1";
  var offline = q.get("offline") === "1";
  if (onlyCaption) document.body.classList.add("caption");
  if (offline) document.body.classList.add("offline");
  var pic = document.getElementById("pic");
  var timer = null, current = null, mode = null;

  function showImage(src) {
    var img = new Image();
    img.onload = function () {
      img.className = "on";
      pic.appendChild(img);
      if (current && current !== img) { var old = current; old.className = ""; setTimeout(function () { old.remove(); }, 700); }
      current = img;
    };
    img.src = src;
  }
  function apply(d) {
    var s = d.settings;
    for (var k in d.colors) document.documentElement.style.setProperty("--" + k, d.colors[k]);
    document.body.classList.toggle("contain", s.fit === "contain");
    var cap = document.getElementById("cap");
    var showCap = s.caption.enabled && (onlyCaption || offline || d.mode === "picture");
    cap.className = (showCap ? "on " : "") + s.caption.position + (s.caption.live && !offline ? " live" : "");
    document.getElementById("capText").textContent = d.caption;
    document.getElementById("liveWord").textContent = d.liveWord;
    document.getElementById("offName").textContent = d.name;
    document.getElementById("offText").textContent = d.offlineText;
    if (onlyCaption || offline) return;
    if (d.mode !== mode) {
      mode = d.mode;
      clearInterval(timer);
      pic.innerHTML = ""; current = null;
      if (d.kind === "mjpeg") showImage(d.mjpegUrl);
      else if (d.kind === "image") {
        var load = function () { showImage(d.imageUrl + (d.imageUrl.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now()); };
        load();
        timer = setInterval(load, Math.max(1, s.refreshSec) * 1000);
      }
    }
  }
  function refresh() {
    fetch("/webcam/" + encodeURIComponent(id) + "/data.json", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(apply)
      .catch(function () {});
  }
  refresh();
  setInterval(refresh, 60000);
})();
</script>
</body>
</html>`;
