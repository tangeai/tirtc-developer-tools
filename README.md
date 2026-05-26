# TiRTC Developer Tools

This repository contains public TiRTC developer tooling.

## Contents

- `devtools/`: `tirtc-devtools-cli`, the public DevTools command line interface.
- `token-issuer/`: `tirtc-issuer-cli`, a small Go implementation of local TiRTC token signing and an HTTP token issuer service.

## Boundary

The token issuer signs short-lived TiRTC connection tokens for a target `remote_id`. It does not implement login, tenancy, user-device authorization, API keys, or production gateway security. Real business systems must authorize access before calling the issuer.
