#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
issuer_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
image_tag="${TIRTC_TOKEN_ISSUER_IMAGE_TAG:-tirtc-token-issuer:local}"
host_port="${TIRTC_TOKEN_ISSUER_HOST_PORT:-8966}"
container_port="8966"

for arg in "$@"; do
  if [ "$arg" = "--port" ]; then
    echo "serve_docker.sh maps host port with TIRTC_TOKEN_ISSUER_HOST_PORT; container service port remains 8966" >&2
  fi
done

docker build -t "$image_tag" "$issuer_root"
exec docker run --rm \
  -e TIRTC_ACCESS_KEY_ID \
  -e TIRTC_SECRET_KEY_ID \
  -e TIRTC_DEVICE_SECRET_KEY \
  -p "$host_port:$container_port" \
  "$image_tag" serve "$@"
