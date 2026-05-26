# TiRTC DevTools CLI

`devtools/` 承接 `TiRTC DevTools CLI`，是当前唯一公开 DevTools 命令行入口。

## 负责什么

- `token issue` / `license qrcode`：本地联调的凭据与二维码工具。
- `assets prepare`：把默认资产或任意 MP4 准备成 native role driver 使用的媒体资产。
- `device start`：作为标准上行 device 启动 native DevTools driver，送出音视频，按需产出本机 `bootstrap.json` 与 execution evidence。
- `client start`：作为标准下行 client 消费本机 `bootstrap.json` 或显式 device/token，产出 `frame_dump` 与 summary。
- CLI 负责参数、环境变量、token 签发、JSON envelope、artifact 摘要与打包定位；真实 TiRTC lifecycle 由 `products/devtools/driver/` 承接。native role 失败且 runtime logging 已初始化时，driver 会在退出前尝试上传日志，CLI JSON 会透出 `log_id` 与 `log_upload` 结果。

## 不负责什么

- 不在 TypeScript 中实现媒体帧队列、PTS pacing、transport attach/detach、decoder 或 render sink。
- 不提供长驻 Host、HTTP API、共享 session 或桌面 UI。
- 不替代业务鉴权系统；token 签发只服务 DevTools 联调与验收。
- 不把 `bootstrap.json` 定义成移动端接入协议；它只是本机 CLI receive、sample smoke 和 validation automation 的交接产物。
- 不提供长驻 Linux 服务端；Linux 调试发布面是 `linux-x64` native CLI/driver，运行在 Linux host 或 `linux/amd64` container。

## 依赖方向

- token/license 工具由 CLI 自己承接；仓库级 token helper 入口为 `./script/issue_devtools_token.sh`。
- device/client 通过本地 native driver executable 执行，默认查找 `.build/devtools-driver/bin/<platform>/devtools_driver_probe` 或 `vendor/devtools/driver/<platform>/devtools_driver_probe`。
- runtime bundle 默认查找 `.build/products/runtime/<platform>` 或 `vendor/runtime/<platform>`。

## 常用命令

```sh
npm --prefix devtools run build
npm --prefix devtools test -- --runInBand
node devtools/bin/tirtc-devtools-cli.js --help
```

常用 token 自测入口：

```sh
./script/issue_devtools_token.sh --token-only
```

真实 device/client 闭环优先走：

```sh
products/devtools/driver/script/run_capability_probe.sh
```

一台电脑模拟上行端送任意 MP4：

```sh
node devtools/bin/tirtc-devtools-cli.js --json assets prepare \
  --source ./movie.mp4 \
  --output-root .build/tirtc-assets
node devtools/bin/tirtc-devtools-cli.js --json device start \
  --source .build/tirtc-assets/manifest.json \
  --video-codec h264 \
  --artifact-root .build/devtools-cli/device-movie-h264
```

`device start` 默认持续运行直到用户结束进程；需要自动化限时时再显式传
`--duration-ms <ms>`。运行期间 CLI 会把启动、listener ready、client 连接 / 断开、
首个音视频包与周期运行状态写到 stderr；`--json` 的结构化 envelope 仍只写 stdout。
prepared asset 会按完整音视频轨循环，任一轨到达源文件末尾时 audio/video 同步回到
源头并保持 PTS 继续递增。

`device start` 的启动成功条件是 device listener 已就绪；客户端是否已经扫码连接不属于
device 启动失败条件。没有 client 时命令会继续常驻，直到用户结束进程或显式
`--duration-ms` 到期，summary 中 `media_send` 会保持未开始或标记为跳过。有 client
连接时 driver 会把该连接挂到共享音视频输入上；client 断开后，device 会清理该连接，
并继续接受新的连接。若旧连接的断开回调尚未到达，新连接也会立即挂载并收到同一组
音视频输入的数据。

native role 失败时，`reason_code` 与 `failed_stage` 仍是主失败事实；`log_upload`
只说明失败现场日志是否已上传。上传成功时，CLI JSON 与 `summary.json` 会包含
可用于后续抓取的 `log_id`。

`device start` 与 `client start` 启动的 native role 默认 echo 收到的 command：
收到任意 command 后，用同一个 command id 与同一 payload 原样回发。CLI 不新增
额外控制命令或开关；`summary.json` 与 `--json` envelope 会包含 `command_echo`
evidence，用于确认 command 收发面已被覆盖。

打包入口：

```sh
npm --prefix devtools run package
```
