# TiRTC Token Issuer

`token-issuer/` 提供一个最小 Token 签发服务模拟。它适合用来跑通 TiRTC 示例 App、本地联调环境，或者作为业务服务接入真实签发逻辑前的参考实现。

它不做登录、租户、用户设备归属或 API key 鉴权。你的业务系统必须先判断调用方是否有权访问目标设备，再调用 issuer 签发短时 Token。

## 准备密钥

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
```

只有一台设备或所有调试设备临时共用同一个 `device_secret_key` 时，可以只配置 `TIRTC_DEVICE_SECRET_KEY`。

多台设备各自使用不同 `device_secret_key` 时，准备一个 JSON 映射文件：

```json
{
  "device-001": "DEVICE_001_SECRET_KEY",
  "device-002": "DEVICE_002_SECRET_KEY"
}
```

然后传入文件路径：

```sh
export TIRTC_DEVICE_SECRET_MAP="./device-secrets.json"
```

也可以在命令里显式传入：

```sh
token-issuer/script/serve.sh --host 0.0.0.0 --port 8966 \
  --device-secret-map ./device-secrets.json
```

`remote_id` 可以是 `device-001` 或 `device://device-001`，issuer 会先归一化为 `device_id`，再从映射文件里查对应的 `device_secret_key`。配置了映射文件后，如果请求的设备不在映射表里，请求会失败。

这些是服务端密钥。不要下发到 App、网页或终端用户，不要放进 HTTP 请求体，也不要写进日志。

## 启动 HTTP 服务

```sh
token-issuer/script/serve.sh --host 0.0.0.0 --port 8966
```

如果服务监听 `0.0.0.0`，但需要明确告诉客户端填写哪个 IP，可以加：

```sh
token-issuer/script/serve.sh --host 0.0.0.0 --port 8966 --advertise-host 192.168.31.68
```

启动后输出的 `Token 签发服务地址` 是客户端配置页要填写的值，例如：

```text
http://192.168.31.68:8966
```

请求：

```sh
curl -sS -X POST http://127.0.0.1:8966/v1/tokens \
  -H 'Content-Type: application/json' \
  --data '{"remote_id":"device-001"}'
```

可选字段：

```json
{
  "remote_id": "device-001",
  "subject": "devtools-cli",
  "ttl_seconds": 300
}
```

`remote_id` 可以是 `device-001` 或 `device://device-001`。最终签出来的 scope 会是：

```text
connect:device://device-001
```

## Docker 启动

```sh
token-issuer/script/serve_docker.sh --host 0.0.0.0 --port 8966
```

脚本会在本机构建 `tirtc-token-issuer:local` 并以前台方式运行服务。这个 Dockerfile 只是源码构建示例，不是官方镜像发布通道。

## 构建二进制

通常不需要手动构建二进制；`serve.sh` 会在缺少本机产物时自动构建。需要单独验证时可以执行：

```sh
platform="$(token-issuer/script/host_platform.sh)"
token-issuer/script/build.sh --platform "$platform"
```

产物：

```sh
.build/token-issuer/bin/$platform/tirtc-issuer-cli
```

支持平台：

- `macos-arm64`
- `linux-x64`

## 同步签发调试

HTTP 服务是推荐的示例接入方式。同步 `issue` 命令主要用于脚本验证和排查：

```sh
platform="$(token-issuer/script/host_platform.sh)"
.build/token-issuer/bin/$platform/tirtc-issuer-cli issue \
  --remote-id device-001 \
  --json
```

Token 格式：

```text
v1.<payload_b64>.<app_sig>
```

默认 TTL 是 300 秒。每次签发都会生成新的 nonce。
