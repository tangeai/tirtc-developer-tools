#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
issuer_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
platform="$("$script_dir/host_platform.sh")"
tirtc_av_repo_root="${TIRTC_AV_REPO_ROOT:-}"
if [ -n "$tirtc_av_repo_root" ]; then
  repo_root="$(CDPATH= cd -- "$tirtc_av_repo_root" && pwd)"
  binary="$repo_root/.build/developer-tools/token-issuer/bin/$platform/tirtc-issuer-cli"
else
  repo_root="$(CDPATH= cd -- "$issuer_root/.." && pwd)"
  binary="$repo_root/.build/token-issuer/bin/$platform/tirtc-issuer-cli"
fi

if [ ! -x "$binary" ]; then
  "$script_dir/build.sh" --platform "$platform" >/dev/null
fi

exec "$binary" serve "$@"
