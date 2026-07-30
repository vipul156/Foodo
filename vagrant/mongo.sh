#!/bin/bash
set -e

MONGO_VERSION="8.0"

DB_ADMIN="admin"
DB_ADMIN_PASS="admin123"

APP_USER="foodo"
APP_PASS="foodo123"

echo "Checking system dependencies..."
if ! command -v gnupg >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v lsb_release >/dev/null 2>&1; then
    apt-get update && apt-get install -y gnupg curl lsb-release
fi

echo "Adding MongoDB $MONGO_VERSION GPG key and repository..."
mkdir -p /usr/share/keyrings
curl -fsSL "https://pgp.mongodb.com/server-${MONGO_VERSION}.asc" | gpg --dearmor --yes -o /usr/share/keyrings/mongodb-server.gpg

# Detect distribution code (e.g., bookworm, jammy, focal)
DISTRO_CODENAME=$(lsb_release -cs 2>/dev/null || echo "bookworm")

echo "deb [ signed-by=/usr/share/keyrings/mongodb-server.gpg ] https://repo.mongodb.org/apt/debian ${DISTRO_CODENAME}/mongodb-org/${MONGO_VERSION} main" \
    > /etc/apt/sources.list.d/mongodb-org.list

apt-get update
apt-get install -y mongodb-org

echo "Starting MongoDB without authentication for initial setup..."
systemctl enable mongod
systemctl start mongod

echo "Waiting for MongoDB engine to become ready..."
until mongosh --eval "db.adminCommand('ping')" >/dev/null 2>&1; do
    echo "Waiting for MongoDB socket connection..."
    sleep 2
done

echo "Creating admin user (if missing)..."
mongosh admin <<EOF
if (!db.getUser("$DB_ADMIN")) {
  db.createUser({
    user: "$DB_ADMIN",
    pwd: "$DB_ADMIN_PASS",
    roles: [ { role: "root", db: "admin" } ]
  });
  print("Admin user created.");
} else {
  print("Admin user already exists.");
}
EOF

echo "Configuring mongod.conf for remote access & authentication..."
# Set bindIp to 0.0.0.0 for remote access
sed -i 's/bindIp: 127.0.0.1/bindIp: 0.0.0.0/' /etc/mongod.conf

# Enable authorization if not already configured
if ! grep -q "authorization: enabled" /etc/mongod.conf; then
    if grep -q "^security:" /etc/mongod.conf; then
        sed -i '/^security:/a \  authorization: enabled' /etc/mongod.conf
    else
        cat <<EOF >> /etc/mongod.conf

security:
  authorization: enabled
EOF
    fi
fi

echo "Restarting MongoDB with authentication enabled..."
systemctl restart mongod

echo "Waiting for authenticated MongoDB connection..."
until mongosh -u "$DB_ADMIN" -p "$DB_ADMIN_PASS" --authenticationDatabase admin --eval "db.adminCommand('ping')" >/dev/null 2>&1; do
    echo "Waiting for MongoDB startup post-restart..."
    sleep 2
done

echo "Creating application user (if missing)..."
mongosh -u "$DB_ADMIN" -p "$DB_ADMIN_PASS" --authenticationDatabase admin <<EOF
use admin
if (!db.getUser("$APP_USER")) {
  db.createUser({
    user: "$APP_USER",
    pwd: "$APP_PASS",
    roles: [ { role: "readWriteAnyDatabase", db: "admin" } ]
  });
  print("App user created.");
} else {
  print("App user already exists.");
}
EOF

echo "MongoDB $MONGO_VERSION setup completed successfully!"
echo "Connection String format: mongodb://$APP_USER:$APP_PASS@<VM-IP>:27017/foodo?authSource=admin"