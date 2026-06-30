#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRIVER_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVTOOLS_ROOT="$(cd "$DRIVER_ROOT/.." && pwd)"

resolve_platform() {
  if [[ -n "${TIRTC_RUNTIME_PLATFORM:-}" ]]; then
    printf '%s\n' "$TIRTC_RUNTIME_PLATFORM"
    return
  fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "macos-arm64" ;;
    *) printf '%s\n' "linux-x64" ;;
  esac
}

PLATFORM="$(resolve_platform)"

resolve_runtime_root() {
  local explicit="${TIRTC_DEVTOOLS_RUNTIME_SDK_DIR:-${TIRTC_RUNTIME_SDK_DIR:-${TIRTC_RUNTIME_BUNDLE_ROOT:-}}}"
  if [[ -n "$explicit" ]]; then
    if [[ -d "$explicit/include" ]]; then
      printf '%s\n' "$explicit"
      return
    fi
    if [[ -d "$explicit/$PLATFORM/include" ]]; then
      printf '%s\n' "$explicit/$PLATFORM"
      return
    fi
    echo "[devtools-driver-probe] runtime SDK does not contain include/: $explicit" >&2
    exit 3
  fi
  printf '%s\n' "$DEVTOOLS_ROOT/3rd/runtime/$PLATFORM"
}

RUNTIME_ROOT_RAW="$(resolve_runtime_root)"
RUNTIME_ROOT="$(cd "$RUNTIME_ROOT_RAW" && pwd)"
RUNTIME_INCLUDE_DIR="$RUNTIME_ROOT/include"
OUTPUT_DIR="${TIRTC_DEVTOOLS_DRIVER_TEST_OUTPUT_DIR:-$DEVTOOLS_ROOT/.build/driver/test/$PLATFORM}"
OUTPUT="$OUTPUT_DIR/probe_send_session_contract_test"

required=(
  "$RUNTIME_INCLUDE_DIR/tirtc/audio.h"
  "$RUNTIME_INCLUDE_DIR/tirtc/av.h"
)

for path in "${required[@]}"; do
  if [[ ! -f "$path" ]]; then
    echo "[devtools-driver-probe] missing dependency: $path" >&2
    exit 3
  fi
done

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

"${CXX:-c++}" \
  -std=c++17 \
  -O2 \
  -I "$DRIVER_ROOT/src" \
  -I "$RUNTIME_INCLUDE_DIR" \
  "$DRIVER_ROOT/test/probe_send_session_contract_test.cc" \
  "$DRIVER_ROOT/src/probe_common.cc" \
  "$DRIVER_ROOT/src/probe_send_session.cc" \
  -o "$OUTPUT"

"$OUTPUT"
echo "$OUTPUT"
