import {Command} from 'commander';
import fs from 'fs';
import path from 'path';

import {resolveCliPackageRoot} from './embedded_paths';
import {prepareMediaAssets} from './media_assets';
import {ProgressIndicator} from './progress';
import {registerTokenCommands, type CliOptions} from './token_command';
import {runClientStart, runDeviceStart} from './role_driver';

type CliError = {
  reasonCode?: string;
  message?: string;
  data?: unknown;
};

function resolveCliVersion(): string {
  try {
    const packageRoot = resolveCliPackageRoot(__dirname);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as {version?: unknown};
    return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const cliVersion = resolveCliVersion();

if (process.argv.includes('--version') || process.argv.includes('-V')) {
  console.log('CLI Version: ' + cliVersion);
  console.log('DevTools Driver Contract: 1');
  process.exit(0);
}

const program = new Command();

function getCliOptions(): CliOptions {
  return program.opts<CliOptions>();
}

function normalizeError(error: unknown): Required<CliError> {
  if (typeof error === 'object' && error !== null) {
    const typed = error as CliError;
    if (typed.reasonCode || typed.message || typed.data !== undefined) {
      return {
        reasonCode: typed.reasonCode ?? 'internal_error',
        message: typed.message ?? 'Internal error',
        data: typed.data,
      };
    }
  }

  if (error instanceof Error) {
    return {
      reasonCode: 'internal_error',
      message: error.message,
      data: undefined,
    };
  }

  return {
    reasonCode: 'internal_error',
    message: 'Internal error',
    data: undefined,
  };
}

function printError(error: unknown, options: CliOptions): number {
  const normalized = normalizeError(error);
  if (options.json) {
    console.log(JSON.stringify({
      code: 1,
      message: normalized.message,
      data: normalized.data ?? {reason_code: normalized.reasonCode},
    }));
  } else {
    console.error('Error (' + normalized.reasonCode + '): ' + normalized.message);
  }
  return 1;
}

async function runAssetsPrepare(
  commandOptions: {source?: string; outputRoot?: string},
  options: CliOptions,
): Promise<number> {
  const progress = new ProgressIndicator();
  progress.start('Preparing media assets');
  try {
    const result = await prepareMediaAssets({
      source: commandOptions.source ?? 'runtime/assets/source.mp4',
      outputRoot: commandOptions.outputRoot ?? 'runtime/assets/.workspace',
      overwrite: false,
    }, {
      progress: (message) => {
        progress.update(message);
      },
    });

    progress.succeed(result.cache_hit ? 'Media assets cache hit' : 'Prepared media assets');
    if (options.json) {
      console.log(JSON.stringify({code: 0, message: 'OK', data: result}));
    } else {
      console.log('Prepared media assets:', JSON.stringify(result, null, 2));
    }
    return 0;
  } catch (error: unknown) {
    progress.fail('Media assets prepare failed');
    return printError(error, options);
  }
}

function runAndExit(promise: Promise<number>): void {
  promise.then((code) => process.exit(code));
}

program.name('tirtc-devtools-cli')
    .description('TiRTC DevTools CLI')
    .option('--json', '以机器可读 JSON 输出（便于脚本集成）');

registerTokenCommands(program, getCliOptions, runAndExit);

const assets = program.command('assets').description('准备 DevTools driver 使用的媒体资产');
assets.command('prepare')
    .description('准备默认 runtime assets 或把显式 source 写入 output root')
    .option('--source <path>', '输入 MP4 路径；device start 使用输出的 manifest_path')
    .option('--output-root <dir>', 'prepared assets 输出根目录')
    .addHelpText('after', `
Examples:
  $ tirtc-devtools-cli --json assets prepare --source ./movie.mp4 --output-root .build/tirtc-assets
  $ tirtc-devtools-cli --json device start --source .build/tirtc-assets/manifest.json --video-codec h264
`)
    .action((commandOptions: {source?: string; outputRoot?: string}) => {
      runAndExit(runAssetsPrepare(commandOptions, getCliOptions()));
    });

const device = program.command('device').description('作为标准上行 device 运行 native DevTools driver');
device.command('start')
    .description('启动上行 device，读取 prepared asset 并送出音视频')
    .option('--artifact-root <dir>', 'artifact 输出目录')
    .option('--device-id <id>', 'device id；不传时读取 TIRTC_DEVICE_ID')
    .option('--device-secret-key <key>', 'device secret key；不传时读取 TIRTC_DEVICE_SECRET_KEY')
    .option('--endpoint <url>', 'TiRTC endpoint；不传时读取 TIRTC_ENDPOINT')
    .option('--source <path>', 'prepared asset root、manifest_path 或 encoded track；MP4 先运行 assets prepare')
    .option('--video-codec <codec>', 'h264|h265|mjpeg', 'h264')
    .option('--audio-codec <codec>', 'g711a|aac', 'g711a')
    .option('--audio-sample-rate <hz>', '8000|16000', '8000')
    .option('--audio-channels <count>', '1|2', '1')
    .option('--exit-after-first-session', '首个 client 会话完成后主动正常退出并写出 summary')
    .option('--duration-ms <ms>', '可选自动结束时长；默认持续运行直到用户结束进程')
    .option('--connect-timeout-ms <ms>', 'service ready 最大等待')
    .option('--first-packet-timeout-ms <ms>', '首包最大等待')
    .option('--client-token-json <path>', 'token issue --json 输出文件；传入时写出本机 bootstrap.json')
    .addHelpText('after', `
Examples:
  $ tirtc-devtools-cli --json assets prepare --source ./movie.mp4 --output-root .build/tirtc-assets
  $ tirtc-devtools-cli --json device start --source .build/tirtc-assets/manifest.json --artifact-root .build/tirtc-device

device start requires device id, device secret key, and endpoint.
Missing flags are read from TIRTC_DEVICE_ID, TIRTC_DEVICE_SECRET_KEY, and TIRTC_ENDPOINT.

device start succeeds once the device listener is ready. It keeps running without a client until
the process is stopped or an explicit --duration-ms deadline is reached.
Runtime lifecycle logs are written to stderr. With --json, the final envelope remains on stdout.

The native device role echoes every received command with the same command id and payload.
summary.json and the --json envelope include command_echo evidence.

bootstrap.json is a local handoff artifact for client/sample/validation automation.
It is only written when --client-token-json is provided.
It is not a mobile SDK connection protocol.
`)
    .action((commandOptions) => {
      runAndExit(runDeviceStart(commandOptions, getCliOptions()));
    });

const client = program.command('client').description('作为标准下行 client 运行 native DevTools driver');
client.command('start')
    .description('启动下行 client，消费 bootstrap 或显式 token 并产出 frame_dump')
    .option('--artifact-root <dir>', 'artifact 输出目录')
    .option('--bootstrap <path>', 'device start 产出的 bootstrap.json')
    .option('--target-device-id <id>', '目标 device id；优先于 bootstrap')
    .option('--token <token>', '显式 token；优先于 bootstrap')
    .option('--endpoint <url>', 'TiRTC endpoint；优先于 bootstrap')
    .option('--app-id <id>', 'client connect app id；不传时读取 bootstrap 或 TIRTC_APP_ID')
    .option('--audio-stream-id <id>', '音频 stream id')
    .option('--video-stream-id <id>', '视频 stream id')
    .option('--consumer <consumer>', 'packet_dump|frame_dump', 'frame_dump')
    .option('--frame-limit <count>', 'frame_dump 帧数上限')
    .option('--duration-ms <ms>', '可选自动结束时长；默认由输出条件或用户结束进程')
    .option('--connect-timeout-ms <ms>', 'connect 最大等待')
    .option('--first-packet-timeout-ms <ms>', '首包最大等待')
    .option('--first-output-timeout-ms <ms>', '首帧输出最大等待')
    .addHelpText('after', `
Examples:
  $ tirtc-devtools-cli --json client start --bootstrap .build/tirtc-device/bootstrap.json

bootstrap.json is expected to come from a local device start run.
For mobile device debugging, use token/license QR or a future session QR/deeplink.

The native client role echoes every received command with the same command id and payload.
summary.json and the --json envelope include command_echo evidence.
`)
    .action((commandOptions) => {
      runAndExit(runClientStart(commandOptions, getCliOptions()));
    });

program.parse(process.argv);
