#!/bin/sh
set -e
envsubst < /docker/config.js.template > /usr/share/nginx/html/config.js
exec "$@"
