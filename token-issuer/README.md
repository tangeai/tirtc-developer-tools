# TiRTC Token Issuer

`token-issuer/` 提供 `tirtc-issuer-cli`，用于在服务端或本机开发环境中签发 TiRTC 连接 Token。

它有两种使用方式：

- `issue`：同步签发一个 Token，适合脚本、CI、本地联调。
- `serve`：启动一个 HTTP Token 签发服务，适合示例 App、业务服务或 Docker 环境按需获取 Token。

## 前置密钥

推荐通过环境变量提供密钥：

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"
```

也可以在当前进程中通过参数覆盖：

- `--access-key-id`
- `--secret-key-id`
- `--device-secret-key`

这些值是服务端密钥。不要把它们下发到客户端，不要写进 HTTP 请求体，也不要输出到日志、截图、工单或聊天记录。

## 构建

在仓库根目录执行：

```sh
platform="$(token-issuer/script/host_platform.sh)"
token-issuer/script/build.sh --platform "$platform"
```

产物位置：

```sh
.build/token-issuer/bin/$platform/tirtc-issuer-cli
```

当前支持：

- `macos-arm64`
- `linux-x64`

## 签发一个 Token

```sh
platform="$(token-issuer/script/host_platform.sh)"
.build/token-issuer/bin/$platform/tirtc-issuer-cli issue \
  --remote-id device-001 \
  --json
```

`remote_id` 可以是裸设备 ID，例如 `device-001`，也可以是 `device://device-001`。工具会按 TiRTC access server 的校验规则生成：

```text
scope=connect:device://device-001
```

Token 格式为：

```text
v1.<payload_b64>.<app_sig>
```

默认 TTL 是 300 秒。每次签发都会生成新的 nonce。

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

响应会包含 Token 和公开 claims payload。HTTP 请求体不能传入 `access_key_id`、`secret_key_id`、`device_secret_key` 等密钥字段；服务启动时读取密钥，启动后不会从请求里接受密钥覆盖。

可选字段：

```json
{
  "remote_id": "device-001",
  "subject": "devtools-cli",
  "ttl_seconds": 300
}
```

## Docker 启动

```sh
token-issuer/script/serve_docker.sh --host 0.0.0.0 --port 8966
```

脚本会在本机构建一个名为 `tirtc-token-issuer:local` 的镜像，并以前台方式运行服务。这个 Dockerfile 是源码构建示例，不是官方镜像发布通道；本仓库不维护 registry tag、镜像签名或线上镜像安全扫描。

## 安全边界

`tirtc-issuer-cli` 只负责 TiRTC Token 签名，不负责判断调用方是谁，也不判断用户是否有权访问某个设备。

正确接入方式是：

1. 你的业务服务先完成登录态、租户、用户设备归属等授权判断。
2. 授权通过后，业务服务调用 `tirtc-issuer-cli issue` 或 HTTP `/v1/tokens`。
3. 业务服务把短时 Token 返回给客户端。

不要把本工具直接暴露成公网无鉴权服务。
