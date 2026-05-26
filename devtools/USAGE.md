# TiRTC DevTools CLI Usage

## Build

```sh
npm --prefix devtools ci
npm --prefix devtools run build
node devtools/bin/tirtc-devtools-cli.js --help
```

## Global

- `--json` prints a machine-readable envelope.
- `--version` prints CLI version and native driver contract version.

## Platform Support

- `macos-arm64`: supported for token, assets prepare, device, client, package smoke, and native device+client qualification.
- `linux-x64`: supported for token, assets prepare, device, client, package smoke, and native driver packaging. Linux native device/client runs through the packaged headless driver on Linux hosts or `linux/amd64` containers.

## Token

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
export TIRTC_APP_ID="<APP_ID>"
export TIRTC_DEVICE_ID="<REMOTE_ID>"
export TIRTC_ENDPOINT="<SERVICE_ENTRY>"

node devtools/bin/tirtc-devtools-cli.js --json token issue <REMOTE_ID> \
  --endpoint <ENDPOINT>

./script/issue_devtools_token.sh --token-only
```

`--openapi-endpoint` is accepted only for compatibility with older scripts. Token signing is local and does not call a remote OpenAPI service.

`token issue` preserves the public JSON envelope:

```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "payload": {
      "app_id": "APP",
      "remote_id": "REMOTE",
      "token": "<TOKEN>",
      "endpoint": "http://..."
    },
    "payloadJson": "{\"app_id\":\"APP\",\"remote_id\":\"REMOTE\",\"token\":\"<TOKEN>\"}",
    "token": "<TOKEN>",
    "qrCodePngPath": "/absolute/path/token-*.png"
  }
}
```

TiRTC token has anti-replay semantics. Treat every token as single-use and issue a fresh token for every new connection.

## License QR

```sh
node devtools/bin/tirtc-devtools-cli.js --json license qrcode <LICENSE> --endpoint <ENDPOINT>
```

## Assets

```sh
node devtools/bin/tirtc-devtools-cli.js --json assets prepare
node devtools/bin/tirtc-devtools-cli.js --json assets prepare --source runtime/assets/source.mp4
```

Prepare any MP4 and use the returned `data.manifest_path` as `device start --source`:

```sh
node devtools/bin/tirtc-devtools-cli.js --json assets prepare \
  --source ./movie.mp4 \
  --output-root .build/tirtc-assets
```

## Device

Device startup requires:

```sh
export TIRTC_DEVICE_ID="<DEVICE_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
export TIRTC_ENDPOINT="<SERVICE_ENTRY>"
```

These can also be passed explicitly with `--device-id`, `--device-secret-key`,
and `--endpoint`. Missing values fail during CLI preflight before the native
driver starts.

If the local `client start --bootstrap` flow is needed, issue a fresh client
token first:

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
export TIRTC_APP_ID="<APP_ID>"

node devtools/bin/tirtc-devtools-cli.js --json token issue "$TIRTC_DEVICE_ID" \
  --endpoint "$TIRTC_ENDPOINT" \
  > .build/devtools-client-token.json
```

Run one device with the default prepared asset:

```sh
node devtools/bin/tirtc-devtools-cli.js --json device start \
  --video-codec h264 \
  --artifact-root .build/devtools-cli/device-h264
```

Run one device from a prepared MP4 and write a local client bootstrap:

```sh
node devtools/bin/tirtc-devtools-cli.js --json device start \
  --source .build/tirtc-assets/manifest.json \
  --video-codec h264 \
  --client-token-json .build/devtools-client-token.json \
  --artifact-root .build/devtools-cli/device-movie-h264
```

By default `device start` keeps running until the process is stopped. Use
`--duration-ms <ms>` only for bounded automation. Prepared assets loop over the
full audio/video source cycle; when either track reaches the source end, both
tracks restart from offset 0 while PTS keeps increasing.

While the device process is running, CLI writes human-readable lifecycle logs to
stderr: startup, listener readiness, client connect/disconnect, first audio/video
packet, and periodic running status. With `--json`, the final machine-readable
envelope remains on stdout.

`device start` is considered started once the device listener is ready. A
missing client is not a device startup failure. Without a connected client, the
process remains resident until it is stopped or an explicit `--duration-ms`
deadline is reached.

`device start` writes `bootstrap.json` only when `--client-token-json` is
provided. That file is a local handoff artifact for CLI client, runtime sample
smoke, and validation automation. The token in that bootstrap is intended for
one client connection.

`device start` starts a native role that echoes every received command with the
same command id and payload. No extra CLI command or option is required.
`summary.json` and the `--json` envelope include `command_echo` evidence.

`bootstrap.json` is not a mobile SDK connection protocol. For phone debugging,
use token/license QR today; a full session QR or deeplink is a separate product
slice.

## Client

```sh
node devtools/bin/tirtc-devtools-cli.js --json client start \
  --bootstrap .build/devtools-cli/device-h264/bootstrap.json \
  --artifact-root .build/devtools-cli/client-h264
```

Client writes `summary.json`, `events.jsonl`, runtime logs, and `render/first-video-frame.*` for `frame_dump`.

The native client role also echoes every received command with the same command
id and payload. `summary.json` and the `--json` envelope include `command_echo`
evidence, so command receive and reply coverage is visible in normal CLI
artifacts.

`client start --bootstrap` is meant for the local computer-to-computer DevTools
flow. Mobile clients should not be required to fetch a local JSON file from the
developer machine.

## Codec Matrix

For the current macOS gate, use the native capability runner:

```sh
products/devtools/driver/script/run_capability_probe.sh
```

It runs H264, H265, and MJPEG device+client with a fresh token per case.
