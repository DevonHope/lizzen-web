#!/usr/bin/env bash
# Lizzen Web one-time setup script for a fresh Linux host (Debian/Ubuntu-based)
# - Installs Node.js and required packages
# - Installs and builds backend and frontend
# - Creates and starts a systemd service for the backend (port 3001 by default)
# - Optionally configures Nginx to serve the frontend and reverse-proxy the backend
# - Optionally runs Certbot for SSL (you can also run setup-ssl.sh later)

set -euo pipefail
IFS=$'\n\t'

# -------- Configuration (can be overridden via env or flags) --------
APP_USER="${APP_USER:-$(logname 2>/dev/null || whoami)}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
APP_ROOT="${APP_ROOT:-/home/$APP_USER/lizzen-web}"
BACKEND_DIR="$APP_ROOT/backend"
FRONTEND_DIR="$APP_ROOT/frontend"
INSTALL_NGINX="${INSTALL_NGINX:-1}"           # 1 to install and configure nginx, 0 to skip
SETUP_SSL="${SETUP_SSL:-0}"                   # 1 to attempt SSL via certbot at the end
DOMAIN="${DOMAIN:-lizzen.org}"                # change or override via env/flag
BACKEND_PORT="${PORT:-3001}"                  # backend listen port
NODE_MAJOR="${NODE_MAJOR:-20}"                # Node.js major version to install (LTS)

usage() {
  cat <<USAGE
Usage: sudo ./install.sh [options]

Options (or use env vars):
  --user NAME           System user to run the service (default: $APP_USER)
  --root PATH           Path to repo root (default: $APP_ROOT)
  --domain NAME         Domain for nginx config (default: $DOMAIN)
  --port N              Backend port (default: $BACKEND_PORT)
  --no-nginx            Skip nginx install/config
  --with-ssl            Run certbot at the end (requires domain DNS ready)
  -h, --help            Show this help

Environment overrides:
  APP_USER, APP_GROUP, APP_ROOT, DOMAIN, PORT, NODE_MAJOR, INSTALL_NGINX, SETUP_SSL
USAGE
}

# -------- Parse flags --------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) APP_USER="$2"; shift 2 ;;
    --root) APP_ROOT="$2"; BACKEND_DIR="$APP_ROOT/backend"; FRONTEND_DIR="$APP_ROOT/frontend"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --port) BACKEND_PORT="$2"; shift 2 ;;
    --no-nginx) INSTALL_NGINX="0"; shift ;;
    --with-ssl) SETUP_SSL="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# -------- Preflight checks --------
if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (use: sudo ./install.sh)" >&2
  exit 1
fi

if [[ ! -d "$APP_ROOT" ]]; then
  echo "Repo folder not found: $APP_ROOT" >&2
  exit 1
fi

command -v apt-get >/dev/null 2>&1 || {
  echo "This script expects a Debian/Ubuntu system with apt-get." >&2
  exit 1
}

# -------- Install base packages --------
apt-get update -y
apt-get install -y ca-certificates curl gnupg git

# -------- Install Node.js (NodeSource) --------
if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js $NODE_MAJOR.x..."
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  apt-get update -y
  apt-get install -y nodejs
else
  echo "Node.js already installed: $(node -v)"
fi

# -------- Backend setup --------
echo "Setting up backend in $BACKEND_DIR"
cd "$BACKEND_DIR"

# Create .env from example if missing
if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
  chown "$APP_USER:$APP_GROUP" .env
  echo "Created backend/.env from example. Update PROWLARR_API_KEY and other values as needed."
fi

# Install dependencies (prefer ci if lockfile present)
if [[ -f package-lock.json ]]; then
  sudo -u "$APP_USER" npm ci
else
  sudo -u "$APP_USER" npm install --no-audit --no-fund
fi

# Create systemd service
SERVICE_FILE=/etc/systemd/system/lizzen-backend.service
cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=Lizzen Web Backend (Node.js)
After=network.target

[Service]
Type=simple
WorkingDirectory=$BACKEND_DIR
ExecStart=/usr/bin/env node index.js
Environment=PORT=$BACKEND_PORT
EnvironmentFile=$BACKEND_DIR/.env
Restart=always
RestartSec=3
User=$APP_USER
Group=$APP_GROUP
# Hardening (adjust if you need outbound access beyond DNS/HTTP(S))
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable lizzen-backend.service
systemctl restart lizzen-backend.service
sleep 1
systemctl --no-pager --full status lizzen-backend.service || true

# -------- Frontend build --------
echo "Building frontend in $FRONTEND_DIR"
cd "$FRONTEND_DIR"
if [[ -f package-lock.json ]]; then
  sudo -u "$APP_USER" npm ci
else
  sudo -u "$APP_USER" npm install --no-audit --no-fund
fi
sudo -u "$APP_USER" npm run build

# Deploy static files
WEB_ROOT=/var/www/lizzen-web/frontend
mkdir -p "$WEB_ROOT"
rsync -a --delete "$FRONTEND_DIR/dist/" "$WEB_ROOT/"
chown -R "$APP_USER:$APP_GROUP" "$WEB_ROOT"

# -------- Nginx (optional) --------
if [[ "$INSTALL_NGINX" == "1" ]]; then
  echo "Installing and configuring Nginx..."
  apt-get install -y nginx

  NGINX_SITE=/etc/nginx/sites-available/lizzen-web.conf
  cat > "$NGINX_SITE" <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    # Serve built frontend
    root $WEB_ROOT;
    index index.html;

    # SPA fallback
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Backend API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:$BACKEND_PORT/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300;
    }
}
NGINX

  ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/lizzen-web.conf
  # Disable default site if present
  if [[ -f /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default
  fi
  nginx -t
  systemctl enable nginx
  systemctl restart nginx

  if [[ "$SETUP_SSL" == "1" ]]; then
    echo "Attempting SSL via certbot for domain $DOMAIN..."
    apt-get install -y certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" || true
  else
    echo "SSL not requested (SETUP_SSL=0). You can run ./setup-ssl.sh later."
  fi
else
  echo "Skipped Nginx install/config (--no-nginx)."
fi

# -------- Summary --------
echo "\n✅ Installation complete"
echo "- Backend service: lizzen-backend (port $BACKEND_PORT)"
echo "  View logs: sudo journalctl -u lizzen-backend -f"
echo "- Frontend files: $WEB_ROOT"
echo "- Nginx: $( [[ "$INSTALL_NGINX" == "1" ]] && echo enabled || echo skipped ) for domain $DOMAIN"
echo "- Backend .env: $BACKEND_DIR/.env (update PROWLARR_API_KEY, etc.)"

exit 0
