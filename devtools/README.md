# TiRTC DevTools CLI

`devtools/` 提供 `tirtc-devtools-cli`，用于 TiRTC 本地联调、二维码生成、媒体资产准备，以及标准 device / client 调试流程。

常见使用场景：

- 为客户端生成连接 Token 或二维码。
- 启动本地 Token HTTP 服务，供示例 App 按需获取 Token。
- 把 MP4 准备成 DevTools device 可发送的媒体资产。
- 在支持平台上启动标准上行 device，送出音视频。
- 在支持平台上启动标准下行 client，接收音视频并产出调试证据。

## 安装

推荐使用 npm 包：

```sh
npm install -g tirtc-devtools-cli
tirtc-devtools-cli --help
```

从源码运行：

```sh
npm ci
npm run build
node bin/tirtc-devtools-cli.js --help
```

源码运行 Token 相关命令时，如果还没有随包携带的 issuer binary，可以先在仓库根目录构建：

```sh
platform="$(../token-issuer/script/host_platform.sh)"
../token-issuer/script/build.sh --platform "$platform"
export TIRTC_ISSUER_CLI_PATH="$PWD/../.build/token-issuer/bin/$platform/tirtc-issuer-cli"
```

## 命令总览

| 命令 | 用途 |
| --- | --- |
| `token issue` | 本地签发 TiRTC 连接 Token，并输出二维码 payload。 |
| `token serve` | 启动本地 HTTP Token issuer 服务。 |
| `license qrcode` | 生成 license 二维码。 |
| `assets prepare` | 准备 DevTools device 使用的媒体资产。 |
| `device start` | 启动标准上行 device，发送音视频。 |
| `client start` | 启动标准下行 client，接收音视频并生成调试产物。 |

所有命令都支持全局 `--json`，用于输出机器可读 envelope。人类可读日志写到 stderr，JSON 结果写到 stdout。

## 签发 Token

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
export TIRTC_APP_ID="<APP_ID>"

tirtc-devtools-cli --json token issue device-001 \
  --endpoint "<TIRTC_ENDPOINT>"
```

源码运行：

```sh
node bin/tirtc-devtools-cli.js --json token issue device-001 \
  --endpoint "<TIRTC_ENDPOINT>"
```

`--openapi-endpoint` 和 `TIRTC_OPEN_API_ENDPOINT` / `TIRTC_OPENAPI_ENDPOINT` 只为了兼容旧脚本而保留；当前 Token 签发是本地签名，不会回退到远端 OpenAPI。

TiRTC Token 有短时和防重放语义。每次新连接都应该重新签发 Token，不要长期复用。

## 启动 Token 服务

```sh
tirtc-devtools-cli token serve --host 0.0.0.0 --port 8966
```

请求：

```sh
curl -sS -X POST http://127.0.0.1:8966/v1/tokens \
  -H 'Content-Type: application/json' \
  --data '{"remote_id":"device-001"}'
```

这个服务只做 TiRTC Token 签名，不做登录鉴权、租户鉴权或用户设备归属鉴权。真实业务系统必须在调用它之前完成授权。

## 准备媒体资产

```sh
tirtc-devtools-cli --json assets prepare \
  --source ./movie.mp4 \
  --output-root .build/tirtc-assets
```

输出里的 `manifest_path` 可以传给 `device start --source`。

## 启动 device

```sh
export TIRTC_DEVICE_ID="<DEVICE_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
export TIRTC_ENDPOINT="<TIRTC_ENDPOINT>"

tirtc-devtools-cli --json device start \
  --source .build/tirtc-assets/manifest.json \
  --video-codec h264 \
  --artifact-root .build/devtools-cli/device-h264
```

`device start` 默认持续运行，直到你结束进程。需要自动化限时时再传 `--duration-ms <ms>`。

device 启动成功的条件是 listener ready；没有 client 连接不算启动失败。client 连接后，native driver 会发送音视频，并在 artifact 目录写入 summary 和运行证据。

## 启动 client

本地 device / client 闭环通常先让 device 写出 `bootstrap.json`，再让 client 消费它：

```sh
tirtc-devtools-cli --json client start \
  --bootstrap .build/devtools-cli/device-h264/bootstrap.json \
  --artifact-root .build/devtools-cli/client-h264
```

client 会写出 `summary.json`、`events.jsonl`、runtime logs，以及首帧渲染相关产物。`bootstrap.json` 只是 DevTools 本机联调产物，不是移动端 SDK 接入协议。

## 平台和打包

当前公开包重点支持：

- `macos-arm64`
- `linux-x64`

已发布 npm 包会携带对应平台的 issuer binary、native driver 和 runtime bundle。源码 checkout 默认不提交这些大型运行资产；维护者可以通过 package 脚本在具备完整 runtime 输入的环境中重新 staging：

```sh
npm run package
```

## 继续阅读

- [USAGE.md](USAGE.md)：更完整的命令示例。
- [../token-issuer/README.md](../token-issuer/README.md)：Token 签名工具和 HTTP issuer 服务。
