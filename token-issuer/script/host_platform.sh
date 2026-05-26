#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    echo "macos-arm64"
    ;;
  Linux:x86_64|Linux:amd64)
    echo "linux-x64"
    ;;
  *)
    echo "unsupported host platform: $(uname -s):$(uname -m)" >&2
    exit 2
    ;;
esac
