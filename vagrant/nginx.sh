#!/bin/bash
set -e

ENV_FILE="/etc/foodo/nginx.env"

echo "=============================="
echo " Installing Nginx"
echo "=============================="

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y nginx gettext-base

if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found"
    exit 1
fi

echo "Loading environment..."

sed -i 's/\r$//' "$ENV_FILE"

set -a
source "$ENV_FILE"
set +a

required_vars=(
    FRONTEND_URL
    AUTH_SERVICE_URL
    RESTAURANT_SERVICE_URL
    RIDER_SERVICE_URL
    ADMIN_SERVICE_URL
    REALTIME_SERVICE_URL
    UTILS_SERVICE_URL
)

for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "ERROR: $var is missing"
        exit 1
    fi
done

cat >/tmp/foodo.conf.template <<'EOF'
server {

    listen 80 default_server;
    server_name _;

    client_max_body_size 50M;

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 256;

    gzip_types
        text/plain
        text/css
        application/json
        application/javascript
        text/xml
        application/xml
        application/xml+rss
        text/javascript
        image/svg+xml;

    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    ###################################################
    # Frontend
    ###################################################

    location / {
        proxy_pass ${FRONTEND_URL};
    }

    ###################################################
    # Auth
    ###################################################

    location /api/auth/ {
        proxy_pass ${AUTH_SERVICE_URL}/api/auth/;
    }

    ###################################################
    # Restaurant
    ###################################################

    location /api/restaurant/ {
        proxy_pass ${RESTAURANT_SERVICE_URL}/api/restaurant/;
    }

    location /api/menu-item/ {
        proxy_pass ${RESTAURANT_SERVICE_URL}/api/menu-item/;
    }

    location /api/cart/ {
        proxy_pass ${RESTAURANT_SERVICE_URL}/api/cart/;
    }

    location /api/order/ {
        proxy_pass ${RESTAURANT_SERVICE_URL}/api/order/;
    }

    location /api/address/ {
        proxy_pass ${RESTAURANT_SERVICE_URL}/api/address/;
    }

    ###################################################
    # Rider
    ###################################################

    location /api/rider/ {
        proxy_pass ${RIDER_SERVICE_URL}/api/rider/;
    }

    ###################################################
    # Admin
    ###################################################

    location /api/admin/ {
        proxy_pass ${ADMIN_SERVICE_URL}/api/admin/;
    }

    ###################################################
    # Utils
    ###################################################

    location /api/utils/ {
        proxy_pass ${UTILS_SERVICE_URL}/api/utils/;
    }

    ###################################################
    # Realtime
    ###################################################

    location /api/internal/ {
        proxy_pass ${REALTIME_SERVICE_URL}/api/internal/;
    }

}
EOF

envsubst \
'${FRONTEND_URL} ${AUTH_SERVICE_URL} ${RESTAURANT_SERVICE_URL} ${RIDER_SERVICE_URL} ${ADMIN_SERVICE_URL} ${REALTIME_SERVICE_URL} ${UTILS_SERVICE_URL}' \
< /tmp/foodo.conf.template \
> /etc/nginx/sites-available/foodo.conf

rm -f /etc/nginx/sites-enabled/default

ln -sf \
    /etc/nginx/sites-available/foodo.conf \
    /etc/nginx/sites-enabled/foodo.conf

echo
echo "Generated nginx config:"
echo "----------------------------------------"
cat /etc/nginx/sites-available/foodo.conf
echo "----------------------------------------"

echo "Testing nginx..."

nginx -t

systemctl enable nginx
systemctl restart nginx

echo
echo "========================================"
echo " Nginx configured successfully"
echo "========================================"