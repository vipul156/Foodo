#!/bin/bash
set -e

echo "Checking Redis installation..."
if ! command -v redis-server >/dev/null 2>&1; then
    echo "Updating packages and installing Redis..."
    apt-get update
    apt-get install -y redis-server
fi

echo "Configuring Redis listeners (access governed by redis-sg)..."
# Listen on all interfaces so other VPC hosts can connect; protected-mode
# off allows this, and the security group is the actual access control —
# only realtime-sg is allowed inbound on 6379.
sed -i "s/^bind .*/bind 0.0.0.0/" /etc/redis/redis.conf
sed -i "s/^protected-mode .*/protected-mode no/" /etc/redis/redis.conf

echo "Enabling and starting Redis service..."
systemctl daemon-reload
systemctl enable redis-server
systemctl restart redis-server

echo "Verifying Redis is responding..."
redis-cli ping
