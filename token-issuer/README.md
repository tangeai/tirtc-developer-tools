# TiRTC Token Issuer

`token-issuer/` 提供一个最小 Token 签发服务模拟。它适合用来跑通 TiRTC 示例 App、本地联调环境，或者作为业务服务接入真实签发逻辑前的参考实现。

它不做登录、租户、用户设备归属或 API key 鉴权。你的业务系统必须先判断调用方是否有权访问目标设备，再调用 issuer 签发短时 Token。

## 准备密钥

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
```

这些是服务端密钥。不要下发到 App、网页或终端用户，不要放进 HTTP 请求体，也不要写进日志。

## 启动 HTTP 服务

```sh
token-issuer/script/serve.sh --host 0.0.0.0 --port 8966
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
