import fs from 'fs';
import os from 'os';
import path from 'path';

import {runClientStart, runDeviceStart} from '../src/role_driver';

type JsonEnvelope = {
  code: number;
  message: string;
  data: {
    status: string;
    exit_code: number;
    role: string;
    reason_code: string;
    failed_stage: string;
    artifact_root: string;
    summary_path: string;
    bootstrap_path?: string;
  };
};

type DeviceContractOptions = Parameters<typeof runDeviceStart>[0] & {
  cacheDir?: string;
  input?: 'file' | 'system';
  output?: 'file' | 'system' | 'both';
  preview?: boolean;
  audioInputAec?: 'disabled' | 'enabled';
  audioInputAgc?: 'disabled' | 'low' | 'medium' | 'high';
  audioInputAns?: 'disabled' | 'low' | 'medium' | 'high';
  audioOutputAgc?: 'disabled' | 'low' | 'medium' | 'high';
  audioOutputAns?: 'disabled' | 'low' | 'medium' | 'high';
};

type ClientContractOptions = Parameters<typeof runClientStart>[0] & {
  cacheDir?: string;
  output?: 'file' | 'system' | 'both';
  audioOutputAgc?: 'disabled' | 'low' | 'medium' | 'high';
  audioOutputAns?: 'disabled' | 'low' | 'medium' | 'high';
};

function makeRuntimeRoot(root: string): string {
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(runtimeRoot, 'include', 'tirtc'), {recursive: true});
  fs.mkdirSync(path.join(runtimeRoot, 'lib'), {recursive: true});
  fs.writeFileSync(path.join(runtimeRoot, 'include', 'tirtc', 'av.h'), '/* test */\n');
  fs.writeFileSync(path.join(runtimeRoot, 'lib', 'libtirtc_av.so'), '');
  fs.writeFileSync(path.join(runtimeRoot, 'lib', 'libtirtc_av.dylib'), '');
  return runtimeRoot;
}

function makeDriver(root: string): string {
  const driverPath = path.join(root, 'devtools_driver_probe');
  fs.writeFileSync(path.join(root, 'libtgrtc.dylib'), '');
  fs.writeFileSync(
    driverPath,
    `#!/bin/sh
set -eu
artifact_root=""
request_path=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact-root)
      artifact_root="$2"
      shift 2
      ;;
    --request)
      request_path="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$artifact_root"
execution_id="$(node -e "const fs=require('fs'); const req=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(req.execution_id || 'contract-test')" "$request_path")"
cat > "$artifact_root/summary.json" <<JSON
{"schema_version":1,"execution_id":"$execution_id","role":"device","status":"completed","exit_code":0,"reason_code":"ok"}
JSON
exit 0
`,
  );
  fs.chmodSync(driverPath, 0o755);
  return driverPath;
}

function makeIssuer(root: string): string {
  const issuerPath = path.join(root, 'tirtc-issuer-cli');
  fs.writeFileSync(
    issuerPath,
    `#!/bin/sh
printf '%s\\n' '{"code":0,"message":"OK","data":{"token":"client-token-secret"}}'
`,
  );
  fs.chmodSync(issuerPath, 0o755);
  return issuerPath;
}

function writePreparedInput(cacheDir: string): void {
  const inputDir = path.join(cacheDir, 'input');
  const audioFileName = 'audio_send.g711a_16000_1ch_s16.g711a';
  fs.mkdirSync(inputDir, {recursive: true});
  fs.writeFileSync(path.join(inputDir, audioFileName), 'audio');
  fs.writeFileSync(path.join(inputDir, audioFileName + '.packets.csv'), 'pts_us,offset,size\n0,0,5\n');
  fs.writeFileSync(path.join(inputDir, 'video_send.h264'), 'video');
  fs.writeFileSync(
    path.join(inputDir, 'video_send.h264.packets.csv'),
    'pts_us,offset,size,is_key_frame\n0,0,5,true\n',
  );
  fs.writeFileSync(path.join(inputDir, 'media_input.json'), JSON.stringify({
    schema_version: 1,
    prepared_at: '2026-06-26T00:00:00Z',
    source_file: '/tmp/source.mp4',
    cache_dir: cacheDir,
    audio: {
      g711a_16000_1ch_s16: {
        codec: 'g711a',
        path: 'input/' + audioFileName,
        packet_index_path: 'input/' + audioFileName + '.packets.csv',
        sample_rate_hz: 16000,
        channels: 1,
        bits_per_sample: 16,
        sample_format: 'encoded',
        bytes: 5,
        packet_count: 1,
      },
    },
    video: {
      h264: {
        codec: 'h264',
        path: 'input/video_send.h264',
        packet_index_path: 'input/video_send.h264.packets.csv',
        bitstream_format: 'h264_annexb',
        width: 1280,
        height: 720,
        fps: 15,
        bytes: 5,
        packet_count: 1,
      },
    },
  }, null, 2) + '\n');
}

describe('role driver public contract preflight', () => {
  const originalEnv = {...process.env};
  let tempRoot = '';
  let cacheDir = '';
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = {...originalEnv};
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-cli-contract-'));
    cacheDir = path.join(tempRoot, 'cache', 'tirtc-devtools');
    process.env.TIRTC_RUNTIME_PLATFORM = 'linux-x64';
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = makeDriver(tempRoot);
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = makeRuntimeRoot(tempRoot);
    process.env.TIRTC_ISSUER_CLI_PATH = makeIssuer(tempRoot);
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_ACCESS_KEY_ID = 'access-key-id';
    process.env.TIRTC_SECRET_KEY_ID = 'secret-key-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';
    process.env.TIRTC_APP_ID = 'app-id';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(tempRoot, {recursive: true, force: true});
    process.env = originalEnv;
  });

  function lastEnvelope(): JsonEnvelope {
    const raw = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    return JSON.parse(raw) as JsonEnvelope;
  }

  it('requires prepared fixed cache input for file device input', async () => {
    await expect(runDeviceStart({
      cacheDir,
      input: 'file',
    } as DeviceContractOptions, {json: true})).resolves.toBe(3);

    expect(lastEnvelope().data).toMatchObject({
      status: 'failed',
      exit_code: 3,
      role: 'device',
      reason_code: 'input_not_prepared',
      failed_stage: 'preflight',
    });
  });

  it('rejects input 3A options when device input is file', async () => {
    writePreparedInput(cacheDir);

    await expect(runDeviceStart({
      cacheDir,
      input: 'file',
      audioInputAec: 'enabled',
    } as DeviceContractOptions, {json: true})).resolves.toBe(3);

    expect(lastEnvelope().data.reason_code).toBe('invalid_option_combination');
  });

  it('rejects output 3A options when output mode is file', async () => {
    writePreparedInput(cacheDir);

    await expect(runDeviceStart({
      cacheDir,
      input: 'file',
      output: 'file',
      audioOutputAgc: 'medium',
    } as DeviceContractOptions, {json: true})).resolves.toBe(3);

    expect(lastEnvelope().data.reason_code).toBe('invalid_option_combination');
  });

  it('rejects preview unless device input is system', async () => {
    writePreparedInput(cacheDir);

    await expect(runDeviceStart({
      cacheDir,
      input: 'file',
      preview: true,
    } as DeviceContractOptions, {json: true})).resolves.toBe(3);

    expect(lastEnvelope().data.reason_code).toBe('invalid_option_combination');
  });

  it('rejects linux system input and output capabilities before driver startup', async () => {
    writePreparedInput(cacheDir);

    await expect(runDeviceStart({
      cacheDir,
      input: 'system',
      output: 'system',
    } as DeviceContractOptions, {json: true})).resolves.toBe(3);

    expect(lastEnvelope().data.reason_code).toBe('unsupported_platform_capability');
  });

  it('maps invalid client bootstrap to the stable preflight reason', async () => {
    const bootstrapPath = path.join(tempRoot, 'invalid-bootstrap.json');
    fs.writeFileSync(bootstrapPath, '{"schema_version":1,"remote_id":"peer"}\n');

    await expect(runClientStart({
      cacheDir,
      bootstrap: bootstrapPath,
      output: 'file',
    } as ClientContractOptions, {json: true})).resolves.toBe(3);

    expect(lastEnvelope().data).toMatchObject({
      exit_code: 3,
      role: 'client',
      reason_code: 'bootstrap_invalid',
      failed_stage: 'preflight',
    });
  });

  it('cleans only the active role directory and preserves prepared input', async () => {
    writePreparedInput(cacheDir);
    fs.mkdirSync(path.join(cacheDir, 'device'), {recursive: true});
    fs.writeFileSync(path.join(cacheDir, 'device', 'old-summary.json'), '{}\n');
    const preparedInput = path.join(cacheDir, 'input', 'media_input.json');

    await expect(runDeviceStart({
      cacheDir,
      input: 'file',
      output: 'file',
    } as DeviceContractOptions, {json: true})).resolves.toBe(0);

    const envelope = lastEnvelope();
    expect(envelope.data.artifact_root).toBe(path.join(cacheDir, 'device'));
    expect(envelope.data.summary_path).toBe(path.join(cacheDir, 'device', 'summary.json'));
    expect(fs.existsSync(path.join(cacheDir, 'device', 'old-summary.json'))).toBe(false);
    expect(fs.existsSync(preparedInput)).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'device', 'bootstrap.json'))).toBe(true);
  });

  it('does not enable remote audio receive for file-input device runs', async () => {
    writePreparedInput(cacheDir);

    await expect(runDeviceStart({
      cacheDir,
      input: 'file',
      output: 'file',
    } as DeviceContractOptions, {json: true})).resolves.toBe(0);

    const requestPath = path.join(cacheDir, 'device', 'request.redacted.json');
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8')) as {
      media?: {receive_audio?: {enabled?: boolean}};
    };
    expect(request.media?.receive_audio?.enabled).toBe(false);
  });

  it('enables remote audio receive for explicit file-input device talkback runs', async () => {
    writePreparedInput(cacheDir);

    await expect(runDeviceStart({
      cacheDir,
      input: 'file',
      output: 'file',
      receiveAudioStreamId: '17',
    } as DeviceContractOptions, {json: true})).resolves.toBe(0);

    const requestPath = path.join(cacheDir, 'device', 'request.redacted.json');
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8')) as {
      media?: {receive_audio?: {enabled?: boolean; stream_id?: number}};
    };
    expect(request.media?.receive_audio).toMatchObject({enabled: true, stream_id: 17});
  });

  it('enables remote audio receive for system-input device runs', async () => {
    process.env.TIRTC_RUNTIME_PLATFORM = 'macos-arm64';
    process.env.TIRTC_AV_ASSET_WORKSPACE_ROOT = path.join(tempRoot, 'missing-system-assets');

    await expect(runDeviceStart({
      cacheDir,
      input: 'system',
      output: 'both',
      preview: true,
    } as DeviceContractOptions, {json: true})).resolves.toBe(0);

    const requestPath = path.join(cacheDir, 'device', 'request.redacted.json');
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8')) as {
      media?: {
        source?: {kind?: string; path?: string};
        receive_audio?: {enabled?: boolean; stream_id?: number};
      };
    };
    expect(request.media?.source).toMatchObject({kind: 'system', path: ''});
    expect(request.media?.receive_audio).toMatchObject({enabled: true, stream_id: 14});
  });
});
