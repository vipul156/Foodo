#!/bin/bash
set -e

REPO="https://github.com/vipul156/Foodo.git"
SERVICE="admin"
APP_DIR="/opt/$SERVICE"
ENV_FILE="/etc/foodo/$SERVICE.env"

echo "Checking system dependencies..."
if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    apt-get update && apt-get install -y git curl
fi

# Install Node.js 22 only if missing
if ! command -v node >/dev/null 2>&1; then
    echo "Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

echo "Cleaning previous deployment..."
rm -rf /tmp/Foodo
rm -rf "$APP_DIR"

echo "Cloning repository..."
git clone --depth 1 "$REPO" /tmp/Foodo

cd "/tmp/Foodo/$SERVICE"

echo "Installing build dependencies..."
npm ci --prefer-offline --no-audit --legacy-peer-deps

echo "Building TypeScript project..."
npm run build

echo "Pruning devDependencies for production..."
npm prune --production

echo "Creating application directory..."
mkdir -p "$APP_DIR"

echo "Copying runtime files..."
cp -r dist "$APP_DIR/"
cp -r node_modules "$APP_DIR/"
cp package.json "$APP_DIR/"

echo "Cleaning source..."
rm -rf /tmp/Foodo

echo "Creating systemd service..."

cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Foodo $SERVICE Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node dist/index.js
Environment=NODE_ENV=production
$( [ -f "$ENV_FILE" ] && echo "EnvironmentFile=$ENV_FILE" )
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

echo "Deployment of $SERVICE completed successfully."