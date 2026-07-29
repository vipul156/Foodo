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

echo "Installing dependencies..."
npm ci

echo "Building..."
npm run build

echo "Installing production dependencies..."
rm -rf node_modules
npm ci --omit=dev

echo "Creating application directory..."
mkdir -p "$APP_DIR"

echo "Copying runtime files..."

cp -r .next "$APP_DIR/"
cp -r node_modules "$APP_DIR/"
cp package.json package-lock.json "$APP_DIR/"

[ -d public ] && cp -r public "$APP_DIR/"
[ -f next.config.js ] && cp next.config.js "$APP_DIR/"
[ -f next.config.mjs ] && cp next.config.mjs "$APP_DIR/"
[ -f .env.production ] && cp .env.production "$APP_DIR/"

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
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
EnvironmentFile=/etc/foodo/frontend.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $SERVICE
systemctl restart $SERVICE

echo "Deployment completed."