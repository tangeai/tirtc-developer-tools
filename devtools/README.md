# DevTools CLI 源码工程

`devtools/` 是 `tirtc-devtools-cli` 的源码目录。这里说明 CLI 如何从源码构建、验证和打包；具体命令使用方式请看开发者文档和 [USAGE.md](USAGE.md)。

当前公开角色入口使用固定 CLI 工作区：`input prepare --file` 准备 `cache/tirtc-devtools/input/`，`device start --input file|system --output file|system|both` 写出 `device/bootstrap.json` 和 role evidence，`client start --bootstrap ... --output file|system|both` 消费 bootstrap 并写出 `client/output/`。

## 目录

| 目录 | 作用 |
| --- | --- |
| `src/` | TypeScript CLI 实现。 |
| `bin/` | npm bin 入口。 |
| `script/` | 本子工程的准备、构建、打包和验证脚本。 |
| `tests/` | CLI 单元测试、package 验证测试和 e2e 配置示例。 |
| `driver/` | CLI 打包使用的 native device/client driver 源码。 |
| `3rd/runtime/` | 预构建 runtime SDK 输入目录，由 `script/prepare_runtime.sh` 生成。 |
| `vendor/` | npm package staging 目录，由 `script/package.sh` 生成。 |

`3rd/runtime/` 和 `vendor/` 是本地生成目录，不提交到源码仓库。

## 前置条件

- Node.js 20+ 和 npm。
- macOS arm64 或 Linux x64。
- 完整打包前需要准备 runtime SDK。
- 自动下载 runtime SDK 时，需要能访问 GitHub Releases。

## 安装依赖

```sh
npm ci
```

## 构建

只构建 TypeScript：

```sh
npm run build
```

从源码启动 CLI：

```sh
node bin/tirtc-devtools-cli.js --help
```

## 准备 runtime SDK

完整 package 需要 `3rd/runtime/<platform>/include` 和 `3rd/runtime/<platform>/lib`。

自动下载最新 release asset：

```sh
./script/prepare_runtime.sh
```

手动指定 runtime SDK zip：

```sh
TIRTC_DEVTOOLS_RUNTIME_SDK_ZIP=/path/to/devtools-runtime-sdk-YYYYMMDDHHMMSS.zip \
  ./script/prepare_runtime.sh
```

手动指定已经解压好的 SDK 目录：

```sh
TIRTC_DEVTOOLS_RUNTIME_SDK_DIR=/path/to/runtime-sdk-root \
  ./script/prepare_runtime.sh
```

## 测试

```sh
npm test
```

package 验证：

```sh
npm run test:package
```

需要真实 TiRTC 链路时，先按 `tests/runtime-backed.e2e.config.example.json` 准备本地配置，再运行对应 e2e 脚本。

DevTools CLI 自身验收：

```sh
npm run test:acceptance
```

从 TiRTC AV 仓库根目录执行标准三 codec 真实闭环：

```sh
.agents/skills/devtools-cli-send-receive-e2e/scripts/run_devtools_cli_send_receive_e2e.sh
```

## 打包

```sh
npm run package
```

`npm run package` 会：

1. 构建 TypeScript。
2. 准备 runtime SDK。
3. 构建当前平台对应的 native driver。
4. 构建 token issuer 二进制。
5. 生成 `vendor/` staging 内容。

生成 npm tarball：

```sh
npm pack
```

## 平台

当前 package 支持：

- `macos-arm64`
- `linux-x64`

可以通过环境变量指定构建平台：

```sh
TIRTC_RUNTIME_PLATFORM=linux-x64 npm run package
```

或一次构建多个平台：

```sh
TIRTC_RUNTIME_PLATFORMS="macos-arm64 linux-x64" npm run package
```
