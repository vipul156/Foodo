#!/bin/bash
set -e

echo "Checking RabbitMQ installation..."
if ! command -v rabbitmq-server >/dev/null 2>&1; then
    echo "Updating packages and installing RabbitMQ..."
    apt-get update
    apt-get install -y rabbitmq-server
fi

echo "Enabling RabbitMQ Management Plugin..."
rabbitmq-plugins enable rabbitmq_management

echo "Configuring network & remote access listeners..."
mkdir -p /etc/rabbitmq
cat > /etc/rabbitmq/rabbitmq.conf <<EOF
loopback_users = none
listeners.tcp.default = 5672
management.tcp.port = 15672
management.tcp.ip = 0.0.0.0
EOF

echo "Enabling and starting RabbitMQ service..."
systemctl daemon-reload
systemctl enable rabbitmq-server
systemctl restart rabbitmq-server

echo "Configuring RabbitMQ user permissions..."
RABBIT_USER="test"
RABBIT_PASS="test"

# Check if user exists; create if missing, update password if existing
if rabbitmqctl list_users | grep -q "^${RABBIT_USER}\b"; then
    echo "User '${RABBIT_USER}' already exists. Updating password..."
    rabbitmqctl change_password "$RABBIT_USER" "$RABBIT_PASS"
else
    echo "Creating user '${RABBIT_USER}'..."
    rabbitmqctl add_user "$RABBIT_USER" "$RABBIT_PASS"
fi

echo "Setting administrator tags and permissions..."
rabbitmqctl set_user_tags "$RABBIT_USER" administrator
rabbitmqctl set_permissions -p / "$RABBIT_USER" ".*" ".*" ".*"

echo "RabbitMQ installed and configured successfully!"
echo "Management Console available at: http://<VM-IP>:15672"