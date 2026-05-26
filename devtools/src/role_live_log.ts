import fs from 'fs';
import path from 'path';

export type RoleLiveLogOptions = {
  role: 'device' | 'client';
  artifactRoot: string;
  request: Record<string, unknown>;
  runtimeRoot: string;
  assetRoot: string;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  emit?: (message: string) => void;
};

export type RoleLiveLogHandle = {
  processError(error: Error): void;
  processExit(code: number | null, signal: NodeJS.Signals | null): void;
  signalForwarded(signal: NodeJS.Signals): void;
  stop(): void;
};

type DriverEvent = {
  level?: unknown;
  kind?: unknown;
  payload?: unknown;
};

type LiveStats = {
  listenerReady: boolean;
  sessionsStarted: number;
  sessionsEnded: number;
  activeSession?: number;
  firstAudioSessions: Set<number>;
  firstVideoSessions: Set<number>;
  lastEventKind?: string;
};

const defaultHeartbeatIntervalMs = 5000;
const defaultPollIntervalMs = 500;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(root[key]);
}

function nestedString(root: Record<string, unknown>, first: string, second?: string): string | undefined {
  const value = second === undefined ? root[first] : nestedRecord(root, first)[second];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nestedNumber(root: Record<string, unknown>, first: string, second?: string): number | undefined {
  const value = second === undefined ? root[first] : nestedRecord(root, first)[second];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function payloadBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === 'boolean' ? value : undefined;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) {
    return String(ms) + 'ms';
  }
  return (ms / 1000).toFixed(1) + 's';
}

function formatDurationUs(us: number | undefined): string | undefined {
  if (us === undefined) {
    return undefined;
  }
  return formatDurationMs(Math.round(us / 1000));
}

function sessionIndex(payload: Record<string, unknown>): number | undefined {
  return payloadNumber(payload, 'session_index');
}

function appendField(parts: string[], name: string, value: string | number | boolean | undefined): void {
  if (value !== undefined) {
    parts.push(name + '=' + String(value));
  }
}

function makeNoopHandle(): RoleLiveLogHandle {
  return {
    processError: () => undefined,
    processExit: () => undefined,
    signalForwarded: () => undefined,
    stop: () => undefined,
  };
}

export function startRoleLiveLog(options: RoleLiveLogOptions): RoleLiveLogHandle {
  if (options.role !== 'device') {
    return makeNoopHandle();
  }

  const emit = options.emit ?? ((message: string) => console.error(message));
  const startedAt = Date.now();
  const eventsPath = path.join(options.artifactRoot, 'events.jsonl');
  const summaryPath = path.join(options.artifactRoot, 'summary.json');
  const request = options.request;
  const stats: LiveStats = {
    listenerReady: false,
    sessionsStarted: 0,
    sessionsEnded: 0,
    firstAudioSessions: new Set<number>(),
    firstVideoSessions: new Set<number>(),
  };
  let processedLineCount = 0;
  let stopped = false;

  const log = (message: string): void => {
    emit(new Date().toISOString() + ' [device] ' + message);
  };

  const media = nestedRecord(request, 'media');
  const codec = payloadString(nestedRecord(media, 'video'), 'codec') ??
    nestedString(request, 'video_codec') ?? 'unknown';
  const sourcePath = payloadString(nestedRecord(media, 'source'), 'path') ?? options.assetRoot;
  const durationMs = nestedNumber(request, 'run', 'duration_ms');
  const deviceId = nestedString(request, 'identity', 'device_id') ?? 'unknown';
  const endpoint = nestedString(request, 'endpoint') ?? 'unknown';

  log(
    'starting device driver device_id=' + deviceId +
      ' endpoint=' + endpoint +
      ' codec=' + codec +
      ' artifact_root=' + options.artifactRoot,
  );
  log('source=' + sourcePath + ' runtime_root=' + options.runtimeRoot);
  if (durationMs === undefined) {
    log('resident mode enabled; waiting for client connections until the process is stopped');
  } else {
    log('bounded mode enabled duration=' + formatDurationMs(durationMs));
  }

  const emitHeartbeat = (): void => {
    const elapsed = Date.now() - startedAt;
    const parts = [
      'running',
      'elapsed=' + formatDurationMs(elapsed),
      'listener=' + (stats.listenerReady ? 'ready' : 'starting'),
      'sessions=' + String(stats.sessionsStarted) + '/' + String(stats.sessionsEnded),
      'active_session=' + (stats.activeSession ?? 'none'),
      'first_audio_sessions=' + String(stats.firstAudioSessions.size),
      'first_video_sessions=' + String(stats.firstVideoSessions.size),
    ];
    appendField(parts, 'last_event', stats.lastEventKind);
    log(parts.join(' '));
  };

  const emitEventLog = (event: DriverEvent): void => {
    const kind = typeof event.kind === 'string' ? event.kind : undefined;
    if (!kind) {
      return;
    }
    const payload = asRecord(event.payload);
    stats.lastEventKind = kind;
    if (event.level === 'error') {
      const reason = payloadString(payload, 'reason_code') ?? 'unknown';
      log('driver event failed kind=' + kind + ' reason_code=' + reason);
    }

    switch (kind) {
      case 'connection.listen.done':
        stats.listenerReady = true;
        log('listener ready; waiting for client connections');
        break;
      case 'bootstrap.write.done':
        log('bootstrap written path=' + (payloadString(payload, 'path') ?? 'unknown'));
        break;
      case 'connection.connect.done': {
        const session = sessionIndex(payload);
        if (session !== undefined) {
          stats.sessionsStarted = Math.max(stats.sessionsStarted, session);
          stats.activeSession = session;
        }
        log('client connected session=' + (session ?? 'unknown'));
        break;
      }
      case 'connection.state.changed': {
        const parts = ['connection state changed'];
        appendField(parts, 'session', sessionIndex(payload));
        appendField(parts, 'state', payloadString(payload, 'state'));
        appendField(parts, 'state_code', payloadNumber(payload, 'state_code'));
        appendField(parts, 'error', payloadNumber(payload, 'error'));
        log(parts.join(' '));
        break;
      }
      case 'connection.session.start': {
        const session = sessionIndex(payload);
        if (session !== undefined) {
          stats.activeSession = session;
        }
        log('media session started session=' + (session ?? 'unknown'));
        break;
      }
      case 'media.audio_send.start': {
        const parts = ['audio input started'];
        appendField(parts, 'session', sessionIndex(payload));
        appendField(parts, 'stream_id', payloadNumber(payload, 'stream_id'));
        appendField(parts, 'codec', payloadString(payload, 'audio_codec') ?? payloadString(payload, 'codec'));
        appendField(parts, 'sample_rate_hz', payloadNumber(payload, 'sample_rate_hz'));
        log(parts.join(' '));
        break;
      }
      case 'media.video_send.start': {
        const parts = ['video input started'];
        appendField(parts, 'session', sessionIndex(payload));
        appendField(parts, 'stream_id', payloadNumber(payload, 'stream_id'));
        appendField(parts, 'codec', payloadString(payload, 'codec'));
        log(parts.join(' '));
        break;
      }
      case 'media.asset_cycle.config': {
        const parts = ['asset cycle ready'];
        appendField(parts, 'session', sessionIndex(payload));
        appendField(parts, 'audio_packets', payloadNumber(payload, 'audio_packet_count'));
        appendField(parts, 'video_packets', payloadNumber(payload, 'video_packet_count'));
        appendField(
          parts,
          'cycle_duration',
          formatDurationUs(payloadNumber(payload, 'cycle_duration_us')),
        );
        log(parts.join(' '));
        break;
      }
      case 'media.audio_send.session_first_packet': {
        const session = sessionIndex(payload);
        if (session !== undefined) {
          stats.firstAudioSessions.add(session);
        }
        const parts = ['first audio packet sent'];
        appendField(parts, 'session', session);
        appendField(parts, 'pts_us', payloadNumber(payload, 'pts_us'));
        appendField(parts, 'bytes', payloadNumber(payload, 'bytes'));
        log(parts.join(' '));
        break;
      }
      case 'media.video_send.session_first_packet': {
        const session = sessionIndex(payload);
        if (session !== undefined) {
          stats.firstVideoSessions.add(session);
        }
        const parts = ['first video packet sent'];
        appendField(parts, 'session', session);
        appendField(parts, 'codec', payloadString(payload, 'codec'));
        appendField(parts, 'key_frame', payloadBoolean(payload, 'is_key_frame'));
        appendField(parts, 'pts_us', payloadNumber(payload, 'pts_us'));
        appendField(parts, 'bytes', payloadNumber(payload, 'bytes'));
        log(parts.join(' '));
        break;
      }
      case 'connection.session.end': {
        const session = sessionIndex(payload);
        if (session !== undefined) {
          stats.sessionsEnded = Math.max(stats.sessionsEnded, session);
          if (stats.activeSession === session) {
            stats.activeSession = undefined;
          }
        }
        const disconnected = payloadBoolean(payload, 'disconnected');
        const elapsed = payloadNumber(payload, 'elapsed_ms');
        const parts = [disconnected ? 'client disconnected' : 'client session ended'];
        appendField(parts, 'session', session);
        appendField(parts, 'first_audio', payloadBoolean(payload, 'sent_first_audio'));
        appendField(parts, 'first_video', payloadBoolean(payload, 'sent_first_video'));
        appendField(parts, 'exit_reason', payloadString(payload, 'exit_reason'));
        appendField(parts, 'submit_error_track', payloadString(payload, 'submit_error_track'));
        appendField(parts, 'submit_error_status', payloadNumber(payload, 'submit_error_status'));
        appendField(parts, 'elapsed', elapsed === undefined ? undefined : formatDurationMs(elapsed));
        log(parts.join(' '));
        break;
      }
      case 'connection.wait.no_client': {
        const reason = payloadString(payload, 'reason') ?? 'unknown';
        const elapsed = payloadNumber(payload, 'elapsed_ms');
        log(
          'no client connected before stop reason=' + reason +
            (elapsed === undefined ? '' : ' elapsed=' + formatDurationMs(elapsed)),
        );
        break;
      }
      case 'driver.execution.finished': {
        const status = payloadString(payload, 'status') ?? 'unknown';
        const exitCode = payloadNumber(payload, 'exit_code');
        const reason = payloadString(payload, 'reason_code') ?? 'unknown';
        log(
          'driver finished status=' + status +
            ' exit_code=' + String(exitCode ?? 'unknown') +
            ' reason_code=' + reason,
        );
        break;
      }
      default:
        break;
    }
  };

  const pollEvents = (flushPartial: boolean = false): void => {
    if (!fs.existsSync(eventsPath)) {
      return;
    }
    let text = '';
    try {
      text = fs.readFileSync(eventsPath, 'utf8');
    } catch {
      return;
    }
    const lines = text.split(/\r?\n/);
    const completeLineCount = text.endsWith('\n')
      ? lines.length - 1
      : (flushPartial ? lines.length : lines.length - 1);
    for (let index = processedLineCount; index < completeLineCount; index += 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      try {
        emitEventLog(JSON.parse(line) as DriverEvent);
      } catch {
        if (flushPartial) {
          log('skipped malformed driver event line=' + String(index + 1));
        }
      }
    }
    processedLineCount = Math.max(processedLineCount, completeLineCount);
  };

  const pollTimer = setInterval(
    () => pollEvents(false),
    options.pollIntervalMs ?? defaultPollIntervalMs,
  );
  const heartbeatTimer = setInterval(
    emitHeartbeat,
    options.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs,
  );

  return {
    processError: (error: Error): void => {
      pollEvents(true);
      log('driver process error message=' + error.message);
    },
    processExit: (code: number | null, signal: NodeJS.Signals | null): void => {
      pollEvents(true);
      const elapsed = Date.now() - startedAt;
      log(
        'process exited code=' + String(code ?? 'null') +
          ' signal=' + String(signal ?? 'none') +
          ' elapsed=' + formatDurationMs(elapsed) +
          ' summary=' + summaryPath,
      );
    },
    signalForwarded: (signal: NodeJS.Signals): void => {
      log('forwarding signal=' + signal + ' to native driver');
    },
    stop: (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      pollEvents(true);
    },
  };
}
