# TiRTC 开发者工具源码工程

这是 TiRTC 开发者工具集的开源工程，完整源码位于：

https://github.com/tangeai/tirtc-developer-tools

本仓库说明源码工程如何准备、构建和验证。TiRTC 接入流程、客户端配置和工具使用方式请看开发者文档：

https://docs.tange.ai/products/tirtc/

## 目录

| 目录 | 作用 |
| --- | --- |
| `token-issuer/` | Go 实现的 token 签发服务模拟。它提供独立的 HTTP issuer 和命令行二进制，用于开发联调和业务服务接入前的签名逻辑参考。 |
| `devtools/` | Node.js/TypeScript 实现的 TiRTC DevTools CLI 源码。它负责 CLI 命令入口、npm 包构建、runtime SDK 准备、native driver 打包和 package 级验证。 |
| `devtools/driver/` | CLI 使用的 native device/client driver。它通过 TiRTC runtime C API 执行标准 device/client 对端能力。 |
| `devtools/3rd/runtime/` | 本地准备出来的预构建 runtime SDK 输入目录。源码仓库不提交该目录内容。 |
| `devtools/vendor/` | npm package staging 目录，由 `npm run package` 生成。源码仓库不提交该目录内容。 |

## 前置条件

- Node.js 20+ 和 npm。
- Go 1.22+。
- macOS arm64 或 Linux x64。
- 构建完整 CLI package 时，需要准备预构建 runtime SDK。
- 自动下载 runtime SDK 时，需要能访问 GitHub Releases。

## 准备 runtime SDK

完整 CLI package 依赖预构建 runtime SDK。执行：

```sh
cd devtools
./script/prepare_runtime.sh
```

脚本会从本仓库 GitHub Releases 下载最新 `devtools-runtime-sdk-*.zip`，并解压到：

```text
devtools/3rd/runtime/
  macos-arm64/
    include/
    lib/
  linux-x64/
    include/
    lib/
```

如果已经手动下载 runtime SDK zip，可以直接指定：

```sh
cd devtools
TIRTC_DEVTOOLS_RUNTIME_SDK_ZIP=/path/to/devtools-runtime-sdk-YYYYMMDDHHMMSS.zip \
  ./script/prepare_runtime.sh
```

## 构建与验证

### token-issuer

```sh
cd token-issuer
./script/test.sh
./script/build.sh --platform "$(./script/host_platform.sh)"
```

启动本机开发服务时：

```sh
./script/serve.sh --port 8966
```

### devtools CLI

```sh
cd devtools
npm ci
npm run build
npm test
```

准备 runtime SDK 后，可以构建完整 package staging：

```sh
./script/prepare_runtime.sh
npm run package
npm run test:package
```

源码方式启动 CLI：

```sh
node bin/tirtc-devtools-cli.js --help
```

## 安全边界

`TIRTC_ACCESS_KEY_ID`、`TIRTC_SECRET_KEY_ID`、`TIRTC_DEVICE_SECRET_KEY` 以及设备密钥映射文件都属于服务端密钥材料。它们只应存在于服务端、网关或受控开发环境中，不应下发到客户端，也不应写入日志。
