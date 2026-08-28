#!/bin/sh
set -e

BARNEY_TRUSTED_PROXY_CIDR="${BARNEY_TRUSTED_PROXY_CIDR:-127.0.0.1/32}"
MORPHEUS_RELAY_PORT="${MORPHEUS_RELAY_PORT:-8081}"
export BARNEY_TRUSTED_PROXY_CIDR MORPHEUS_RELAY_PORT

case "$MORPHEUS_RELAY_PORT" in
  *[!0-9]*|'')
    echo "ERROR: MORPHEUS_RELAY_PORT must be a numeric TCP port." >&2
    exit 1
    ;;
esac
if [ "$MORPHEUS_RELAY_PORT" -gt 65535 ] || [ "$MORPHEUS_RELAY_PORT" -lt 1 ]; then
  echo "ERROR: MORPHEUS_RELAY_PORT must be between 1 and 65535." >&2
  exit 1
fi

validate_proxy_cidr() (
  set -f
  value=$1
  case "$value" in
    ''|*[!0-9./]*|*/*/*) exit 1 ;;
  esac
  address=${value%/32}
  [ "$address/32" = "$value" ] || exit 1
  [ "$address" != "0.0.0.0" ] || exit 1
  IFS=.
  set -- $address
  [ "$#" -eq 4 ] || exit 1
  for octet do
    case "$octet" in
      ''|*[!0-9]*) exit 1 ;;
    esac
    [ "$octet" -le 255 ] || exit 1
  done
)

if ! validate_proxy_cidr "$BARNEY_TRUSTED_PROXY_CIDR"; then
  echo "ERROR: BARNEY_TRUSTED_PROXY_CIDR must be one explicit nonzero IPv4 /32 address." >&2
  exit 1
fi

# Generate nginx config without secrets. The paid key remains only in the relay
# process environment and never appears in generated nginx configuration.
envsubst '$BARNEY_TRUSTED_PROXY_CIDR $MORPHEUS_RELAY_PORT' \
  < /docker/nginx.conf.template > /etc/nginx/conf.d/default.conf

# Generate runtime config.js for the browser (public vars only — no secrets).
# Build the object with jq so every value is correctly JSON-escaped, then wrap it
# as a JS string literal for JSON.parse() — no PUBLIC_* value (quote, backslash,
# newline, etc.) can break out of the literal. Unset var → "" (matches the
# DEFAULTS fallback in runtimeConfig.ts).
CONFIG_JSON=$(jq -cn \
  --arg PUBLIC_REST_URL "$PUBLIC_REST_URL" \
  --arg PUBLIC_RPC_URL "$PUBLIC_RPC_URL" \
  --arg PUBLIC_WEB3AUTH_CLIENT_ID "$PUBLIC_WEB3AUTH_CLIENT_ID" \
  --arg PUBLIC_WEB3AUTH_NETWORK "$PUBLIC_WEB3AUTH_NETWORK" \
  --arg PUBLIC_MORPHEUS_MODEL "$PUBLIC_MORPHEUS_MODEL" \
  --arg PUBLIC_PWR_DENOM "$PUBLIC_PWR_DENOM" \
  --arg PUBLIC_GAS_PRICE "$PUBLIC_GAS_PRICE" \
  --arg PUBLIC_CHAIN_ID "$PUBLIC_CHAIN_ID" \
  --arg PUBLIC_FAUCET_URL "$PUBLIC_FAUCET_URL" \
  --arg PUBLIC_AI_STREAM_TIMEOUT_MS "$PUBLIC_AI_STREAM_TIMEOUT_MS" \
  --arg PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS "$PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS" \
  --arg PUBLIC_AI_TOOL_API_TIMEOUT_MS "$PUBLIC_AI_TOOL_API_TIMEOUT_MS" \
  --arg PUBLIC_AI_MAX_RETRIES "$PUBLIC_AI_MAX_RETRIES" \
  --arg PUBLIC_AI_CONFIRMATION_TIMEOUT_MS "$PUBLIC_AI_CONFIRMATION_TIMEOUT_MS" \
  --arg PUBLIC_AI_MAX_TOOL_ITERATIONS "$PUBLIC_AI_MAX_TOOL_ITERATIONS" \
  --arg PUBLIC_AI_MAX_MESSAGES "$PUBLIC_AI_MAX_MESSAGES" \
  --arg PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY "$PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY" \
  --arg PUBLIC_SKU_SPECS "$PUBLIC_SKU_SPECS" \
  '$ARGS.named')
RUNTIME_CONFIG_JS=$(printf '%s' "$CONFIG_JSON" | jq -Rs .)
export RUNTIME_CONFIG_JS
envsubst '$RUNTIME_CONFIG_JS' \
  < /docker/config.js.template > /usr/share/nginx/html/config.js

# Validate the rendered nginx config before starting — surfaces module load
# failures, envsubst errors, and syntax issues with a clear diagnostic
# instead of a cryptic crash loop.
nginx -t || { echo "ERROR: nginx config validation failed after envsubst." >&2; exit 1; }

if [ "$#" -eq 0 ]; then
  set -- node /opt/barney-relay/main.mjs
fi
exec "$@"
