import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {readJson} from './role_driver_io';
import {pathExists, resolveAssetRoot, resolveRuntimePlatform} from './role_driver_paths';
import {
  defaultAudioStreamId,
  defaultConnectTimeoutMs,
  defaultFirstOutputTimeoutMs,
  defaultFirstPacketTimeoutMs,
  defaultFrameLimit,
  defaultReceiveAudioStreamId,
  defaultVideoStreamId,
  rolePreflightError,
  roleUsageError,
  roleUsageReasonError,
  type Bootstrap,
  type ClientCommandOptions,
  type DeviceCommandOptions,
  type RoleDriverRoots,
} from './role_driver_types';
import {issueToken} from './token_tool';

type TokenIssueJson = {
  data?: {
    token?: string;
    payload?: {
      remote_id?: string;
      endpoint?: string;
      app_id?: string;
    };
  };
};

type DeviceIdentity = {
  deviceId: string;
  appId: string;
  deviceSecretKey: string;
  accessKeyId: string;
  secretKeyId: string;
  endpoint?: string;
};

type AudioProcessingRequest = {
  input: {
    status: 'not_requested' | 'applied' | 'rejected';
    requested: {aec: string; agc: string; ans: string};
    runtime: {aec_mode: number; agc_level: number; ans_level: number};
  };
  output: {
    status: 'not_requested' | 'applied' | 'rejected';
    requested: {agc: string; ans: string};
    runtime: {agc_level: number; ans_level: number};
  };
};

const supportedAudioCodecs = ['g711a', 'aac', 'pcm', 'opus', 'amr'] as const;
type SupportedAudioCodec = typeof supportedAudioCodecs[number];

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw roleUsageError(name + ' must be a positive integer');
  }
  return parsed;
}

function parsePositiveIntAtMost(
  raw: string | undefined,
  fallback: number,
  name: string,
  maxValue: number,
): number {
  const parsed = parsePositiveInt(raw, fallback, name);
  if (parsed > maxValue) {
    throw roleUsageError(name + ' must be <= ' + String(maxValue));
  }
  return parsed;
}

function parseOptionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parsePositiveInt(raw, 1, name);
}

function parseDurationMs(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw roleUsageError('--duration-ms must be a non-negative integer');
  }
  return parsed;
}

export function executionSuffix(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function boolOptionEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== 'disabled';
}

function tokenFingerprint(token: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
}

function readTokenIssueJson(filePath: string): {token: string; remoteId?: string; endpoint?: string; appId?: string} {
  const resolved = path.resolve(filePath);
  if (!pathExists(resolved)) {
    throw rolePreflightError('token_issue_missing', resolved);
  }
  let parsed: TokenIssueJson;
  try {
    parsed = readJson<TokenIssueJson>(resolved);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw rolePreflightError('token_issue_invalid', detail);
  }
  const token = trimOptional(parsed.data?.token);
  if (!token) {
    throw rolePreflightError('token_issue_invalid', 'missing data.token');
  }
  return {
    token,
    remoteId: trimOptional(parsed.data?.payload?.remote_id),
    endpoint: trimOptional(parsed.data?.payload?.endpoint),
    appId: trimOptional(parsed.data?.payload?.app_id),
  };
}

function resolveRequiredEnv(value: string | undefined, fieldName: string): string {
  const normalized = trimOptional(value);
  if (!normalized) {
    throw rolePreflightError(
      'token_config_missing',
      'token issuer default config missing required ' + fieldName,
    );
  }
  return normalized;
}

function resolveDeviceIdentity(options: DeviceCommandOptions): DeviceIdentity {
  const deviceId = trimOptional(options.deviceId) ?? trimOptional(process.env.TIRTC_DEVICE_ID);
  const deviceSecretKey = trimOptional(options.deviceSecretKey) ??
    trimOptional(process.env.TIRTC_DEVICE_SECRET_KEY);
  return {
    deviceId: resolveRequiredEnv(deviceId, 'device_id'),
    appId: resolveRequiredEnv(process.env.TIRTC_APP_ID, 'app_id'),
    accessKeyId: resolveRequiredEnv(process.env.TIRTC_ACCESS_KEY_ID, 'access_key_id'),
    secretKeyId: resolveRequiredEnv(process.env.TIRTC_SECRET_KEY_ID, 'secret_key_id'),
    deviceSecretKey: resolveRequiredEnv(deviceSecretKey, 'device_secret'),
    endpoint: trimOptional(options.endpoint) ?? trimOptional(process.env.TIRTC_ENDPOINT),
  };
}

function readBootstrap(bootstrapPath: string): Bootstrap {
  const resolved = path.resolve(bootstrapPath);
  let parsed: Bootstrap;
  try {
    parsed = readJson<Bootstrap>(resolved);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw rolePreflightError('bootstrap_invalid', detail);
  }
  if (parsed.schema_version !== 1 || !(parsed.device_id || parsed.remote_id) || !parsed.token) {
    throw rolePreflightError('bootstrap_invalid', 'missing schema_version, remote_id, or token');
  }
  return parsed;
}

function codecOrDefault(raw?: string): string {
  const codec = raw?.trim() || 'h264';
  if (codec !== 'h264' && codec !== 'h265' && codec !== 'mjpeg') {
    throw roleUsageError('video-codec must be h264, h265, or mjpeg');
  }
  return codec;
}

function audioCodecOrDefault(raw?: string): string {
  const codec = raw?.trim() || 'g711a';
  if (!supportedAudioCodecs.includes(codec as SupportedAudioCodec)) {
    throw roleUsageReasonError(
      'audio_codec_unsupported',
      'audio-codec must be g711a, aac, pcm, opus, or amr',
    );
  }
  return codec;
}

function audioSampleRateOrDefault(raw?: string | number): number {
  const sampleRate = raw === undefined ? 16000 : Number(raw);
  if (sampleRate !== 8000 && sampleRate !== 16000) {
    throw roleUsageReasonError(
      'audio_format_unsupported',
      'audio-sample-rate must be 8000 or 16000',
    );
  }
  return sampleRate;
}

function audioChannelsOrDefault(raw?: string | number): number {
  const channels = raw === undefined ? 1 : Number(raw);
  if (channels !== 1 && channels !== 2) {
    throw roleUsageReasonError('audio_format_unsupported', 'audio-channels must be 1 or 2');
  }
  return channels;
}

function validateAudioFormat(codec: string, sampleRateHz: number, channels: number): void {
  if (codec === 'amr' && (sampleRateHz !== 8000 || channels !== 1)) {
    throw roleUsageReasonError(
      'audio_format_unsupported',
      'amr audio requires --audio-sample-rate 8000 and --audio-channels 1',
    );
  }
}

function consumerOrDefault(raw?: string): string {
  const consumer = raw?.trim() || 'frame_dump';
  if (consumer !== 'frame_dump' && consumer !== 'packet_dump') {
    throw roleUsageError('consumer must be packet_dump or frame_dump');
  }
  return consumer;
}

function modeOrDefault(raw: string | undefined, fallback: string, name: string, allowed: string[]): string {
  const mode = raw?.trim() || fallback;
  if (!allowed.includes(mode)) {
    throw roleUsageReasonError('invalid_option_combination', name + ' must be ' + allowed.join('|'));
  }
  return mode;
}

function aecOrDefault(raw?: string): string {
  const value = raw?.trim() || 'disabled';
  if (value !== 'disabled' && value !== 'enabled') {
    throw roleUsageReasonError('invalid_option_combination', 'audio input AEC must be disabled or enabled');
  }
  return value;
}

function levelOrDefault(raw: string | undefined, name: string): string {
  const value = raw?.trim() || 'disabled';
  if (value !== 'disabled' && value !== 'low' && value !== 'medium' && value !== 'high') {
    throw roleUsageReasonError('invalid_option_combination', name + ' must be disabled|low|medium|high');
  }
  return value;
}

function processingLevel(value: string): number {
  switch (value) {
    case 'enabled':
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    default:
      return 0;
  }
}

function supportsSystemCapability(platform: string): boolean {
  return platform === 'macos-arm64';
}

function assertPlatformCapability(inputMode: string | null, outputMode: string, preview: boolean): void {
  const platform = resolveRuntimePlatform();
  const systemRequested = inputMode === 'system' || outputMode === 'system' || outputMode === 'both' || preview;
  if (systemRequested && !supportsSystemCapability(platform)) {
    throw rolePreflightError(
      'unsupported_platform_capability',
      'system input, system output, and preview are supported only on macos-arm64 in this release',
    );
  }
}

function buildAudioProcessing(
  options: DeviceCommandOptions | ClientCommandOptions,
  inputMode: string | null,
  outputMode: string,
  channels: number,
): AudioProcessingRequest {
  const inputAec = aecOrDefault('audioInputAec' in options ? options.audioInputAec : undefined);
  const inputAgc = levelOrDefault('audioInputAgc' in options ? options.audioInputAgc : undefined, 'audio input AGC');
  const inputAns = levelOrDefault('audioInputAns' in options ? options.audioInputAns : undefined, 'audio input ANS');
  const outputAgc = levelOrDefault(options.audioOutputAgc, 'audio output AGC');
  const outputAns = levelOrDefault(options.audioOutputAns, 'audio output ANS');
  const inputRequested = boolOptionEnabled(inputAec) || boolOptionEnabled(inputAgc) ||
    boolOptionEnabled(inputAns);
  const outputRequested = boolOptionEnabled(outputAgc) || boolOptionEnabled(outputAns);

  if (inputRequested && inputMode !== 'system') {
    throw rolePreflightError(
      'invalid_option_combination',
      'audio input 3A options require device start --input system',
    );
  }
  if (outputRequested && outputMode === 'file') {
    throw rolePreflightError(
      'invalid_option_combination',
      'audio output 3A options require --output system or --output both',
    );
  }
  if (inputMode === 'system' && channels === 2 && inputRequested) {
    throw rolePreflightError(
      'invalid_option_combination',
      'audio input 3A options require mono system input',
    );
  }

  return {
    input: {
      status: inputMode === 'system' ? 'applied' : 'not_requested',
      requested: {aec: inputAec, agc: inputAgc, ans: inputAns},
      runtime: {
        aec_mode: processingLevel(inputAec),
        agc_level: processingLevel(inputAgc),
        ans_level: processingLevel(inputAns),
      },
    },
    output: {
      status: outputMode === 'system' || outputMode === 'both' ? 'applied' : 'not_requested',
      requested: {agc: outputAgc, ans: outputAns},
      runtime: {
        agc_level: processingLevel(outputAgc),
        ans_level: processingLevel(outputAns),
      },
    },
  };
}

function resolveCacheDir(raw?: string): string {
  return path.resolve(raw?.trim() || path.join('cache', 'tirtc-devtools'));
}

function mediaInputPath(cacheDir: string): string {
  return path.join(cacheDir, 'input', 'media_input.json');
}

function readMediaInput(cacheDir: string): Record<string, unknown> {
  const inputPath = mediaInputPath(cacheDir);
  if (!pathExists(inputPath)) {
    throw rolePreflightError(
      'input_not_prepared',
      'fixed input cache missing; run input prepare --file <mp4> first',
    );
  }
  try {
    return readJson<Record<string, unknown>>(inputPath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw rolePreflightError('input_not_prepared', detail);
  }
}

function mediaInputHasTrack(
  mediaInput: Record<string, unknown>,
  family: 'audio' | 'video',
  key: string,
): boolean {
  const familyValue = mediaInput[family];
  if (typeof familyValue !== 'object' || familyValue === null) {
    return false;
  }
  const track = (familyValue as Record<string, unknown>)[key];
  return typeof track === 'object' && track !== null;
}

function audioTrackKey(codec: string, sampleRateHz: number, channels: number): string {
  return codec + '_' + String(sampleRateHz) + '_' + String(channels) + 'ch_s16';
}

function assertPreparedInput(
  cacheDir: string,
  videoCodec: string,
  audioCodec: string,
  sampleRateHz: number,
  channels: number,
): void {
  const mediaInput = readMediaInput(cacheDir);
  const audioKey = audioTrackKey(audioCodec, sampleRateHz, channels);
  if (!mediaInputHasTrack(mediaInput, 'video', videoCodec) || !mediaInputHasTrack(mediaInput, 'audio', audioKey)) {
    throw rolePreflightError('input_codec_missing', 'fixed input cache does not contain requested codec');
  }
}

async function issueClientToken(identity: DeviceIdentity): Promise<string> {
  try {
    return await issueToken({
      accessKeyId: identity.accessKeyId,
      secretKeyId: identity.secretKeyId,
      deviceSecretKey: identity.deviceSecretKey,
      accessKeyIdFromEnv: true,
      secretKeyIdFromEnv: true,
      deviceSecretKeyFromEnv: true,
      appId: identity.appId,
      remoteId: identity.deviceId,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw rolePreflightError('token_issue_failed', detail);
  }
}

function writeBootstrap(
  roleDir: string,
  executionId: string,
  identity: DeviceIdentity,
  token: string,
  videoCodec: string,
  audioCodec: string,
  sampleRateHz: number,
  channels: number,
): string {
  const bootstrapPath = path.join(roleDir, 'bootstrap.json');
  const bootstrap = {
    schema_version: 1,
    bootstrap_id: executionId + '-bootstrap',
    execution_id: executionId,
    pairing_id: executionId,
    created_at: new Date().toISOString(),
    producer: 'cli_device',
    app_id: identity.appId,
    endpoint_mode: identity.endpoint ? 'custom' : 'default',
    ...(identity.endpoint ? {endpoint: identity.endpoint} : {}),
    device_id: identity.deviceId,
    remote_id: identity.deviceId,
    token,
    token_fingerprint: tokenFingerprint(token),
    require_audio: true,
    require_control_probe: false,
    audio_stream_id: defaultAudioStreamId,
    video_stream_id: defaultVideoStreamId,
    audio_codec: audioCodec,
    sample_rate_hz: sampleRateHz,
    channels,
    bits_per_sample: 16,
    video_codec: videoCodec,
  };
  try {
    fs.writeFileSync(bootstrapPath, JSON.stringify(bootstrap, null, 2) + '\n');
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw rolePreflightError('bootstrap_write_failed', detail);
  }
  return bootstrapPath;
}

export async function buildDeviceRequest(
  roots: RoleDriverRoots,
  artifactRoot: string,
  options: DeviceCommandOptions,
): Promise<Record<string, unknown>> {
  const codec = codecOrDefault(options.videoCodec);
  const audioCodec = audioCodecOrDefault(options.audioCodec);
  const audioSampleRateHz = audioSampleRateOrDefault(options.audioSampleRate);
  const audioChannels = audioChannelsOrDefault(options.audioChannels);
  const inputMode = modeOrDefault(options.input, 'file', '--input', ['file', 'system']);
  const outputMode = modeOrDefault(options.output, 'file', '--output', ['file', 'system', 'both']);
  const previewRequested = options.preview === true;
  if (previewRequested && inputMode !== 'system') {
    throw rolePreflightError('invalid_option_combination', '--preview requires device start --input system');
  }
  assertPlatformCapability(inputMode, outputMode, previewRequested);
  const audioProcessing = buildAudioProcessing(options, inputMode, outputMode, audioChannels);
  const receiveAudioStreamId = parsePositiveIntAtMost(
    options.receiveAudioStreamId,
    defaultReceiveAudioStreamId,
    '--receive-audio-stream-id',
    255,
  );
  validateAudioFormat(audioCodec, audioSampleRateHz, audioChannels);
  if (!options.source && inputMode === 'file') {
    assertPreparedInput(resolveCacheDir(options.cacheDir), codec, audioCodec, audioSampleRateHz, audioChannels);
  }
  const executionId = 'cli-device-' + codec + '-' + executionSuffix();
  const caseId = 'devtools-cli-device.' + codec;
  const deviceIdentity = resolveDeviceIdentity(options);
  const tokenIssue = options.clientTokenJson ? readTokenIssueJson(options.clientTokenJson) : undefined;
  const clientToken = tokenIssue?.token ?? await issueClientToken(deviceIdentity);
  const bootstrapPath = writeBootstrap(
    artifactRoot,
    executionId,
    deviceIdentity,
    clientToken,
    codec,
    audioCodec,
    audioSampleRateHz,
    audioChannels,
  );
  const bootstrap = {
    client_token: clientToken,
    token_fingerprint: tokenFingerprint(clientToken),
    path: bootstrapPath,
  };
  const cacheDir = resolveCacheDir(options.cacheDir);
  const mediaSourcePath = options.source ??
    (inputMode === 'file' ? path.join(cacheDir, 'input') : '');
  const receiveAudioEnabled = inputMode === 'system';
  return {
    schema_version: 1,
    execution_id: executionId,
    pairing_id: executionId,
    case_id: caseId,
    role: 'device',
    cache_dir: cacheDir,
    role_dir: artifactRoot,
    input_mode: inputMode,
    output_mode: outputMode,
    pairing_mode: 'standard',
    endpoint_mode: deviceIdentity.endpoint ? 'custom' : 'default',
    endpoint: deviceIdentity.endpoint ?? '',
    identity: {
      device_id: deviceIdentity.deviceId,
      device_secret_key: deviceIdentity.deviceSecretKey,
    },
    bootstrap,
    streams: {
      audio_stream_id: defaultAudioStreamId,
      video_stream_id: defaultVideoStreamId,
    },
    media: {
      source: {kind: inputMode === 'file' ? 'fixed_cache' : 'system', path: mediaSourcePath || resolveAssetRoot(roots)},
      media_input_path: inputMode === 'file' ? mediaInputPath(cacheDir) : null,
      video: {codec},
      audio: {
        codec: audioCodec,
        sample_rate_hz: audioSampleRateHz,
        channels: audioChannels,
      },
      receive_audio: {
        enabled: receiveAudioEnabled,
        stream_id: receiveAudioStreamId,
      },
    },
    output: {
      mode: outputMode,
      consumer: outputMode === 'file' || outputMode === 'both' ? 'packet_dump' : 'system',
      video: {frame_limit: defaultFrameLimit},
    },
    audio_processing: audioProcessing,
    preview: {
      requested: previewRequested,
    },
    run: {
      exit_after_first_session: options.exitAfterFirstSession === true,
      duration_ms: parseDurationMs(options.durationMs),
      connect_timeout_ms: parsePositiveInt(options.connectTimeoutMs, defaultConnectTimeoutMs, '--connect-timeout-ms'),
      first_packet_timeout_ms: parsePositiveInt(options.firstPacketTimeoutMs, defaultFirstPacketTimeoutMs, '--first-packet-timeout-ms'),
      first_output_timeout_ms: parsePositiveInt(options.firstOutputTimeoutMs, defaultFirstOutputTimeoutMs, '--first-output-timeout-ms'),
    },
    artifact: {root_dir: artifactRoot},
    probe: {app_id: tokenIssue?.appId ?? deviceIdentity.appId},
  };
}

export function buildClientRequest(
  roots: RoleDriverRoots,
  artifactRoot: string,
  options: ClientCommandOptions,
): Record<string, unknown> {
  const bootstrap = options.bootstrap ? readBootstrap(options.bootstrap) : undefined;
  const outputMode = modeOrDefault(options.output, 'file', '--output', ['file', 'system', 'both']);
  assertPlatformCapability(null, outputMode, false);
  const targetDeviceId = trimOptional(options.targetDeviceId) ??
    trimOptional(bootstrap?.device_id) ??
    trimOptional(bootstrap?.remote_id) ??
    trimOptional(process.env.TIRTC_TARGET_DEVICE_ID);
  const token = options.token?.trim() || bootstrap?.token || process.env.TIRTC_TOKEN?.trim();
  const endpoint = trimOptional(options.endpoint) ??
    trimOptional(bootstrap?.endpoint) ??
    trimOptional(process.env.TIRTC_ENDPOINT) ??
    '';
  const endpointMode = trimOptional(bootstrap?.endpoint_mode) ??
    (trimOptional(bootstrap?.endpoint) ? 'custom' : 'default');
  const appId = trimOptional(options.appId) ??
    trimOptional(bootstrap?.app_id) ??
    trimOptional(process.env.TIRTC_APP_ID);
  const missing: string[] = [];
  if (!targetDeviceId) {
    missing.push('target device id (pass --target-device-id, --bootstrap, or set TIRTC_TARGET_DEVICE_ID)');
  }
  if (!token) {
    missing.push('token (pass --token, --bootstrap, or set TIRTC_TOKEN)');
  }
  if (!appId) {
    missing.push('app id (pass --app-id, --bootstrap, or set TIRTC_APP_ID)');
  }
  if (missing.length > 0 || !targetDeviceId || !token || !appId) {
    throw rolePreflightError('missing_env', 'client start requires ' + missing.join(' and '));
  }

  const executionId = 'cli-client-' + executionSuffix();
  const identityOverride = Boolean(bootstrap && (options.targetDeviceId || options.token));
  const videoCodec = codecOrDefault(bootstrap?.video_codec);
  const audioCodec = audioCodecOrDefault(bootstrap?.audio_codec);
  const audioSampleRateHz = audioSampleRateOrDefault(
    bootstrap?.audio_sample_rate_hz ?? bootstrap?.sample_rate_hz,
  );
  const audioChannels = audioChannelsOrDefault(bootstrap?.audio_channels ?? bootstrap?.channels);
  validateAudioFormat(audioCodec, audioSampleRateHz, audioChannels);
  const audioProcessing = buildAudioProcessing(options, null, outputMode, audioChannels);
  const cacheDir = resolveCacheDir(options.cacheDir);
  return {
    schema_version: 1,
    execution_id: executionId,
    pairing_id: trimOptional(bootstrap?.pairing_id) ?? trimOptional(bootstrap?.execution_id) ?? executionId,
    case_id: 'devtools-cli-client',
    role: 'client',
    cache_dir: cacheDir,
    role_dir: artifactRoot,
    input_mode: null,
    output_mode: outputMode,
    pairing_mode: 'standard',
    require_audio: bootstrap?.require_audio ?? true,
    require_control_probe: bootstrap?.require_control_probe ?? true,
    endpoint,
    endpoint_mode: endpointMode,
    identity: {
      device_id: targetDeviceId,
      token,
      bootstrap_path: options.bootstrap ? path.resolve(options.bootstrap) : undefined,
      bootstrap_id: bootstrap?.bootstrap_id,
      identity_override: identityOverride,
    },
    streams: {
      audio_stream_id: parsePositiveInt(
        options.audioStreamId,
        bootstrap?.audio_stream_id ?? defaultAudioStreamId,
        '--audio-stream-id',
      ),
      video_stream_id: parsePositiveInt(
        options.videoStreamId,
        bootstrap?.video_stream_id ?? defaultVideoStreamId,
        '--video-stream-id',
      ),
    },
    media: {
      source: {kind: 'encoded_asset', path: resolveAssetRoot(roots)},
      video: {codec: videoCodec},
      audio: {
        codec: audioCodec,
        sample_rate_hz: audioSampleRateHz,
        channels: audioChannels,
      },
    },
    output: {
      mode: outputMode,
      consumer: outputMode === 'file' || outputMode === 'both' ? 'packet_dump' : consumerOrDefault(options.consumer),
      video: {frame_limit: parsePositiveInt(options.frameLimit, defaultFrameLimit, '--frame-limit')},
    },
    audio_processing: audioProcessing,
    preview: {
      requested: false,
    },
    run: {
      duration_ms: parseOptionalPositiveInt(options.durationMs, '--duration-ms'),
      connect_timeout_ms: parsePositiveInt(options.connectTimeoutMs, defaultConnectTimeoutMs, '--connect-timeout-ms'),
      first_packet_timeout_ms: parsePositiveInt(options.firstPacketTimeoutMs, defaultFirstPacketTimeoutMs, '--first-packet-timeout-ms'),
      first_output_timeout_ms: parsePositiveInt(options.firstOutputTimeoutMs, defaultFirstOutputTimeoutMs, '--first-output-timeout-ms'),
    },
    artifact: {root_dir: artifactRoot},
    probe: {app_id: appId},
  };
}
