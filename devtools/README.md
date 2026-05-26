# TiRTC DevTools CLI

`tirtc-devtools-cli` 是 TiRTC 日常开发调试 CLI。

它可以做这些事：

- 生成连接 Token、Token 服务和 license 二维码。
- 把 MP4 准备成 device 可发送的媒体资产。
- 启动标准 device，向 TiRTC 发送音视频。
- 启动标准 client，接收音视频并产出调试证据。

## 安装

```sh
npm install -g tirtc-devtools-cli
tirtc-devtools-cli --help
```

源码运行：

```sh
npm ci
npm run build
node bin/tirtc-devtools-cli.js --help
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `token issue` | 生成连接 Token 和二维码 payload。 |
| `token serve` | 启动本地 Token issuer HTTP 服务。 |
| `license qrcode` | 生成 license 二维码。 |
| `assets prepare` | 准备 device 使用的媒体资产。 |
| `device start` | 启动上行 device，发送音视频。 |
| `client start` | 启动下行 client，接收音视频。 |

`--json` 会把结果写成机器可读 JSON；运行日志仍写到 stderr。

## Token 服务

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"

tirtc-devtools-cli token serve --host 0.0.0.0 --port 8966
```

```sh
curl -sS -X POST http://127.0.0.1:8966/v1/tokens \
  -H 'Content-Type: application/json' \
  --data '{"remote_id":"device-001"}'
```

这个服务只做 Token 签名。业务鉴权要放在调用它之前。

## Token 和二维码

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
export TIRTC_APP_ID="<APP_ID>"

tirtc-devtools-cli --json token issue device-001 \
  --endpoint "<TIRTC_ENDPOINT>"
```

`--openapi-endpoint` 只为兼容旧脚本保留，不会触发远端 OpenAPI。

## 媒体资产

```sh
tirtc-devtools-cli --json assets prepare \
  --source ./movie.mp4 \
  --output-root .build/tirtc-assets
```

把返回的 `manifest_path` 传给 `device start --source`。

## Device

```sh
export TIRTC_DEVICE_ID="<DEVICE_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
export TIRTC_ENDPOINT="<TIRTC_ENDPOINT>"

tirtc-devtools-cli --json device start \
  --source .build/tirtc-assets/manifest.json \
  --video-codec h264 \
  --artifact-root .build/devtools-cli/device-h264
```

`device start` 默认一直运行。需要自动结束时传 `--duration-ms <ms>`。

## Client

```sh
tirtc-devtools-cli --json client start \
  --bootstrap .build/devtools-cli/device-h264/bootstrap.json \
  --artifact-root .build/devtools-cli/client-h264
```

client 会写出 `summary.json`、`events.jsonl`、runtime logs 和首帧渲染产物。`bootstrap.json` 只是 DevTools 本机联调文件，不是移动端 SDK 接入协议。

## 平台

- `macos-arm64`
- `linux-x64`

已发布 npm 包会携带对应平台的 issuer、native driver 和 runtime bundle。源码 checkout 默认不包含这些大型运行资产。

## 更多命令

看 [USAGE.md](USAGE.md)。
