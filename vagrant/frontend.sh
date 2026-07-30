#!/bin/bash
set -e

REPO="https://github.com/vipul156/Foodo.git"
SERVICE="frontend"
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

echo "Cleaning build area..."
rm -rf /tmp/Foodo
rm -rf "$APP_DIR"

echo "Cloning repository..."
git clone --depth 1 "$REPO" /tmp/Foodo

cd "/tmp/Foodo/$SERVICE"

echo "Loading environment variables for build time..."
if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
fi

echo "Installing dependencies..."
npm ci --prefer-offline --no-audit

echo "Building Next.js standalone app..."
npm run build

echo "Preparing target application directory..."
mkdir -p "$APP_DIR"

echo "Deploying standalone output..."
# Copy standalone server, node_modules, and configs
cp -r .next/standalone/. "$APP_DIR/"

# Copy static assets (required by Next.js standalone)
mkdir -p "$APP_DIR/.next/static"
cp -r .next/static/* "$APP_DIR/.next/static/"

# Copy public folder if it exists
cp -r public "$APP_DIR/public"

echo "Cleaning temporary build files..."
rm -rf /tmp/Foodo

echo "Configuring systemd service..."
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Foodo Frontend Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production
Environment=PORT=3000
$( [ -f "$ENV_FILE" ] && echo "EnvironmentFile=$ENV_FILE" )
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "Starting systemd service..."
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

echo "Deployment of $SERVICE completed successfully!"