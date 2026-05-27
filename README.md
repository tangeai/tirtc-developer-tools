# TiRTC 开发者工具集

这里放 TiRTC 对外开放的开发者工具。现在主要有两类：

| 目录 | 用途 |
| --- | --- |
| `token-issuer/` | Token 签发服务模拟。适合在服务端、本地网关或 Docker 环境里跑一个最小 issuer，给示例 App 或业务服务按需签发短时 Token。 |
| `devtools/` | 日常开发调试 CLI。用于二维码、媒体资产准备、标准 device / client 联调和调试证据采集。 |

## Token 签发服务模拟

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"

token-issuer/script/serve.sh --host 0.0.0.0 --port 8966
```

多设备联调时，用 JSON 文件按 `device_id` 映射 `device_secret_key`：

```json
{
  "device-001": "DEVICE_001_SECRET_KEY",
  "device-002": "DEVICE_002_SECRET_KEY"
}
```

```sh
export TIRTC_DEVICE_SECRET_MAP="./device-secrets.json"
token-issuer/script/serve.sh --host 0.0.0.0 --port 8966
```

```sh
curl -sS -X POST http://127.0.0.1:8966/v1/tokens \
  -H 'Content-Type: application/json' \
  --data '{"remote_id":"device-001"}'
```

继续看：[token-issuer/README.md](token-issuer/README.md)

## 日常开发调试 CLI

```sh
npm install -g tirtc-devtools-cli
tirtc-devtools-cli --help
```

从源码运行：

```sh
npm --prefix devtools ci
npm --prefix devtools run build
node devtools/bin/tirtc-devtools-cli.js --help
```

继续看：

- [devtools/README.md](devtools/README.md)
- [devtools/USAGE.md](devtools/USAGE.md)

## 平台

- `macos-arm64`
- `linux-x64`

已发布的 `tirtc-devtools-cli` 包会带上对应平台的 issuer、native driver 和 runtime bundle。源码仓库默认不提交这些大型运行资产。

## 安全边界

`TIRTC_ACCESS_KEY_ID`、`TIRTC_SECRET_KEY_ID`、`TIRTC_DEVICE_SECRET_KEY` 和 `TIRTC_DEVICE_SECRET_MAP` 指向的文件是服务端密钥材料，不能下发到客户端，也不要写进日志。

本仓库不提供登录、租户、用户设备归属、API key 网关或公网部署安全方案。HTTP issuer 只能放在你的业务服务或网关后面，由业务系统先完成授权判断。
