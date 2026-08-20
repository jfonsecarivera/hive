#!/usr/bin/env bash
# Expose this machine's hive to YOUR devices only, over Tailscale — run it once on the
# machine that serves hive (e.g. the devbox). Prints the phone URL, token included.
#
#   bash scripts/phone.sh
#
# Needs: tailscale installed and logged in (`sudo tailscale up` — one browser approval),
# and the Tailscale app signed in on your phone. Nothing is exposed to the internet:
# tailscale serve terminates TLS on your tailnet and proxies to hive on 127.0.0.1.
set -euo pipefail

PORT="${HIVE_PORT:-4483}"

if ! command -v tailscale >/dev/null; then
  echo "tailscale isn't installed — https://tailscale.com/download" >&2
  exit 1
fi
if ! tailscale status >/dev/null 2>&1; then
  echo "tailscale is logged out. Run:  sudo tailscale up   (one browser approval), then re-run this." >&2
  exit 1
fi

TOKEN=""
UNIT="$HOME/.config/systemd/user/hive.service"
if [ -f "$UNIT" ]; then
  TOKEN=$(grep -o 'HIVE_TOKEN=[a-f0-9]*' "$UNIT" | head -1 | cut -d= -f2 || true)
fi
if [ -z "$TOKEN" ]; then
  echo "note: HIVE_TOKEN isn't set in $UNIT — the page will be tailnet-gated only." >&2
fi

tailscale serve --bg "http://127.0.0.1:${PORT}" >/dev/null
HOST=$(tailscale status --json | grep -o '"DNSName": *"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')

echo
echo "hive is on your tailnet:"
echo "  board:  https://${HOST}/${TOKEN:+?key=$TOKEN}"
echo "  phone:  https://${HOST}/go${TOKEN:+?key=$TOKEN}"
echo
echo "Open the phone URL once — the key becomes a cookie; bookmark it / add to home screen."
