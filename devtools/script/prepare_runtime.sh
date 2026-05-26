#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../../../.." && pwd)

resolve_platform() {
  if [[ -n "${TIRTC_RUNTIME_PLATFORM:-}" ]]; then
    echo "$TIRTC_RUNTIME_PLATFORM"
    return
  fi

  case "$(uname -s)" in
    Darwin)
      echo "macos-arm64"
      ;;
    *)
      echo "linux-x64"
      ;;
  esac
}

platform="$(resolve_platform)"
stage_dir="$REPO_ROOT/.build/products/runtime/$platform"
target_dir="$REPO_ROOT/developer-tools/public/devtools/bin/runtime/$platform"

echo "[devtools runtime] preparing staged runtime bundle for $platform..."
"$REPO_ROOT/runtime/script/prepare_product_runtime.sh" --platform "$platform"

if [[ ! -d "$stage_dir/include" || ! -d "$stage_dir/lib" || ! -f "$stage_dir/manifest.txt" ]]; then
  echo "[devtools runtime] staged runtime bundle is not ready: $stage_dir" >&2
  exit 1
fi

echo "[devtools runtime] syncing staged runtime bundle -> $target_dir"
rm -rf "$target_dir"
mkdir -p "$(dirname "$target_dir")"
cp -R "$stage_dir" "$target_dir"

echo "[devtools runtime] done"
