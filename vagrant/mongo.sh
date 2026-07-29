#!/bin/bash
set -e

MONGO_VERSION="8.0"

DB_ADMIN="admin"
DB_ADMIN_PASS="admin123"

APP_USER="foodo"
APP_PASS="foodo123"

echo "Updating packages..."
apt-get update
apt-get install -y gnupg curl

echo "Adding MongoDB repository..."

curl -fsSL https://pgp.mongodb.com/server-${MONGO_VERSION}.asc \
| gpg --dearmor -o /usr/share/keyrings/mongodb-server.gpg

echo "deb [ signed-by=/usr/share/keyrings/mongodb-server.gpg ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/${MONGO_VERSION} main" \
> /etc/apt/sources.list.d/mongodb-org.list

apt-get update

echo "Installing MongoDB..."

apt-get install -y mongodb-org

systemctl enable mongod
systemctl start mongod

echo "Waiting for MongoDB..."
sleep 10

echo "Creating admin user..."

mongosh <<EOF
use admin

db.createUser({
  user: "$DB_ADMIN",
  pwd: "$DB_ADMIN_PASS",
  roles: [
    { role: "root", db: "admin" }
  ]
})
EOF

echo "Enabling authentication..."

sed -i '/^#security:/a\security:\n  authorization: enabled' /etc/mongod.conf

sed -i 's/bindIp: 127.0.0.1/bindIp: 0.0.0.0/' /etc/mongod.conf

systemctl restart mongod

sleep 5

echo "Creating application user..."

mongosh \
-u "$DB_ADMIN" \
-p "$DB_ADMIN_PASS" \
--authenticationDatabase admin <<EOF

use admin

db.createUser({
  user: "$APP_USER",
  pwd: "$APP_PASS",
  roles: [
    { role: "readWriteAnyDatabase", db: "admin" }
  ]
})

EOF

echo "MongoDB installed successfully."