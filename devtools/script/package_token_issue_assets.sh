#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLI_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

usage() {
  cat <<'USAGE'
Usage:
  ./developer-tools/devtools/script/package_token_issue_assets.sh [--skip-build]
USAGE
}

skip_build=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      skip_build=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$skip_build" == "0" ]]; then
  echo "[package-token-assets] building CLI dist..."
  npm --prefix "$CLI_ROOT" run build
fi

echo "[package-token-assets] done; token issue is provided by bundled tirtc-issuer-cli"
