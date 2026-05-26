# TiRTC 开发者工具集

这个仓库是 TiRTC 面向外部开发者开放的工具集合，用来完成本地联调、Token 签发、二维码生成、媒体资产准备，以及标准 device / client 调试流程。

当前包含两个子项目：

| 目录 | 工具 | 用途 |
| --- | --- | --- |
| `devtools/` | `tirtc-devtools-cli` | 日常联调 CLI。提供 `token issue`、`token serve`、`license qrcode`、`assets prepare`、`device start`、`client start` 等命令。 |
| `token-issuer/` | `tirtc-issuer-cli` | Go 实现的本地 Token 签发工具。可以同步签发一个 Token，也可以启动 HTTP 签发服务。 |

## 你应该从哪里开始

如果你只是想在本机生成 TiRTC 连接 Token，先看：

- [token-issuer/README.md](token-issuer/README.md)

如果你想使用完整 DevTools CLI 做二维码、媒体资产准备或 device / client 联调，先看：

- [devtools/README.md](devtools/README.md)
- [devtools/USAGE.md](devtools/USAGE.md)

## 快速生成一个 Token

Token 签发需要三类服务端密钥。它们只能放在你的服务端、CI 或本机安全环境里，不能下发给 App、网页、终端用户，也不要写进日志。

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"

platform="$(token-issuer/script/host_platform.sh)"
token-issuer/script/build.sh --platform "$platform"

.build/token-issuer/bin/$platform/tirtc-issuer-cli issue \
  --remote-id device-001 \
  --json
```

签发结果里的 Token 可以交给 TiRTC 客户端连接目标设备。`remote_id` 可以写成 `device-001`，工具会按服务端校验规则归一化为 `device://device-001`，最终 scope 是 `connect:device://device-001`。

## 启动一个 HTTP 签发服务

当你的 App、示例工程或业务服务需要按需获取 Token 时，可以在服务端启动 HTTP issuer：

```sh
export TIRTC_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export TIRTC_SECRET_KEY_ID="<SECRET_KEY_ID>"
export TIRTC_DEVICE_SECRET_KEY="<DEVICE_SECRET_KEY>"

token-issuer/script/serve.sh --host 0.0.0.0 --port 8966
```

请求示例：

```sh
curl -sS -X POST http://127.0.0.1:8966/v1/tokens \
  -H 'Content-Type: application/json' \
  --data '{"remote_id":"device-001"}'
```

这个服务只负责 TiRTC Token 签名。用户是否登录、是否属于某个租户、是否有权访问某个设备，必须由你的业务系统在调用 issuer 之前完成判断。

## 使用 DevTools CLI

推荐直接安装已发布的 npm 包：

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

源码模式下，Token 相关命令可以直接配合上面构建出的 `tirtc-issuer-cli` 使用。完整 `device start` / `client start` 需要本地存在对应平台的 native driver 和 runtime bundle；已发布 npm 包会携带当前支持平台的运行资产。

## 平台支持

当前公开包重点支持：

- `macos-arm64`
- `linux-x64`

Token 签发工具支持在这两个平台构建。DevTools CLI 的 device / client 调试能力依赖随包携带的 native driver 和 runtime bundle。

## 安全边界

- `TIRTC_ACCESS_KEY_ID`、`TIRTC_SECRET_KEY_ID`、`TIRTC_DEVICE_SECRET_KEY` 是服务端密钥，不要下发到客户端。
- HTTP issuer 请求体不能传入 secret，只能传 `remote_id`、`subject`、`ttl_seconds` 这类非密钥参数。
- 本仓库不提供登录鉴权、租户鉴权、用户设备归属鉴权、API key 网关或公网部署安全方案。
- 如果要把 HTTP issuer 部署到线上，请放在你的业务服务或网关后面，由业务系统先完成授权判断。
