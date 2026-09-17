// ============================================================================
//  media-proxy.js  —  local CORS proxy for Emby / Jellyfin  (+ xCloud catalog)
// ============================================================================
//
//  WHY THIS EXISTS
//  1. Emby/Jellyfin on "Secure connection mode: Required" only answer over HTTPS
//     with a self-signed certificate. Browsers refuse to fetch from a self-signed
//     cert. This proxy talks HTTPS to your server, ignores the self-signed cert,
//     and returns the data to the VR Catalog over plain http.
//  2. It also whitelists the public xCloud (Game Pass) catalog hosts, so the
//     catalog's xCloud source can route through here instead of flaky public
//     CORS proxies (which have started returning 401).
//
//  ----------------------------------------------------------------------------
//  REQUIREMENTS:  Node.js 18+   (Termux:  pkg install -y nodejs)
//
//  RUN:
//    node media-proxy.js
//    -> prints: media-proxy listening on http://0.0.0.0:8877
//    Keep it open. Termux: run  termux-wake-lock  once to keep it alive.
//
//  POINT THE CATALOG AT IT:
//    Settings > "Media proxy" field:   http://127.0.0.1:8877/?url=
//    (Used for BOTH Emby/Jellyfin and xCloud.)
//    Set your Emby/Jellyfin base URL to the real HTTPS address, e.g.
//    https://192.168.0.55:8920
//
//  TEST (from the same device — replace host/port/key):
//    curl 'http://127.0.0.1:8877/?url=https://192.168.0.55:8920/System/Info?api_key=YOURKEY'
//    -> should return JSON. If it returns an error line now, that error tells you
//       what's wrong (wrong port, server down, etc.) instead of hanging.
//
//  SECURITY
//    * Proxies ONLY: private LAN addresses (192.168.x / 10.x / 172.16-31.x /
//      localhost) AND the fixed public xCloud catalog hosts below. Not an open
//      relay. Add your own hosts to ALLOW_HOSTS if needed.
//    * Ignores TLS cert validation for HTTPS (needed for self-signed servers).
//      Run only on your own trusted LAN.
//    * No server address or key is stored here — passed at runtime via ?url=.
//      Safe to publish.
//
//  TROUBLESHOOTING
//    curl returns nothing/hangs   -> was the old bug; now it returns an error line
//    "upstream timeout"           -> wrong Emby port, or server not responding
//    "host not allowed"           -> add the host to ALLOW_HOSTS
//    401 from Emby                -> the api_key is wrong (make a new one in Emby)
// ============================================================================

const http  = require("http");
const https = require("https");
const httpN = require("http");

const PORT = 8877;
const UPSTREAM_TIMEOUT_MS = 12000;

// Private LAN ranges + localhost, plus the public xCloud catalog hosts.
const ALLOW_HOSTS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^catalog\.gamepass\.com$/i,
  /^displaycatalog\.mp\.microsoft\.com$/i,
  /^[a-z0-9.-]*\.provider\.plex\.tv$/i,
  /^[a-z0-9.-]*\.plex\.tv$/i,
  /^[a-z0-9.-]*\.plexvideos\.com$/i
];
function hostAllowed(host){ return ALLOW_HOSTS.some(re => re.test(host)); }

// hosts that require a browser-like origin/referer (Plex provider checks these)
function needsPlexOrigin(host){ return /plex\.tv$|plexvideos\.com$/i.test(host); }

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  let target;
  try { target = new URL(req.url, "http://localhost").searchParams.get("url"); }
  catch (_) { target = null; }
  if (!target) { res.writeHead(400); return res.end("missing ?url="); }

  let u;
  try { u = new URL(target); } catch (_) { res.writeHead(400); return res.end("bad url"); }
  if (!hostAllowed(u.hostname)) {
    res.writeHead(403); return res.end("host not allowed: " + u.hostname);
  }

  const mod = u.protocol === "https:" ? https : httpN;
  const opts = { method: req.method, headers: { "Accept":"application/json" } };
  if (u.protocol === "https:") opts.agent = insecureAgent;
  if (req.headers["x-emby-token"])          opts.headers["X-Emby-Token"]         = req.headers["x-emby-token"];
  if (req.headers["x-mediabrowser-token"])  opts.headers["X-MediaBrowser-Token"] = req.headers["x-mediabrowser-token"];
  if (req.headers["x-emby-authorization"])  opts.headers["X-Emby-Authorization"] = req.headers["x-emby-authorization"];
  if (req.headers["content-type"])          opts.headers["Content-Type"]         = req.headers["content-type"];
  if (req.headers["content-length"])        opts.headers["Content-Length"]       = req.headers["content-length"];
  if (needsPlexOrigin(u.hostname)) {
    opts.headers["Origin"]  = "https://app.plex.tv";
    opts.headers["Referer"] = "https://app.plex.tv/";
    opts.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  }

  let done = false;
  const finish = (code, body) => { if(done) return; done = true; try{ res.writeHead(code, {"Content-Type":"application/json"}); res.end(body); }catch(_){} };

  const preq = mod.request(target, opts, (pres) => {
    const chunks = [];
    pres.on("data", c => chunks.push(c));
    pres.on("end", () => {
      if(done) return; done = true;
      try{
        res.writeHead(pres.statusCode || 502, { "Content-Type": pres.headers["content-type"] || "application/json" });
        res.end(Buffer.concat(chunks));
      }catch(_){}
    });
  });
  preq.setTimeout(UPSTREAM_TIMEOUT_MS, () => { preq.destroy(); finish(504, "upstream timeout: " + u.host); });
  preq.on("error", (e) => finish(502, "upstream error: " + (e && e.message ? e.message : String(e))));
  if (req.method === "POST") req.pipe(preq); else preq.end();
}).listen(PORT, () => console.log("media-proxy listening on http://0.0.0.0:" + PORT));
