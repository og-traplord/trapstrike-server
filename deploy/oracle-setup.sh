#!/usr/bin/env bash
# TrapStrike game-server — one-shot setup for an Oracle Cloud (Always Free) Ubuntu VM.
#
# Runs ON the VM (Ubuntu 22.04/24.04, ARM or x86). Installs Node + Caddy, opens the
# instance firewall, runs the game-server as a systemd service on 127.0.0.1:8080, and
# fronts it with Caddy for auto-TLS so the browser can reach wss://$DOMAIN.
#
#   sudo DOMAIN=trapstrike.ogtraplord.com bash oracle-setup.sh
#
# Expects the backend source already at /opt/trapstrike (scp'd up beforehand).
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN, e.g. trapstrike.ogtraplord.com}"
APP_DIR="${APP_DIR:-/opt/trapstrike}"
PORT="${PORT:-8080}"
RUN_USER="${RUN_USER:-trapstrike}"

echo "==> TrapStrike server setup for $DOMAIN (app=$APP_DIR port=$PORT)"

# --- 1. Node 20 + corepack (pnpm) ---
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  echo "==> installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
corepack enable

# --- 2. Caddy (official apt repo) for auto-TLS reverse proxy ---
if ! command -v caddy >/dev/null; then
  echo "==> installing Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

# --- 3. Service user + app deps ---
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"
echo "==> installing app deps (pnpm)"
sudo -u "$RUN_USER" bash -lc "cd $APP_DIR && corepack pnpm install --prod=false"

# --- 4. Open the instance firewall (Oracle's Ubuntu images block most input via
#        iptables — the cloud Security List is NOT enough on its own). 80+443 only;
#        the node server stays on localhost behind Caddy. ---
echo "==> opening iptables 80/443"
iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT || true
iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT || true
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save || true
else apt-get install -y iptables-persistent && netfilter-persistent save || true; fi

# --- 5. systemd service: endless deathmatch, WS only (browser uses WS), localhost ---
cat >/etc/systemd/system/trapstrike.service <<EOF
[Unit]
Description=TrapStrike authoritative game-server
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=WT=0
# NB: `pnpm run server` (not the bare `pnpm server` shorthand, which can exit 0
# silently → with Restart=always that would spin-loop without ever serving).
ExecStart=/usr/bin/env corepack pnpm run server
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# --- 6. Caddy: TLS + WebSocket reverse proxy (Caddy proxies wss transparently) ---
cat >/etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}
EOF

systemctl daemon-reload
systemctl enable --now trapstrike.service
systemctl restart caddy

echo "==> done. Game-server: wss://$DOMAIN  (and ws://<this-ip>:$PORT is NOT public — only Caddy is)"
echo "==> check:  systemctl status trapstrike --no-pager ; journalctl -u trapstrike -n 30 --no-pager"
