#!/bin/bash
set -e

REPO="https://github.com/vipul156/Foodo.git"
SERVICE="frontend"
APP_DIR="/opt/$SERVICE"

echo "Updating packages..."
apt-get update
apt-get install -y git curl

# Install Node.js 22
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

echo "Cleaning previous deployment..."
rm -rf /tmp/Foodo
rm -rf "$APP_DIR"

echo "Cloning repository..."
git clone --depth 1 "$REPO" /tmp/Foodo

cd "/tmp/Foodo/$SERVICE"

echo "Loading environment variables..."

if [ -f "/etc/foodo/$SERVICE.env" ]; then
    set -a
    . "/etc/foodo/$SERVICE.env"
    set +a
fi

echo "Installing dependencies..."
npm ci

echo "Building..."
npm run build

echo "Creating application directory..."
mkdir -p "$APP_DIR"

echo "Copying standalone build..."

cp -r .next/standalone/* "$APP_DIR/"

mkdir -p "$APP_DIR/.next"

cp -r .next/standalone/.next/. "$APP_DIR/.next/"
cp -r .next/static "$APP_DIR/.next/static"

[ -d public ] && cp -r public "$APP_DIR/"

echo "Cleaning source..."
rm -rf /tmp/Foodo

echo "Creating systemd service..."

cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Foodo Frontend
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production
Environment=PORT=3000
EnvironmentFile=/etc/foodo/frontend.env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $SERVICE
systemctl restart $SERVICE

echo "Deployment completed."