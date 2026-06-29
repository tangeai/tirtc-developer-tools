#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
issuer_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
tirtc_av_repo_root="${TIRTC_AV_REPO_ROOT:-}"
if [ -n "$tirtc_av_repo_root" ]; then
  repo_root="$(CDPATH= cd -- "$tirtc_av_repo_root" && pwd)"
else
  repo_root="$(CDPATH= cd -- "$issuer_root/.." && pwd)"
fi
platform=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform)
      platform="$2"
      shift 2
      ;;
    -h|--help)
      echo "usage: ./script/build.sh --platform macos-arm64|linux-x64"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$platform" ]; then
  platform="$("$script_dir/host_platform.sh")"
fi

case "$platform" in
  macos-arm64)
    export GOOS=darwin GOARCH=arm64
    ;;
  linux-x64)
    export GOOS=linux GOARCH=amd64
    ;;
  *)
    echo "unsupported platform: $platform" >&2
    exit 2
    ;;
esac

if [ -n "$tirtc_av_repo_root" ]; then
  out_dir="$repo_root/.build/developer-tools/token-issuer/bin/$platform"
else
  out_dir="$repo_root/.build/token-issuer/bin/$platform"
fi
mkdir -p "$out_dir"
(cd "$issuer_root" && go build -o "$out_dir/tirtc-issuer-cli" .)
echo "$out_dir/tirtc-issuer-cli"
