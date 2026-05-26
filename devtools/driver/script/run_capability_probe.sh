#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRIVER_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVTOOLS_ROOT="$(cd "$DRIVER_ROOT/.." && pwd)"
if [[ -n "${TIRTC_MATRIX_REPO_ROOT:-}" ]]; then
  MATRIX_REPO_ROOT="$(cd "$TIRTC_MATRIX_REPO_ROOT" && pwd)"
else
  MATRIX_REPO_ROOT="$(cd "$DEVTOOLS_ROOT/../.." && pwd)"
fi

ARTIFACT_ROOT="${DEVTOOLS_DRIVER_PROBE_ARTIFACT_ROOT:-$DEVTOOLS_ROOT/.build/driver-capability-probe}"
ASSET_ROOT="${MATRIX_ASSET_WORKSPACE_ROOT:-$MATRIX_REPO_ROOT/runtime/assets/.workspace/runtime-assets-current}"
PLATFORM="${TIRTC_RUNTIME_PLATFORM:-macos-arm64}"
RUNTIME_ROOT="${TIRTC_RUNTIME_BUNDLE_ROOT:-$DEVTOOLS_ROOT/3rd/runtime/$PLATFORM}"

required_env=(
  TIRTC_ACCESS_KEY_ID
  TIRTC_SECRET_KEY_ID
  TIRTC_APP_ID
  TIRTC_DEVICE_ID
  TIRTC_DEVICE_SECRET_KEY
  TIRTC_ENDPOINT
)

for key in "${required_env[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "[devtools-driver-probe] missing environment: $key" >&2
    exit 3
  fi
done

DRIVER_BIN="$("$SCRIPT_DIR/build.sh")"
mkdir -p "$ARTIFACT_ROOT"

issue_token() {
  local remote_id="$1"
  local output_file="$2"
  "$MATRIX_REPO_ROOT/script/issue_devtools_token.sh" \
    --remote-id "$remote_id" \
    --endpoint "$TIRTC_ENDPOINT" > "$output_file"
  python3 - "$output_file" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
print(data["data"]["token"])
PY
}

write_request() {
  local role="$1"
  local codec="$2"
  local token="$3"
  local artifact_dir="$4"
  local request_file="$5"
  local bootstrap_path="${6:-}"
  python3 - "$role" "$codec" "$token" "$artifact_dir" "$request_file" "$bootstrap_path" <<'PY'
import hashlib
import json
import os
import sys

role, codec, token, artifact_dir, request_file, bootstrap_path = sys.argv[1:7]
case_name = os.path.basename(os.path.dirname(artifact_dir))
execution_id = case_name + "-" + os.path.basename(artifact_dir)
pairing_id = "devtools-driver-capability-probe." + codec
identity = {}
bootstrap = {}
if role == "device":
    identity = {
        "device_id": os.environ["TIRTC_DEVICE_ID"],
        "device_secret_key": os.environ["TIRTC_DEVICE_SECRET_KEY"],
    }
    bootstrap = {
        "client_token": token,
        "token_fingerprint": "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest(),
    }
else:
    bootstrap_id = ""
    if bootstrap_path:
        with open(bootstrap_path, "r", encoding="utf-8") as fh:
            bootstrap_id = json.load(fh).get("bootstrap_id", "")
    identity = {
        "device_id": os.environ["TIRTC_DEVICE_ID"],
        "token": token,
        "bootstrap_path": bootstrap_path,
        "bootstrap_id": bootstrap_id,
    }

request = {
    "schema_version": 1,
    "execution_id": execution_id,
    "case_id": "devtools-driver-capability-probe." + codec + "." + role,
    "pairing_id": pairing_id,
    "role": role,
    "endpoint": os.environ["TIRTC_ENDPOINT"],
    "identity": identity,
    "bootstrap": bootstrap,
    "streams": {"audio_stream_id": 10, "video_stream_id": 11},
    "media": {
        "source": {"kind": "encoded_asset", "path": os.environ["MATRIX_ASSET_ROOT"]},
        "video": {"codec": codec},
    },
    "output": {"consumer": "frame_dump", "video": {"frame_limit": 1}},
    "run": {
        "duration_ms": 10000,
        "connect_timeout_ms": 10000,
        "first_packet_timeout_ms": 10000,
        "first_output_timeout_ms": 12000,
    },
    "artifact": {"root_dir": artifact_dir},
    "probe": {"app_id": os.environ["TIRTC_APP_ID"]},
}

with open(request_file, "w", encoding="utf-8") as fh:
    json.dump(request, fh, indent=2)
    fh.write("\n")
PY
}

run_case() {
  local codec="$1"
  local case_root="$ARTIFACT_ROOT/$codec"
  local send_root="$case_root/send"
  local receive_root="$case_root/receive"
  local secret_root
  secret_root="$(mktemp -d "${TMPDIR:-/tmp}/tirtc-devtools-capability-${codec}.XXXXXX")"
  local token_json="$secret_root/token-issue.json"
  local send_request="$secret_root/send-request.json"
  local receive_request="$secret_root/receive-request.json"

  rm -rf "$case_root"
  mkdir -p "$send_root" "$receive_root"

  local token
  token="$(issue_token "$TIRTC_DEVICE_ID" "$token_json")"

  MATRIX_ASSET_ROOT="$ASSET_ROOT" write_request "device" "$codec" "$token" "$send_root" "$send_request"

  "$DRIVER_BIN" \
    --request "$send_request" \
    --runtime-root "$RUNTIME_ROOT" \
    --asset-root "$ASSET_ROOT" \
    --artifact-root "$send_root" \
    > "$send_root/stdout.log" \
    2> "$send_root/stderr.log" &
  local send_pid=$!

  local bootstrap="$send_root/bootstrap.json"
  local waited=0
  while [[ ! -f "$bootstrap" && "$waited" -lt 100 ]]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if [[ ! -f "$bootstrap" ]]; then
    wait "$send_pid" || true
    if [[ -f "$send_root/summary.json" ]]; then
      local reason
      reason="$(python3 - "$send_root/summary.json" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
print(data.get("reason_code", "unknown"))
PY
)"
      echo "[devtools-driver-probe] send failed before bootstrap for codec=$codec reason_code=$reason" >&2
    fi
    echo "[devtools-driver-probe] bootstrap not produced for codec=$codec" >&2
    rm -rf "$secret_root"
    return 1
  fi

  MATRIX_ASSET_ROOT="$ASSET_ROOT" write_request \
    "client" "$codec" "$token" "$receive_root" "$receive_request" "$bootstrap"

  local receive_status=0
  "$DRIVER_BIN" \
    --request "$receive_request" \
    --runtime-root "$RUNTIME_ROOT" \
    --asset-root "$ASSET_ROOT" \
    --artifact-root "$receive_root" \
    > "$receive_root/stdout.log" \
    2> "$receive_root/stderr.log" || receive_status=$?

  local send_status=0
  wait "$send_pid" || send_status=$?
  if [[ "$receive_status" -ne 0 ]]; then
    rm -rf "$secret_root"
    return "$receive_status"
  fi
  rm -rf "$secret_root"
  return "$send_status"
}

for codec in h264 h265 mjpeg; do
  echo "[devtools-driver-probe] running codec=$codec"
  run_case "$codec"
done

echo "[devtools-driver-probe] artifact root: $ARTIFACT_ROOT"
