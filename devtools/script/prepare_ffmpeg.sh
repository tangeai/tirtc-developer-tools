#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../../../.." && pwd)

usage() {
  cat <<'USAGE'
Usage:
  ./developer-tools/public/devtools/script/prepare_ffmpeg.sh [--platform macos-arm64|linux-x64] [--check-only]

Behavior:
  - Prepares developer-tools/public/devtools/bin/tools/<platform>/
  - Reuses existing prepared binaries when present
  - On prepare, prefers system ffmpeg/ffprobe, then user cache, then network download
USAGE
}

resolve_platform() {
  if [[ -n "${TIRTC_RUNTIME_PLATFORM:-}" ]]; then
    echo "$TIRTC_RUNTIME_PLATFORM"
    return
  fi

  case "$(uname -s):$(uname -m)" in
    Darwin:arm64)
      echo "macos-arm64"
      ;;
    *)
      echo "linux-x64"
      ;;
  esac
}

resolve_cache_root() {
  if [[ -n "${TIRTC_FFMPEG_CACHE_DIR:-}" ]]; then
    echo "$TIRTC_FFMPEG_CACHE_DIR"
    return
  fi

  echo "$HOME/.tirtc-devtools-cli/tools/ffmpeg"
}

resolve_system_tool() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    return 1
  fi

  command -v "$command_name"
}

link_tool_pair() {
  local source_ffmpeg="$1"
  local source_ffprobe="$2"

  rm -f "$ffmpeg_bin" "$ffprobe_bin"
  ln -sf "$source_ffmpeg" "$ffmpeg_bin"
  ln -sf "$source_ffprobe" "$ffprobe_bin"
  "$ffmpeg_bin" -version >/dev/null
  "$ffprobe_bin" -version >/dev/null
}

prepare_from_system_tools() {
  local system_ffmpeg=""
  local system_ffprobe=""

  system_ffmpeg="$(resolve_system_tool ffmpeg || true)"
  system_ffprobe="$(resolve_system_tool ffprobe || true)"
  if [[ -z "$system_ffmpeg" || -z "$system_ffprobe" ]]; then
    return 1
  fi

  link_tool_pair "$system_ffmpeg" "$system_ffprobe"
  echo "[ffmpeg] prepared from system tools: $tool_dir"
}

prepare_from_cache() {
  local cache_root=""
  local cache_dir=""
  local cached_ffmpeg=""
  local cached_ffprobe=""

  cache_root="$(resolve_cache_root)"
  cache_dir="$cache_root/$platform"
  cached_ffmpeg="$cache_dir/ffmpeg"
  cached_ffprobe="$cache_dir/ffprobe"

  if [[ ! -x "$cached_ffmpeg" || ! -x "$cached_ffprobe" ]]; then
    return 1
  fi

  link_tool_pair "$cached_ffmpeg" "$cached_ffprobe"
  echo "[ffmpeg] prepared from cache: $tool_dir"
}

platform=""
check_only="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      platform="$2"
      shift 2
      ;;
    --check-only)
      check_only="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$platform" ]]; then
  platform="$(resolve_platform)"
fi

if [[ "$platform" != "macos-arm64" && "$platform" != "linux-x64" ]]; then
  echo "unsupported platform: $platform (expected macos-arm64|linux-x64)" >&2
  exit 1
fi

tool_dir="$REPO_ROOT/developer-tools/public/devtools/bin/tools/$platform"
ffmpeg_bin="$tool_dir/ffmpeg"
ffprobe_bin="$tool_dir/ffprobe"

if [[ -x "$ffmpeg_bin" && -x "$ffprobe_bin" ]]; then
  echo "[ffmpeg] ready: $tool_dir"
  exit 0
fi

if [[ "$check_only" == "1" ]]; then
  echo "[ffmpeg] missing binaries in $tool_dir" >&2
  exit 1
fi

mkdir -p "$tool_dir"

if prepare_from_system_tools; then
  exit 0
fi

if prepare_from_cache; then
  exit 0
fi

if [[ "$platform" == "macos-arm64" ]]; then
  ffmpeg_zip="$tool_dir/ffmpeg.zip"
  ffprobe_zip="$tool_dir/ffprobe.zip"

  curl -fL "https://evermeet.cx/ffmpeg/getrelease/zip" -o "$ffmpeg_zip"
  curl -fL "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" -o "$ffprobe_zip"

  unzip -o "$ffmpeg_zip" -d "$tool_dir" >/dev/null
  unzip -o "$ffprobe_zip" -d "$tool_dir" >/dev/null

  rm -f "$ffmpeg_zip" "$ffprobe_zip"
else
  tarball="$tool_dir/ffmpeg-release-amd64-static.tar.xz"
  extract_dir="$tool_dir/.extract"
  rm -rf "$extract_dir"

  curl -fL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" -o "$tarball"
  mkdir -p "$extract_dir"
  tar -xf "$tarball" -C "$extract_dir"

  source_dir=$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  if [[ -z "${source_dir:-}" ]]; then
    echo "[ffmpeg] failed to resolve extracted source dir" >&2
    exit 1
  fi

  cp "$source_dir/ffmpeg" "$ffmpeg_bin"
  cp "$source_dir/ffprobe" "$ffprobe_bin"

  rm -rf "$extract_dir" "$tarball"
fi

chmod +x "$ffmpeg_bin" "$ffprobe_bin"

"$ffmpeg_bin" -version >/dev/null
"$ffprobe_bin" -version >/dev/null

echo "[ffmpeg] prepared: $tool_dir"
