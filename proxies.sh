#!/data/data/com.termux/files/usr/bin/bash
# Start both proxies for the VR Catalog and keep them alive.
#   cb-proxy.js     : Chaturbate source        (port 8899)
#   media-proxy.js  : Emby/Jellyfin + xCloud    (port 8877)
#
# Usage:  bash proxies.sh      (Ctrl+C stops both)
# Put this in the same folder as cb-proxy.js and media-proxy.js.

cd "$(dirname "$0")"

# keep the phone from sleeping the proxies
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

# stop any old copies so ports are free
pkill -f cb-proxy.js 2>/dev/null
pkill -f media-proxy.js 2>/dev/null
sleep 1

echo "starting media-proxy (8877) + cb-proxy (8899)..."
node media-proxy.js &
MP=$!
node cb-proxy.js &
CB=$!

# stop both cleanly on Ctrl+C
trap 'echo; echo stopping...; kill $MP $CB 2>/dev/null; command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock; exit 0' INT TERM

wait
