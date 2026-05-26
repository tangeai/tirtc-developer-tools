# DevTools Native Role Driver

`developer-tools/devtools/driver/` owns the native DevTools role runner used by
the public `tirtc-devtools-cli` package.

## Responsibility

- Run DevTools device and client roles from a normalized request.
- Own the prepared asset send source used by CLI send: G711A / AAC audio plus selected H264 / H265 / MJPEG encoded video.
- Produce role evidence under an artifact root: `request.redacted.json`, `events.jsonl`, `driver.log`, `summary.json`, and role artifacts.
- On runtime-initialized role failures, upload runtime logs before uninitializing runtime and record `log_upload` evidence in `events.jsonl` and `summary.json`. Upload failure does not replace the original role failure.
- Prove the current runtime public facade surface can support the DevTools codec matrix before any destructive architecture reset.

## Non-Responsibility

- It is not a long-running Host, HTTP API, desktop UI backend, or service-control replacement.
- It does not own credential issuance. The CLI prepares tokens, bootstrap input, and request files.
- It does not include `runtime/core/**/include/internal` or own runtime media, transport, video, or facade product surfaces.
- It does not build TiRTC runtime from source. Build it with a prepared runtime SDK under `devtools/3rd/runtime/<platform>` or pass `TIRTC_DEVTOOLS_RUNTIME_SDK_DIR`.

## Current Probe Entry

Step 1 of `docs/specs/refactor/devtools_cli_native_role_driver.plan.md` uses:

```sh
developer-tools/devtools/driver/script/run_capability_probe.sh
```

Artifacts are written to `.build/devtools-driver-capability-probe/` by default. The probe requires standard `TIRTC_*` environment variables and prepared runtime assets. Send role startup succeeds when the device listener is ready; it starts shared audio and video inputs when the first connection is accepted, attaches each accepted connection to those inputs, and keeps sending to all active connections through the runtime facade fan-out. A missing client by itself does not fail the device role. The device role is resident: after a client disconnects it detaches and destroys that connection while continuing to accept new connections without waiting for older disconnect callbacks.

CLI send consumes the selected prepared audio/video packet indexes by default. It loops as one
source cycle: when either track reaches the source end, both tracks restart from offset 0 while
submitted PTS values continue increasing.
