export type CliOptions = {
  json?: boolean;
};

export type RoleSummary = {
  status: string;
  exit_code: number;
  role: string;
  execution_id: string;
  started_at?: string;
  finished_at?: string;
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
  received_audio?: {
    enabled?: boolean;
    stream_id?: number;
    codec?: 'g711a' | 'aac' | 'pcm';
    sample_rate_hz?: 8000 | 16000;
    channels?: 1;
    bits_per_sample?: 16;
    sample_format?: 's16le';
    first_output_timing_ms?: number | null;
    captured_bytes?: number;
    pcm_path?: string;
    metadata_path?: string;
    mp3_path?: string | null;
    mp3_status?: 'generated' | 'skipped' | 'failed';
    mp3_reason_code?: 'ok' | 'ffmpeg_unavailable' | 'ffmpeg_failed' | 'pcm_missing' | 'format_unknown' | null;
  };
  artifact_paths?: {
    summary?: string;
  };
  stage_status?: Record<string, {status?: string; reason_code?: string}>;
};

export type Bootstrap = {
  schema_version?: number;
  bootstrap_id?: string;
  execution_id?: string;
  app_id?: string;
  endpoint_mode?: string;
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

export type DeviceCommandOptions = {
  cacheDir?: string;
  input?: string;
  output?: string;
  preview?: boolean;
  artifactRoot?: string;
  deviceId?: string;
  deviceSecretKey?: string;
  endpoint?: string;
  source?: string;
  videoCodec?: string;
  audioCodec?: string;
  audioSampleRate?: string;
  audioChannels?: string;
  receiveAudioStreamId?: string;
  exitAfterFirstSession?: boolean;
  durationMs?: string;
  connectTimeoutMs?: string;
  firstPacketTimeoutMs?: string;
  firstOutputTimeoutMs?: string;
  audioInputAec?: string;
  audioInputAgc?: string;
  audioInputAns?: string;
  audioOutputAgc?: string;
  audioOutputAns?: string;
  clientTokenJson?: string;
};

export type ClientCommandOptions = {
  cacheDir?: string;
  output?: string;
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
  audioOutputAgc?: string;
  audioOutputAns?: string;
};

export type RoleDriverRoots = {
  packageRoot: string;
  repoRoot?: string;
};

export type DriverProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export const defaultAudioStreamId = 10;
export const defaultVideoStreamId = 11;
export const defaultReceiveAudioStreamId = 14;
export const defaultConnectTimeoutMs = 10000;
export const defaultFirstPacketTimeoutMs = 10000;
export const defaultFirstOutputTimeoutMs = 12000;
export const defaultFrameLimit = 1;
export const roleFailedExitCode = 1;
export const usageExitCode = 2;
export const preflightExitCode = 3;

export class RoleCommandError extends Error {
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

export function rolePreflightError(reasonCode: string, detail: string): RoleCommandError {
  return new RoleCommandError(reasonCode, 'preflight', preflightExitCode, reasonCode + ': ' + detail);
}

export function roleUsageError(message: string): RoleCommandError {
  return new RoleCommandError('invalid_request', 'config', usageExitCode, message);
}

export function roleUsageReasonError(reasonCode: string, message: string): RoleCommandError {
  return new RoleCommandError(reasonCode, 'config', usageExitCode, reasonCode + ': ' + message);
}
