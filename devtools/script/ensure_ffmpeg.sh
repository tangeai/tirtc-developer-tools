#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLI_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
CLI_DIST="$CLI_ROOT/dist/src/ffmpeg_tool.js"

if [[ ! -f "$CLI_DIST" ]]; then
  echo "[ensure_ffmpeg] compiled helper missing: $CLI_DIST" >&2
  echo "[ensure_ffmpeg] run: npm --prefix $CLI_ROOT run build" >&2
  exit 1
fi

CLI_DIST="$CLI_DIST" node <<'NODE'
const helperPath = process.env.CLI_DIST;
if (!helperPath) {
  throw new Error('missing CLI_DIST');
}
const {ensureFfmpegTools} = require(helperPath);
const tools = ensureFfmpegTools();
process.stdout.write(JSON.stringify(tools));
NODE
