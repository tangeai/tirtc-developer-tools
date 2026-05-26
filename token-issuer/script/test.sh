#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
issuer_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"

(cd "$issuer_root" && go test ./...)
