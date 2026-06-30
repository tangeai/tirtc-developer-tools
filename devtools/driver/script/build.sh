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
case "$PLATFORM" in
  macos-arm64|linux-x64)
    ;;
  *)
    echo "[devtools-driver-probe] unsupported platform: $PLATFORM" >&2
    echo "[devtools-driver-probe] expected macos-arm64|linux-x64" >&2
    exit 3
    ;;
esac

if [[ "${TIRTC_DEVTOOLS_DRIVER_SKIP_TAXONOMY_VERIFY:-0}" != "1" ]]; then
  python3 "$SCRIPT_DIR/verify_reason_taxonomy.py" >&2
fi

resolve_runtime_root() {
  local explicit="${TIRTC_DEVTOOLS_RUNTIME_SDK_DIR:-${TIRTC_RUNTIME_SDK_DIR:-${TIRTC_RUNTIME_BUNDLE_ROOT:-}}}"
  if [[ -n "$explicit" ]]; then
    if [[ -d "$explicit/include" && -d "$explicit/lib" ]]; then
      printf '%s\n' "$explicit"
      return
    fi
    if [[ -d "$explicit/$PLATFORM/include" && -d "$explicit/$PLATFORM/lib" ]]; then
      printf '%s\n' "$explicit/$PLATFORM"
      return
    fi
    echo "[devtools-driver-probe] runtime SDK does not contain include/ and lib/: $explicit" >&2
    exit 3
  fi
  printf '%s\n' "$DEVTOOLS_ROOT/3rd/runtime/$PLATFORM"
}

RUNTIME_ROOT_RAW="$(resolve_runtime_root)"
RUNTIME_ROOT="$(cd "$RUNTIME_ROOT_RAW" && pwd)"
RUNTIME_INCLUDE_DIR="$RUNTIME_ROOT/include"
RUNTIME_LIB_DIR="$RUNTIME_ROOT/lib"
OUTPUT_DIR="${TIRTC_DEVTOOLS_DRIVER_OUTPUT_DIR:-$DEVTOOLS_ROOT/.build/driver/bin/$PLATFORM}"
OUTPUT="$OUTPUT_DIR/devtools_driver_probe"

required=(
  "$RUNTIME_INCLUDE_DIR/tirtc/audio.h"
  "$RUNTIME_INCLUDE_DIR/tirtc/av.h"
  "$RUNTIME_INCLUDE_DIR/tirtc/video_io.h"
)

if [[ "$PLATFORM" == "macos-arm64" ]]; then
  required+=(
    "$RUNTIME_LIB_DIR/libtirtc_av.dylib"
    "$RUNTIME_LIB_DIR/libtgrtc.dylib"
  )
else
  required+=(
    "$RUNTIME_LIB_DIR/libtirtc_av.so"
  )
fi

for path in "${required[@]}"; do
  if [[ ! -f "$path" ]]; then
    echo "[devtools-driver-probe] missing dependency: $path" >&2
    exit 3
  fi
done

host_os="$(uname -s)"
if [[ "$PLATFORM" == "linux-x64" && "$host_os" != "Linux" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "[devtools-driver-probe] docker is required to build linux-x64 driver on $host_os" >&2
    exit 3
  fi

  linux_image="${TIRTC_DEVTOOLS_LINUX_BUILD_IMAGE:-}"
  if [[ -z "$linux_image" ]]; then
    if docker image inspect tirtc-av/linux-build:runtime-release >/dev/null 2>&1; then
      linux_image="tirtc-av/linux-build:runtime-release"
    else
      linux_image="gcc:13"
    fi
  fi

  docker_args=(
    run
    --rm
    --platform linux/amd64
    -e TIRTC_RUNTIME_PLATFORM="$PLATFORM"
    -e TIRTC_DEVTOOLS_RUNTIME_SDK_DIR="$RUNTIME_ROOT"
    -e TIRTC_DEVTOOLS_DRIVER_OUTPUT_DIR="$OUTPUT_DIR"
    -e TIRTC_DEVTOOLS_DRIVER_SKIP_TAXONOMY_VERIFY=1
    -v "$DEVTOOLS_ROOT:$DEVTOOLS_ROOT"
    -w "$DEVTOOLS_ROOT"
  )
  case "$RUNTIME_ROOT" in
    "$DEVTOOLS_ROOT"/*)
      ;;
    *)
      docker_args+=(-v "$RUNTIME_ROOT:$RUNTIME_ROOT:ro")
      ;;
  esac
  case "$OUTPUT_DIR" in
    "$DEVTOOLS_ROOT"/*)
      ;;
    *)
      mkdir -p "$OUTPUT_DIR"
      docker_args+=(-v "$OUTPUT_DIR:$OUTPUT_DIR")
      ;;
  esac
  docker "${docker_args[@]}" "$linux_image" bash "$SCRIPT_DIR/build.sh"
  exit 0
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

sources=(
  "$DRIVER_ROOT/src/probe_common.cc"
  "$DRIVER_ROOT/src/probe_device_bootstrap.cc"
  "$DRIVER_ROOT/src/probe_evidence.cc"
  "$DRIVER_ROOT/src/probe_role_helpers.cc"
  "$DRIVER_ROOT/src/probe_send_session.cc"
  "$DRIVER_ROOT/src/probe_system_send_role.cc"
  "$DRIVER_ROOT/src/probe_send_role.cc"
  "$DRIVER_ROOT/src/probe_receive_role.cc"
  "$DRIVER_ROOT/src/devtools_driver_probe_main.cc"
)

if [[ "$PLATFORM" == "macos-arm64" ]]; then
  c++ \
    -std=c++17 \
    -O2 \
    -I "$RUNTIME_INCLUDE_DIR" \
    "${sources[@]}" \
    -o "$OUTPUT" \
    -L "$RUNTIME_LIB_DIR" \
    -Wl,-rpath,@loader_path \
    -framework CoreFoundation \
    -ltirtc_av
else
  "${CXX:-g++}" \
    -std=c++17 \
    -O2 \
    -I "$RUNTIME_INCLUDE_DIR" \
    "${sources[@]}" \
    -o "$OUTPUT" \
    -L "$RUNTIME_LIB_DIR" \
    -Wl,-rpath,'$ORIGIN' \
    -ltirtc_av
fi

find "$RUNTIME_LIB_DIR" -maxdepth 1 -type f \( -name '*.dylib' -o -name '*.so' \) \
  -exec cp {} "$OUTPUT_DIR/" \;

echo "$OUTPUT"
