#!/bin/sh
set -e
envsubst '$PUBLIC_REST_URL $PUBLIC_RPC_URL $PUBLIC_WEB3AUTH_CLIENT_ID $PUBLIC_WEB3AUTH_NETWORK $PUBLIC_OLLAMA_URL $PUBLIC_OLLAMA_MODEL $PUBLIC_PWR_DENOM' \
  < /docker/config.js.template > /usr/share/nginx/html/config.js
exec "$@"
