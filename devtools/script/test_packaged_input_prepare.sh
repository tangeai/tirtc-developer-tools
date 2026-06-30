#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cli_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"

if [[ ! -d "$cli_root/vendor/runtime/script" ]]; then
  echo "[package-input-prepare] vendor runtime scripts missing; run npm run package first" >&2
  exit 1
fi

tmp_root="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

pack_dir="$tmp_root/pack"
prefix_dir="$tmp_root/prefix"
work_dir="$tmp_root/work"
home_dir="$tmp_root/home"
result_json="$tmp_root/input_prepare.json"
mkdir -p "$pack_dir" "$prefix_dir" "$work_dir" "$home_dir"

test_media_url="${TIRTC_DEVTOOLS_CLI_TEST_MP4_URL:-https://download.tangeopen.com/TIRTC_OPEN_DOC/assets/sea.mp4}"
curl -fL --retry 3 "$test_media_url" -o "$work_dir/sea.mp4"

pack_output="$(npm --prefix "$cli_root" pack --pack-destination "$pack_dir")"
package_file="$(printf '%s\n' "$pack_output" | tail -n 1)"
package_path="$pack_dir/$package_file"

tar -tf "$package_path" | grep -q 'package/vendor/runtime/script/prepare_runtime_media_dataset.sh'
tar -tf "$package_path" | grep -q 'package/vendor/runtime/script/prepare_runtime_audio_tracks.sh'

npm install --global --prefix "$prefix_dir" "$package_path" >/dev/null

(
  cd "$work_dir"
  HOME="$home_dir" \
    TIRTC_FFMPEG_CACHE_DIR="$tmp_root/ffmpeg-cache" \
    "$prefix_dir/bin/tirtc-devtools-cli" --json input prepare \
      --file ./sea.mp4 \
      --cache-dir cache/tirtc-file-device >"$result_json"
)

test -f "$work_dir/cache/tirtc-file-device/input/media_input.json"
test -d "$work_dir/cache/tirtc-file-device/input"

node -e '
const fs = require("fs");
const path = process.argv[1];
const result = JSON.parse(fs.readFileSync(path, "utf8"));
if (result.code !== 0) {
  throw new Error("input prepare failed: " + JSON.stringify(result));
}
' "$result_json"

echo "[package-input-prepare] packaged CLI input prepare smoke passed"
