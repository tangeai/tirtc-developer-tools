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

python3 "$SCRIPT_DIR/verify_reason_taxonomy.py" >&2

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

RUNTIME_ROOT="$(resolve_runtime_root)"
RUNTIME_INCLUDE_DIR="$RUNTIME_ROOT/include"
RUNTIME_LIB_DIR="$RUNTIME_ROOT/lib"
FFMPEG_STATIC_DIR="$RUNTIME_LIB_DIR"
OUTPUT_DIR="${TIRTC_DEVTOOLS_DRIVER_OUTPUT_DIR:-$DEVTOOLS_ROOT/.build/driver/bin/$PLATFORM}"
OUTPUT="$OUTPUT_DIR/devtools_driver_probe"

required=(
  "$RUNTIME_INCLUDE_DIR/tirtc/audio.h"
  "$RUNTIME_INCLUDE_DIR/tirtc/av.h"
  "$RUNTIME_INCLUDE_DIR/tirtc/video_io.h"
  "$RUNTIME_LIB_DIR/libmatrix_runtime_facade.a"
  "$RUNTIME_LIB_DIR/libmatrix_runtime_transport.a"
  "$RUNTIME_LIB_DIR/libmatrix_runtime_media.a"
  "$RUNTIME_LIB_DIR/libmatrix_runtime_audio.a"
  "$RUNTIME_LIB_DIR/libmatrix_runtime_video.a"
  "$RUNTIME_LIB_DIR/libmatrix_runtime_foundation_logging.a"
  "$RUNTIME_LIB_DIR/libmatrix_runtime_foundation_http.a"
  "$RUNTIME_LIB_DIR/libwebrtc_apm.a"
  "$RUNTIME_LIB_DIR/libxlog.a"
  "$RUNTIME_LIB_DIR/libTiRTC.a"
  "$RUNTIME_LIB_DIR/libssl.a"
  "$RUNTIME_LIB_DIR/libcrypto.a"
  "$FFMPEG_STATIC_DIR/libavcodec.a"
  "$FFMPEG_STATIC_DIR/libavutil.a"
  "$FFMPEG_STATIC_DIR/libswscale.a"
  "$FFMPEG_STATIC_DIR/libswresample.a"
  "$FFMPEG_STATIC_DIR/libavformat.a"
  "$FFMPEG_STATIC_DIR/libavfilter.a"
  "$FFMPEG_STATIC_DIR/libpostproc.a"
  "$FFMPEG_STATIC_DIR/libx264.a"
)

if [[ "$PLATFORM" == "macos-arm64" ]]; then
  required+=(
    "$RUNTIME_LIB_DIR/libtgrtc.dylib"
    "$RUNTIME_LIB_DIR/libTGTRP.a"
  )
else
  required+=(
    "$RUNTIME_LIB_DIR/libwebrtc.a"
    "$RUNTIME_LIB_DIR/libusrsctp.a"
    "$RUNTIME_LIB_DIR/libmbedtls.a"
  )
fi

for path in "${required[@]}"; do
  if [[ ! -f "$path" ]]; then
    echo "[devtools-driver-probe] missing dependency: $path" >&2
    exit 3
  fi
done

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

sources=(
  "$DRIVER_ROOT/src/probe_common.cc"
  "$DRIVER_ROOT/src/probe_evidence.cc"
  "$DRIVER_ROOT/src/probe_role_helpers.cc"
  "$DRIVER_ROOT/src/probe_send_session.cc"
  "$DRIVER_ROOT/src/probe_send_role.cc"
  "$DRIVER_ROOT/src/probe_receive_role.cc"
  "$DRIVER_ROOT/src/devtools_driver_probe_main.cc"
)

runtime_libs=(
  "$RUNTIME_LIB_DIR/libmatrix_runtime_facade.a" \
  "$RUNTIME_LIB_DIR/libmatrix_runtime_transport.a" \
  "$RUNTIME_LIB_DIR/libmatrix_runtime_media.a" \
  "$RUNTIME_LIB_DIR/libmatrix_runtime_audio.a" \
  "$RUNTIME_LIB_DIR/libmatrix_runtime_video.a" \
  "$RUNTIME_LIB_DIR/libmatrix_runtime_foundation_logging.a" \
  "$RUNTIME_LIB_DIR/libmatrix_runtime_foundation_http.a" \
  "$RUNTIME_LIB_DIR/libwebrtc_apm.a" \
  "$RUNTIME_LIB_DIR/libxlog.a" \
  "$RUNTIME_LIB_DIR/libTiRTC.a"
)
if [[ -f "$RUNTIME_LIB_DIR/libmatrix_runtime_credential.a" ]]; then
  runtime_libs+=("$RUNTIME_LIB_DIR/libmatrix_runtime_credential.a")
fi
if [[ "$PLATFORM" == "linux-x64" ]]; then
  runtime_libs+=(
    "$RUNTIME_LIB_DIR/libwebrtc.a" \
    "$RUNTIME_LIB_DIR/libusrsctp.a" \
    "$RUNTIME_LIB_DIR/libmbedtls.a"
  )
fi

ffmpeg_libs=(
  "$FFMPEG_STATIC_DIR/libavcodec.a" \
  "$FFMPEG_STATIC_DIR/libavutil.a" \
  "$FFMPEG_STATIC_DIR/libswscale.a" \
  "$FFMPEG_STATIC_DIR/libswresample.a" \
  "$FFMPEG_STATIC_DIR/libavformat.a" \
  "$FFMPEG_STATIC_DIR/libavfilter.a" \
  "$FFMPEG_STATIC_DIR/libpostproc.a" \
  "$FFMPEG_STATIC_DIR/libx264.a"
)

if [[ "$PLATFORM" == "macos-arm64" ]]; then
  c++ \
    -std=c++17 \
    -O2 \
    -I "$RUNTIME_INCLUDE_DIR" \
    "${sources[@]}" \
    -o "$OUTPUT" \
    "${runtime_libs[@]}" \
    "$RUNTIME_LIB_DIR/libTGTRP.a" \
    "$RUNTIME_LIB_DIR/libssl.a" \
    "$RUNTIME_LIB_DIR/libcrypto.a" \
    "${ffmpeg_libs[@]}" \
    -framework AudioToolbox \
    -framework Foundation \
    -framework CoreFoundation \
    -framework CoreMedia \
    -framework CoreVideo \
    -framework VideoToolbox \
    -framework CoreGraphics \
    -framework AppKit \
    -framework Security \
    -lobjc \
    -lz \
    -lpthread \
    -lm
  ln -sf "$RUNTIME_LIB_DIR/libtgrtc.dylib" "$OUTPUT_DIR/libtgrtc.dylib"
else
  "${CXX:-g++}" \
    -std=c++17 \
    -O2 \
    -I "$RUNTIME_INCLUDE_DIR" \
    "${sources[@]}" \
    -o "$OUTPUT" \
    -Wl,--start-group \
    "${runtime_libs[@]}" \
    "$RUNTIME_LIB_DIR/libssl.a" \
    "$RUNTIME_LIB_DIR/libcrypto.a" \
    "${ffmpeg_libs[@]}" \
    -Wl,--end-group \
    -ldl \
    -lpthread \
    -lm \
    -lz
fi

echo "$OUTPUT"
