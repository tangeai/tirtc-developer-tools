import {Command, Option} from 'commander';
import fs from 'fs';
import path from 'path';

import {resolveCliPackageRoot} from './embedded_paths';
import {prepareCliInput, prepareMediaAssets} from './media_assets';
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

async function runInputPrepare(
  commandOptions: {file?: string; cacheDir?: string},
  options: CliOptions,
): Promise<number> {
  const progress = new ProgressIndicator();
  progress.start('Preparing fixed CLI input');
  try {
    if (!commandOptions.file?.trim()) {
      throw {reasonCode: 'invalid_source_media', message: 'input prepare requires --file <path>'};
    }
    const result = await prepareCliInput({
      file: commandOptions.file,
      cacheDir: commandOptions.cacheDir ?? path.join('cache', 'tirtc-devtools'),
    }, {
      progress: (message) => {
        progress.update(message);
      },
    });

    progress.succeed('Prepared fixed CLI input');
    if (options.json) {
      console.log(JSON.stringify({code: 0, message: 'OK', data: result}));
    } else {
      console.log('Prepared CLI input:', JSON.stringify(result, null, 2));
    }
    return 0;
  } catch (error: unknown) {
    progress.fail('Input prepare failed');
    return printError(error, options);
  }
}

function runAndExit(promise: Promise<number>): void {
  promise.then((code) => process.exit(code));
}

program.name('tirtc-devtools-cli')
    .description('TiRTC DevTools CLI')
    .option('--version', 'display version')
    .option('--json', '以机器可读 JSON 输出（便于脚本集成）');

registerTokenCommands(program, getCliOptions, runAndExit);

const input = program.command('input').description('准备 DevTools CLI 固定本地输入');
input.command('prepare')
    .description('把本地 MP4 准备到固定 CLI 工作区 input/')
    .requiredOption('--file <path>', '本地 MP4 输入文件')
    .option('--cache-dir <dir>', 'CLI 工作区根目录', path.join('cache', 'tirtc-devtools'))
    .addHelpText('after', `
Examples:
  $ tirtc-devtools-cli --json input prepare --file ./movie.mp4
  $ tirtc-devtools-cli --json device start --input file
`)
    .action((commandOptions: {file?: string; cacheDir?: string}) => {
      runAndExit(runInputPrepare(commandOptions, getCliOptions()));
    });

const assets = program.command('assets', {hidden: true}).description('准备 DevTools driver 使用的媒体资产');
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
    .description('启动上行 device，读取固定文件输入或 macOS 系统输入')
    .option('--input <mode>', 'file|system', 'file')
    .option('--output <mode>', 'file|system|both', 'file')
    .option('--cache-dir <dir>', 'CLI 工作区根目录', path.join('cache', 'tirtc-devtools'))
    .option('--preview', '仅 --input system 合法，显示本地预览')
    .option('--video-codec <codec>', 'h264|h265|mjpeg', 'h264')
    .option('--audio-codec <codec>', 'g711a|aac|pcm|opus|amr', 'g711a')
    .option('--audio-sample-rate <hz>', '8000|16000', '16000')
    .option('--audio-channels <count>', '1|2', '1')
    .option('--audio-input-aec <mode>', 'disabled|enabled', 'disabled')
    .option('--audio-input-agc <level>', 'disabled|low|medium|high', 'disabled')
    .option('--audio-input-ans <level>', 'disabled|low|medium|high', 'disabled')
    .option('--audio-output-agc <level>', 'disabled|low|medium|high', 'disabled')
    .option('--audio-output-ans <level>', 'disabled|low|medium|high', 'disabled')
    .option('--duration-ms <ms>', '可选自动结束时长；0 表示持续运行', '0')
    .option('--connect-timeout-ms <ms>', 'service ready 最大等待')
    .option('--first-packet-timeout-ms <ms>', '首包最大等待')
    .option('--first-output-timeout-ms <ms>', 'system 输出首帧 / 首次出声最大等待')
    .addOption(new Option('--artifact-root <dir>', 'artifact 输出目录').hideHelp())
    .addOption(new Option('--device-id <id>', 'device id；不传时读取 TIRTC_DEVICE_ID').hideHelp())
    .addOption(new Option('--device-secret-key <key>', 'device secret key；不传时读取 TIRTC_DEVICE_SECRET_KEY').hideHelp())
    .addOption(new Option('--endpoint <url>', 'TiRTC endpoint；不传时读取 TIRTC_ENDPOINT').hideHelp())
    .addOption(new Option('--source <path>', 'legacy prepared asset root、manifest_path 或 encoded track').hideHelp())
    .addOption(new Option('--receive-audio-stream-id <id>', '接收 Flutter 本地音频传输的 stream id').hideHelp())
    .addOption(new Option('--exit-after-first-session', '首个 client 会话完成后主动正常退出并写出 summary').hideHelp())
    .addOption(new Option('--client-token-json <path>', 'legacy token issue --json 输出文件').hideHelp())
    .addHelpText('after', `
Examples:
  $ tirtc-devtools-cli --json input prepare --file ./movie.mp4
  $ tirtc-devtools-cli --json device start --input file --output file
  $ tirtc-devtools-cli --json device start --input system --preview --output both

Artifacts are written under cache/tirtc-devtools/device by default.
`)
    .action((commandOptions) => {
      runAndExit(runDeviceStart(commandOptions, getCliOptions()));
    });

const client = program.command('client').description('作为标准下行 client 运行 native DevTools driver');
client.command('start')
    .description('启动下行 client，消费 device bootstrap 并输出远端音视频')
    .option('--bootstrap <path>', 'device start 产出的 bootstrap.json')
    .option('--output <mode>', 'file|system|both', 'file')
    .option('--cache-dir <dir>', 'CLI 工作区根目录', path.join('cache', 'tirtc-devtools'))
    .option('--audio-output-agc <level>', 'disabled|low|medium|high', 'disabled')
    .option('--audio-output-ans <level>', 'disabled|low|medium|high', 'disabled')
    .option('--audio-stream-id <id>', '音频 stream id')
    .option('--video-stream-id <id>', '视频 stream id')
    .option('--duration-ms <ms>', '可选自动结束时长；0 表示持续运行', '0')
    .option('--connect-timeout-ms <ms>', 'connect 最大等待')
    .option('--first-packet-timeout-ms <ms>', '首包最大等待')
    .option('--first-output-timeout-ms <ms>', '首帧输出最大等待')
    .addOption(new Option('--artifact-root <dir>', 'artifact 输出目录').hideHelp())
    .addOption(new Option('--target-device-id <id>', '目标 device id；优先于 bootstrap').hideHelp())
    .addOption(new Option('--token <token>', '显式 token；优先于 bootstrap').hideHelp())
    .addOption(new Option('--endpoint <url>', 'TiRTC endpoint；优先于 bootstrap').hideHelp())
    .addOption(new Option('--app-id <id>', 'client connect app id；不传时读取 bootstrap 或 TIRTC_APP_ID').hideHelp())
    .addOption(new Option('--consumer <consumer>', 'packet_dump|frame_dump').default('frame_dump').hideHelp())
    .addOption(new Option('--frame-limit <count>', 'frame_dump 帧数上限').hideHelp())
    .addHelpText('after', `
Examples:
  $ tirtc-devtools-cli --json client start --bootstrap cache/tirtc-devtools/device/bootstrap.json
  $ tirtc-devtools-cli --json client start --bootstrap cache/tirtc-devtools/device/bootstrap.json --output both

Artifacts are written under cache/tirtc-devtools/client by default.
`)
    .action((commandOptions) => {
      runAndExit(runClientStart(commandOptions, getCliOptions()));
    });

program.parse(process.argv);
