# DevTools Native Role Driver 维护入口

`driver/` 是 `tirtc-devtools-cli` 内置的 native role runner。TypeScript CLI 负责命令面、token、bootstrap 和 request 归一化；这里只消费归一化后的 JSON request，通过 TiRTC runtime public C facade 跑标准 device / client 对端，并产出可验收 evidence。

## 模块职责

负责：

- 执行 `device start` / `client start` 的 native 生命周期。
- 支持固定文件输入、macOS system 输入 / 输出、本地预览和远端音视频输出。
- 管理 TiRTC runtime、service、connection、media input / output、窗口和文件输出资源。
- 写出 `events.jsonl`、`summary.json`、`driver.log`、`request.redacted.json`、`bootstrap.json`、raw receive 文件和 `media_receive.json`。
- 在 role 失败且 runtime 已初始化时上传 runtime 日志，并把 `log_upload` 结果写进 evidence。

不负责：

- 不做 CLI 参数设计、token 签发、bootstrap 生成策略或 npm package 编排。
- 不实现 Host、HTTP API、桌面 UI 后端或长驻服务。
- 不引用 `runtime/core/**/include/internal`，不拥有 runtime media / transport / facade 产品实现。
- 不从源码构建 runtime；只消费 `devtools/3rd/runtime/<platform>` 下准备好的 runtime SDK。

## 运行入口

CLI 启动 native 二进制时传入：

```sh
devtools_driver_probe --request FILE --runtime-root DIR --asset-root DIR --artifact-root DIR
```

`devtools_driver_probe_main.cc` 完成 request 读取、preflight、artifact 目录初始化和 signal 注册，然后按 `role` 分发：

- `device` / `send` -> `run_send_role`
- `client` / `receive` -> `run_receive_role`

driver 只认 request schema，不直接解析公开 CLI 参数。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `src/devtools_driver_probe_main.cc` | native 入口、参数解析、role 分发和终态 summary。 |
| `src/probe_common.*` | request、常量、共享状态、JSON / 文件工具、preflight 和基础 artifact 工具。 |
| `src/probe_send_role.cc` | 标准 device file input 主路径：监听、接入连接、attach 本地编码音视频输入。 |
| `src/probe_system_send_role.*` | macOS system input / preview / 远端回传输出路径。 |
| `src/probe_receive_role.cc` | 标准 client 下行路径：连接 bootstrap、订阅远端媒体、file / system output。 |
| `src/probe_send_session.*` | 固定输入资产和 packet index 校验、循环发送资产准备。 |
| `src/probe_role_helpers.*` | service / connection callbacks、command echo、stream message、output observer 和等待工具。 |
| `src/probe_device_bootstrap.*` | device ready 后写出 bootstrap。 |
| `src/probe_evidence.cc` | events、stage、summary、media receive artifact 和失败日志上传。 |
| `script/` | driver 构建、capability probe、packet index 测试和 reason taxonomy 校验入口。 |
| `test/` | driver 近身单元测试。 |

## 设计原则

- **边界固定**：TypeScript 层拥有 CLI UX；driver 拥有 native role lifecycle；runtime 拥有媒体、传输和平台 I/O 能力。
- **只走 public facade**：driver 通过 runtime public C headers 接入，不为了排障或便捷打穿 internal header。
- **证据先行**：关键阶段必须有 `events.jsonl` 和 `summary.json` 可还原；正常高频收包 / 渲染路径不逐包刷日志。
- **资源成对**：`create / start / attach / subscribe` 必须有对应 `destroy / stop / detach / unsubscribe`；失败、超时、signal 和重复清理都要成立。
- **输出语义清楚**：`file` 保存远端原始媒体；`system` 输出到系统设备；`both` 两边都必须满足验收。
- **平台不静默回退**：macOS 承接 system I/O；Linux 当前只承接 file 输入 / 输出；请求不支持能力必须失败并给稳定 `reason_code`。
- **command echo 是对端能力**：driver 对收到的每条 command 都原样 echo 同一个 command id 和 payload；具体 probe id 由调用方自己选择。
- **role 文件不继续无限膨胀**：新增共享逻辑优先下沉到 helper / evidence / session owner；新增稳定职责再拆新文件。

## 验证入口

常规 driver acceptance 从 DevTools 子工程执行：

```sh
cd developer-tools/devtools
npm run test:acceptance
```

该入口会使用 prepared runtime SDK 和标准 `TIRTC_*` token 默认配置，artifact 默认写到 `.build/driver-capability-probe/`。

近身校验入口：

```sh
cd developer-tools/devtools
driver/script/test_packet_index.sh
driver/script/verify_reason_taxonomy.py
```

三 codec 真实闭环从 Matrix 仓库根目录执行：

```sh
.agents/skills/devtools-cli-send-receive-e2e/scripts/run_devtools_cli_send_receive_e2e.sh
```
