#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLI_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DEVELOPER_TOOLS_ROOT=$(cd "$CLI_ROOT/.." && pwd)
if [[ -n "${TIRTC_MATRIX_REPO_ROOT:-}" ]]; then
  REPO_ROOT=$(cd "$TIRTC_MATRIX_REPO_ROOT" && pwd)
elif [[ -x "$CLI_ROOT/../../runtime/script/prepare_product_runtime.sh" ]]; then
  REPO_ROOT=$(cd "$CLI_ROOT/../.." && pwd)
else
  REPO_ROOT="$DEVELOPER_TOOLS_ROOT"
fi

resolve_platforms() {
  if [[ -n "${TIRTC_RUNTIME_PLATFORMS:-}" ]]; then
    printf '%s\n' $TIRTC_RUNTIME_PLATFORMS
    return
  fi

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

platforms=()
while IFS= read -r platform; do
  if [[ -n "$platform" ]]; then
    platforms+=("$platform")
  fi
done < <(resolve_platforms)
if [[ "${#platforms[@]}" -eq 0 ]]; then
  echo "[package] no runtime platforms resolved" >&2
  exit 1
fi

export TIRTC_RUNTIME_PREPARE_FORCE_REBUILD="${TIRTC_RUNTIME_PREPARE_FORCE_REBUILD:-1}"

copy_dir_contents() {
  local source_dir="$1"
  local target_dir="$2"
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  cp -R "$source_dir/." "$target_dir/"
}

stage_driver_runtime_dependencies() {
  local platform="$1"
  local runtime_dir="$2"
  local driver_dir="$3"

  case "$platform" in
    macos-arm64)
      rm -f "$driver_dir/libtgrtc.dylib"
      cp "$runtime_dir/lib/libtgrtc.dylib" "$driver_dir/libtgrtc.dylib"
      ;;
  esac
}

echo "[package] Building CLI..."
npm --prefix "$CLI_ROOT" run build

mkdir -p "$CLI_ROOT/.build"
echo "[package] Preparing runtime SDK input..."
TIRTC_RUNTIME_PLATFORMS="${platforms[*]}" "$SCRIPT_DIR/prepare_runtime.sh"

echo "[package] Syncing package staging payload..."
rm -rf "$CLI_ROOT/vendor"
mkdir -p "$CLI_ROOT/vendor/devtools/driver" "$CLI_ROOT/vendor/runtime"
mkdir -p "$CLI_ROOT/vendor/issuer-cli"

for platform in "${platforms[@]}"; do
  case "$platform" in
    macos-arm64|linux-x64)
      ;;
    *)
      echo "[package] unsupported platform: $platform (expected macos-arm64|linux-x64)" >&2
      exit 1
      ;;
  esac

  runtime_sdk="$CLI_ROOT/3rd/runtime/$platform"
  if [[ ! -d "$runtime_sdk/include" || ! -d "$runtime_sdk/lib" ]]; then
    echo "[package] runtime SDK not prepared for $platform: $runtime_sdk" >&2
    exit 1
  fi

  echo "[package] Building DevTools native driver: $platform"
  TIRTC_RUNTIME_PLATFORM="$platform" \
    TIRTC_DEVTOOLS_RUNTIME_SDK_DIR="$runtime_sdk" \
    "$CLI_ROOT/driver/script/build.sh" >/dev/null

  copy_dir_contents "$runtime_sdk" \
    "$CLI_ROOT/vendor/runtime/$platform"
  copy_dir_contents "$CLI_ROOT/.build/driver/bin/$platform" \
    "$CLI_ROOT/vendor/devtools/driver/$platform"
  stage_driver_runtime_dependencies \
    "$platform" \
    "$CLI_ROOT/vendor/runtime/$platform" \
    "$CLI_ROOT/vendor/devtools/driver/$platform"

  echo "[package] Building token issuer: $platform"
  issuer_bin="$("$DEVELOPER_TOOLS_ROOT/token-issuer/script/build.sh" --platform "$platform")"
  mkdir -p "$CLI_ROOT/vendor/issuer-cli/$platform"
  cp "$issuer_bin" "$CLI_ROOT/vendor/issuer-cli/$platform/tirtc-issuer-cli"
done

mkdir -p "$CLI_ROOT/vendor/runtime/script"
if [[ -f "$REPO_ROOT/runtime/script/prepare_runtime_media_dataset.sh" ]]; then
  cp "$REPO_ROOT/runtime/script/prepare_runtime_media_dataset.sh" \
    "$CLI_ROOT/vendor/runtime/script/prepare_runtime_media_dataset.sh"
fi

echo "[package] Done. Package staging surface staged under vendor/ (gitignored ephemeral surface)."
