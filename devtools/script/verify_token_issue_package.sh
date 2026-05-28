#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLI_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$CLI_ROOT/../.." && pwd)

usage() {
  cat <<'USAGE'
Usage:
  ./developer-tools/devtools/script/verify_token_issue_package.sh <package.tgz>
USAGE
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

tarball_path="$1"
if [[ ! -f "$tarball_path" ]]; then
  echo "[verify-token-package] tarball missing: $tarball_path" >&2
  exit 1
fi

if [[ -z "${TIRTC_ACCESS_KEY_ID:-}" || -z "${TIRTC_SECRET_KEY_ID:-}" || -z "${TIRTC_DEVICE_SECRET_KEY:-}" || -z "${TIRTC_APP_ID:-}" ]]; then
  echo "[verify-token-package] TIRTC_ACCESS_KEY_ID / TIRTC_SECRET_KEY_ID / TIRTC_DEVICE_SECRET_KEY / TIRTC_APP_ID are required" >&2
  exit 1
fi

work_root=$(mktemp -d "${TMPDIR:-/tmp}/tirtc-token-package-XXXXXX")
cleanup() {
  rm -rf "$work_root"
}
trap cleanup EXIT

extract_dir="$work_root/extracted"
mkdir -p "$extract_dir"
tar -xzf "$tarball_path" -C "$extract_dir"

mac_install_root="$work_root/mac-install"
mkdir -p "$mac_install_root"
tar -xzf "$tarball_path" -C "$mac_install_root"

echo "[verify-token-package] installing production dependencies for mac package"
(
  cd "$mac_install_root/package"
  npm install --omit=dev --ignore-scripts >/dev/null
)

for platform in macos-arm64 linux-x64; do
  if [[ ! -f "$mac_install_root/package/vendor/issuer-cli/$platform/tirtc-issuer-cli" ]]; then
    echo "[verify-token-package] missing bundled issuer: vendor/issuer-cli/$platform/tirtc-issuer-cli" >&2
    exit 1
  fi
done

if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  set +e
  issuer_help=$("$mac_install_root/package/vendor/issuer-cli/macos-arm64/tirtc-issuer-cli" serve --help 2>&1)
  issuer_help_status=$?
  set -e
  if [[ $issuer_help_status -ne 2 && $issuer_help_status -ne 0 ]]; then
    echo "$issuer_help" >&2
    exit $issuer_help_status
  fi
  if [[ "$issuer_help" != *"-advertise-host"* ]]; then
    echo "[verify-token-package] bundled macos issuer is stale; missing -advertise-host" >&2
    echo "$issuer_help" >&2
    exit 1
  fi
fi

echo "[verify-token-package] smoke test on macos-arm64 host package"
set +e
mac_output=$(env -i HOME="$HOME" PATH="$PATH" TIRTC_ACCESS_KEY_ID="$TIRTC_ACCESS_KEY_ID" TIRTC_SECRET_KEY_ID="$TIRTC_SECRET_KEY_ID" TIRTC_DEVICE_SECRET_KEY="$TIRTC_DEVICE_SECRET_KEY" TIRTC_APP_ID="$TIRTC_APP_ID" \
  node "$mac_install_root/package/bin/tirtc-devtools-cli.js" --json token issue TEST-PEER --endpoint http://ep-test-tirtc.tange365.com --openapi-endpoint http://api-test-tirtc.tange365.com 2>&1)
mac_status=$?
set -e
if [[ $mac_status -ne 0 ]]; then
  echo "$mac_output" >&2
  exit $mac_status
fi

echo "[verify-token-package] done"
