#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLI_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
RELEASE_REPO=${TIRTC_DEVTOOLS_RELEASE_REPO:-tangeai/tirtc-developer-tools}
if [[ -n "${TIRTC_MATRIX_REPO_ROOT:-}" ]]; then
  MATRIX_REPO_ROOT=$(cd "$TIRTC_MATRIX_REPO_ROOT" && pwd)
else
  MATRIX_REPO_ROOT=$(cd "$CLI_ROOT/../.." && pwd)
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
    Darwin) echo "macos-arm64" ;;
    *) echo "linux-x64" ;;
  esac
}

copy_runtime_platform() {
  local source_root="$1"
  local platform="$2"
  local source_dir="$source_root"
  if [[ -d "$source_root/$platform/include" && -d "$source_root/$platform/lib" ]]; then
    source_dir="$source_root/$platform"
  fi
  if [[ ! -d "$source_dir/include" || ! -d "$source_dir/lib" ]]; then
    echo "[devtools runtime] runtime SDK missing include/lib for $platform: $source_root" >&2
    exit 1
  fi
  local target_dir="$CLI_ROOT/3rd/runtime/$platform"
  rm -rf "$target_dir"
  mkdir -p "$(dirname "$target_dir")"
  cp -R "$source_dir" "$target_dir"
}

prepare_from_zip() {
  local zip_path="$1"
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tirtc-devtools-runtime.XXXXXX")"
  python3 - "$zip_path" "$tmp_dir" <<'PY'
import sys
import zipfile

zip_path, tmp_dir = sys.argv[1:3]
with zipfile.ZipFile(zip_path) as archive:
    archive.extractall(tmp_dir)
PY
  local runtime_root=""
  for candidate in "$tmp_dir"/*/3rd/runtime "$tmp_dir"/*/3rd "$tmp_dir"/3rd/runtime "$tmp_dir"/3rd "$tmp_dir"; do
    if [[ -d "$candidate" ]]; then
      runtime_root="$candidate"
      break
    fi
  done
  if [[ -z "$runtime_root" ]]; then
    echo "[devtools runtime] cannot locate runtime SDK in zip: $zip_path" >&2
    exit 1
  fi
  for platform in "$@"; do
    if [[ "$platform" == "$zip_path" ]]; then
      continue
    fi
    copy_runtime_platform "$runtime_root" "$platform"
  done
  rm -rf "$tmp_dir"
}

download_latest_release_asset() {
  local output_zip="$1"
  command -v curl >/dev/null 2>&1 || {
    echo "[devtools runtime] missing command: curl" >&2
    exit 3
  }

  local latest_url="https://github.com/$RELEASE_REPO/releases/latest"
  local effective_url
  effective_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$latest_url")
  local timestamp="${effective_url##*/}"
  case "$timestamp" in
    *[!0-9]*|"")
      echo "[devtools runtime] latest release tag is not a timestamp: $timestamp" >&2
      exit 3
      ;;
  esac
  if [[ "${#timestamp}" -ne 14 ]]; then
    echo "[devtools runtime] latest release tag must be YYYYMMDDHHMMSS: $timestamp" >&2
    exit 3
  fi

  local asset_url="https://github.com/$RELEASE_REPO/releases/download/$timestamp/devtools-runtime-sdk-$timestamp.zip"
  echo "[devtools runtime] downloading $asset_url"
  curl -fL "$asset_url" -o "$output_zip"
}

platforms=()
while IFS= read -r platform; do
  if [[ -n "$platform" ]]; then
    case "$platform" in
      macos-arm64|linux-x64) platforms+=("$platform") ;;
      *)
        echo "[devtools runtime] unsupported platform: $platform" >&2
        exit 2
        ;;
    esac
  fi
done < <(resolve_platforms)

if [[ -n "${TIRTC_DEVTOOLS_RUNTIME_SDK_DIR:-${TIRTC_RUNTIME_SDK_DIR:-}}" ]]; then
  sdk_dir="${TIRTC_DEVTOOLS_RUNTIME_SDK_DIR:-${TIRTC_RUNTIME_SDK_DIR:-}}"
  for platform in "${platforms[@]}"; do
    copy_runtime_platform "$sdk_dir" "$platform"
  done
elif [[ -n "${TIRTC_DEVTOOLS_RUNTIME_SDK_ZIP:-}" ]]; then
  prepare_from_zip "$TIRTC_DEVTOOLS_RUNTIME_SDK_ZIP" "${platforms[@]}"
elif [[ -x "$MATRIX_REPO_ROOT/runtime/script/prepare_product_runtime.sh" ]]; then
  for platform in "${platforms[@]}"; do
    echo "[devtools runtime] preparing Matrix runtime SDK for $platform..."
    "$MATRIX_REPO_ROOT/runtime/script/prepare_product_runtime.sh" --platform "$platform"
    copy_runtime_platform "$MATRIX_REPO_ROOT/.build/products/runtime" "$platform"
  done
else
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tirtc-devtools-runtime-sdk.XXXXXX")"
  tmp_zip="$tmp_dir/runtime-sdk.zip"
  echo "[devtools runtime] downloading latest runtime SDK release asset..."
  download_latest_release_asset "$tmp_zip"
  prepare_from_zip "$tmp_zip" "${platforms[@]}"
  rm -rf "$tmp_dir"
fi

echo "[devtools runtime] staged runtime SDK under $CLI_ROOT/3rd/runtime"
