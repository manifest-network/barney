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

# The morpheus location block concatenates this URL with the request path tail
# and query string ("$URL/$1$is_args$args"), so any '?' or '#' embedded in the
# env var would silently corrupt every upstream request. Reject loudly here.
case "$PUBLIC_MORPHEUS_URL" in
  *[?\#]*)
    echo "ERROR: PUBLIC_MORPHEUS_URL must not contain '?' or '#' (got: $PUBLIC_MORPHEUS_URL)" >&2
    exit 1
    ;;
esac

# Extract IPv4 DNS resolvers from /etc/resolv.conf for nginx's `resolver`
# directive (used by the morpheus location block — see template). Falls back
# to public DNS if /etc/resolv.conf is missing, empty, or has no IPv4 entries.
# This mirrors what the upstream nginx:alpine image does in
# /docker-entrypoint.d/15-local-resolvers.envsh, which we bypass because
# env.sh is the entrypoint instead of docker-entrypoint.sh.
#
# IPv4-only filter: nginx accepts IPv6 resolvers only when bracketed
# (e.g. `[2001:db8::1]`), and busybox awk doesn't preserve brackets — so we
# drop IPv6 entries and let the fallback fire if none remain.
# `tr -d '\r'` strips CRLF that can leak in from Windows-edited bind mounts.
NGINX_RESOLVERS="$(tr -d '\r' < /etc/resolv.conf 2>/dev/null | awk '/^nameserver[[:space:]]/ && $2 ~ /^[0-9.]+$/ { print $2 }' | tr '\n' ' ' | sed 's/ *$//')"
if [ -z "$NGINX_RESOLVERS" ]; then
  NGINX_RESOLVERS="1.1.1.1 8.8.8.8"
fi
export NGINX_RESOLVERS

# Generate nginx config with Morpheus proxy settings (server-side secrets)
envsubst '$MORPHEUS_API_KEY $PUBLIC_MORPHEUS_URL $NGINX_RESOLVERS' \
  < /docker/nginx.conf.template > /etc/nginx/conf.d/default.conf

# Generate runtime config.js for the browser (public vars only — no secrets)
envsubst '$PUBLIC_REST_URL $PUBLIC_RPC_URL $PUBLIC_WEB3AUTH_CLIENT_ID $PUBLIC_WEB3AUTH_NETWORK $PUBLIC_MORPHEUS_MODEL $PUBLIC_PWR_DENOM $PUBLIC_GAS_PRICE $PUBLIC_CHAIN_ID $PUBLIC_FAUCET_URL $PUBLIC_AI_STREAM_TIMEOUT_MS $PUBLIC_AI_DEPLOY_PROVISION_TIMEOUT_MS $PUBLIC_AI_TOOL_API_TIMEOUT_MS $PUBLIC_AI_MAX_RETRIES $PUBLIC_AI_CONFIRMATION_TIMEOUT_MS $PUBLIC_AI_MAX_TOOL_ITERATIONS $PUBLIC_AI_MAX_MESSAGES $PUBLIC_AI_BATCH_DEPLOY_CONCURRENCY' \
  < /docker/config.js.template > /usr/share/nginx/html/config.js

exec "$@"
