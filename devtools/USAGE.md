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

- `macos-arm64`：Token、license、固定输入准备、file input/output、system input/output、本地预览、package smoke、native driver validation。
- `linux-x64`：Token、license、固定输入准备、file input/output、package smoke、native driver packaging。`system` 输入、`system` 输出和 `--preview` 在本轮不会静默回退。

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

## 固定工作区

角色命令默认使用 `cache/tirtc-devtools` 作为 CLI 工作区：

```text
cache/tirtc-devtools/
  input/
    media_input.json
  device/
    bootstrap.json
    summary.json
    events.jsonl
    output/
  client/
    summary.json
    events.jsonl
    output/
```

`--cache-dir <dir>` 可以切换整套工作区。`input prepare` 只重建 `input/`，`device start` 只重建 `device/`，`client start` 只重建 `client/`。

## 本地文件输入

```sh
mkdir -p .build/tirtc-source
curl -L "https://download.tangeopen.com/TIRTC_OPEN_DOC/assets/sea.mp4" \
  -o .build/tirtc-source/sea.mp4

tirtc-devtools-cli --json input prepare \
  --file .build/tirtc-source/sea.mp4 \
  --cache-dir cache/tirtc-devtools
```

命令会把本地 MP4 准备成固定文件输入，并写入 `cache/tirtc-devtools/input/media_input.json`。后续 `device start --input file` 只读取这个固定输入目录。

## Device

device 作为标准上行对端运行。启动前需要现有 token issuer 默认配置：

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_APP_ID="<APP_ID>"
export TIRTC_DEVICE_ID="<DEVICE_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
```

Device 角色不需要提供连接地址或令牌文件。生成的 bootstrap 使用默认连接模式，runtime 使用自身默认连接配置。

文件上行：

```sh
mkdir -p .build/tirtc-source
curl -L "https://download.tangeopen.com/TIRTC_OPEN_DOC/assets/sea.mp4" \
  -o .build/tirtc-source/sea.mp4

tirtc-devtools-cli --json input prepare --file .build/tirtc-source/sea.mp4

tirtc-devtools-cli --json device start \
  --input file \
  --output file \
  --video-codec h264 \
  --audio-codec g711a \
  --audio-sample-rate 16000
```

macOS 系统摄像头 / 麦克风上行并打开本地预览：

```sh
tirtc-devtools-cli --json device start \
  --input system \
  --preview \
  --output both \
  --video-codec h264 \
  --audio-codec g711a
```

成功进入 ready 后，device 会写出 `cache/tirtc-devtools/device/bootstrap.json`。client 只需要消费这个 bootstrap。
长期运行模式下，如果 client 尚未开启麦克风或尚未发送对讲音频，device 会继续等待这一路音频，不会因为对讲音频暂未到达而退出。

常用参数：

- `--input file|system`：默认 `file`；`system` 当前只支持 macOS。
- `--output file|system|both`：默认 `file`；`system` 当前只支持 macOS。
- `--preview`：只对 `--input system` 合法。
- `--video-codec h264|h265|mjpeg`：默认 `h264`。
- `--audio-codec g711a|aac|pcm|opus|amr`：默认 `g711a`；`amr` 当前按 AMR-NB 处理，只支持 `8000` Hz、单声道。
- `--audio-sample-rate 8000|16000`：默认 `16000`。
- `--audio-channels 1|2`：默认 `1`。
- `--duration-ms <ms>`：默认 `0`，表示持续运行到信号或失败。

链路级 3A 参数：

- 输入链路：`--audio-input-aec disabled|enabled`、`--audio-input-agc disabled|low|medium|high`、`--audio-input-ans disabled|low|medium|high`，只适用于 `--input system`。
- 输出链路：`--audio-output-agc disabled|low|medium|high`、`--audio-output-ans disabled|low|medium|high`，只适用于 `--output system|both`。

不适用的平台能力或 3A 组合会在启动前失败并写入稳定 `reason_code`。

## Client

client 作为标准下行对端运行，消费 device 写出的 bootstrap：

```sh
tirtc-devtools-cli --json client start \
  --bootstrap cache/tirtc-devtools/device/bootstrap.json \
  --output both
```

常用参数：

- `--bootstrap <path>`：必填，指向 device 产出的 `bootstrap.json`。
- `--output file|system|both`：默认 `file`；`system` 当前只支持 macOS。
- `--cache-dir <dir>`：默认 `cache/tirtc-devtools`。
- `--duration-ms <ms>`：默认 `0`，表示持续运行到信号或失败。
- `--first-packet-timeout-ms <ms>`：等待远端媒体首包。
- `--first-output-timeout-ms <ms>`：等待 system 输出首次出声 / 首帧。

`--output file` 或 `--output both` 会在 `client/output/` 写出收到的远端原始媒体、packet index 和 `media_receive.json`：

```text
cache/tirtc-devtools/client/output/
  audio_receive.<codec>
  audio_receive.<codec>.packets.csv
  video_receive.<codec>
  video_receive.<codec>.packets.csv
  media_receive.json
```

`--output system` 或 `--output both` 会在 macOS 上把远端音频送到系统输出设备，并为远端视频创建窗口。summary 中的 `system_output.audio.state` 和 `system_output.video.state` 记录出声 / 出图状态。
