#!/bin/sh
set -e
if [ -f /app/keys.json ]; then
  jq --argjson k "$(cat /app/keys.json)" '.systems = [.systems[] | .keys = $k]' /app/config.json > /tmp/config.json
  exec /usr/local/bin/trunk-recorder --config=/tmp/config.json
fi
exec /usr/local/bin/trunk-recorder "$@"
