#!/bin/bash
set -e

echo "Updating packages..."
sudo apt update
sudo apt install -y rabbitmq-server

echo "Starting RabbitMQ..."
sudo systemctl enable rabbitmq-server
sudo systemctl start rabbitmq-server

echo "Enable Management Plugin..."
sudo rabbitmq-plugins enable rabbitmq_management

echo "Configure remote access..."
sudo tee /etc/rabbitmq/rabbitmq.conf > /dev/null <<EOF
loopback_users = none
listeners.tcp.default = 5672
management.tcp.port = 15672
management.tcp.ip = 0.0.0.0
EOF

echo "Creating user..."
sudo rabbitmqctl add_user test test || true
sudo rabbitmqctl set_user_tags test administrator
sudo rabbitmqctl set_permissions -p / test ".*" ".*" ".*"

sudo systemctl restart rabbitmq-server

echo "RabbitMQ Installed Successfully!"