#!/usr/bin/env bash
# ComCom Relay: one-command setup on a fresh Linux VPS (Ubuntu/Debian recommended).
# One relay serves many companies; each gets its own private connection code.
#
#   curl -fsSL https://raw.githubusercontent.com/pashaintercorpservices-cyber/comcom-download/main/relay/install-relay.sh | sudo bash -s -- "First Company"
#
# Installs Docker if needed, starts the relay (restarts automatically after
# reboots), adds the companies named on the command line and prints their codes.
# Afterwards manage companies with:  comcom-relay add "Company name" | list | code <company> | disable <company> | enable <company> | remove <company>
#
# Optional settings (put them before "bash", e.g. ... | sudo RELAY_DOMAIN=relay.example.com bash -s -- "Acme"):
#   RELAY_DOMAIN       your own domain for company addresses; needs a DNS record  *.relay.example.com -> this server's IP
#                      (without it, addresses use the free sslip.io DNS service)
#   RELAY_PUBLIC_HOST  this server's public IP, if detection picks the wrong one
set -euo pipefail

BASE="https://raw.githubusercontent.com/pashaintercorpservices-cyber/comcom-download/main/relay"
DIR=/opt/comcom-relay
CONF="$DIR/relay.env"

if [ "$(id -u)" -ne 0 ]; then echo "Run as root (use: ... | sudo bash)"; exit 1; fi

echo "==> ComCom Relay setup"
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker (takes a minute or two)"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

mkdir -p "$DIR"
# Keep settings from an earlier install unless new ones are given.
if [ -f "$CONF" ]; then . "$CONF"; fi
HOST="${RELAY_PUBLIC_HOST:-${SAVED_HOST:-}}"
DOMAIN="${RELAY_DOMAIN:-${SAVED_DOMAIN:-}}"
if [ -z "$HOST" ]; then
  HOST="$(curl -fsS4 --max-time 10 https://api.ipify.org || curl -fsS4 --max-time 10 https://ifconfig.me || true)"
fi
if [ -z "$HOST" ]; then echo "Could not detect this server's public IP. Re-run with RELAY_PUBLIC_HOST=<ip> before bash."; exit 1; fi
printf 'SAVED_HOST=%q\nSAVED_DOMAIN=%q\n' "$HOST" "$DOMAIN" > "$CONF"
echo "==> Public address: $HOST${DOMAIN:+ (company addresses under $DOMAIN)}"

for f in Dockerfile package.json relay.js index.js; do
  curl -fsSL "$BASE/$f" -o "$DIR/$f"
done

echo "==> Building the relay"
docker build -q -t comcom-relay "$DIR" >/dev/null
docker rm -f comcom-relay >/dev/null 2>&1 || true
docker run -d --name comcom-relay --restart unless-stopped \
  -p 443:8443 -p 7443:7443 -v comcom-relay:/data \
  -e RELAY_PUBLIC_HOST="$HOST" -e RELAY_DOMAIN="$DOMAIN" comcom-relay >/dev/null

# Helper for managing companies.
cat > /usr/local/bin/comcom-relay <<'EOS'
#!/bin/sh
# Manage the companies on this ComCom Relay. Run without arguments for help.
[ $# -eq 0 ] && set -- help
exec docker exec comcom-relay node index.js "$@"
EOS
chmod +x /usr/local/bin/comcom-relay

# Open the two ports if a host firewall is active.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 443/tcp >/dev/null; ufw allow 7443/tcp >/dev/null
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=443/tcp --add-port=7443/tcp >/dev/null && firewall-cmd --reload >/dev/null
fi

for _ in $(seq 1 30); do
  docker logs comcom-relay 2>&1 | grep -q "ComCom Relay running" && break
  sleep 1
done
if ! docker logs comcom-relay 2>&1 | grep -q "ComCom Relay running"; then echo "The relay did not start. Details:"; docker logs comcom-relay; exit 1; fi

echo ""
echo "============================================================"
echo " ComCom Relay is running on $HOST (ports 443 and 7443)."
echo " If your provider has a cloud firewall, allow TCP 443 and 7443."
echo "============================================================"

for name in "$@"; do
  if comcom-relay code "$name" >/dev/null 2>&1; then
    comcom-relay code "$name"
  else
    comcom-relay add "$name"
  fi
done

# Check that company addresses resolve to this server.
first="$(comcom-relay list | awk 'NR==1 && $2=="active" {print $1}' || true)"
if [ -n "$first" ]; then
  name="$(comcom-relay code "$first" | awk '/Staff connect at:/ {print $4}')"
  ip="$(getent ahostsv4 "$name" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
  if [ "$ip" = "$HOST" ]; then
    echo "Check: $name -> $ip (correct)."
  else
    echo "WARNING: $name resolves to '${ip:-nothing}', not $HOST."
    echo "Staff will not reach the relay until it does. Set RELAY_DOMAIN to a domain with a"
    echo "wildcard DNS record pointing at $HOST and run this installer again."
  fi
fi

cat <<'EOF'

Add more companies at any time (each gets its own code):
  comcom-relay add "Company name"
Other commands:  comcom-relay list | code <company> | disable <company> | enable <company> | remove <company>
EOF
