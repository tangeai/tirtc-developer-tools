import fs from 'fs';
import os from 'os';
import path from 'path';

import * as ffmpegTool from '../src/ffmpeg_tool';
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
    log_id?: string;
    log_upload?: {
      status?: string;
      log_id?: string;
      reason_code?: string;
      error_code?: number;
    };
    received_audio?: {
      enabled?: boolean;
      stream_id?: number;
      codec?: string;
      sample_rate_hz?: number;
      channels?: number;
      captured_bytes?: number;
      pcm_path?: string;
      metadata_path?: string;
      mp3_path?: string | null;
      mp3_status?: string;
      mp3_reason_code?: string | null;
    };
  };
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

function makeAssetRoot(root: string): string {
  const assetRoot = path.join(root, 'assets');
  fs.mkdirSync(assetRoot, {recursive: true});
  fs.writeFileSync(path.join(assetRoot, 'manifest.json'), '{}\n');
  return assetRoot;
}

function makeDriver(root: string): string {
  const driverPath = path.join(root, 'devtools_driver_probe');
  fs.writeFileSync(driverPath, '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(root, 'libtgrtc.dylib'), '');
  fs.chmodSync(driverPath, 0o755);
  return driverPath;
}

function makeSummaryDriver(root: string, summaryJson: string, exitCode: number): string {
  const driverPath = path.join(root, 'devtools_driver_probe');
  fs.writeFileSync(
    driverPath,
    `#!/bin/sh
set -eu
artifact_root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact-root)
      artifact_root="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$artifact_root"
cat > "$artifact_root/summary.json" <<'JSON'
${summaryJson}
JSON
exit ${exitCode}
`,
  );
  fs.chmodSync(driverPath, 0o755);
  return driverPath;
}

function makeReceivedAudioPcmSummaryDriver(root: string, summaryJson: string, exitCode: number): string {
  const driverPath = path.join(root, 'devtools_driver_probe');
  fs.writeFileSync(
    driverPath,
    `#!/bin/sh
set -eu
artifact_root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact-root)
      artifact_root="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$artifact_root"
printf 'tirtc-pcm' > "$artifact_root/received-audio.pcm"
cat > "$artifact_root/summary.json" <<'JSON'
${summaryJson}
JSON
exit ${exitCode}
`,
  );
  fs.chmodSync(driverPath, 0o755);
  return driverPath;
}

function makeLiveSummaryDriver(root: string): string {
  const driverPath = path.join(root, 'devtools_driver_probe');
  fs.writeFileSync(
    driverPath,
    `#!/bin/sh
set -eu
artifact_root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact-root)
      artifact_root="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$artifact_root"
cat > "$artifact_root/events.jsonl" <<'JSONL'
{"schema_version":1,"execution_id":"live-log-test","event_id":"event-1","timestamp":"2026-05-03T00:00:00Z","level":"info","family":"connection","kind":"connection.listen.done","role":"device","payload":{"remote_id":"server-device-id","elapsed_ms":0}}
{"schema_version":1,"execution_id":"live-log-test","event_id":"event-2","timestamp":"2026-05-03T00:00:01Z","level":"info","family":"connection","kind":"connection.connect.done","role":"device","payload":{"session_index":1,"remote_id":"server-device-id","elapsed_ms":1}}
{"schema_version":1,"execution_id":"live-log-test","event_id":"event-3","timestamp":"2026-05-03T00:00:02Z","level":"info","family":"media","kind":"media.audio_send.session_first_packet","role":"device","payload":{"session_index":1,"stream_id":10,"codec":"g711a","pts_us":0,"bytes":160}}
{"schema_version":1,"execution_id":"live-log-test","event_id":"event-4","timestamp":"2026-05-03T00:00:03Z","level":"info","family":"media","kind":"media.video_send.session_first_packet","role":"device","payload":{"session_index":1,"stream_id":11,"codec":"h265","pts_us":0,"bytes":1024,"is_key_frame":true}}
{"schema_version":1,"execution_id":"live-log-test","event_id":"event-5","timestamp":"2026-05-03T00:00:04Z","level":"info","family":"connection","kind":"connection.session.end","role":"device","payload":{"session_index":1,"sent_first_audio":true,"sent_first_video":true,"disconnected":true,"elapsed_ms":4000}}
{"schema_version":1,"execution_id":"live-log-test","event_id":"event-6","timestamp":"2026-05-03T00:00:05Z","level":"info","family":"artifact","kind":"driver.execution.finished","role":"device","payload":{"status":"completed","exit_code":0,"reason_code":"ok"}}
JSONL
cat > "$artifact_root/summary.json" <<'JSON'
{
  "schema_version": 1,
  "execution_id": "live-log-test",
  "driver_version": "fake",
  "runtime_version": "fake",
  "role": "device",
  "status": "completed",
  "exit_code": 0,
  "stage_status": {
    "connect": {"status": "passed"},
    "media_send": {"status": "passed"}
  },
  "received_audio": {
    "enabled": true,
    "stream_id": 14,
    "codec": "g711a",
    "sample_rate_hz": 16000,
    "channels": 1,
    "bits_per_sample": 16,
    "sample_format": "s16le",
    "first_output_timing_ms": 120,
    "captured_bytes": 4096,
    "pcm_path": "received-audio.pcm",
    "metadata_path": "received-audio.metadata.json",
    "mp3_path": "received-audio-20260624-120000.mp3",
    "mp3_status": "generated",
    "mp3_reason_code": "ok"
  },
  "stream_message": {
    "enabled": true,
    "pairing_id": "live-log-test",
    "stream_id": 11,
    "last_session_index": 1,
    "sent_count": 1,
    "received_count": 0,
    "error_count": 0,
    "last_payload_epoch_seconds": 1799930000,
    "last_payload_hash": "fnv1a64:0000000000000000",
    "last_send_result": 0,
    "first_send_monotonic_ms": 10,
    "last_send_monotonic_ms": 10,
    "matched_receive_count": 0,
    "periodic_send_ok": true,
    "periodic_window_short": true,
    "stopped_after_disconnect": true
  },
  "artifact_paths": {
    "summary": "summary.json"
  }
}
JSON
exit 0
`,
  );
  fs.chmodSync(driverPath, 0o755);
  return driverPath;
}

describe('role driver preflight failures', () => {
  const originalEnv = {...process.env};
  let tempRoot = '';
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = {...originalEnv};
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-cli-role-preflight-'));
    process.env.TIRTC_RUNTIME_PLATFORM = 'unit-test';
    process.env.TIRTC_ENDPOINT = 'https://example.invalid';
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

  async function runReceiveWithArtifact(artifactName: string): Promise<number> {
    return runClientStart(
      {
        artifactRoot: path.join(tempRoot, artifactName),
        targetDeviceId: 'peer-unit-test',
        token: 'token-unit-test',
      },
      {json: true},
    );
  }

  it('reports missing native driver as a preflight failure', async () => {
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = path.join(tempRoot, 'missing-driver');
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = makeRuntimeRoot(tempRoot);
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = makeAssetRoot(tempRoot);

    await expect(runReceiveWithArtifact('missing-driver-artifacts')).resolves.toBe(3);

    const envelope = lastEnvelope();
    expect(envelope.code).toBe(1);
    expect(envelope.data).toMatchObject({
      status: 'failed',
      exit_code: 3,
      role: 'client',
      reason_code: 'driver_not_found',
      failed_stage: 'preflight',
    });
    expect(envelope.data.summary_path).toBe(
      path.join(tempRoot, 'missing-driver-artifacts', 'summary.json'),
    );
  });

  it('reports missing runtime bundle as a preflight failure', async () => {
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = makeDriver(tempRoot);
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = path.join(tempRoot, 'missing-runtime');
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = makeAssetRoot(tempRoot);

    await expect(runReceiveWithArtifact('missing-runtime-artifacts')).resolves.toBe(3);

    expect(lastEnvelope().data).toMatchObject({
      status: 'failed',
      exit_code: 3,
      role: 'client',
      reason_code: 'runtime_bundle_missing',
      failed_stage: 'preflight',
    });
  });

  it('reports missing prepared assets as a preflight failure', async () => {
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = makeDriver(tempRoot);
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = makeRuntimeRoot(tempRoot);
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = path.join(tempRoot, 'missing-assets');

    await expect(runReceiveWithArtifact('missing-assets-artifacts')).resolves.toBe(3);

    expect(lastEnvelope().data).toMatchObject({
      status: 'failed',
      exit_code: 3,
      role: 'client',
      reason_code: 'asset_missing',
      failed_stage: 'preflight',
    });
  });

  it('reports missing token issuer device secret before native driver startup', async () => {
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    delete process.env.TIRTC_DEVICE_SECRET_KEY;

    await expect(runDeviceStart({
      artifactRoot: path.join(tempRoot, 'device-missing-device-secret'),
      source: makeAssetRoot(tempRoot),
    }, {json: true})).resolves.toBe(3);

    const envelope = lastEnvelope();
    expect(envelope.message).toContain('token issuer default config missing required device_secret');
    expect(envelope.data).toMatchObject({
      status: 'failed',
      exit_code: 3,
      role: 'device',
      reason_code: 'token_config_missing',
      failed_stage: 'preflight',
    });
  });

  it('reports missing token issuer device id before native driver startup', async () => {
    delete process.env.TIRTC_DEVICE_ID;
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';
    delete process.env.TIRTC_ENDPOINT;

    await expect(runDeviceStart({
      artifactRoot: path.join(tempRoot, 'device-missing-id-endpoint'),
      source: makeAssetRoot(tempRoot),
    }, {json: true})).resolves.toBe(3);

    const envelope = lastEnvelope();
    expect(envelope.message).toContain('token issuer default config missing required device_id');
    expect(envelope.data).toMatchObject({
      status: 'failed',
      exit_code: 3,
      role: 'device',
      reason_code: 'token_config_missing',
      failed_stage: 'preflight',
    });
  });

  it('accepts OPUS audio codec in the public device contract', async () => {
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';
    process.env.TIRTC_ACCESS_KEY_ID = 'access-key-id';
    process.env.TIRTC_SECRET_KEY_ID = 'secret-key-id';
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = makeSummaryDriver(
      tempRoot,
      '{"schema_version":1,"execution_id":"opus-audio-test","role":"device","status":"completed","exit_code":0,"reason_code":"ok"}',
      0,
    );
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = makeRuntimeRoot(tempRoot);
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = makeAssetRoot(tempRoot);
    const tokenIssuePath = path.join(tempRoot, 'token-issue-opus.json');
    fs.writeFileSync(tokenIssuePath, '{"code":0,"message":"OK","data":{"token":"client-token-secret"}}\n');

    const artifactRoot = path.join(tempRoot, 'device-opus-audio-codec');
    await expect(runDeviceStart({
      artifactRoot,
      source: makeAssetRoot(tempRoot),
      audioCodec: 'opus',
      audioSampleRate: '16000',
      audioChannels: '2',
      clientTokenJson: tokenIssuePath,
    }, {json: true})).resolves.toBe(0);

    const request = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, 'request.redacted.json'), 'utf8'),
    ) as {media: {audio: {codec: string; sample_rate_hz: number; channels: number}}};
    expect(request.media.audio).toEqual({codec: 'opus', sample_rate_hz: 16000, channels: 2});
  });

  it('adds receive audio stream id to device request preflight', async () => {
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = makeDriver(tempRoot);
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = makeRuntimeRoot(tempRoot);
    process.env.TIRTC_RUNTIME_PLATFORM = 'macos-arm64';
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = makeAssetRoot(tempRoot);

    const artifactRoot = path.join(tempRoot, 'device-receive-audio-stream');
    await expect(runDeviceStart({
      artifactRoot,
      input: 'system',
      output: 'both',
      receiveAudioStreamId: '17',
    }, {json: true})).resolves.toBe(1);

    const request = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, 'request.redacted.json'), 'utf8'),
    ) as {media: {receive_audio?: {enabled?: boolean; stream_id?: number}}};
    expect(request.media.receive_audio).toEqual({enabled: true, stream_id: 17});
  });

  it('rejects invalid receive audio stream id during config', async () => {
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';

    await expect(runDeviceStart({
      artifactRoot: path.join(tempRoot, 'device-invalid-receive-audio-stream'),
      source: makeAssetRoot(tempRoot),
      receiveAudioStreamId: '0',
    }, {json: true})).resolves.toBe(2);

    const envelope = lastEnvelope();
    expect(envelope.message).toContain('--receive-audio-stream-id must be a positive integer');
    expect(envelope.data).toMatchObject({
      status: 'failed',
      exit_code: 2,
      role: 'device',
      reason_code: 'invalid_request',
      failed_stage: 'config',
    });
  });

  it('rejects out-of-range receive audio stream id during config', async () => {
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';

    await expect(runDeviceStart({
      artifactRoot: path.join(tempRoot, 'device-out-of-range-receive-audio-stream'),
      source: makeAssetRoot(tempRoot),
      receiveAudioStreamId: '256',
    }, {json: true})).resolves.toBe(2);

    const envelope = lastEnvelope();
    expect(envelope.message).toContain('--receive-audio-stream-id must be <= 255');
    expect(envelope.data).toMatchObject({
      status: 'failed',
      exit_code: 2,
      role: 'device',
      reason_code: 'invalid_request',
      failed_stage: 'config',
    });
  });

  it('reports unsupported audio codec with a specific reason code', async () => {
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';

    await expect(runDeviceStart({
      artifactRoot: path.join(tempRoot, 'device-invalid-audio-codec'),
      source: makeAssetRoot(tempRoot),
      audioCodec: 'vorbis',
    }, {json: true})).resolves.toBe(2);

    expect(lastEnvelope().data).toMatchObject({
      status: 'failed',
      exit_code: 2,
      role: 'device',
      reason_code: 'audio_codec_unsupported',
      failed_stage: 'config',
    });
  });

  it('reports unsupported audio format with a specific reason code', async () => {
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';

    await expect(runDeviceStart({
      artifactRoot: path.join(tempRoot, 'device-invalid-audio-format'),
      source: makeAssetRoot(tempRoot),
      audioSampleRate: '44100',
    }, {json: true})).resolves.toBe(2);

    expect(lastEnvelope().data).toMatchObject({
      status: 'failed',
      exit_code: 2,
      role: 'device',
      reason_code: 'audio_format_unsupported',
      failed_stage: 'config',
    });
  });

  it('accepts AMR-NB mono audio codec in the public device contract', async () => {
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';
    process.env.TIRTC_ACCESS_KEY_ID = 'access-key-id';
    process.env.TIRTC_SECRET_KEY_ID = 'secret-key-id';
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = makeSummaryDriver(
      tempRoot,
      '{"schema_version":1,"execution_id":"amr-audio-test","role":"device","status":"completed","exit_code":0,"reason_code":"ok"}',
      0,
    );
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = makeRuntimeRoot(tempRoot);
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = makeAssetRoot(tempRoot);
    const tokenIssuePath = path.join(tempRoot, 'token-issue-amr.json');
    fs.writeFileSync(tokenIssuePath, '{"code":0,"message":"OK","data":{"token":"client-token-secret"}}\n');

    const artifactRoot = path.join(tempRoot, 'device-valid-amr-audio-format');
    await expect(runDeviceStart({
      artifactRoot,
      source: makeAssetRoot(tempRoot),
      audioCodec: 'amr',
      audioSampleRate: '8000',
      audioChannels: '1',
      clientTokenJson: tokenIssuePath,
    }, {json: true})).resolves.toBe(0);

    const request = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, 'request.redacted.json'), 'utf8'),
    ) as {media: {audio: {codec: string; sample_rate_hz: number; channels: number}}};
    expect(request.media.audio).toEqual({codec: 'amr', sample_rate_hz: 8000, channels: 1});
  });

  it('rejects AMR audio formats outside AMR-NB mono', async () => {
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';

    await expect(runDeviceStart({
      artifactRoot: path.join(tempRoot, 'device-invalid-amr-audio-format'),
      source: makeAssetRoot(tempRoot),
      audioCodec: 'amr',
      audioSampleRate: '16000',
      audioChannels: '1',
    }, {json: true})).resolves.toBe(2);

    expect(lastEnvelope().data).toMatchObject({
      status: 'failed',
      exit_code: 2,
      role: 'device',
      reason_code: 'audio_format_unsupported',
      failed_stage: 'config',
    });
  });

  it('reports a driver exit without summary as an artifact failure', async () => {
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = makeDriver(tempRoot);
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = makeRuntimeRoot(tempRoot);
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = makeAssetRoot(tempRoot);

    await expect(runReceiveWithArtifact('summaryless-driver-artifacts')).resolves.toBe(1);

    expect(lastEnvelope().data).toMatchObject({
      status: 'failed',
      exit_code: 1,
      role: 'client',
      reason_code: 'artifact_write_failed',
      failed_stage: 'artifact',
    });
  });

  it('surfaces failed-role log upload evidence from driver summary', async () => {
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = makeSummaryDriver(
      tempRoot,
      JSON.stringify({
        schema_version: 1,
        execution_id: 'log-upload-summary-test',
        driver_version: 'fake',
        runtime_version: 'fake',
        role: 'client',
        status: 'failed',
        exit_code: 1,
        reason_code: 'connect_failed',
        stage_status: {
          connect: {status: 'failed', reason_code: 'connect_failed'},
          log_upload: {status: 'passed', reason_code: 'ok'},
        },
        log_upload: {
          status: 'passed',
          log_id: '22-14-36-001',
        },
        artifact_paths: {
          summary: 'summary.json',
        },
      }, null, 2),
      1,
    );
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = makeRuntimeRoot(tempRoot);
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = makeAssetRoot(tempRoot);

    await expect(runReceiveWithArtifact('log-upload-summary-artifacts')).resolves.toBe(1);

    expect(lastEnvelope().data).toMatchObject({
      status: 'failed',
      exit_code: 1,
      role: 'client',
      reason_code: 'connect_failed',
      failed_stage: 'connect',
      log_id: '22-14-36-001',
      log_upload: {
        status: 'passed',
        log_id: '22-14-36-001',
      },
    });
  });

  it('builds device request from client token json without identity token', async () => {
    const driverPath = makeDriver(tempRoot);
    const runtimeRoot = makeRuntimeRoot(tempRoot);
    const assetRoot = makeAssetRoot(tempRoot);
    const artifactRoot = path.join(tempRoot, 'device-runtime-validation-artifacts');
    const tokenIssuePath = path.join(tempRoot, 'token-issue.json');
    fs.writeFileSync(
      tokenIssuePath,
      JSON.stringify({
        code: 0,
        message: 'OK',
        data: {
          token: 'client-token-secret',
          payload: {
            remote_id: 'server-remote-id',
            endpoint: 'https://endpoint-from-token.invalid',
            app_id: 'app-from-token',
          },
        },
      }) + '\n',
    );
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = driverPath;
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = runtimeRoot;
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = assetRoot;
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';

    await expect(
      runDeviceStart(
        {
          artifactRoot,
          source: assetRoot,
          videoCodec: 'mjpeg',
          audioCodec: 'aac',
          audioSampleRate: '16000',
          audioChannels: '2',
          clientTokenJson: tokenIssuePath,
        },
        {json: true},
      ),
    ).resolves.toBe(1);

    expect(fs.existsSync(path.join(artifactRoot, 'request.json'))).toBe(false);
    const request = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, 'request.redacted.json'), 'utf8'),
    ) as {
      execution_id: string;
      case_id: string;
      role: string;
      endpoint: string;
      identity: {device_secret_key: string; device_id: string; token?: string};
      bootstrap: {client_token: string; token_fingerprint: string};
      media: {
        source: {path: string};
        video: {codec: string};
        audio: {codec: string; sample_rate_hz: number; channels: number};
      };
      run: {duration_ms?: number};
      probe: {app_id: string};
    };
    expect(request.execution_id).toMatch(/^cli-device-mjpeg-\d{14}$/);
    expect(request.case_id).toBe('devtools-cli-device.mjpeg');
    expect(request.role).toBe('device');
    expect(request.endpoint).toBe('https://example.invalid');
    expect(request.identity).toMatchObject({
      device_secret_key: '[REDACTED]',
      device_id: 'server-device-id',
    });
    expect(request.identity.token).toBeUndefined();
    expect(request.bootstrap.client_token).toBe('[REDACTED]');
    expect(request.bootstrap.token_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(request.media.source.path).toBe(assetRoot);
    expect(request.media.video.codec).toBe('mjpeg');
    expect(request.media.audio).toEqual({codec: 'aac', sample_rate_hz: 16000, channels: 2});
    expect(request.run.duration_ms).toBe(0);
    expect(request.probe.app_id).toBe('app-from-token');
  });

  it('builds client request audio format from bootstrap', async () => {
    const driverPath = makeDriver(tempRoot);
    const runtimeRoot = makeRuntimeRoot(tempRoot);
    const assetRoot = makeAssetRoot(tempRoot);
    const artifactRoot = path.join(tempRoot, 'client-bootstrap-audio-artifacts');
    const bootstrapPath = path.join(tempRoot, 'client-bootstrap.json');
    fs.writeFileSync(
      bootstrapPath,
      JSON.stringify({
        schema_version: 1,
        bootstrap_id: 'bootstrap-audio',
        app_id: 'app-from-bootstrap',
        endpoint_mode: 'default',
        remote_id: 'server-device-id',
        token: 'client-token-secret',
        audio_stream_id: 10,
        video_stream_id: 11,
        video_codec: 'h264',
        audio_codec: 'aac',
        require_control_probe: false,
        sample_rate_hz: 16000,
        channels: 2,
      }) + '\n',
    );
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = driverPath;
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = runtimeRoot;
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = assetRoot;

    await expect(
      runClientStart(
        {
          artifactRoot,
          bootstrap: bootstrapPath,
        },
        {json: true},
      ),
    ).resolves.toBe(1);

    const request = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, 'request.redacted.json'), 'utf8'),
    ) as {
      media: {
        video: {codec: string};
        audio: {codec: string; sample_rate_hz: number; channels: number};
      };
      require_control_probe: boolean;
      endpoint_mode: string;
    };
    expect(request.media.video.codec).toBe('h264');
    expect(request.media.audio).toEqual({codec: 'aac', sample_rate_hz: 16000, channels: 2});
    expect(request.require_control_probe).toBe(false);
    expect(request.endpoint_mode).toBe('default');
  });

  it('keeps explicit device duration for bounded automation', async () => {
    const driverPath = makeDriver(tempRoot);
    const runtimeRoot = makeRuntimeRoot(tempRoot);
    const assetRoot = makeAssetRoot(tempRoot);
    const artifactRoot = path.join(tempRoot, 'device-bounded-duration-artifacts');
    const tokenIssuePath = path.join(tempRoot, 'token-issue-bounded.json');
    fs.writeFileSync(
      tokenIssuePath,
      JSON.stringify({
        code: 0,
        message: 'OK',
        data: {
          token: 'client-token-secret',
          payload: {
            remote_id: 'server-remote-id',
            endpoint: 'https://endpoint-from-token.invalid',
            app_id: 'app-from-token',
          },
        },
      }) + '\n',
    );
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = driverPath;
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = runtimeRoot;
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = assetRoot;
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';

    await expect(
      runDeviceStart(
        {
          artifactRoot,
          source: assetRoot,
          videoCodec: 'h264',
          clientTokenJson: tokenIssuePath,
          durationMs: '15000',
        },
        {json: true},
      ),
    ).resolves.toBe(1);

    const request = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, 'request.redacted.json'), 'utf8'),
    ) as {run: {duration_ms?: number}};
    expect(request.run.duration_ms).toBe(15000);
  });

  it('emits device live logs to stderr without leaking device secret or breaking JSON stdout', async () => {
    const driverPath = makeLiveSummaryDriver(tempRoot);
    const runtimeRoot = makeRuntimeRoot(tempRoot);
    const assetRoot = makeAssetRoot(tempRoot);
    const artifactRoot = path.join(tempRoot, 'device-live-log-artifacts');
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = driverPath;
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = runtimeRoot;
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = assetRoot;
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';

    await expect(
      runDeviceStart(
        {
          artifactRoot,
          source: assetRoot,
          videoCodec: 'h265',
        },
        {json: true},
      ),
    ).resolves.toBe(0);

    const envelope = lastEnvelope();
    expect(envelope).toMatchObject({
      code: 0,
      data: {
        status: 'completed',
        exit_code: 0,
        role: 'device',
        artifact_root: artifactRoot,
        summary_path: path.join(artifactRoot, 'summary.json'),
        received_audio: {
          enabled: true,
          stream_id: 14,
          codec: 'g711a',
          sample_rate_hz: 16000,
          channels: 1,
          captured_bytes: 4096,
          pcm_path: 'received-audio.pcm',
          metadata_path: 'received-audio.metadata.json',
          mp3_path: 'received-audio-20260624-120000.mp3',
          mp3_status: 'generated',
          mp3_reason_code: 'ok',
        },
        stream_message: {
          enabled: true,
          pairing_id: 'live-log-test',
          stream_id: 11,
          sent_count: 1,
          error_count: 0,
        },
      },
    });
    const stderr = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(stderr).toContain('[device] starting device driver device_id=server-device-id');
    expect(stderr).toContain('[device] listener ready; waiting for client connections');
    expect(stderr).toContain('[device] client connected session=1');
    expect(stderr).toContain('[device] first audio packet sent session=1');
    expect(stderr).toContain('[device] first video packet sent session=1 codec=h265');
    expect(stderr).toContain('[device] client disconnected session=1');
    expect(stderr).toContain('[device] driver finished status=completed exit_code=0 reason_code=ok');
    expect(stderr).toContain('[device] process exited code=0 signal=none');
    expect(stderr).not.toContain('device-secret');
  });

  it('marks received audio mp3 generation as ffmpeg_failed when ffmpeg exits non-zero', async () => {
    const fakeToolDir = path.join(tempRoot, 'fake-ffmpeg-bin');
    fs.mkdirSync(fakeToolDir, {recursive: true});
    const fakeFfmpeg = path.join(fakeToolDir, 'ffmpeg');
    const fakeFfprobe = path.join(fakeToolDir, 'ffprobe');
    fs.writeFileSync(fakeFfmpeg, '#!/bin/sh\nexit 42\n');
    fs.writeFileSync(fakeFfprobe, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeFfmpeg, 0o755);
    fs.chmodSync(fakeFfprobe, 0o755);
    const ffmpegSpy = jest.spyOn(ffmpegTool, 'ensureFfmpegTools').mockReturnValue({
      ffmpeg: fakeFfmpeg,
      ffprobe: fakeFfprobe,
    });

    const artifactRoot = path.join(tempRoot, 'device-received-audio-ffmpeg-failed');
    const driverPath = makeReceivedAudioPcmSummaryDriver(tempRoot, `{
  "schema_version": 1,
  "execution_id": "ffmpeg-failed-test",
  "driver_version": "fake",
  "runtime_version": "fake",
  "role": "device",
  "status": "completed",
  "exit_code": 0,
  "received_audio": {
    "enabled": true,
    "stream_id": 14,
    "codec": "g711a",
    "sample_rate_hz": 16000,
    "channels": 1,
    "bits_per_sample": 16,
    "sample_format": "s16le",
    "first_output_timing_ms": 120,
    "captured_bytes": 9,
    "pcm_path": "received-audio.pcm",
    "metadata_path": "received-audio.metadata.json",
    "mp3_path": null,
    "mp3_status": "skipped",
    "mp3_reason_code": "ffmpeg_unavailable"
  },
  "artifact_paths": {
    "summary": "summary.json"
  }
}`, 0);
    process.env.TIRTC_DEVTOOLS_DRIVER_PATH = driverPath;
    process.env.TIRTC_RUNTIME_BUNDLE_ROOT = makeRuntimeRoot(tempRoot);
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = makeAssetRoot(tempRoot);
    process.env.TIRTC_DEVICE_ID = 'server-device-id';
    process.env.TIRTC_DEVICE_SECRET_KEY = 'device-secret';

    try {
      await expect(runDeviceStart({
        artifactRoot,
        source: makeAssetRoot(tempRoot),
      }, {json: true})).resolves.toBe(0);

      const envelope = lastEnvelope();
      expect(envelope.data.received_audio).toMatchObject({
        enabled: true,
        captured_bytes: 9,
        mp3_path: null,
        mp3_status: 'failed',
        mp3_reason_code: 'ffmpeg_failed',
      });
      const metadata = JSON.parse(
        fs.readFileSync(path.join(artifactRoot, 'received-audio.metadata.json'), 'utf8'),
      ) as {mp3_status?: string; mp3_reason_code?: string};
      expect(metadata).toMatchObject({
        mp3_status: 'failed',
        mp3_reason_code: 'ffmpeg_failed',
      });
    } finally {
      ffmpegSpy.mockRestore();
    }
  });
});
