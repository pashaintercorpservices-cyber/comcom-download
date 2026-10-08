#!/usr/bin/env bash
# ComCom Relay: one-command setup on a fresh Linux VPS (Ubuntu/Debian recommended).
#
#   curl -fsSL https://raw.githubusercontent.com/pashaintercorpservices-cyber/comcom-download/main/relay/install-relay.sh | sudo bash
#
# Installs Docker if needed, starts the relay (restarts automatically after reboots)
# and prints the connection code to paste into ComCom → Admin console → Remote access.
# Optional: RELAY_PUBLIC_HOST=<domain or IP> to override the detected public IP.
set -euo pipefail

BASE="https://raw.githubusercontent.com/pashaintercorpservices-cyber/comcom-download/main/relay"
DIR=/opt/comcom-relay

if [ "$(id -u)" -ne 0 ]; then echo "Run as root (use: ... | sudo bash)"; exit 1; fi

echo "==> ComCom Relay setup"
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker (takes a minute or two)"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

HOST="${RELAY_PUBLIC_HOST:-}"
if [ -z "$HOST" ]; then
  HOST="$(curl -fsS4 --max-time 10 https://api.ipify.org || curl -fsS4 --max-time 10 https://ifconfig.me || true)"
fi
if [ -z "$HOST" ]; then echo "Could not detect this server's public IP. Re-run with RELAY_PUBLIC_HOST=<ip> in front."; exit 1; fi
echo "==> Public address: $HOST"

mkdir -p "$DIR"
for f in Dockerfile package.json relay.js index.js; do
  curl -fsSL "$BASE/$f" -o "$DIR/$f"
done

echo "==> Building the relay"
docker build -q -t comcom-relay "$DIR" >/dev/null
docker rm -f comcom-relay >/dev/null 2>&1 || true
docker run -d --name comcom-relay --restart unless-stopped \
  -p 443:8443 -p 7443:7443 -v comcom-relay:/data \
  -e RELAY_PUBLIC_HOST="$HOST" comcom-relay >/dev/null

# Open the two ports if a host firewall is active.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 443/tcp >/dev/null; ufw allow 7443/tcp >/dev/null
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=443/tcp --add-port=7443/tcp >/dev/null && firewall-cmd --reload >/dev/null
fi

CODE=""
for _ in $(seq 1 30); do
  CODE="$(docker logs comcom-relay 2>&1 | grep -o 'comcom-relay:[A-Za-z0-9_-]*' | tail -1 || true)"
  [ -n "$CODE" ] && break
  sleep 1
done
if [ -z "$CODE" ]; then echo "The relay did not start. Details:"; docker logs comcom-relay; exit 1; fi

cat <<EOF

============================================================
 ComCom Relay is running on $HOST (ports 443 and 7443).

 On the office host PC: ComCom → Admin console → Remote access
 → paste this code → Save:

$CODE

 Keep this code private. To show it again later run:
   docker logs comcom-relay | grep comcom-relay:
 If your provider has a cloud firewall, allow TCP 443 and 7443.
============================================================
EOF
