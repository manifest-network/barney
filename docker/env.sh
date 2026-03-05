#!/bin/sh
set -e

# Normalize: strip trailing slash from Morpheus URL to avoid double-slash in proxy_pass
PUBLIC_MORPHEUS_URL="${PUBLIC_MORPHEUS_URL%/}"
export PUBLIC_MORPHEUS_URL

# Fail fast if PUBLIC_MORPHEUS_URL is not provided
if [ -z "$PUBLIC_MORPHEUS_URL" ]; then
  echo "ERROR: PUBLIC_MORPHEUS_URL is required but not set or empty." >&2
  exit 1
fi

# Generate nginx config with Morpheus proxy settings (server-side secrets)
envsubst '$MORPHEUS_API_KEY $PUBLIC_MORPHEUS_URL' \
  < /docker/nginx.conf.template > /etc/nginx/conf.d/default.conf

# Generate runtime config.js for the browser (public vars only — no secrets)
envsubst '$PUBLIC_REST_URL $PUBLIC_RPC_URL $PUBLIC_WEB3AUTH_CLIENT_ID $PUBLIC_WEB3AUTH_NETWORK $PUBLIC_MORPHEUS_MODEL $PUBLIC_PWR_DENOM $PUBLIC_GAS_PRICE $PUBLIC_CHAIN_ID $PUBLIC_FAUCET_URL $PUBLIC_AI_STREAM_TIMEOUT_MS $PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS $PUBLIC_AI_TOOL_API_TIMEOUT_MS $PUBLIC_AI_MAX_RETRIES $PUBLIC_AI_CONFIRMATION_TIMEOUT_MS $PUBLIC_AI_MAX_TOOL_ITERATIONS $PUBLIC_AI_MAX_MESSAGES' \
  < /docker/config.js.template > /usr/share/nginx/html/config.js

exec "$@"
