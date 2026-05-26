# TiRTC DevTools CLI 使用说明

这份文档按任务列出常用命令。第一次使用建议先读 [README.md](README.md)。

## 构建和查看帮助

```sh
npm ci
npm run build
node bin/tirtc-devtools-cli.js --help
```

全局安装后：

```sh
npm install -g tirtc-devtools-cli
tirtc-devtools-cli --help
```

## 全局选项

- `--json`：输出机器可读 JSON envelope，适合脚本集成。
- `--version`：输出 CLI 版本和 native driver contract version。

## 平台支持

- `macos-arm64`：支持 Token、资产准备、device、client、package smoke 和 native device / client qualification。
- `linux-x64`：支持 Token、资产准备、device、client、package smoke 和 native driver packaging。Linux native device / client 运行在 Linux host 或 `linux/amd64` container。

## Token

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
export TIRTC_APP_ID="<APP_ID>"

tirtc-devtools-cli --json token issue <REMOTE_ID> \
  --endpoint "<TIRTC_ENDPOINT>"
```

源码运行：

```sh
node bin/tirtc-devtools-cli.js --json token issue <REMOTE_ID> \
  --endpoint "<TIRTC_ENDPOINT>"
```

如果源码模式下没有随包携带的 issuer binary，先在仓库根目录构建 `token-issuer`，并设置：

```sh
export TIRTC_ISSUER_CLI_PATH="<repo>/.build/token-issuer/bin/<platform>/tirtc-issuer-cli"
```

`--openapi-endpoint` 只为了兼容旧脚本而保留。当前 Token 签发是本地签名，不会调用远端 OpenAPI。

输出 envelope 示例：

```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "payload": {
      "app_id": "APP",
      "remote_id": "REMOTE",
      "token": "<TOKEN>",
      "endpoint": "https://..."
    },
    "payloadJson": "{\"app_id\":\"APP\",\"remote_id\":\"REMOTE\",\"token\":\"<TOKEN>\"}",
    "token": "<TOKEN>",
    "qrCodePngPath": "/absolute/path/token-*.png"
  }
}
```

每次新连接都应该重新签发 Token，不要长期复用。

## Token HTTP 服务

```sh
tirtc-devtools-cli token serve --host 0.0.0.0 --port 8966
```

```sh
curl -sS -X POST http://127.0.0.1:8966/v1/tokens \
  -H 'Content-Type: application/json' \
  --data '{"remote_id":"device-001"}'
```

HTTP 服务不会做业务鉴权。请把登录态、租户、用户设备归属判断放在你的业务服务里。

## License QR

```sh
tirtc-devtools-cli --json license qrcode <LICENSE> \
  --endpoint "<TIRTC_ENDPOINT>"
```

## 资产准备

准备默认资产：

```sh
tirtc-devtools-cli --json assets prepare
```

准备指定 MP4：

```sh
tirtc-devtools-cli --json assets prepare \
  --source ./movie.mp4 \
  --output-root .build/tirtc-assets
```

命令会返回 `manifest_path`。后续 `device start` 使用这个路径作为 `--source`。

## Device

device 启动前需要：

```sh
export TIRTC_DEVICE_ID="<DEVICE_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
export TIRTC_ENDPOINT="<TIRTC_ENDPOINT>"
```

也可以通过 `--device-id`、`--device-secret-key`、`--endpoint` 显式传入。

启动一个 device：

```sh
tirtc-devtools-cli --json device start \
  --source .build/tirtc-assets/manifest.json \
  --video-codec h264 \
  --artifact-root .build/devtools-cli/device-h264
```

默认情况下，`device start` 会一直运行到你结束进程。自动化场景可以传 `--duration-ms <ms>`。

`device start` 的启动成功条件是 listener ready。没有 client 连接不算 device 启动失败；没有 client 时进程会继续等待。

如果需要本机 client 消费 device 输出，可以先生成 client token JSON：

```sh
tirtc-devtools-cli --json token issue "$TIRTC_DEVICE_ID" \
  --endpoint "$TIRTC_ENDPOINT" \
  > .build/devtools-client-token.json
```

然后让 device 写出本机交接文件：

```sh
tirtc-devtools-cli --json device start \
  --source .build/tirtc-assets/manifest.json \
  --video-codec h264 \
  --client-token-json .build/devtools-client-token.json \
  --artifact-root .build/devtools-cli/device-h264
```

`bootstrap.json` 是 DevTools 本机联调产物，不是移动端 SDK 接入协议。

## Client

```sh
tirtc-devtools-cli --json client start \
  --bootstrap .build/devtools-cli/device-h264/bootstrap.json \
  --artifact-root .build/devtools-cli/client-h264
```

client 会写出：

- `summary.json`
- `events.jsonl`
- runtime logs
- `render/first-video-frame.*`

native client role 会 echo 收到的 command，并在 `summary.json` 和 `--json` envelope 中记录 `command_echo` evidence。
