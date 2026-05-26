#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
issuer_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
repo_root="$(CDPATH= cd -- "$issuer_root/../../.." && pwd)"
platform="$("$script_dir/host_platform.sh")"
binary="$repo_root/.build/developer-tools/public/token-issuer/bin/$platform/tirtc-issuer-cli"

if [ ! -x "$binary" ]; then
  "$script_dir/build.sh" --platform "$platform" >/dev/null
fi

exec "$binary" serve "$@"
