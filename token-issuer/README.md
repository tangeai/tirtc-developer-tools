# TiRTC Token Issuer

`tirtc-issuer-cli` signs local TiRTC connection tokens and can run a small HTTP issuer service.

## Required Secrets

Prefer environment variables:

```sh
export TIRTC_ACCESS_KEY_ID=...
export TIRTC_SECRET_KEY_ID=...
export TIRTC_DEVICE_SECRET_KEY=...
```

The same values can be passed as `--access-key-id`, `--secret-key-id`, and `--device-secret-key` for the current process. Do not send these values to clients or HTTP request bodies.

## Issue One Token

```sh
./script/build.sh --platform "$(./script/host_platform.sh)"
.build/token-issuer/bin/20 20 12 61 79 80 81 98 701 33 100 204 250 395 398 399 400./script/host_platform.sh)/tirtc-issuer-cli issue --remote-id device-001 --json
```

`remote_id` may be either a bare device id such as `device-001` or `device://device-001`. The signed token scope always follows the access server contract: `connect:device://<device_id>`.

## Serve HTTP

```sh
./script/serve.sh --host 0.0.0.0 --port 8966
curl -sS -X POST http://127.0.0.1:8966/v1/tokens \
  -H 'Content-Type: application/json' \
  --data '{"remote_id":"device-001"}'
```

Docker source-build example:

```sh
./script/serve_docker.sh --host 0.0.0.0 --port 8966
```

The Docker path builds a local image named `tirtc-token-issuer:local` and runs the foreground service. It is not an official container image release path.

## Security Boundary

This tool only demonstrates TiRTC token signing. It does not decide whether the caller is logged in, which tenant owns a device, or whether a user may access a `remote_id`. Put those checks in your business service before calling this issuer.
