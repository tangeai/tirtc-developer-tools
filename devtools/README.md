# TiRTC DevTools CLI

`tirtc-devtools-cli` 是 TiRTC 日常开发调试 CLI。

它可以做这些事：

- 启动开发调试用 Token 签发 HTTP 服务。
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

源码打包完整 CLI 前，需要先准备预构建 runtime SDK：

```sh
./script/prepare_runtime.sh
npm run package
```

`prepare_runtime.sh` 默认从 [tangeai/tirtc-developer-tools Releases](https://github.com/tangeai/tirtc-developer-tools/releases) 下载最新 `devtools-runtime-sdk-*.zip`，并把 runtime SDK 放到 `3rd/runtime/<platform>/`。在 Matrix 主仓内运行时，也可以从本地 `.build/sdk` 生成同样的预构建输入。

手动指定 runtime SDK zip：

```sh
TIRTC_DEVTOOLS_RUNTIME_SDK_ZIP=/path/to/devtools-runtime-sdk-YYYYMMDDHHMMSS.zip \
  ./script/prepare_runtime.sh
```

手动指定已经解压好的 SDK 目录：

```sh
TIRTC_DEVTOOLS_RUNTIME_SDK_DIR=/path/to/runtime-sdk-root \
  ./script/prepare_runtime.sh
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `token serve` | 启动开发调试用 Token 签发 HTTP 服务。 |
| `license qrcode` | 生成 license 二维码。 |
| `assets prepare` | 准备 device 使用的媒体资产。 |
| `device start` | 启动上行 device，发送音视频。 |
| `client start` | 启动下行 client，接收音视频。 |

`--json` 会把结果写成机器可读 JSON；运行日志仍写到 stderr。

## Token 签发 HTTP 服务

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"

tirtc-devtools-cli token serve --port 8966
```

启动后客户端请求：

```sh
curl -sS -X POST http://127.0.0.1:8966/v1/tokens \
  -H 'Content-Type: application/json' \
  --data '{"remote_id":"device-001"}'
```

响应：

```json
{
  "token": "v1..."
}
```

这个服务只做 Token 签名，不判断请求用户是谁，也不判断用户是否有权访问对应设备。生产环境应先在业务服务里完成登录态、租户、用户设备归属和访问权限校验，再签发短时 Token。

多设备联调时，改用 JSON 映射文件：

```json
{
  "device-001": "DEVICE_001_SECRET_KEY",
  "device-002": "DEVICE_002_SECRET_KEY"
}
```

```sh
tirtc-devtools-cli token serve --port 8966 \
  --device-secret-map ./device-secrets.json
```

## 内部一次性 Token 签发

`token issue` 保留给内部自动化、旧 App 组合和排查脚本使用。新接入请优先使用 `token serve`，由客户端在连接前向业务服务请求短时 Token。

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

已发布 npm 包会携带对应平台的 issuer、native driver 和 runtime bundle。源码 checkout 默认不提交这些大型运行资产；`driver/` 源码在本仓内，构建时只需要 `3rd/runtime/<platform>` 中的预构建 runtime SDK。

## 更多命令

看 [USAGE.md](USAGE.md)。
