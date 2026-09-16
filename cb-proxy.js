// ============================================================================
//  cb-proxy.js  —  optional Chaturbate source proxy for the VR Catalog
// ============================================================================
//
//  WHAT THIS IS
//  A tiny local CORS proxy so the VR Catalog's (optional, adult) Chaturbate
//  source can read the public room-list API. Public CORS proxies get age-gated
//  because they carry no cookies; this one sends a real browser User-Agent plus
//  an age-consent cookie, so the room-list API returns JSON instead of the
//  splash page. It ONLY proxies chaturbate.com (not an open relay).
//
//  You do NOT need this file for the rest of the project (Plex, xCloud, capture,
//  firefly, head tracking all work without it). Skip it if you don't want the
//  adult source.
//
//  ----------------------------------------------------------------------------
//  REQUIREMENTS
//    Node.js 18+  (needs built-in fetch). Check with:  node -v
//
//  INSTALL NODE ON ANDROID (Termux):
//    pkg install -y nodejs
//
//  RUN:
//    node cb-proxy.js
//    -> prints: cb-proxy listening on http://0.0.0.0:8899
//    Leave this session open. In Termux, keep it alive with:
//    termux-wake-lock
//
//  POINT THE CATALOG AT IT:
//    In the VR Catalog settings, set the "Chaturbate proxy" field to:
//        http://127.0.0.1:8899/?url=
//    (If the proxy runs on a different device, use that device's LAN IP
//     instead of 127.0.0.1, e.g. http://192.168.0.55:8899/?url= )
//
//  TEST IT (optional, from the same device):
//    curl 'http://127.0.0.1:8899/?url=https://chaturbate.com/api/ts/roomlist/room-list/?hashtags=feet&limit=5'
//    -> should return JSON. (Single-quote the URL so the shell keeps the & .)
//
//  TROUBLESHOOTING:
//    "node: command not found"   -> pkg install -y nodejs
//    "failed to fetch" in-app     -> proxy not running, wrong port, or (in a
//                                    WebView) the app lacks INTERNET permission
//    403 "only chaturbate.com"    -> the ?url= value must start with
//                                    https://chaturbate.com/
//    EADDRINUSE                   -> already running; reuse it or: pkill node
//
//  CHANGE THE PORT: edit PORT below.
// ============================================================================

const http = require("http");

const PORT = 8899;

http.createServer(async (req, res) => {
  // allow the catalog page (any origin) to read the response
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  let target;
  try { target = new URL(req.url, "http://localhost").searchParams.get("url"); }
  catch (_) { target = null; }

  if (!target) { res.writeHead(400); return res.end("missing ?url="); }

  // only proxy chaturbate to keep this from being an open relay
  if (!/^https:\/\/chaturbate\.com\//.test(target)) {
    res.writeHead(403); return res.end("only chaturbate.com allowed");
  }

  try {
    const r = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://chaturbate.com/",
        "Cookie": "agreeterms=1"          // age-consent so CB serves the API, not the splash
      }
    });
    const body = await r.text();
    res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  } catch (e) {
    res.writeHead(502);
    res.end(String(e));
  }
}).listen(PORT, () => console.log("cb-proxy listening on http://0.0.0.0:" + PORT));
