# TiRTC DevTools CLI 使用说明

## 构建和帮助

```sh
npm ci
npm run build
node bin/tirtc-devtools-cli.js --help
```

全局安装：

```sh
npm install -g tirtc-devtools-cli
tirtc-devtools-cli --help
```

## 全局选项

- `--json`：输出 JSON envelope，适合脚本集成。
- `--version`：输出 CLI 版本和 native driver contract version。

## 平台

- `macos-arm64`：Token、资产准备、device、client、package smoke、native device / client qualification。
- `linux-x64`：Token、资产准备、device、client、package smoke、native driver packaging。device / client 运行在 Linux host 或 `linux/amd64` container。

## Token 签发 HTTP 服务

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"

tirtc-devtools-cli token serve --port 8966
```

客户端请求：

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

多设备时，用 JSON 文件按 `device_id` 映射 `device_secret_key`：

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

## License QR

```sh
tirtc-devtools-cli --json license qrcode <LICENSE> \
  --endpoint "<TIRTC_ENDPOINT>"
```

## 资产准备

```sh
tirtc-devtools-cli --json assets prepare \
  --source ./movie.mp4 \
  --output-root .build/tirtc-assets
```

命令会返回 `manifest_path`。

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

默认持续运行。自动化场景可以传 `--duration-ms <ms>`。

如果要生成本机 client 使用的 `bootstrap.json`，先准备 client token：

```sh
tirtc-devtools-cli --json token issue "$TIRTC_DEVICE_ID" \
  --endpoint "$TIRTC_ENDPOINT" \
  > .build/devtools-client-token.json
```

再启动 device：

```sh
tirtc-devtools-cli --json device start \
  --source .build/tirtc-assets/manifest.json \
  --video-codec h264 \
  --client-token-json .build/devtools-client-token.json \
  --artifact-root .build/devtools-cli/device-h264
```

## Client

```sh
tirtc-devtools-cli --json client start \
  --bootstrap .build/devtools-cli/device-h264/bootstrap.json \
  --artifact-root .build/devtools-cli/client-h264
```

client 会写出 `summary.json`、`events.jsonl`、runtime logs 和首帧渲染产物。
