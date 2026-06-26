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

启动后把输出里的 `Token 签发服务地址` 填到客户端，例如：

```text
http://192.168.31.68:8966
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

如果服务监听 `0.0.0.0`，但希望启动摘要明确展示客户端应访问的 IP，可以加 `--advertise-host 192.168.31.68`。

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
  --receive-audio-stream-id 14 \
  --artifact-root .build/devtools-cli/device-h264
```

默认持续运行。自动化场景可以传 `--duration-ms <ms>`。

常用媒体参数：

- `--audio-codec <codec>`：设备端下发音频格式，支持 `g711a`、`aac`、`pcm`、`opus`、`amr`。`amr` 只支持 8 kHz mono。
- `--audio-sample-rate <hz>`：设备端下发音频采样率，支持 `8000`、`16000`。
- `--audio-channels <count>`：设备端下发音频声道数，支持 `1`、`2`；`amr` 只支持 `1`。
- `--receive-audio-stream-id <id>`：device 侧接收 Flutter 本地音频采集与传输的 stream id，默认 `14`。非法值会在配置阶段失败，`reason_code` 为 `invalid_request`。

当 Flutter 本地音频发送到 `--receive-audio-stream-id` 指定的 stream 后，device summary 会包含 `received_audio`：

```json
{
  "received_audio": {
    "enabled": true,
    "stream_id": 14,
    "codec": "g711a",
    "sample_rate_hz": 16000,
    "channels": 1,
    "bits_per_sample": 16,
    "sample_format": "s16le",
    "first_output_timing_ms": 120,
    "captured_bytes": 4096,
    "pcm_path": "received-audio.pcm",
    "metadata_path": "received-audio.metadata.json",
    "mp3_path": "received-audio-20260624-120000.mp3",
    "mp3_status": "generated",
    "mp3_reason_code": "ok"
  }
}
```

`received-audio.pcm` 来自 runtime public facade 的 `TirtcAudioOutput + headless TirtcAudioAout` render PCM。`received-audio.metadata.json` 与 summary 中的 `received_audio` 保持同字段合同，并补充 artifact root 与开始 / 结束时间。CLI 会在 PCM 和格式信息完整时调用 FFmpeg 派生 MP3；缺 FFmpeg 时记录 `mp3_status = "skipped"`、`mp3_reason_code = "ffmpeg_unavailable"`，FFmpeg 转码失败时记录 `mp3_status = "failed"`、`mp3_reason_code = "ffmpeg_failed"`。

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
