#!/bin/bash

services=(
  auth
  admin
  restaurant
  rider
  realtime
  utils
)

for service in "${services[@]}"; do
    echo "Starting $service..."
    (
      cd "$service" || exit
      npm run dev
    ) &
done

wait