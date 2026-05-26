import childProcess from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  resolveCliPackageRoot,
  resolveWorkspaceRepoRoot,
} from './embedded_paths';
import {startRoleLiveLog, type RoleLiveLogHandle} from './role_live_log';

export type CliOptions = {
  json?: boolean;
};

type RoleSummary = {
  status: string;
  exit_code: number;
  role: string;
  execution_id: string;
  reason_code?: string;
  bootstrap_path?: string;
  log_upload?: {
    status?: string;
    log_id?: string;
    reason_code?: string;
    error_code?: number;
  };
  command_echo?: {
    enabled?: boolean;
    received_count?: number;
    echoed_count?: number;
    error_count?: number;
    last_command_id?: number;
    last_payload_bytes?: number;
    last_payload_hash?: string;
    last_send_result?: number;
  };
  stream_message?: {
    enabled?: boolean;
    pairing_id?: string;
    stream_id?: number;
    last_session_index?: number | null;
    sent_count?: number;
    received_count?: number;
    error_count?: number;
    last_payload_epoch_seconds?: number | null;
    last_payload_hash?: string | null;
    last_send_result?: number | null;
    first_send_monotonic_ms?: number | null;
    last_send_monotonic_ms?: number | null;
    matched_receive_count?: number;
    periodic_send_ok?: boolean;
    periodic_window_short?: boolean;
    stopped_after_disconnect?: boolean | null;
  };
  artifact_paths?: {
    summary?: string;
  };
  stage_status?: Record<string, {status?: string; reason_code?: string}>;
};

type Bootstrap = {
  schema_version?: number;
  bootstrap_id?: string;
  execution_id?: string;
  app_id?: string;
  endpoint?: string;
  device_id?: string;
  remote_id?: string;
  token?: string;
  require_audio?: boolean;
  require_control_probe?: boolean;
  audio_stream_id?: number;
  video_stream_id?: number;
  video_codec?: string;
  audio_codec?: string;
  audio_sample_rate_hz?: number;
  audio_channels?: number;
  sample_rate_hz?: number;
  channels?: number;
  pairing_id?: string;
};

type DeviceCommandOptions = {
  artifactRoot?: string;
  deviceId?: string;
  deviceSecretKey?: string;
  endpoint?: string;
  source?: string;
  videoCodec?: string;
  audioCodec?: string;
  audioSampleRate?: string;
  audioChannels?: string;
  exitAfterFirstSession?: boolean;
  durationMs?: string;
  connectTimeoutMs?: string;
  firstPacketTimeoutMs?: string;
  clientTokenJson?: string;
};

type ClientCommandOptions = {
  artifactRoot?: string;
  bootstrap?: string;
  targetDeviceId?: string;
  token?: string;
  endpoint?: string;
  appId?: string;
  audioStreamId?: string;
  videoStreamId?: string;
  consumer?: string;
  frameLimit?: string;
  durationMs?: string;
  connectTimeoutMs?: string;
  firstPacketTimeoutMs?: string;
  firstOutputTimeoutMs?: string;
};

type DeviceIdentity = {
  deviceId: string;
  deviceSecretKey: string;
  endpoint: string;
};

type RoleDriverRoots = {
  packageRoot: string;
  repoRoot?: string;
};

type DriverProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

const defaultAudioStreamId = 10;
const defaultVideoStreamId = 11;
const defaultConnectTimeoutMs = 10000;
const defaultFirstPacketTimeoutMs = 10000;
const defaultFirstOutputTimeoutMs = 12000;
const defaultFrameLimit = 1;
const roleFailedExitCode = 1;
const usageExitCode = 2;
const preflightExitCode = 3;

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

class RoleCommandError extends Error {
  readonly reasonCode: string;
  readonly failedStage: string;
  readonly exitCode: number;

  constructor(reasonCode: string, failedStage: string, exitCode: number, message: string) {
    super(message);
    this.name = 'RoleCommandError';
    this.reasonCode = reasonCode;
    this.failedStage = failedStage;
    this.exitCode = exitCode;
  }
}

function rolePreflightError(reasonCode: string, detail: string): RoleCommandError {
  return new RoleCommandError(reasonCode, 'preflight', preflightExitCode, reasonCode + ': ' + detail);
}

function roleUsageError(message: string): RoleCommandError {
  return new RoleCommandError('invalid_request', 'config', usageExitCode, message);
}

function roleUsageReasonError(reasonCode: string, message: string): RoleCommandError {
  return new RoleCommandError(reasonCode, 'config', usageExitCode, reasonCode + ': ' + message);
}

function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function pathIsExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimePlatform(): string {
  const explicit = process.env.TIRTC_RUNTIME_PLATFORM?.trim();
  if (explicit) {
    return explicit;
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'macos-arm64';
  }
  return 'linux-x64';
}

function resolveRoleDriverRoots(fromDir: string = __dirname): RoleDriverRoots {
  return {
    packageRoot: resolveCliPackageRoot(fromDir),
    repoRoot: resolveWorkspaceRepoRoot(fromDir),
  };
}

function appendIfDefined(candidates: string[], candidate: string | undefined): void {
  if (candidate && candidate.length > 0) {
    candidates.push(candidate);
  }
}

function resolveDriverPath(roots: RoleDriverRoots, platform: string): string {
  const explicit = process.env.TIRTC_DEVTOOLS_DRIVER_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  const candidates: string[] = [];
  appendIfDefined(
    candidates,
    roots.repoRoot
      ? path.join(roots.repoRoot, '.build/devtools-driver/bin', platform, 'devtools_driver_probe')
      : undefined,
  );
  appendIfDefined(
    candidates,
    roots.repoRoot
      ? path.join(roots.repoRoot, 'products/devtools/driver/bin', platform, 'devtools_driver_probe')
      : undefined,
  );
  appendIfDefined(
    candidates,
    roots.repoRoot
      ? path.join(roots.repoRoot, 'developer-tools/devtools/vendor/devtools/driver', platform, 'devtools_driver_probe')
      : undefined,
  );
  candidates.push(
    path.join(roots.packageRoot, 'vendor/devtools/driver', platform, 'devtools_driver_probe'),
  );
  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? '';
}

function hasRuntimeBundle(runtimeRoot: string): boolean {
  return pathExists(path.join(runtimeRoot, 'include/tirtc/av.h')) &&
    pathExists(path.join(runtimeRoot, 'lib/libmatrix_runtime_facade.a'));
}

function requiredAdjacentDriverDependency(platform: string): string | undefined {
  if (platform === 'macos-arm64') {
    return 'libtgrtc.dylib';
  }
  return undefined;
}

function resolveRuntimeRoot(roots: RoleDriverRoots, platform: string): string {
  const explicit = process.env.TIRTC_RUNTIME_BUNDLE_ROOT?.trim();
  if (explicit) {
    return explicit;
  }
  const candidates: string[] = [];
  appendIfDefined(
    candidates,
    roots.repoRoot ? path.join(roots.repoRoot, '.build/products/runtime', platform) : undefined,
  );
  appendIfDefined(
    candidates,
    roots.repoRoot ? path.join(roots.repoRoot, 'developer-tools/devtools/bin/runtime', platform) : undefined,
  );
  appendIfDefined(
    candidates,
    roots.repoRoot ? path.join(roots.repoRoot, 'developer-tools/devtools/vendor/runtime', platform) : undefined,
  );
  candidates.push(path.join(roots.packageRoot, 'vendor/runtime', platform));
  for (const candidate of candidates) {
    if (hasRuntimeBundle(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? '';
}

function resolveAssetRoot(roots: RoleDriverRoots): string {
  const explicit = process.env.MATRIX_ASSET_WORKSPACE_ROOT?.trim();
  if (explicit) {
    return explicit;
  }
  if (roots.repoRoot) {
    return path.join(roots.repoRoot, 'runtime/assets/.workspace/runtime-assets-current');
  }
  return path.join(roots.packageRoot, 'runtime/assets/.workspace/runtime-assets-current');
}

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

function parseOptionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parsePositiveInt(raw, 1, name);
}

function executionSuffix(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, {recursive: true});
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function redactRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactRequestValue(item));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'license' ||
      key === 'token' ||
      key === 'client_token' ||
      key === 'device_secret_key' ||
      key === 'secret_key'
    ) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactRequestValue(child);
    }
  }
  return result;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

function resolveDeviceIdentity(options: DeviceCommandOptions): DeviceIdentity {
  const deviceId = trimOptional(options.deviceId) ?? trimOptional(process.env.TIRTC_DEVICE_ID);
  const deviceSecretKey = trimOptional(options.deviceSecretKey) ??
    trimOptional(process.env.TIRTC_DEVICE_SECRET_KEY);
  const endpoint = trimOptional(options.endpoint) ?? trimOptional(process.env.TIRTC_ENDPOINT);
  const missing: string[] = [];
  if (!deviceId) {
    missing.push('device id (pass --device-id or set TIRTC_DEVICE_ID)');
  }
  if (!deviceSecretKey) {
    missing.push('device secret key (pass --device-secret-key or set TIRTC_DEVICE_SECRET_KEY)');
  }
  if (!endpoint) {
    missing.push('endpoint (pass --endpoint or set TIRTC_ENDPOINT)');
  }
  if (missing.length > 0 || !deviceId || !deviceSecretKey || !endpoint) {
    throw rolePreflightError('missing_env', 'device start requires ' + missing.join(' and '));
  }
  return {deviceId, deviceSecretKey, endpoint};
}

function readBootstrap(bootstrapPath: string): Bootstrap {
  const resolved = path.resolve(bootstrapPath);
  const parsed = readJson<Bootstrap>(resolved);
  if (parsed.schema_version !== 1 || !(parsed.device_id || parsed.remote_id) || !parsed.token) {
    throw roleUsageError('bootstrap_invalid');
  }
  return parsed;
}

function requestMediaSourcePath(request: Record<string, unknown>): string | undefined {
  const media = request.media as {source?: {path?: unknown}} | undefined;
  const sourcePath = media?.source?.path;
  return typeof sourcePath === 'string' && sourcePath.trim() ? sourcePath.trim() : undefined;
}

function resolveDriverAssetRoot(request: Record<string, unknown>, roots: RoleDriverRoots): string {
  const source = requestMediaSourcePath(request);
  if (source) {
    const sourcePath = path.resolve(source);
    if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
      return sourcePath;
    }
    if (path.basename(sourcePath) === 'manifest.json') {
      return path.dirname(sourcePath);
    }
    if (path.basename(path.dirname(sourcePath)) === 'video') {
      return path.dirname(path.dirname(sourcePath));
    }
  }
  return resolveAssetRoot(roots);
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
  if (codec !== 'g711a' && codec !== 'aac') {
    throw roleUsageReasonError('audio_codec_unsupported', 'audio-codec must be g711a or aac');
  }
  return codec;
}

function audioSampleRateOrDefault(raw?: string | number): number {
  const sampleRate = raw === undefined ? 8000 : Number(raw);
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

function consumerOrDefault(raw?: string): string {
  const consumer = raw?.trim() || 'frame_dump';
  if (consumer !== 'frame_dump' && consumer !== 'packet_dump') {
    throw roleUsageError('consumer must be packet_dump or frame_dump');
  }
  return consumer;
}

function failedStage(summary: RoleSummary): string | undefined {
  for (const [name, stage] of Object.entries(summary.stage_status ?? {})) {
    if (stage.status === 'failed') {
      return name;
    }
  }
  return undefined;
}

function printEnvelope(options: CliOptions, code: number, message: string, data: unknown): void {
  if (options.json) {
    console.log(JSON.stringify({code, message, data}));
    return;
  }
  if (code === 0) {
    console.log('OK:', JSON.stringify(data, null, 2));
  } else {
    console.error('Error:', message);
    if (data !== undefined) {
      console.error(JSON.stringify(data, null, 2));
    }
  }
}

function buildDeviceRequest(
  roots: RoleDriverRoots,
  artifactRoot: string,
  options: DeviceCommandOptions,
): Record<string, unknown> {
  const codec = codecOrDefault(options.videoCodec);
  const audioCodec = audioCodecOrDefault(options.audioCodec);
  const audioSampleRateHz = audioSampleRateOrDefault(options.audioSampleRate);
  const audioChannels = audioChannelsOrDefault(options.audioChannels);
  const executionId = 'cli-device-' + codec + '-' + executionSuffix();
  const caseId = 'devtools-cli-device.' + codec;
  const deviceIdentity = resolveDeviceIdentity(options);
  const tokenIssue = options.clientTokenJson ? readTokenIssueJson(options.clientTokenJson) : undefined;
  const bootstrap = tokenIssue ? {
    client_token: tokenIssue.token,
    token_fingerprint: tokenFingerprint(tokenIssue.token),
  } : undefined;
  return {
    schema_version: 1,
    execution_id: executionId,
    pairing_id: executionId,
    case_id: caseId,
    role: 'device',
    endpoint: deviceIdentity.endpoint,
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
      source: {kind: 'encoded_asset', path: options.source ?? resolveAssetRoot(roots)},
      video: {codec},
      audio: {
        codec: audioCodec,
        sample_rate_hz: audioSampleRateHz,
        channels: audioChannels,
      },
    },
    output: {consumer: 'frame_dump', video: {frame_limit: defaultFrameLimit}},
    run: {
      exit_after_first_session: options.exitAfterFirstSession === true,
      duration_ms: parseOptionalPositiveInt(options.durationMs, '--duration-ms'),
      connect_timeout_ms: parsePositiveInt(options.connectTimeoutMs, defaultConnectTimeoutMs, '--connect-timeout-ms'),
      first_packet_timeout_ms: parsePositiveInt(options.firstPacketTimeoutMs, defaultFirstPacketTimeoutMs, '--first-packet-timeout-ms'),
      first_output_timeout_ms: defaultFirstOutputTimeoutMs,
    },
    artifact: {root_dir: artifactRoot},
    probe: {app_id: tokenIssue?.appId ?? ''},
  };
}

function buildClientRequest(
  roots: RoleDriverRoots,
  artifactRoot: string,
  options: ClientCommandOptions,
): Record<string, unknown> {
  const bootstrap = options.bootstrap ? readBootstrap(options.bootstrap) : undefined;
  const targetDeviceId = trimOptional(options.targetDeviceId) ??
    trimOptional(bootstrap?.device_id) ??
    trimOptional(bootstrap?.remote_id) ??
    trimOptional(process.env.TIRTC_TARGET_DEVICE_ID);
  const token = options.token?.trim() || bootstrap?.token || process.env.TIRTC_TOKEN?.trim();
  const endpoint = trimOptional(options.endpoint) ??
    trimOptional(bootstrap?.endpoint) ??
    trimOptional(process.env.TIRTC_ENDPOINT);
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
  if (!endpoint) {
    missing.push('endpoint (pass --endpoint, --bootstrap, or set TIRTC_ENDPOINT)');
  }
  if (!appId) {
    missing.push('app id (pass --app-id, --bootstrap, or set TIRTC_APP_ID)');
  }
  if (missing.length > 0 || !targetDeviceId || !token || !endpoint || !appId) {
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
  return {
    schema_version: 1,
    execution_id: executionId,
    pairing_id: trimOptional(bootstrap?.pairing_id) ?? trimOptional(bootstrap?.execution_id) ?? executionId,
    case_id: 'devtools-cli-client',
    role: 'client',
    require_audio: bootstrap?.require_audio ?? true,
    require_control_probe: bootstrap?.require_control_probe ?? true,
    endpoint,
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
      consumer: consumerOrDefault(options.consumer),
      video: {frame_limit: parsePositiveInt(options.frameLimit, defaultFrameLimit, '--frame-limit')},
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

function installSignalForwarding(
  child: childProcess.ChildProcess,
  liveLog: RoleLiveLogHandle,
): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const removers: Array<() => void> = [];
  let forwardedCount = 0;
  for (const signal of signals) {
    const handler = (): void => {
      forwardedCount += 1;
      liveLog.signalForwarded(signal);
      if (!child.killed) {
        child.kill(forwardedCount > 1 ? 'SIGKILL' : signal);
      }
    };
    process.on(signal, handler);
    removers.push(() => process.off(signal, handler));
  }
  return () => {
    for (const remove of removers) {
      remove();
    }
  };
}

function spawnDriverProcess(
  driverPath: string,
  args: string[],
  stdoutFd: number,
  stderrFd: number,
  liveLog: RoleLiveLogHandle,
): Promise<DriverProcessResult> {
  return new Promise((resolve) => {
    let child: childProcess.ChildProcess;
    try {
      child = childProcess.spawn(driverPath, args, {
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      liveLog.processError(normalized);
      resolve({
        status: null,
        signal: null,
        error: normalized,
      });
      return;
    }

    let spawnError: Error | undefined;
    const removeSignalHandlers = installSignalForwarding(child, liveLog);
    child.once('error', (error: Error) => {
      spawnError = error;
      liveLog.processError(error);
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      removeSignalHandlers();
      resolve({status: code, signal, error: spawnError});
    });
  });
}

async function runDriver(
  role: 'device' | 'client',
  request: Record<string, unknown>,
  artifactRoot: string,
  roots: RoleDriverRoots,
): Promise<RoleSummary> {
  const platform = resolveRuntimePlatform();
  const driverPath = resolveDriverPath(roots, platform);
  const runtimeRoot = resolveRuntimeRoot(roots, platform);
  const assetRoot = resolveDriverAssetRoot(request, roots);
  if (!pathExists(driverPath)) {
    throw rolePreflightError('driver_not_found', driverPath);
  }
  if (!pathIsExecutable(driverPath)) {
    throw rolePreflightError('driver_not_executable', driverPath);
  }
  const adjacentDependency = requiredAdjacentDriverDependency(platform);
  if (adjacentDependency) {
    const dependencyPath = path.join(path.dirname(driverPath), adjacentDependency);
    if (!pathExists(dependencyPath)) {
      throw rolePreflightError('driver_dependency_missing', dependencyPath);
    }
  }
  if (!hasRuntimeBundle(runtimeRoot)) {
    throw rolePreflightError('runtime_bundle_missing', runtimeRoot);
  }
  if (!pathExists(path.join(assetRoot, 'manifest.json'))) {
    throw rolePreflightError('asset_missing', assetRoot);
  }

  const requestTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-devtools-cli-request-'));
  const requestPath = path.join(requestTempDir, 'request.json');
  const summaryPath = path.join(artifactRoot, 'summary.json');
  fs.rmSync(summaryPath, {force: true});
  fs.rmSync(path.join(artifactRoot, 'events.jsonl'), {force: true});
  writeJson(requestPath, request);
  writeJson(path.join(artifactRoot, 'request.redacted.json'), redactRequestValue(request));
  const stdoutFd = fs.openSync(path.join(artifactRoot, 'stdout.log'), 'w');
  const stderrFd = fs.openSync(path.join(artifactRoot, 'stderr.log'), 'w');
  const liveLog = startRoleLiveLog({
    role,
    artifactRoot,
    request,
    runtimeRoot,
    assetRoot,
  });
  let result: DriverProcessResult = {status: null, signal: null};
  try {
    result = await spawnDriverProcess(
      driverPath,
      [
        '--request', requestPath,
        '--runtime-root', runtimeRoot,
        '--asset-root', assetRoot,
        '--artifact-root', artifactRoot,
      ],
      stdoutFd,
      stderrFd,
      liveLog,
    );
    liveLog.processExit(result.status, result.signal);
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    fs.rmSync(requestTempDir, {recursive: true, force: true});
    liveLog.stop();
  }

  if (!pathExists(summaryPath)) {
    const message = result.error instanceof Error
      ? result.error.message
      : 'driver exited without summary: status=' + String(result.status) +
        ' signal=' + String(result.signal ?? 'none');
    if (result.error) {
      throw new RoleCommandError(
        'artifact_write_failed',
        'artifact',
        roleFailedExitCode,
        message,
      );
    }
    throw new RoleCommandError('artifact_write_failed', 'artifact', roleFailedExitCode, message);
  }
  return readJson<RoleSummary>(summaryPath);
}

function normalizeRoleError(error: unknown): RoleCommandError {
  if (error instanceof RoleCommandError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RoleCommandError('artifact_write_failed', 'artifact', roleFailedExitCode, message);
}

async function runRole(role: 'device' | 'client', commandOptions: DeviceCommandOptions | ClientCommandOptions, options: CliOptions): Promise<number> {
  const roots = resolveRoleDriverRoots();
  const defaultBaseRoot = roots.repoRoot ?? roots.packageRoot;
  const defaultRoot = path.join(defaultBaseRoot, '.build/devtools-cli', role + '-' + executionSuffix());
  const artifactRoot = path.resolve(commandOptions.artifactRoot ?? defaultRoot);
  ensureDir(artifactRoot);

  try {
    const request = role === 'device' ?
      buildDeviceRequest(roots, artifactRoot, commandOptions as DeviceCommandOptions) :
      buildClientRequest(roots, artifactRoot, commandOptions as ClientCommandOptions);
    const summary = await runDriver(role, request, artifactRoot, roots);
    const summaryPath = path.join(artifactRoot, 'summary.json');
    const data = {
      status: summary.status,
      exit_code: summary.exit_code,
      role,
      execution_id: summary.execution_id,
      artifact_root: artifactRoot,
      summary_path: summaryPath,
      bootstrap_path: summary.bootstrap_path,
      reason_code: summary.reason_code,
      failed_stage: failedStage(summary),
      log_id: summary.log_upload?.log_id,
      log_upload: summary.log_upload,
      command_echo: summary.command_echo,
      stream_message: summary.stream_message,
    };
    if (summary.exit_code === 0 && summary.status === 'completed') {
      printEnvelope(options, 0, 'OK', data);
      return 0;
    }
    printEnvelope(options, 1, summary.reason_code ?? 'driver failed', data);
    return summary.exit_code || 1;
  } catch (error: unknown) {
    const normalized = normalizeRoleError(error);
    printEnvelope(options, 1, normalized.message, {
      status: 'failed',
      exit_code: normalized.exitCode,
      role,
      reason_code: normalized.reasonCode,
      failed_stage: normalized.failedStage,
      artifact_root: artifactRoot,
      summary_path: path.join(artifactRoot, 'summary.json'),
    });
    return normalized.exitCode;
  }
}

export function runDeviceStart(commandOptions: DeviceCommandOptions, options: CliOptions): Promise<number> {
  return runRole('device', commandOptions, options);
}

export function runClientStart(commandOptions: ClientCommandOptions, options: CliOptions): Promise<number> {
  return runRole('client', commandOptions, options);
}
