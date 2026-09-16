# VR Catalog + Firefly 3D Screen

A phone-first, self-contained pipeline for watching your media on a floating
screen inside a 3D firefly forest — with real-time 2D→3D depth shading and head
tracking. Built and run entirely on-device

Pick something from the **catalog launcher**, and it opens in M Edge browser where the
**firefly script** wraps it in a stereoscopic screen with a pseudo-3D
depth or native shader and an anchored, head-tracked forest environment for android phone VR
viewers

---

## What's included

| File | What it does |
|------|--------------|
| `vr-catalog.html` | The launcher. A WebGL stereoscopic catalog that browses your sources (Plex, xCloud, generic tiles, native apps) and hands the chosen content off to the firefly script. Locked-panel mode for glasses/HDMI, head-tracked mode for viewers. |
| `The firefly forest screens` | WebXR VR 3D custom 2d to 3d and native shaders, applied to any `<video>`, `<canvas>`, or `<img>` on the page. |
| `play.html` | Plex transcode player (hls.js). The catalog opens this for Plex movies/episodes that need transcoding, with correct audio. |
| `vr-shell/` | Optional Android WebView shell (APK source). Loads the launcher from a local server, adds a bridge to launch native apps by package name, and keeps a secure context for head tracking. |
| `cb-proxy.js` | **Optional.** A small local proxy for one adult source. Not required for anything else — instructions are inside the file. |

---

## Quick start (phone)

1. **Serve the files.** Put `vr-catalog.html` and `play.html` in one
   folder and serve it locally (any on-device HTTP server, e.g. a Termux
   `python -m http.server 8080 --bind 0.0.0.0`, or a local-server app).
2. **Install the firefly script** as a userscript (Tampermonkey) in
   edge browser.
3. **Open the launcher** at `http://127.0.0.1:8080/vr-catalog.html`.
   Using `127.0.0.1` / `localhost` matters — it's a secure context, so head
   tracking works. Or use the apk
4. **Configure your sources** in the launcher's settings (Plex base URL + token,
   etc.), pick a tile, and it opens in your browser where firefly shades it.

### Head tracking needs a secure context
DeviceOrientation only fires on `https://` or `http://localhost` / `127.0.0.1`.
On a plain LAN IP (e.g. `http://192.168.x.x`) the screen still renders but won't
track. Serve/view content from localhost or wrap it in a local page.

---

## Sources

- **Plex** — movies and TV (drills Show → Season → Episode); direct-play when the
  codec allows, otherwise transcodes via `play.html`.
- **xCloud** — public Game Pass cloud catalog (launch tiles).
- **Native app tile** — launches any installed app by package name (Android shell
  only).
- **Generic tile / feed** — any URL or JSON feed.

---

## Controls

- **Mouse (recommended dwell is not very good set to zero) wheel steps the highlight through tiles, click opens, right-click / back goes up a level. Right click goes in and out of the firefly screen.
- **Head-tracked mode** (viewers): the panel is anchored in space; look around it.
  A recenter control sets "forward."
- **Depth slider** — strength of the 3D pop.


---

## Requirements

- A WebXR Tampermonkey capable browser edge recommended 
- On-device HTTP server for local hosting.
- Android phone, VR phone viewer, Bluetooth mouse

---

## Notes

- The Android shell is optional. Everything except native-app launching runs from a
  plain browser.


---

## License

[MIT](LICENSE) © 2026

