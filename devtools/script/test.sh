#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cli_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
if [[ -n "${TIRTC_AV_REPO_ROOT:-}" ]]; then
  repo_root="$(CDPATH= cd -- "$TIRTC_AV_REPO_ROOT" && pwd)"
else
  repo_root="$(CDPATH= cd -- "$script_dir/../../.." && pwd)"
fi

resolve_platform() {
  if [[ -n "${TIRTC_RUNTIME_PLATFORM:-}" ]]; then
    echo "$TIRTC_RUNTIME_PLATFORM"
    return
  fi

  local os
  local arch
  os="$(uname -s)"
  arch="$(uname -m)"

  if [[ "$os" == "Darwin" && "$arch" == "arm64" ]]; then
    echo "macos-arm64"
    return
  fi

  echo "linux-x64"
}

mode="${1:-acceptance}"
platform="$(resolve_platform)"

case "$mode" in
  owner)
    npm --prefix "$cli_root" test -- --runInBand
    ;;
  package)
    npm --prefix "$cli_root" test -- --runInBand tests/token_tool.test.ts tests/embedded_paths.test.ts tests/issuer_resolver.test.ts tests/media_assets_prepare.test.ts tests/smoke.test.ts
    ;;
  real-transport)
    echo "[cli real-transport] use developer-tools/devtools/driver/script/run_capability_probe.sh"
    ;;
  e2e)
    echo "[cli e2e] use developer-tools/devtools/driver/script/run_capability_probe.sh"
    ;;
  two-endpoints)
    echo "[cli two-endpoints] removed with legacy Host"
    ;;
  cli-e2e)
    "$cli_root/driver/script/run_capability_probe.sh"
    ;;
  acceptance)
    npm --prefix "$cli_root" test -- --runInBand
    "$cli_root/driver/script/run_capability_probe.sh"
    ;;
  *)
    echo "unknown mode: $mode" >&2
    echo "usage: ./developer-tools/devtools/script/test.sh [owner|package|real-transport|e2e|two-endpoints|cli-e2e|acceptance]" >&2
    exit 2
    ;;
esac
