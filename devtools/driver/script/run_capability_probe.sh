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

validate_send_contract() {
  local codec="$1"
  local send_root="$2"
  python3 - "$codec" "$send_root/bootstrap.json" "$send_root/events.jsonl" <<'PY'
import json
import sys

codec, bootstrap_path, events_path = sys.argv[1:4]

with open(bootstrap_path, "r", encoding="utf-8") as fh:
    bootstrap = json.load(fh)
if bootstrap.get("schema_version") != 1:
    raise SystemExit(f"bootstrap schema_version mismatch for {codec}: {bootstrap.get('schema_version')}")
endpoint_mode = bootstrap.get("endpoint_mode")
if endpoint_mode not in ("default", "custom"):
    raise SystemExit(f"bootstrap endpoint_mode invalid for {codec}: {endpoint_mode!r}")
if endpoint_mode == "default" and "endpoint" in bootstrap:
    raise SystemExit(f"bootstrap default endpoint_mode must omit endpoint for {codec}")
if endpoint_mode == "custom" and not bootstrap.get("endpoint"):
    raise SystemExit(f"bootstrap custom endpoint_mode missing endpoint for {codec}")

with open(events_path, "r", encoding="utf-8") as fh:
    events = [json.loads(line) for line in fh if line.strip()]
ready = [
    event for event in events
    if event.get("kind") == "role.ready" and event.get("payload", {}).get("endpoint_mode") == endpoint_mode
]
if not ready:
    raise SystemExit(f"role.ready missing endpoint_mode for {codec}")
PY
}

validate_system_preview_lifecycle() {
  local case_root="$1"
  python3 - "$case_root/summary.json" "$case_root/events.jsonl" <<'PY'
import json
import sys

summary_path, events_path = sys.argv[1:3]
with open(summary_path, "r", encoding="utf-8") as fh:
    summary = json.load(fh)
if summary.get("status") != "completed" or summary.get("exit_code") != 0:
    raise SystemExit(f"system preview did not complete: {summary.get('reason_code')}")
if summary.get("stop_reason") != "duration_elapsed":
    raise SystemExit(f"system preview stop_reason mismatch: {summary.get('stop_reason')}")

with open(events_path, "r", encoding="utf-8") as fh:
    events = [json.loads(line) for line in fh if line.strip()]
def has_event(kind, predicate=lambda payload: True):
    for event in events:
        if event.get("kind") == kind and predicate(event.get("payload") or {}):
            return True
    return False

if not has_event("preview.first_frame"):
    raise SystemExit("system preview first frame event missing")
if not has_event(
    "media.system_input.cleanup.done",
    lambda payload: payload.get("preview_attached_before_cleanup") is True
    and payload.get("runtime_uninit") is True,
):
    raise SystemExit("system preview cleanup event missing paired lifecycle evidence")
if not has_event("driver.execution.finished", lambda payload: payload.get("exit_code") == 0):
    raise SystemExit("system preview finished event missing")
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
  if [[ "$send_status" -eq 0 ]]; then
    validate_send_contract "$codec" "$send_root"
  fi
  if [[ "$receive_status" -ne 0 ]]; then
    rm -rf "$secret_root"
    return "$receive_status"
  fi
  rm -rf "$secret_root"
  return "$send_status"
}

run_system_preview_lifecycle_case() {
  if [[ "$PLATFORM" != "macos-arm64" ]]; then
    echo "[devtools-driver-probe] skipping system preview lifecycle on platform=$PLATFORM"
    return 0
  fi
  if [[ "${DEVTOOLS_DRIVER_PROBE_SKIP_SYSTEM_IO:-0}" == "1" ]]; then
    echo "[devtools-driver-probe] skipping system preview lifecycle by DEVTOOLS_DRIVER_PROBE_SKIP_SYSTEM_IO=1"
    return 0
  fi

  local case_root="$ARTIFACT_ROOT/system-preview-lifecycle"
  local secret_root
  secret_root="$(mktemp -d "${TMPDIR:-/tmp}/tirtc-devtools-system-preview.XXXXXX")"
  local token_json="$secret_root/token-issue.json"
  local request_file="$secret_root/request.json"
  rm -rf "$case_root"
  mkdir -p "$case_root"

  local token
  token="$(issue_token "$TIRTC_DEVICE_ID" "$token_json")"

  python3 - "$token" "$case_root" "$request_file" <<'PY'
import hashlib
import json
import os
import sys

token, artifact_dir, request_file = sys.argv[1:4]
request = {
    "schema_version": 1,
    "execution_id": "system-preview-lifecycle",
    "case_id": "devtools-driver-capability-probe.system-preview-lifecycle.device",
    "pairing_id": "devtools-driver-capability-probe.system-preview-lifecycle",
    "role": "device",
    "input_mode": "system",
    "output_mode": "file",
    "pairing_mode": "standard",
    "endpoint_mode": "custom",
    "endpoint": os.environ["TIRTC_ENDPOINT"],
    "identity": {
        "device_id": os.environ["TIRTC_DEVICE_ID"],
        "device_secret_key": os.environ["TIRTC_DEVICE_SECRET_KEY"],
    },
    "bootstrap": {
        "client_token": token,
        "token_fingerprint": "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest(),
    },
    "streams": {"audio_stream_id": 10, "video_stream_id": 11},
    "media": {
        "source": {"kind": "system", "path": os.environ["MATRIX_ASSET_ROOT"]},
        "video": {"codec": "h264"},
        "audio": {"codec": "g711a", "sample_rate_hz": 16000, "channels": 1},
    },
    "output": {"consumer": "packet_dump", "video": {"frame_limit": 1}},
    "preview": {"requested": True},
    "run": {
        "duration_ms": 2500,
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

  MATRIX_ASSET_ROOT="$ASSET_ROOT" python3 - "$DRIVER_BIN" "$request_file" "$RUNTIME_ROOT" "$ASSET_ROOT" "$case_root" <<'PY'
import subprocess
import sys

driver_bin, request_file, runtime_root, asset_root, case_root = sys.argv[1:6]
with open(case_root + "/stdout.log", "w", encoding="utf-8") as stdout, open(
    case_root + "/stderr.log", "w", encoding="utf-8"
) as stderr:
    try:
        result = subprocess.run(
            [
                driver_bin,
                "--request",
                request_file,
                "--runtime-root",
                runtime_root,
                "--asset-root",
                asset_root,
                "--artifact-root",
                case_root,
            ],
            stdout=stdout,
            stderr=stderr,
            timeout=20,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise SystemExit(f"system preview lifecycle timed out after {exc.timeout}s")
if result.returncode != 0:
    raise SystemExit(result.returncode)
PY
  validate_send_contract "system-preview-lifecycle" "$case_root"
  validate_system_preview_lifecycle "$case_root"
  rm -rf "$secret_root"
}

for codec in h264 h265 mjpeg; do
  echo "[devtools-driver-probe] running codec=$codec"
  run_case "$codec"
done

echo "[devtools-driver-probe] running system preview lifecycle"
MATRIX_ASSET_ROOT="$ASSET_ROOT" run_system_preview_lifecycle_case

echo "[devtools-driver-probe] artifact root: $ARTIFACT_ROOT"
